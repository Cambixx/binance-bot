# Informe de Auditoría y Mejoras — Binance Shadow Bot (2026-06-14)

Auditoría profunda multi-agente con **verificación adversarial** de cada hallazgo + investigación
online consciente de costes, y aplicación de todas las correcciones y mejoras. Este documento
resume QUÉ estaba mal, QUÉ se arregló y QUÉ se añadió.

## Metodología
- **Auditoría** en 6 dimensiones (matemática de indicadores, motor de backtest, paridad live,
  concurrencia/infra, seguridad, validez estadística). Cada hallazgo lo intentó **refutar** un
  verificador independiente que releyó el código y recomputó la matemática. → **35 hallazgos
  reales confirmados**.
- **Investigación** en 6 frentes (trend-following cost-aware, rotación cross-sectional/dual-momentum,
  vol-targeting, filtros de régimen BTC, modelado de costes, métodos de validación rigurosa), con
  fact-checking adversarial de cada estrategia y síntesis priorizada.

---

## 1. Correcciones aplicadas (por severidad)

### 🔴 ALTA
| # | Hallazgo | Fix |
|---|---|---|
| 1 | **MaxDrawdown subestimado**: la curva de equity se submuestreaba a 1h, ocultando caídas intra-hora; además se comparaba con un HODL medido a resolución completa (manzanas vs peras). | Tracker de DD **por-vela** por fase (`trackDrawdown`) independiente de la curva del plot. `backtestEngine.js` |
| 2 | **Trailing stop divergente live vs backtest**: en live no disparaba si el profit caía bajo la activación aunque siguiera por encima del trailing → la posición caía hasta el SL duro (pérdida de dinero). | Lógica de salida extraída a **`exits.js` (`evaluateFixedExit`)**, fuente única usada por motor Y bot live → paridad garantizada por construcción. |
| 3 | **Race de lost-update**: cada mutación hacía un read-modify-write del estado COMPLETO en Netlify Blobs (decenas por ciclo). | Patrón **transaccional** en `shadowTrader`: `beginSession()` (1 lectura) → mutaciones en memoria → `commitSession()` (1 escritura). |
| 4 | **Fallos silenciosos**: los errores se tragaban con `console.error`, sin alerta. | Try/catch con **alerta a Telegram** en `runBot`/`runDailyBot`/`runRotationBot`. |
| 5 | **Credenciales Binance en `.env` plano** (no commiteadas, pero en disco). | `chmod 600 .env`, `.env.example` con guía, host firmado separado (#31). **⚠️ acción del usuario: rotar la API key si fue real; el bot shadow NO necesita claves.** |
| 6 | **OOS de un solo split 70/30**: un único sorteo de régimen. | Nueva **`walkforward.js`** (folds rodantes, distribución de métricas). |

### 🟡 MEDIA
| # | Hallazgo | Fix |
|---|---|---|
| 7,20 | Trades etiquetados por `buyTime` pero ROI por ventana de equity → métricas desacopladas; sin purga. | Etiquetado por **`sellTime`** (realización) en `executeSell` y parcial. |
| 8 | `profitFactor` devolvía **0** cuando no había pérdidas (peor valor para una estrategia perfecta). | Devuelve `null` (=∞); runner y veredicto lo manejan. |
| 9 | `END_OF_BACKTEST` usaba `Date.now()` → duraciones infladas; sin punto final de equity. | Usa el **timestamp de la última vela** + punto final sin throttle. |
| 10 | Live veía 130 velas, backtest 120 → último valor de EMA/ADX/CHOP distinto. | `LOOKBACK_15M=130` centralizado; `bufferSize` del motor alineado. |
| 11 | SMA200 sin banda de histéresis → whipsaw alrededor de la media (cada in/out paga ~0.30%). | Banda `SMA_HYSTERESIS_BAND` en `evaluateStrategySMA200` (live y backtest, flag `--band`). |
| 12 | Amplificación de I/O de blobs (~30-90 lecturas/ciclo). | Resuelto por el patrón transaccional (#3). |
| 13 | Sin retry/backoff/timeout para Binance. | `getWithRetry` con timeout 10s, backoff exponencial y honra 429/418 `Retry-After`. |
| 14 | Errores de mercado devolvían `[]/{}` indistinguibles de "vacío". | Retries + logging claro; el bot avisa si no puede gestionar una posición abierta. |
| 15 | Webhook de Telegram sin autenticación criptográfica (chat.id falsificable). | Validación de `X-Telegram-Bot-Api-Secret-Token` (`TELEGRAM_WEBHOOK_SECRET`). |
| 16 | Backtest por defecto = top-10 de HOY aplicado al pasado (sesgo de supervivencia). | Default = **cesta fija de large-caps**; top-N dinámico solo con `--universe` y etiquetado. |
| 17 | Holdout con n<30 → métricas ruidosas sin IC. | **Bootstrap CI** en `validate.js`/`validation.js`. |
| 18 | Calmar/Sharpe afirmados en docs pero **nunca computados** (Calmar real SMA200 = 0.31, no 0.64). | Sharpe/Sortino/Calmar/annReturn/annVol computados en `computeRiskAdjusted`. |
| 19 | Benchmark solo equiponderado de la cesta sesgada. | Añadido **BTC HODL** como benchmark adicional. |
| 21 | Artefactos de resultados sin procedencia y desincronizados. | `summary` ahora estampa `interval`, `strategyVersion`, `dataEndTime`, `costs`. Artefactos regenerados. |

### 🟢 BAJA (también corregidas)
| # | Hallazgo | Fix |
|---|---|---|
| 22 | Seed del SuperTrend divergía del canónico (downtrend espurio en warmup). | Seed `trend=+1` (canónico `nz(trend,1)`). |
| 23 | `percentileRank` se incluía a sí mismo (sesgo +1/W). | Rankea contra el historial (`slice(0,-1)`). |
| 24 | Defaults de V4C (45/30) ≠ config productiva (50/20); docstring obsoleto. | Defaults alineados a config + docstring corregido. |
| 25 | `generateReport` etiquetaba TODO como "V3" (mapa local con solo 1/2/3). | **`STRATEGY_NAMES` único** a nivel de módulo (`strategyName()`). |
| 26 | Sizing geométrico, sin cap de posiciones/exposición. | `RISK.maxConcurrentPositions` / `maxExposurePct` (motor y live). |
| 27 | Breakeven contado como pérdida. | Convención winners>0 / losers<0 / breakeven=0. |
| 28 | `getStats`: winRate (cerrados) vs totalProfit (incluye latente) sin etiquetar. | Métricas separadas y etiquetadas (`realizedTotalProfitUSDC`). |
| 29 | `profitUSDC` guardado como string `toFixed(2)` → deriva de redondeo. | Guardado como **Number** a precisión completa. |
| 30 | Cooldown live por wall-clock vs backtest por velas. | Cooldown **anclado al tiempo de vela** (cuenta velas, robusto al jitter del cron). |
| 31 | Petición firmada al host de SOLO datos (filtraba la key). | Host autenticado separado (`api.binance.com`) del de datos. |
| 32 | Interpolación sin escapar en HTML de Telegram. | `telegramService.escape()` aplicado a todos los valores dinámicos. |
| 33 | Artefactos locales `.netlify/` en el árbol de trabajo. | Confirmado ignorados; recomendado limpiar el cluster Postgres local. |
| 34 | Sweep de ~18 configs sin corrección de multiple-testing (PBO). | **Deflated Sharpe + PBO/CSCV** en `sweep.js` (`validation.js`). |
| 35 | "Plateau SMA150/200/250" afirmado sin artefacto. | `walkforward.js`/`validate.js` permiten demostrarlo de forma reproducible. |

---

## 2. Mejoras de estrategia/riesgo (investigación cost-aware)

Solo se implementaron ideas que **sobrevivieron el fact-checking adversarial** para un bot SPOT,
long-only, que paga ~0.30% round-trip:

- **Vol-targeting** (`computeVolTargetWeight`, evidencia alta): escala el tamaño por volatilidad
  realizada (EWMA λ=0.94, anualizado √365). `VOLTARGET` en config; flag `--voltarget`. El beneficio
  fiable es control de drawdown, no alfa.
- **Filtro maestro de régimen BTC** (`btcRegimeOn`): risk-off global si BTC < SMA. `REGIME` en config.
- **Banda de histéresis SMA** (P2): reduce whipsaw del canal diario validado.
- **Canal de rotación cross-sectional + dual-momentum** (`rotationBot.js`, P3+P4): top-N por retorno
  trailing 30d + gate de momentum absoluto + gate BTC; si no, cash. **EXPERIMENTAL** (shadow,
  `ROTATION_ENABLED=true`). El edge robusto viene de los gates (cash en bajista), no del ranking.
- **Caps de cartera**: nº máximo de posiciones y exposición agregada.

### Qué se EVITÓ (mueren a los costes, confirmado):
- TA intradía / cruces MA rápidos / TSMOM sub-diario (**= V4C-COMBO**: breakeven ~3-15bps ≪ 30bps).
- Vol-scaled TSMOM como motor de alfa (su Sharpe viene del apalancamiento long-short en perps).
- Rotación con lookback mensual/largo (el momentum cripto se invierte pasado ~1 mes).
- Kelly completo, optimizadores media-varianza, sobre-tunear los nuevos grados de libertad.

---

## 3. Validación rigurosa añadida (`validation.js` + runners)
- **Walk-forward** (`npm run walkforward`): distribución de PF/ROI/Sharpe/MaxDD por fold.
- **Bootstrap de trades** + **Deflated Sharpe** + **Monte Carlo de permutación** (`npm run validate`).
- **Deflated Sharpe + PBO/CSCV** integrados en `sweep.js` (corrección de multiple-testing).

## 4. Tests (`npm test`)
29 tests (node:test, zero-dep): modelo de costes, indicadores, paridad de salidas (incl. el bug del
trailing del audit), DD per-bar, profitFactor=∞, vol-target, rotación, y toda la estadística de validación.

---

## 5. Acciones recomendadas para el usuario
1. **Rotar la API key de Binance** si las claves del `.env` fueron reales (el bot shadow no las necesita).
2. Definir `TELEGRAM_WEBHOOK_SECRET` y re-registrar el webhook con `secret_token`.
3. Correr `npm run walkforward -- --sma200` y `npm run validate -- --sma200 --permute` para confirmar
   el edge de la familia diaria OOS antes de darle peso real.
4. (Opcional) Activar el canal de rotación en shadow (`ROTATION_ENABLED=true`) y comparar 1-2 meses.

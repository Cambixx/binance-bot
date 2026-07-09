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

---

## 6. Auditoría LIVE de los 3 canales (2026-06-19)

Segunda auditoría multi-agente tras observar el bot en vivo varios días (el usuario reportó que
SMA200-1d "iba bien"). Cada ajuste validado con backtests frescos y **verificación adversarial OOS**.

### Hallazgo honesto de fondo
Ningún canal gana OOS en **retorno**. El "positivo" del diario era **P&L no realizado** (1 trade
cerrado, y fue pérdida: ASTER −46/−11%). V4C sangra por stop-losses (4/5 trades). ROT está en cash.

### Ajustes aplicados — 📅 SMA150-1d (canal del usuario)
| Cambio | Antes → Después | Efecto OOS (36m, costes 0.30%) |
|---|---|---|
| Periodo SMA | 200 → **150** | única longitud con holdout PF>1; plateau monótono (no overfit) |
| Sizing | geométrico → **vol-targeting por-canal** | holdout PF 0.80→0.97, MaxDD 25.8→21.9% |
| Universo | top-10 por volumen → **cesta fija large-caps** | de-risking/paridad (quita mid-caps sin histórico) |
| **Combinado** | — | **Calmar 0.31→0.61, MaxDD −35.9%→−27.9%, holdout PF 0.80→1.55** |

Vol-targeting cableado **por-canal** en `dailyBot.js` (NO `VOLTARGET.enabled` global, que afectaría a
V4C/ROT). `SMA_PERIOD`/`DAILY_BASKET` en `config.js`. `backtest.js`: SMA period default = config,
vol-target ON por defecto en el canal diario, buffer escalado con el periodo → paridad live↔backtest.

**Rechazados (empeoran OOS):** sizing equiponderado equity/N, banda de histéresis 1%, SMA250.

### 📡 V4C-15m → DEPRECADO a observación
Sin edge ni bruto neto de costes (12m holdout PF 0.73; gross ~PF 1.0). No hay bug ni alfa que
rescatar. Se mantiene corriendo en shadow solo para comparación; **no asignar capital real**. No se
liquidan de golpe las posiciones abiertas (terminan su gestión vía `exits.js`).

### 🔄 ROT-dual-mom → confirmado, sin cambios
Estar 100% en cash es la salida diseñada de los gates (momentum absoluto + BTC), no un fallo.

### Riesgo sobre el estado LIVE (verificado)
Ningún cambio rompe las posiciones abiertas: `sizeFraction` solo afecta a nuevas entradas; la lógica
SELL corre sobre `openSymbols ∪ symbols`, así que las posiciones en mid-caps fuera de la nueva cesta
**se siguen gestionando y pueden venderse**; solo se bloquean NUEVAS aperturas fuera de `DAILY_BASKET`.

### Gate de promoción a capital real (pendiente de datos)
No mover el diario a real hasta ver **≥6-8 trades CERRADOS con PF>1** en live. Reportar siempre por
`realizedPnLUSDC`, nunca `totalProfitUSDC` (el latente es surf de toro, no edge).

---

# Anexo: Auditoría 2026-07-09 (código + costes de cortos + resiliencia)

Auditoría completa del código con correcciones aplicadas, validadas con la suite de tests
(**39/39**) y re-backtests de 40 meses. Baselines pre-cambio: long-only ROI +72.1% / Calmar 0.75;
long/short ROI +59.4% / Calmar 0.67.

## Correcciones aplicadas

### 🔴 ALTA
| Hallazgo | Fix |
|---|---|
| **Cortos "gratis"**: ni el motor ni el ledger cobraban borrow/funding a los cortos → el edge del canal SMA150-LS estaba sobreestimado (el propio doc lo admitía como "no modelado"). | `COSTS.shortBorrowDailyPct` (0.03%/día × notional entrada × días abiertos) restado al cubrir, en `executeShortClose` (motor) y `applySell` (ledger) → paridad. Flags `--borrow=N`, `--no-costs`. **Impacto 40m: ROI +59.4→+49.0%, Calmar 0.67→0.55, holdout PF 3.4→3.0; walk-forward: ROI mediano +14.4→+8.8%, sigue 4/5 folds ROI>0 y 5/5 PF≥1** → el lado corto sobrevive al coste, pero más modesto. |
| **Lost-update real en Netlify Blobs**: el patrón transaccional reducía la ventana de carrera pero dos invocaciones solapadas aún podían pisarse trades (last-write-wins). | **Concurrencia optimista**: `beginSession` captura el `etag` y `commitSession` escribe con `onlyIfMatch` (u `onlyIfNew` si el blob no existe). En conflicto, el ciclo aborta SIN notificar y reintenta al siguiente cron. |
| **Rotación: liquidaciones espurias en fallos de API**: si `getTopVolumeSymbols` fallaba, el fallback de 4 monedas degeneraba el ranking → vendía posiciones sanas; si `getPrices` fallaba, el rebalanceo quedaba a medias PERO `lastRebalanceTime` se estampaba → 14 días de cartera inconsistente. | Guardas de integridad: aborta el ciclo (con alerta Telegram) si el universo es sospechosamente pequeño o falta el precio de algún símbolo implicado. Nada se persiste en fallo. |
| **Backtest silenciosamente truncado**: un error transitorio a mitad de paginación hacía `break` sin aviso → métricas calculadas sobre datos incompletos. | `fetchHistoricalData` con retry+backoff (honra 429/418/5xx) y **fallo ruidoso** (throw) si la página no se recupera. |

### 🟡 MEDIA
| Hallazgo | Fix |
|---|---|
| Cron lento: dailyBot y longShortBot descargaban **las mismas velas** de la misma cesta, en secuencia (riesgo de timeout serverless con 3 canales). | Descargas **en paralelo** (`Promise.all`) en los 3 bots + **caché de klines** de corta vida en `binanceService` (`{cacheMs}`) → el canal LS reutiliza las velas del diario en la misma invocación (≈mitad de llamadas). |
| Ventana de cierres live (160) ≠ buffer del backtest (210) → el peso de vol-targeting (EWMA) veía series de longitud distinta. | Bots diarios piden `SMA_PERIOD+61` (⇒ 210 cierres tras descartar la vela en formación) = `bufferSize` del motor → paridad exacta. |
| `canOpenPosition` medía la exposición del corto como `amount·precio` (nocional) en vez de margen+P&L flotante. | Cálculo side-aware (solo afecta si se activan los caps). |
| `updatePosition` legacy escribía sin condición (podía pisar un commit concurrente). | Enrutado por `commitSession` condicional. |
| Vulnerabilidades npm: `form-data` (high, CVE de CRLF injection — dependencia de axios) y `tmp` (high). | `npm audit fix` aplicado; quedan 6 moderadas transitivas (`@opentelemetry/core` vía `@netlify/blobs`, fix = downgrade breaking; riesgo práctico bajo, sin exposición a baggage headers entrantes). |

### 🟢 BAJA
| Hallazgo | Fix |
|---|---|
| Webhook sin `TELEGRAM_WEBHOOK_SECRET` queda protegido solo por chat_id (falsificable). | `console.warn` explícito en cada invocación sin secret (los comandos son read-only; configurar el secret sigue recomendado). |

## Mejoras evaluadas y RECHAZADAS (con datos)
- **Banda de histéresis SMA** (0.5/1/2% vs 0, 40m long-only): ninguna bate a band=0 en
  ROI/Calmar full (72.1%/0.75 vs 61.6%/0.72 la mejor, band=2); el holdout mejora marginalmente
  (PF 1.55→1.65) pero no compensa resetear la observación shadow live. Coherente con el rechazo
  de la auditoría 2026-06-19. **Se mantiene `SMA_HYSTERESIS_BAND = 0`.**

## Estado del riesgo live
Ningún cambio toca posiciones abiertas ni el formato del estado en blobs (solo se añade el etag
en memoria durante la sesión). El borrow solo afecta a cierres de cortos FUTUROS del canal LS
(shadow). La ventana 210 cambia marginalmente el peso de vol-targeting de NUEVAS entradas.

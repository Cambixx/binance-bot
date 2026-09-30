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

## 7. Auditoría LIVE 2026-06-26 (con el canal long/short en marcha)

Multi-agente (auditoría de estado/código + investigación de mejoras), cada hallazgo/propuesta
verificado adversarialmente. Estado live (régimen bajista): SMA150-LS +5.2% latente shorteando la
caída; SMA150-1d −5.3% por longs mid-cap heredados; ROT en cash; V4C parado/congelado.

### Riesgos REALES confirmados y CORREGIDOS
| # | Hallazgo | Fix aplicado |
|---|---|---|
| 1 (HIGH) | El corto no tenía NINGÚN stop → pérdida no acotada hasta el flip (laggy) de la SMA. El backtest **también** lo sobreestimaba. | **Catastrophe-stop 25%** + cooldown 5d en motor y live (`config.LONGSHORT`, `backtestEngine.js`, `longShortBot.js`). |
| 2 | Funding/borrow del corto no modelado → edge sesgado al alza. | **`COSTS.fundingDailyShort` 0.03%/día** netado en `executeShortClose` y `shadowTrader.applySell` (paridad). Recorta ~10pp de ROI en backtest (62%→52%). |
| 3 | Sin cap de exposición en LIVE (7 cortos = ~79%); `canOpenPosition` solo en backtest. | Caps `LONGSHORT.maxExposurePct` 0.85 portados a `longShortBot`/`dailyBot`. |
| 4 | Margen 1x sin liquidación (balance podía ir negativo). | Acotado por el catastrophe-stop (cierra antes del −100%). |
| 5 | `telegramService` sin timeout → un POST colgado starvea el cron. | `timeout: 8000` en ambos posts. |

### Calibración honesta (anti-overfit)
Un barrido de `shortStopPct` mostró 8%→ROI 58% pero 10%→28% y 12%→24% = **no-monotónico = sobreajuste
a 1 muestra**. Por eso el stop se fija ANCHO (25%, protección de cola, 0 disparos en la muestra), NO
en el "pico" de 8%. Walk-forward con funding+stop sigue ✅ robusto (ROI mediano por fold 12.4%, 5/5 PF≥1).

### Acciones operativas recomendadas al usuario (sobre el estado live, no automatizadas)
- **Force-close** las 4 posiciones mid-cap HEREDADAS del canal SMA150-1d (WLD/NEAR/XLM/JTO) que NO
  están en `DAILY_BASKET` — su única salida es su propia SMA (lag enorme tras un pump). Saneamiento puntual.
- **Resetear** el blob huérfano del V4C parado: `npx netlify blobs:delete shadow_trading_state bot_state_v2`.

### Experimentos pendientes de validar OOS (NO aplicados)
Chandelier-stop del corto + estado FLAT (salir a cash en vez de always-in), asimetría de velocidad
(entrar lento/salir rápido con SMA de salida 20-30), sizing inverse-vol sobre equity. La investigación
los marca como experimentos (riesgo de whipsaw/overfit) → validar con walk-forward + DSR + PBO antes de live.

---

## 8. Check-up multiagente 2026-07-03 (auditoría live + research de mejoras)

Dos workflows en paralelo (23 + 32 agentes, verificación/fact-checking adversarial): auditoría del
estado live tras ~2 semanas de los canales nuevos + research online de mejoras. Plan completo del
research en **`RESEARCH_MEJORAS_2026-07.md`**.

### Veredicto por canal (estado a 2026-07-03)
- **📅 SMA150-1d:** 100% cash bajo la SMA150 = comportamiento diseñado (preservar capital en bajista).
  Métricas visibles contaminadas por 4 cierres administrativos (`MANUAL_CLEANUP` 06-26) → corregido.
- **↕️ SMA150-LS:** 7 cortos abiertos desde 06-21, −0.27% reportado (−0.6% real con funding devengado)
  mientras el benchmark rebotó +2.5% — MEJOR que una cesta corta naive. Dentro del guion trend-following.
- **🔄 ROT:** cash correcto (gates). **⏹️ V4C:** parado.
- **Gate de promoción:** diario 1/6-8 cierres válidos; LS 0/6-8. Los primeros cierres del LS serán
  mayoritariamente whipsaws pequeños perdedores — es la distribución diseñada, no un fallo. Paciencia.

### Fixes de instrumentación aplicados (todos verificados adversarialmente)
| # | Hallazgo | Fix |
|---|---|---|
| 1 | Cierres administrativos contaminaban WR/PF del canal | `getStats` separa `signalTrades`/`signalWins` (base del gate); winRate = solo señales |
| 2 | PF del backtest inflado por cierres forzados END_OF_BACKTEST (PF 10 total vs 0.95 realizado en ventanas cortas) | `computeMetrics.signalOnly` + línea "PF solo señales" en el runner (42m: total 1.75 vs honesto **1.40**) |
| 3 | Funding no devengado en cortos ABIERTOS (equity optimista, escalón al cierre, MaxDD infra-medido) | Devengo en `getStats` (live) y `currentEquity(prices, time)` (motor) — simétrico |
| 4 | El motor no leía `LONGSHORT` → backtests sin el catastrophe-stop del live | Defaults desde config (`shortStopPct/cooldown`, caps en modo LS) |
| 5 | Cap de exposición divergente (live a coste y ANTES del flip; motor a nocional y después) | Motor side-aware (corto = margen) + live evalúa el cap DESPUÉS del cierre del flip |
| 7 | Estado corrupto (edición manual) podía envenenar el balance con NaN | Guards `Number.isFinite` en `applySell` + assert en `commitSession` |

### Research aplicado — Tier 0 + κ (validación pareada, 8 folds, 42m)
- **Funding REAL firmado (#1)**: fetcher público de perps (`getFundingRateHistory`/`getFundingCumSeries`
  en `binanceService.js`, helpers puros `buildCumFromRates`/`cumRateAt`), modo `fundingMode:'real'` en
  el motor con fallback flat por símbolo. **Resultado del A/B pareado: el funding real DOMINA a flat en
  los 7 folds** (Calmar mediano 1.45→2.62, IQR 4.43→4.27, peor fold igual) — el flat sobrecargaba al
  corto (el funding cripto es mayormente positivo → el corto lo cobra). **Adoptado como default** en
  `backtest.js`/`walkforward.js` para modo LS (`--funding=flat` para contraste). El edge del LS
  SOBREVIVE al funding real → el Tier 2 del research mantiene prioridad.
- **Gate de dispersión (#2)**: `walkforward.js` reporta ahora Calmar por fold (winsorizado ±10),
  IQR, peor fold y el criterio de adopción pareado (mediana ≥ baseline, IQR ≤, peor fold no peor).
- **κ=0.5 del corto (#3): RECHAZADO por el gate** — vs funding real κ=1: IQR peor (4.27→4.99), peor
  fold peor, y en el fold bajista 2025-26 pierde −4.9% donde κ=1 gana +0.9% (recorta el hedge justo
  cuando importa). `LONGSHORT.shortRiskFraction` queda en 1.0 (parámetro listo para re-test futuro
  vía `--short-risk=`).

### Pendiente del research (validar antes de activar; ver RESEARCH_MEJORAS_2026-07.md)
Tier 1: vol-targeting condicional por quintiles (#4), vol-targeting de cartera con covarianza EWMA (#5).
Tier 2: kill-switch de funding negativo persistente (#6), de-risking en pánico + veto anti-rebote (#7),
entrada del corto más exigente (#8, torneo banda-vol vs confirmación-N). Tier 3: solo si lo anterior
queda cerrado. **NO hacer:** banda simétrica, SuperTrend, filtro naive de correlación, quitar el stop
25%, barrer anti-whipsaws juntos (infla PBO).

---

## 9. Mejoras del research aplicadas y validadas por el gate (2026-07-03)

Se completaron las mejoras pendientes del plan (`RESEARCH_MEJORAS_2026-07.md`) con la disciplina
pre-registrada: cada una se implementa como opción y se **ADOPTA solo si pasa el gate walk-forward
pareado** (Calmar mediano ≥ baseline, IQR de Calmar ≤ baseline, peor fold no peor), en el nuevo
harness **`abtest.js`** (+ `wfcore.js`) que descarga los datos UNA vez y compara variantes por los
MISMOS folds. Resultado neto: el walk-forward del canal LS pasó de **Calmar 2.67 / IQR 4.27** a
**Calmar 3.63 / IQR 3.50** (mismos 7 folds, 42m, funding real).

### ✅ ADOPTADO (pasó el gate)
| Mejora | Regla | Efecto (walk-forward pareado) |
|---|---|---|
| **#8 confirm3d** (entrada del corto) | Exigir **3 cierres consecutivos bajo la SMA** antes de shortear (`LONGSHORT.shortEntry`) | Evita el whipsaw del primer cruce (el que sufrieron SOL/AVAX en vivo). Calmar mediano +, IQR −, PF realizado 1.40→1.51 |
| **#9 ATR-trail 3.0** (salida del corto) | Chandelier del corto: cubrir si `close > minLow + 3·ATR14` (`LONGSHORT.shortTrailAtr`), CAPA sobre el stop 25% | **La mejor mejora**: Calmar 2.75→**3.65**, **IQR 4.16→3.5** (gran reducción de dispersión), con **meseta** 2.5/3.0/3.5 (robusto, no pico). PF realizado →1.81 |
| **#1 funding real** (Tier 0, §8) | Serie firmada del perp en vez de flat | Domina a flat en 7/7 folds |

Ambos cableados en el motor Y en `longShortBot.js` (paridad live↔backtest) con tests.

### 🔻 RECHAZADO por el gate (media ↑ pero dispersión ↑, o sin efecto)
| Mejora | Por qué |
|---|---|
| #8A banda-vol + pendiente | Calmar < baseline y/o peor fold peor |
| #8B confirm2d | IQR ↑ |
| #7b veto anti-rebote 2σ/3σ | Calmar ↑ (¡3.83!) pero **IQR ↑** → más dependencia de régimen |
| #4 vol-target condicional por quintiles | IQR ↑ |
| #9 time-stop 21d/42d | Sin efecto / IQR ↑ |
| #6 funding kill-switch | Calmar ↑ (4.37) pero **IQR ↑** (3.5→3.75) |
| #3 κ=0.5 (recorte del corto) | Empeora el fold bajista (recorta el hedge donde el LS gana) |

Patrón claro: varias variantes **suben la media pero aumentan la dispersión** — el gate las rechaza
por diseño (el objetivo es robustez entre regímenes, no maximizar la mediana). Las opciones quedan
implementadas y disponibles vía flags (`--short-risk`, `shortEntry`, etc.) para re-tests futuros.

### 💤 IMPLEMENTADO pero DORMANTE (seguro de cola, off por defecto)
- **#7a panic-derisk** (BTC 60d < −30% Y vol > P80 → corto al 50%): en la muestra **no gatilló**
  (idéntico al baseline) → sin evidencia de que ayude; queda OFF (`LONGSHORT.panicDerisk=null`).
  Implementado como red de seguridad para un crash extremo fuera de muestra.

### ⏸️ EVALUADO y APLAZADO (no implementado, con razón)
- **#5 vol-target de cartera (covarianza EWMA):** desajuste arquitectónico — el bot dimensiona
  por-símbolo AL ENTRAR, sin rebalanceo continuo de cartera; el beneficio (reducir dispersión por
  correlación) YA lo entrega el ATR-trail adoptado (IQR 4.27→3.5). Coste/valor no lo justifica ahora.
- **Tier 3 #10 (Absorption Ratio), #11 (escalera de SMAs), #12 (Donchian ensemble):** el propio
  research los marcó especulativos / marginales / contradichos por la evidencia interna (SMA150 es la
  única longitud con holdout PF>1). Aplazados hasta cerrar lo anterior; no añadir complejidad no validable.

### Herramientas nuevas
- **`abtest.js`** — torneo de variantes con walk-forward pareado y el gate de adopción (`node abtest.js`).
- **`wfcore.js`** — núcleo de walk-forward reutilizable (`runWalkForward`, `lsBaseEngineOpts`).

---

## 10. Auditoría de código 2026-07-09 (resiliencia de infraestructura + validación)

Auditoría completa del código, hecha en paralelo al check-up §8-§9 y **fusionada con él**
(convergencia: ambas detectaron el funding del corto no modelado; en el merge se conserva UNA sola
implementación, `COSTS.fundingDailyShort` + `fundingMode real/flat` de §8, sin doble cargo).
Validada con la suite de tests y re-backtests de 40 meses.

### 🔴 ALTA
| Hallazgo | Fix |
|---|---|
| **Lost-update real en Netlify Blobs**: el patrón transaccional reducía la ventana de carrera pero dos invocaciones solapadas aún podían pisarse trades (last-write-wins). | **Concurrencia optimista**: `beginSession` captura el `etag` y `commitSession` escribe con `onlyIfMatch` (u `onlyIfNew` si el blob no existe). En conflicto, el ciclo aborta SIN notificar y reintenta al siguiente cron. (Convive con el assert de balance finito de §8 #7.) |
| **Rotación: liquidaciones espurias en fallos de API**: si `getTopVolumeSymbols` fallaba, el fallback de 4 monedas degeneraba el ranking → vendía posiciones sanas; si `getPrices` fallaba, el rebalanceo quedaba a medias PERO `lastRebalanceTime` se estampaba → 14 días de cartera inconsistente. | Guardas de integridad: aborta el ciclo (con alerta Telegram) si el universo es sospechosamente pequeño o falta el precio de algún símbolo implicado. Nada se persiste en fallo. |
| **Backtest silenciosamente truncado**: un error transitorio a mitad de paginación hacía `break` sin aviso → métricas calculadas sobre datos incompletos. | `fetchHistoricalData` con retry+backoff (honra 429/418/5xx) y **fallo ruidoso** (throw) si la página no se recupera. |

### 🟡 MEDIA
| Hallazgo | Fix |
|---|---|
| Cron lento: dailyBot y longShortBot descargaban **las mismas velas** de la misma cesta, en secuencia (riesgo de timeout serverless con 3 canales). | Descargas **en paralelo** (`Promise.all`) en los 3 bots + **caché de klines** de corta vida en `binanceService` (`{cacheMs}`) → el canal LS reutiliza las velas del diario en la misma invocación (≈mitad de llamadas). |
| Ventana de cierres live (160) ≠ buffer del backtest (210) → el peso de vol-targeting (EWMA) veía series de longitud distinta. | Bots diarios piden `SMA_PERIOD+61` (⇒ 210 cierres tras descartar la vela en formación) = `bufferSize` del motor → paridad exacta. |
| `updatePosition` legacy escribía sin condición (podía pisar un commit concurrente). | Enrutado por `commitSession` condicional. |
| Vulnerabilidades npm: `form-data` (high, CVE de CRLF injection — dependencia de axios) y `tmp` (high). | `npm audit fix` aplicado; quedan 6 moderadas transitivas (`@opentelemetry/core` vía `@netlify/blobs`, fix = downgrade breaking; riesgo práctico bajo, sin exposición a baggage headers entrantes). |

### 🟢 BAJA
| Hallazgo | Fix |
|---|---|
| Webhook sin `TELEGRAM_WEBHOOK_SECRET` queda protegido solo por chat_id (falsificable). | `console.warn` explícito en cada invocación sin secret (los comandos son read-only; configurar el secret sigue recomendado). |
| `--no-costs` (idealizado) no anulaba el funding del corto. | Ahora también fuerza `fundingDailyShort=0` y modo flat. |

## Mejoras evaluadas y RECHAZADAS (con datos)
- **Banda de histéresis SMA** (0.5/1/2% vs 0, 40m long-only): ninguna bate a band=0 en
  ROI/Calmar full (72.1%/0.75 vs 61.6%/0.72 la mejor, band=2); el holdout mejora marginalmente
  (PF 1.55→1.65) pero no compensa resetear la observación shadow live. Coherente con el rechazo
  de la auditoría 2026-06-19 y el "NO hacer" del research §8. **Se mantiene `SMA_HYSTERESIS_BAND = 0`.**
- **Cuantificación del funding flat** (pre-merge, motor sin stops de §9): LS 40m ROI +59.4→+49.0%,
  Calmar 0.67→0.55; walk-forward ROI mediano +14.4→+8.8%, 4/5 folds ROI>0, 5/5 PF≥1 → el lado corto
  sobrevive al carry incluso en el modelo flat conservador (el default productivo es el funding
  REAL firmado de §8, más favorable al corto).

## Estado del riesgo live
Ningún cambio toca posiciones abiertas ni el formato del estado en blobs (solo se añade el etag
en memoria durante la sesión). La ventana 210 cambia marginalmente el peso de vol-targeting de
NUEVAS entradas.

---

## 11. Research de ROI 2026-07-10 (torneo pareado de 3 candidatas)

Investigación online + torneo `abtest.js` (42m, 8 folds, funding real, mismos folds/datos para
todas las variantes) buscando mejorar el ROI sin violar la regla de la casa (gate pareado:
Calmar mediano ≥, IQR ≤, peor fold no peor; meseta, no pico; parámetros fijados a priori).

**Evidencia externa revisada antes de diseñar candidatas:** en cripto neto de costes el momentum
de serie temporal (TSMOM) tiene evidencia fuerte y el cross-sectional débil (Han-Kang-Ryu, SSRN
4675565) → el núcleo SMA del bot está bien elegido y NO se construyó tilt cross-sectional. Las
señales continuas tipo Carver reducen churn/costes vs binarias. Vol-managed (Moreira-Muir) ya
estaba implementado (vol-target). Donchian: ya aplazado (Tier 3 #12).

### Candidatas (implementadas como opciones del motor, off por defecto)
| Candidata | Regla (a priori) | Opción del engine |
|---|---|---|
| GATE | No abrir LARGOS nuevos si BTC < SMA200 diaria (los cortos no se tocan) | `btcGateLong: {smaPeriod}` |
| PYR | Piramidación Turtle en largos: tranche extra al confirmar +10%, máx 2 añadidos | `pyramid: {stepPct, maxAdds}` |
| TILT | Sizing continuo Carver-lite al abrir: z = \|ln(close/SMA)\|/(σ20d·√30), clamp [0.25, 1] | `entryTilt: {horizonDays, floor}` |

### Resultados (holdout por fold, pareado)
**Canal LS (SMA150-LS):**
| Variante | CalmarMed | IQR | Peor | SharpeMed | ROIMed | Veredicto |
|---|---|---|---|---|---|---|
| baseline | 2.37 | 3.48 | −1.89 | 1.04 | 10.0% | — |
| **GATE btc>sma200** | **3.19** | 3.49* | −1.88 | **1.38** | **12.2%** | ✅ (meseta 200/220/250 idénticos; *el "IQR↑" de 0.01 es artefacto float de la tolerancia) |
| PYR 10%×2 | 2.36 | 3.93 | −1.84 | 1.03 | 8.3% | 🔻 Calmar< IQR↑ ROI↓ |
| TILT | 2.43 | 3.91 | −2.04 | 1.11 | 5.8% | 🔻 IQR↑ peor↓ ROI↓↓ |
| PYR+TILT | 2.42 | 3.27 | −1.85 | 1.10 | 8.7% | pasa el gate formal pero ROI med↓ y no replica en long-only → no adoptado |

**Canal long-only (SMA150-1d):** GATE ✅ (Calmar 4.22→4.32, ROI med 16.6→18.3); PYR/TILT 🔻 (Calmar<).

### Anatomía de la mejora del GATE (honesta, fold a fold)
La ganancia se concentra en los **rallies de bear market** (el filtro lento de BTC bloquea los
largos-whipsaw que el SMA150 por-moneda sí toma): en el fold 2026-02→07 (bear actual) el LS pasa
de +8.4% a **+12.2%** y el long-only de −2.4% a **0% (100% cash)**; en el fold choppy 2024 cuesta
~1.6pp; el resto ≈neutral. Mecanismo = dual momentum / switch maestro (investigación §2.2, que ya
lo proponía con evidencia alta y estaba SIN cablear). Meseta verificada con buffer 310: SMA
200/220/250 dan resultados casi idénticos; 180 es inerte (redundante con el SMA150 por-moneda).
⚠️ Caveat estadístico: en long-only el fold en cash (0 trades) queda excluido de la mediana del
resumen (sesgo mecánico a favor); la comparación fold-a-fold económica sigue favoreciendo al gate.

### Adopción (paridad live↔backtest)
`REGIME.btcEnabled = true` (config). Motor: default `btcGateLong` desde `REGIME` (fail-open sin
histórico/BTC). Live: `dailyBot.js` y `longShortBot.js` calculan `btcRegimeOn` con las velas de
BTC ya descargadas y bloquean solo APERTURAS de largos. Tests nuevos en `test/roi-research.test.js`
(54/54 en verde). PYR/TILT quedan como opciones del motor para re-tests futuros.

---

## 12. Auditoría LIVE 2026-07-24 (silencio prolongado → causa raíz + observabilidad)

El usuario reportó "semanas sin una señal". Auditoría de **estado real en producción** (no solo
código): logs del cron en vivo (`netlify logs --source functions`), los 3 blobs de estado
(`bot_state_daily_v1`, `bot_state_ls_v1`, `bot_state_rotation_v1`) descargados con `netlify
blobs:get`, y velas diarias reales de la API pública de Binance (independientes del bot) para
verificar la matemática de régimen sin fiarse solo de releer el código.

### Veredicto: no hay bug en el cron — es un bear market real y severo
- El cron corre cada ~15 min **sin un solo error** en la ventana observada.
- BTC: cierre 65,058 USDC vs SMA150=69,835 y SMA200=72,571 (ambas por debajo). **Drawdown de
  −47.8% desde el ATH** (124,750, 2025-10-06). BTC no cierra por encima de su SMA200 desde el
  **2025-11-02** (~9 meses).
- Los 8 símbolos de `DAILY_BASKET` (BTC/ETH/SOL/XRP/LINK/AVAX/DOT/LTC) están **todos** por debajo
  de su propia SMA150 hoy → no hay nada elegible para largo en ningún canal.
- `bot_state_daily_v1` (long-only) y `bot_state_rotation_v1`: 0 operaciones, 100% cash — es
  exactamente el comportamiento DISEÑADO (preservación de capital), no una falla.
- `bot_state_ls_v1` (long/short): sí está activo — 7 cortos abiertos, reabrió ETH/LINK el
  2026-07-22 (stop ATR-trailing → re-short el mismo día). El canal SILENCIOSO percibido por el
  usuario es en realidad el canal que decidió apagarse hace más tiempo: **V4C-15m, parado a
  propósito el 2026-06-21** (§6) — 5 semanas antes de este reporte, coincide con la queja.
- Causa de la "sensación" de silencio: `shadowTrader.commitSession` solo manda Telegram si hay
  un trade (`shadowTrader.js` L95-101). Sin cruce de régimen no hay mensaje, aunque el bot esté
  vivo y evaluando cada 15 min — indistinguible de un cron caído desde Telegram.

### Anomalía encontrada (sin cerrar): DOTUSDC nunca se ha shorteado en SMA150-LS
Los otros 7 símbolos de la cesta abrieron corto el 2026-07-03 (giro bajista generalizado); DOT
no, ni entonces ni después, pese a que replicar `evaluateStrategySMA200`/`shortEntryAllowed`/
`computeVolTargetWeight` contra velas reales de DOT muestra **todas las condiciones cumplidas
hoy** (señal SELL, `confirmDays=3` satisfecho, tamaño 20%). No se pudo reproducir la causa exacta
sin logs históricos del día del giro (retención de `netlify logs` insuficiente). En vez de
"arreglarlo" a ciegas, se añadió el logging de diagnóstico de abajo — si el gate real sigue
bloqueando a DOT, el próximo ciclo (≤15 min) lo dirá con una línea explícita.

### Mejoras aplicadas
| Cambio | Detalle |
|---|---|
| **Logging de diagnóstico por-símbolo** en `longShortBot.js` | Antes, si una entrada elegible (señal BUY/SELL, en cesta, sin posición) no se abría, no quedaba rastro de por qué. Ahora cada gate (`btcRiskOn`, cooldown, `entryOk`/confirmDays, `frac<=0` de vol-target, `canOpenLive`/cap de exposición) deja una línea propia. Mismo orden de condiciones que antes → **sin cambio de comportamiento**, solo de observabilidad. |
| **`botStatus.js` (nuevo)** | `activeChannels()` + `channelStatusBlock()` extraídos de `telegram-webhook.js` (estaban duplicados de facto en cuanto se necesitó la misma lista en un segundo sitio). Fuente única de qué canales están activos y cómo se resumen; `/status` del webhook ahora lo importa en vez de tener su propia copia. |
| **`heartbeat.js` (nuevo)** | `maybeSendHeartbeat()`, enganchado al final de `trader-cron.js`. Manda un resumen a Telegram (equity/posiciones/trades por canal + estado del gate BTC) **máx. 1×/24h** (throttle vía blob `heartbeat_meta` en el store `shadow_trading_state`), para que un régimen sin cambios no se lea como bot caído. Best-effort: cualquier fallo (Blobs/Telegram/Binance) se traga con `console.error` y NUNCA aborta el ciclo de trading — se ejecuta último, después de los 3 `runX`. |

### Riesgo sobre el estado LIVE
Cero cambios en la lógica de entrada/salida ni en el formato de los blobs; `npm test` sigue en
54/54. El heartbeat es una llamada de solo-lectura (`getStats`/`getOpenPositions`) más una
escritura de 1 campo (`lastSentAt`) en una key nueva — no toca `openPositions`/`tradeHistory` de
ningún canal.

---

## 13. Auditoría LIVE Multi-Canal (2026-08-27)

Auditoría completa de los resultados reales acumulados en **Netlify Blobs** (`bot_state_daily_v1`, `bot_state_ls_v1`, `bot_state_rotation_v1`) y mejoras estructurales de riesgo y reporteador.

### Resultados en Vivo Reales (Corte a 27 de agosto de 2026)

| Canal | Saldo Inicial | Saldo Disponible | Invertido | Valor Mercado | P&L Realizado | P&L Latente | **Equity Total** | **ROI Neto** | Posiciones Abiertas |
|---|---|---|---|---|---|---|---|---|---|
| **📅 SMA150-1d (Long-Only)** | 5.000 $ | 1.801,46 $ | 3.198,54 $ | 3.513,12 $ | 0,00 $ | **+314,58 $** | **5.314,58 $** | <span style="color:green">**+6,29%**</span> | 6 (ETH, SOL, LINK, BTC, XRP, LTC) |
| **🔄 ROT-dual-mom (Rotación)** | 5.000 $ | 0,00 $ | 5.000,00 $ | 5.710,12 $ | 0,00 $ | **+710,12 $** | **5.710,12 $** | <span style="color:green">**+14,20%**</span> | 5 (PUMP, LINK, ETH, ENA, BTC) |
| **↕️ SMA150-LS (Long/Short)** | 5.000 $ | 3.004,32 $ | 1.572,83 $ | 1.775,50 $ | **-422,86 $** | **+202,67 $** | **4.779,82 $** | <span style="color:red">**-4,40%**</span> | 3 (LINK, ETH, SOL) |
| **TOTAL CONSOLIDADO** | 15.000 $ | 4.805,78 $ | 9.771,37 $ | 10.998,74 $ | -422,86 $ | **+1.227,36 $** | **15.804,52 $** | <span style="color:green">**+5,36%** (+804,52 $)</span> | 14 posiciones |

### Diagnóstico de Rendimiento
1. **Canal Rotación (+14,20%)**: El canal más rentable con rebalanceo bi-semanal por ratio retorno/volatilidad 30d y gate BTC. Todas las posiciones (5/5) en ganancia (+29% en ENA, +19,7% en PUMP).
2. **Canal SMA150 Diario (+6,29%)**: 5 de 6 posiciones en ganancia clara con vol-targeting protegiendo capital (~64% invertido, 36% colchón en cash).
3. **Canal SMA150 Long/Short (-4,40%)**: El lado corto sufrió *short squeezes* durante el rally de agosto de 2026 (-422,86 $ realizados). Tras girar a largos, acumula +202,67 $ latentes.

### Mejoras Aplicadas
1. **🛡️ Filtro Macro BTC para Cortos (`longShortBot.js` y `backtestEngine.js`)**: Prohibida la apertura de cortos en altcoins si BTC está en régimen alcista (`BTC > SMA200` o `btcRiskOn = true`). Solo se permiten cortos en régimen bajista confirmado de BTC.
2. **📊 Dashboard Multi-Canal (`shadow-report.js` y `shadow-report.html`)**: Soporte multi-pestaña para los 3 canales y cartera global consolidada.
3. **💬 Comandos Telegram (`/portfolio`, `/rendimiento`)**: Resumen consolidado del patrimonio y desglose por canal en Telegram.
4. **⚙️ Scripts `package.json`**: Sincronización paralela de los 3 blobs en `npm run sync`.
5. **🧪 Tests**: Test suite ampliada a 61 tests unitarios pasando al 100%.


---

## 14. Auditoría + research 2026-08-29 — correcciones aplicadas y torneos pre-registrados

Dos workflows multi-agente (21 + 24 agentes) con verificación adversarial de cada hallazgo y
fact-checking de cada fuente: **36 hallazgos candidatos → 13 confirmados**; **27 propuestas de
research → 2 sólidas**. Todos los hallazgos de severidad alta se re-verificaron ejecutando el
código y recomputando la matemática. Suite: **75 tests en verde** (era 61).

### 14.1 Defectos corregidos

| # | Defecto | Fix | Verificación |
|---|---|---|---|
| **H6** | `isBlacklisted` comparaba por SUBSTRING sin anclar: `'DOTUSDC'.includes('TUSD')` → **DOT llevaba meses sin operarse**; también BNB/APT/ARB/SHIB. La cesta declaraba 8 símbolos y el live operaba 7. | Comparación anclada al **activo base** (`config.js`). Eliminadas las **6 copias duplicadas** del filtro (motor, backtest, walkforward, abtest, sweep, validate) → fuente única. | `DAILY_BASKET` operado 8/8. Backtest regenerado: DOTUSDC aporta 19 trades / +166,42 USDC. **Cierra la anomalía que §12 dejó abierta**: DOT nunca entraba en `monitored`, por eso su logging de diagnóstico no podía disparar. |
| **H2** | El circuit breaker **no medía drawdown**: Σ\|pérdidas\| de los ≤8 últimos cierres dividido por la **CAJA**. Nunca neteaba ganancias, sin ventana temporal, inerte con caja 0, y un predicado `is...Active` **mutaba** el estado. | Reescrito: pico de equity persistido, DD real `(pico−equity)/pico`, **histéresis** al 80 % del umbral, predicado puro separado de la mutación, y **portado al motor** (no existía en backtest). | Sobre el estado live: antes 12,34 % → disparaba; ahora **DD real 4,40 % → el canal LS queda desbloqueado**. Regresiones cubiertas: canal ganador (+1.200, DD 0) ya no se pausa; caja 0 ya no lo desactiva; no hay bucle de re-armado. |
| **A1** | `--partial-r` insertaba cada cierre parcial como trade propio y `computeMetrics` lo contaba. Como el parcial **solo dispara en ganancia**, era un interruptor para **falsificar el win rate**. | Métricas por **POSICIÓN** (`aggregateByPosition`). Eliminado además `pos.atrSL = pos.buyPrice` tras el parcial (truncaba la cola derecha *y* ponía el stop en breakeven). | Criterio pre-registrado: Δ win rate `--partial-r=2` vs sin flag **< 3 pp**. Medido: **0,00 pp** con 16 ejecuciones parciales. Sin el fix habrían sido **+14,96 pp fantasma**. |
| **A5** | `config.VOLTARGET.enabled = false` mientras `computeVolTargetWeight` **ignoraba el flag** y los dos bots diarios lo llamaban: el vol-targeting estaba VIVO y la config decía lo contrario. | La función honra el flag; el default pasa a `true`, que es la verdad. Sin cambio de comportamiento. | — |
| **H7** | El "gate pareado" **no estaba pareado**: `summarize` borraba los folds sin trades, así que una variante que se va a cash perdía el fold malo y mejoraba las tres métricas sin ganar nada. | Los folds sin trades cuentan como `roi 0 / calmar 0` (irse a cash **es** un resultado). El gate exige además **mismo nº de folds evaluados**. | El walk-forward de ROT expone 1 fold flat que antes desaparecía. |
| **H9** | `3.49 <= 3.48 + 0.01` es `false` en coma flotante → variantes suspendidas por un empate exacto. | Comparación a 2 decimales enteros. | — |
| **H8** | El bot entra al cierre de la última vela **cerrada**; si el cron dispara horas después, ese precio está rancio (sesgo medido +0,45 % sobre un presupuesto total de costes del 0,30 %). | `entriesAreFresh` + `ENTRY_FRESHNESS_HOURS = 6`. **Solo veta APERTURAS**; las salidas se gestionan siempre. | Fail-open sin datos. |
| **H3** | El canal ROT aportaba el **88 % del beneficio reportado** y **no tenía backtest**: `grep -rl rotation` sobre el arnés = 0 ficheros. | **`rotationBacktest.js`** (extiende `BacktestEngine` → mismos costes, contabilidad y métricas) + runner `rotation-backtest.js` + `engineClass` en `wfcore`. | Ver 14.3. |
| — | El dashboard perdía la etiqueta EXPERIMENTAL de ROT y sumaba su ROI al titular. `buildTradeStats` contaba los breakeven como pérdidas (`profit <= 0`). | Etiqueta propagada, convención alineada con el motor, y **consolidado con y sin canales experimentales**. | Titular **+5,16 %** → **+0,50 %** excluyendo lo no validado. |

### 14.2 Instrumentación nueva (A2/A4)

`computeMetrics` devuelve ahora **panel por libro** (`books`, `booksSignalOnly` → global/largo/corto)
con win rate, **win rate de BREAKEVEN** `1/(1+payoff)` y el **margen** entre ambos, profit factor,
esperanza, **N efectivo** (fechas de entrada distintas), **intervalo de Wilson** y concentración
top-5/top-10; **`entryInWindow`** (holdout purgado de posiciones entradas en train); y
**`truncation`** (contrafactual de take-profit). El dashboard expone WR de breakeven, margen,
N efectivo y Wilson por canal.

Sobre el backtest regenerado (60m, 8 símbolos, costes 0,30 %):

| libro | n | WR | BE-WR | margen | PF | neto | N_eff |
|---|---|---|---|---|---|---|---|
| global | 196 | 34,18 % | 25,15 % | +9,04 pp | 1,55 | +2.940,52 | 127 |
| **largo** | 87 | **21,84 %** | 11,63 % | **+10,21 pp** | **2,12** | +1.975,78 | 66 |
| **corto** | 109 | **44,04 %** | 38,33 % | **+5,71 pp** | **1,27** | +964,74 | 61 |

**El libro con win rate ALTA es el que menos margen tiene.** Contrafactual: base **+2.940** →
TP 20 % **−651** · TP 30 % +484 · TP 50 % +1.630 · TP 100 % +2.382. Holdout purgado: PF **3,46 → 2,52**.

### 14.3 Primer backtest del canal ROT (H3)

Universo FIJO de 16 large/mid-caps. **Limitación declarada:** no reconstruye el top-N por volumen
point-in-time del live (imposible con la API pública), así que valida las REGLAS, no la selección
de universo.

El motor arranca con `portfolioCircuitBreaker: null` para **paridad**: `rotationBot.js` no tiene
breaker (y el antiguo era además inerte en este canal, porque su guard `equity > 0` sobre la caja lo
desactivaba y ROT opera con caja 0). Simular una guarda que el live no aplica habría inflado el
resultado.

- **Split 70/30, 42m:** full ROI +68,88 % (PF 1,46) pero **holdout ROI −19,32 %, PF 0,95, Calmar −0,76**.
  Benchmark del mismo periodo: **BTC HODL +176,03 %**.
- **Walk-forward 8 folds:** Calmar mediano 1,21 · IQR 2,47 · peor −1,86 · **ROI mediano +2,12 %** ·
  4/7 folds con ROI>0. El fold actual (2026-03→08) da **−4,03 % con PF 0,29**. Un solo fold (+69,58 %)
  domina el resultado.
- **Variante gate BTC diario entre rebalanceos** (el riesgo de cola concreto: hasta 14 días sin
  evaluar ninguna salida): **🔻 RECHAZADA** por el gate — Calmar mediano 1,21 → 0, IQR 2,47 → 2,97.
  Implementada como opción del motor (`rotationDailyRiskOff`), **no cableada en live**.

**Veredicto:** el canal que sostenía el titular tiene evidencia débil y muy dispersa, y no bate al
HODL de BTC en su propia muestra. Sigue en shadow, ahora etiquetado y excluido del titular honesto.

### 14.4 Torneos pre-registrados — resultados

Rejilla declarada ANTES de correr; se archivan TODOS los valores, pasen o no.

**κ — presupuesto del corto (`shortRiskFraction`), en las DOS muestras:**

| κ | USDC Calmar / IQR / peor | USDT Calmar / IQR / peor | Gate |
|---|---|---|---|
| 1,00 (baseline) | 2,67 / 3,41 / −1,44 | 2,46 / 2,78 / −1,70 | — |
| 0,60 | 3,14 / 3,99 / −1,42 | 3,15 / 3,66 / −1,68 | 🔻 IQR↑ |
| 0,40 | **3,61** / 4,31 / −1,41 | **3,63** / 4,78 / −1,66 | 🔻 IQR↑ |
| 0,25 | 3,61 / 4,48 / −1,38 | 3,50 / 4,50 / −1,65 | 🔻 IQR↑ |
| 0,15 | 2,24 / 4,74 / −1,35 | 2,19 / 5,63 / −1,62 | 🔻 Calmar< IQR↑ |
| 0,00 | 2,27 / 6,39 / −1,64 | 2,25 / 6,67 / −1,64 | 🔻 |

**TODAS rechazadas, en AMBAS muestras** (veredicto coincidente → criterio de doble muestra
satisfecho). Patrón consistente y monótono: menos corto ⇒ **mejor Calmar mediano**, **mejor peor
fold**, **mayor dispersión** y **menor ROI mediano** (USDC 10,67 → 7,11). `shortRiskFraction`
queda en **1,0**.

**Condición de falsación declarada de antemano:** se predijo que κ=0,25 *subiría* `worstCalmar` y
*bajaría* `medianCalmar`. Lo primero se cumple en ambas muestras; **lo segundo NO** — el Calmar
mediano SUBE. La predicción queda falsada a medias y así se reporta.

**Donchian de horizonte lento solo en largos:** 🔻 RECHAZADO. `medianCalmar` 2,27 → 2,87 (60d) →
3,14 (90d) → **−0,37 (150d)**: **no hay meseta, hay un acantilado**, y el peor fold empeora en los
tres. Pero su efecto sobre el win rate es real y monótono (canal long-only, 42m, holdout 30 %):

| variante | n | WR | BE-WR | margen | PF | ROI | esperanza/trade |
|---|---|---|---|---|---|---|---|
| baseline | 89 | 19,10 % | 9,21 % | +9,89 | 2,33 | **+76,43 %** | 36,64 |
| Donchian 60d | 33 | 30,30 % | 13,95 % | +16,35 | 2,68 | +51,00 % | 62,72 |
| Donchian 90d | 24 | 41,67 % | 19,28 % | +22,39 | 2,99 | +43,62 % | 79,92 |
| Donchian 150d | 19 | **47,37 %** | 22,73 % | +24,64 | **3,06** | +30,90 % | **85,83** |

El win rate se **más que duplica** (19 % → 47 %) y la esperanza por trade también (36,64 → 85,83),
pero el ROI total **cae un 60 %** porque toma 4× menos operaciones. Ésa es, medida sobre los datos
del propio bot, la respuesta completa a "subir el win rate".

**Base de dimensionamiento (H1):** 🔻 RECHAZADA. `sizeBasis:'equity'` mejora mucho la dispersión
(IQR 3,41 → 2,22) y el peor fold (−1,44 → −1,05) pero baja el Calmar mediano (2,68 → 2,01). Y un
**test de sensibilidad al ORDEN del array** (6 permutaciones fijadas a priori) **falsó la hipótesis
del fix**:

| base | rango de Calmar mediano solo por reordenar símbolos | dispersión |
|---|---|---|
| `cash` (actual) | 2,07 – 2,84 | **0,77** |
| `equity` | 0,83 – 2,06 | **1,23** ← *peor* |

Con base `equity` y 20 % por posición, las 5 primeras agotan el equity y el resto no entra: el
orden pasa de repartir capital en escalera a **decidir quién opera**. `SIZING_BASIS` queda en
`'cash'`. **Meta-hallazgo, más importante que el fix:** el baseline arrastra **0,77 de Calmar de
ruido puro por el orden del array** — margen comparable al de adopciones históricas (el gate BTC se
adoptó con +0,82). Varias decisiones pasadas están **dentro de la banda de ruido**. El arreglo real
es asignación **pro-rata en lote** entre todas las señales del día, no secuencial; es un cambio de
diseño que necesita su propia validación y queda propuesto, no improvisado.

**Circuit breaker de cartera:** 🔻 RECHAZADO al medirlo por primera vez — Calmar mediano 2,74 → 2,68
y ROI mediano 10,93 → 10,72, con IQR y peor fold idénticos. Dispara 11 veces en 60 meses. Se
mantiene activo por prudencia (ahora **sí** mide drawdown de verdad y está en el motor), pero
**no tiene evidencia de aportar valor** y es candidato a desactivar.

### 14.5 Qué NO se cambió, y por qué

Ninguna regla de trading se ha modificado. **Cero adopciones**: los cinco torneos rechazaron sus
variantes bajo el gate de la casa. Lo aplicado son **correcciones de defectos** (blacklist, circuit
breaker, contabilidad, frescura, gate pareado, coma flotante) e **instrumentación**. El único cambio
de comportamiento en vivo es consecuencia de los fixes: DOT vuelve a la cesta (8/8 símbolos), el
canal LS deja de estar bloqueado por un breaker mal medido, y no se abren posiciones con velas
rancias.

### 14.6 Herramientas nuevas

- **`rotationBacktest.js`** — motor de backtest del canal de rotación (heredaba de `BacktestEngine`).
- **`rotation-backtest.js`** — runner (`--wf` para walk-forward, `--daily-riskoff`, `--cash-buffer=`).
- **`abtest.js --tournament=`** — torneos parametrizados (`kappa`, `sizing`, `donchian`,
  `circuitbreaker`, `partial`), con baseline explícito (antes el baseline heredaba `btcGateLong` de
  `REGIME` y un torneo sobre el gate **se comparaba consigo mismo**) y salida por muestra/variante.
- **`wfcore.runWalkForward({engineClass})`** — permite validar canales con motor propio por el mismo
  walk-forward pareado.
- Exports de contabilidad honesta en `backtestEngine.js`: `aggregateByPosition`, `bookMetrics`,
  `wilsonInterval`, `truncationCounterfactual`.

---

## 15. El gate de adopción no podía sostener sus decisiones — `robustgate.js` (2026-08-29)

Los cinco torneos de §14.4 rechazaron TODAS sus variantes. Antes de aceptar ese "no", había que
comprobar si el problema eran las variantes o **el procedimiento de decisión**. Era el procedimiento.

### El diagnóstico

`abtest.js` compara **tres estadísticos puntuales** (Calmar mediano, IQR, peor fold) de **una sola
ejecución** por variante. Con esta muestra eso no distingue señal de ruido:

- Reordenar el array de símbolos —sin tocar nada más— mueve el Calmar mediano del baseline
  **0,48-0,77**. El **gate maestro BTC, hoy en producción, se adoptó con un margen de +0,82**.
- Con 7 folds, el **IQR** es un estadístico de cola sobre ~7 puntos: el más inestable de los tres,
  y el que más veces suspendió variantes (fue el único motivo de rechazo de κ en §14.4).

### El arnés nuevo

`robustgate.js` cambia cuatro cosas: corre cada variante bajo **K permutaciones del orden de
símbolos** (el ruido entra en la medición en vez de contaminarla en silencio); parea variante y
baseline en el **mismo (permutación, fold)**; aplica **bootstrap por CLÚSTER DE FOLD** —remuestrea
folds enteros, porque las permutaciones de un mismo fold comparten datos y no son independientes—;
y adopta por **P(mejora media > 0) ≥ 0,80 Y peor fold no peor**. El IQR se reporta pero **ya no veta**.

Validado antes de usarlo, contra casos de respuesta conocida: mejora consistente en 7 folds → P=1,00;
**un solo fold enorme con la MISMA media → P=0,65** (el gate viejo lo habría adoptado); ruido puro →
P=0,48. Esa segunda fila es justo la discriminación que faltaba. PRNG determinista con semilla:
los resultados son reproducibles y auditables.

### Qué cambió el veredicto sobre κ

| κ | Calmar mediano | **Δ media pareada** | **IC 95 %** | **P(Δ>0)** |
|---|---|---|---|---|
| USDC 0,40 | 2,45 → **3,75** | **+0,06** | [−1,48, +1,37] | 0,56 |
| USDT 0,40 | 2,46 → **3,87** | **−0,06** | [−1,48, +1,05] | 0,48 |

**La mejora del Calmar mediano era un artefacto de forma de distribución.** Fold a fold y pareado,
la mejora media es CERO, con un intervalo que cruza el origen de lado a lado. El gate viejo
rechazaba κ por la razón equivocada (IQR); ahora hay evidencia positiva de que **κ no aporta nada**,
y el intervalo lo cuantifica. `shortRiskFraction` sigue en 1,0, ahora con fundamento.

El IC se ensancha monótonamente al recortar el corto ([−0,50, +0,71] en κ=0,60 → [−4,39, +3,53] en
κ=0,00): menos corto = más incertidumbre, no más robustez.

### Modo de sizing `equalN` (nuevo)

`sizeBasis: 'equalN'` reparte `(caja+invertido)/plazas` — el patrón que `rotationBot.js` ya usaba
(`equity/topN`) y el único de los tres modos genuinamente independiente del orden, porque todas las
plazas reciben lo mismo y la suma nunca agota la caja. (`'equity'` con el 20 % fijo NO lo arregla:
las 5 primeras agotan el equity y el orden pasa de repartir capital a decidir **quién opera**.)

### `equalN` bajo el gate robusto (8 permutaciones, ambas muestras)

| variante | Δ USDC | Δ USDT | peor fold USDC | peor fold USDT | ruido-orden USDC | ruido-orden USDT |
|---|---|---|---|---|---|---|
| baseline `cash` | — | — | −1,66 | −1,77 | **1,03** | **0,86** |
| **EQUAL-N 6 plazas** | −0,13 [−0,40, +0,09] | +0,12 [−0,18, +0,35] | **−1,57** | **−1,61** | **0,01** | **0,62** |
| EQUAL-N (equity/8) | −0,14 [−0,29, −0,01] | +0,01 [−0,17, +0,25] | −1,74 | −1,74 | 0,59 | 0,48 |
| EQUITY basis (20 %) | −0,26 | −0,22 | −1,78 | −1,80 | 0,54 | 1,08 |

`EQUAL-N 6 plazas` es la única variante de TODOS los torneos que, en las **dos** muestras: deja el
Calmar estadísticamente indistinguible del baseline (el signo del delta se invierte entre muestras),
**mejora el peor fold**, y **reduce el ruido por orden**. Aun así **NO se adopta**: P = 0,15 (USDC) y
0,79 (USDT), por debajo del 0,80 pre-registrado.

Y una cautela sobre nuestro propio dato: con 5 permutaciones el ruido-orden de esta variante salió
0,010 en USDC; con 8, el mismo estadístico da 0,62 en USDT. **El rango sobre pocas permutaciones es
él mismo ruidoso** — no debe leerse como "elimina la dependencia del orden", solo como "la reduce".

**Nota de método, para no moverse la portería:** el criterio P≥0,80 detecta MEJORAS. `equalN` no es
una mejora de retorno, es una **de-riskificación**: quita un parámetro oculto (el orden del array)
al coste de cero Calmar medible. Juzgarla con un criterio de no-inferioridad daría otro veredicto,
pero ese criterio no estaba pre-registrado y **no se inventa a posteriori**. Queda implementada
(`sizeBasis:'equalN'`, `positionSlots`), apagada, y la decisión es del dueño del capital.

### 🔴 El gate maestro BTC — un parámetro EN PRODUCCIÓN — no sobrevive

`REGIME.btcEnabled = true` está vivo desde 2026-07-10, adoptado con "Calmar mediano 2,37 → 3,19"
(+0,82 en UNA ejecución). Sometido al gate robusto, 8 permutaciones, ambas muestras:

| muestra | Calmar mediano sin gate → con gate | **Δ media pareada** | **IC 95 %** | **P(Δ>0)** |
|---|---|---|---|---|
| USDC | 2,98 → 2,36 | **−0,46** | [−1,34, +0,20] | **0,117** |
| USDT | 2,99 → 2,27 | **−0,05** | [−1,89, +1,66] | **0,476** |

**El signo se ha invertido respecto a su adopción.** Lo que se midió como +0,82 de mejora es −0,46
y −0,05 al parear fold a fold sobre varias ordenaciones. Los IC cruzan el cero, así que **no** se
puede afirmar que el gate haga daño; lo que sí queda establecido es que **no hay ninguna evidencia
de que ayude**, y que su adopción original descansaba en un margen indistinguible del ruido de
reordenar un array (0,43-0,67 en estas mismas corridas).

**Y la dirección inversa, para no quedarse con la lectura que conviene.** Si el baseline es la
PRODUCCIÓN ACTUAL (gate ON) y la variante es quitarlo:

| muestra | Δ de QUITAR el gate | IC 95 % | P(Δ>0) | peor fold | veredicto |
|---|---|---|---|---|---|
| USDC | +0,46 | [−0,20, +1,34] | **0,883** ✅ | −1,66 → **−1,80** ❌ | 🔻 peor fold |
| USDT | +0,05 | [−1,66, +1,89] | 0,524 ❌ | −1,77 → −1,78 | 🔻 P<0,80 |

**Quitarlo tampoco pasa el gate.** En USDC supera el umbral de probabilidad pero empeora el peor
fold; en USDT es neutro. La conclusión simétrica y honesta es que **esta muestra no puede resolver
el efecto del gate BTC**: no hay evidencia de que ayude ni de que quitarlo ayude. Se **mantiene
activo** (el peor fold es algo mejor con él, lo que encaja con su papel de protección de cola),
pero **deja de estar "validado"**: su ficha en §11 debe leerse como una adopción no respaldada.

Este es el hallazgo más incómodo de la auditoría: no es una propuesta rechazada, es **una decisión
ya tomada y corriendo en vivo** cuya justificación no sobrevive al instrumento correcto.

### Lo que este arnés NO cambia

Sigue sin haber adopciones. Pero ahora los rechazos son afirmaciones medidas ("la mejora media es
cero, IC [−1,48, +1,37]") en vez de comparaciones de estadísticos puntuales dentro de la banda de
ruido. **Regla nueva de la casa: ninguna adopción futura es válida si no supera el gate en varias
permutaciones del orden de símbolos.** Un margen inferior a ~0,8 de Calmar en una sola ejecución
es indistinguible de reordenar un array.

---

## 16. MODO SEÑAL — de simulador de cartera a generador de señales (2026-08-29)

Cambio pedido por el usuario: **poner los tres canales a cero y quitar el límite de 5.000 USDC para
que simplemente den señales.**

### Por qué era el cambio correcto

El capital acotado no solo limitaba: **contaminaba la medición**. Con `positionSizePct` sobre la
caja remanente, el bot (a) **dejaba de registrar señales válidas** al quedarse sin efectivo, y
(b) las que registraba recibían tamaños en escalera geométrica según el **orden del array**
(1.000 vs 266 USDC entre la primera y la séptima del 24-jul). Las dos cosas ensucian justo lo que
se quiere saber: cuántas señales aciertan y cuánto rinde cada una. Es también, de raíz, el mismo
problema que §15 midió como 0,48-1,03 de Calmar de ruido puro.

### Qué cambia

`SIGNAL_MODE` en `config.js` (`enabled: true`, `notionalPerSignal: 1000`):

| | Antes (cartera) | Ahora (señal) |
|---|---|---|
| Tamaño | `caja · 20 %` → escalera geométrica | **nocional fijo**, todas las señales pesan igual |
| Sin caja | la señal se **descartaba en silencio** | se registra siempre |
| Guardas de CARTERA (circuit breaker, `maxExposurePct`, `maxConcurrentPositions`) | bloqueaban entradas | **inertes** (el breaker se sigue evaluando y se **loguea** como informativo) |
| Guardas de ESTRATEGIA (régimen BTC, `confirmDays`, cooldowns, crash guard, frescura) | activas | **activas** — forman parte de la señal, no de la cartera |
| Vol-targeting | dimensionaba | no dimensiona (es una decisión de cartera) |
| `balanceUSDC` | caja disponible | **acumulador**; puede ser negativo = más señales de las que el nominal permitiría |

La aritmética de equity sigue cuadrando: `equity = saldo + valor de mercado = nominal + realizado +
latente`. Lo que deja de tener sentido es el **ROI sobre el saldo inicial** (crece con el nº de
señales abiertas, no con la calidad). El reporteador añade por canal: `signalsOpen`,
`signalsClosed`, `deployedCapital`, **`returnOnDeployed`** (el denominador honesto) y
**`avgPctPerTrade`**.

### Separación deliberada: el motor NO entra en modo señal por defecto

`--signal` es **opt-in** en `backtest.js`. Con capital ilimitado no hay drawdown ni Calmar, así que
el gate de adopción (`abtest.js`, `robustgate.js`) **debe seguir corriendo en modo CARTERA**. Son
dos preguntas distintas y ambas legítimas: *"¿acierta la señal?"* (modo señal, métricas por
operación) y *"¿qué le pasa a una cartera que la sigue?"* (modo cartera, Calmar y drawdown).

Medido con `node backtest.js --sma200 --months=42 --signal` (canal largo, costes 0,30 %):

| | valor |
|---|---|
| Señales | 79 (21 aciertos / 58 fallos) |
| Win rate | **26,58 %** |
| Profit factor | **1,97** |
| Esperanza | **+47,83 USDC por señal** (+4,78 % sobre el nocional) |
| Avg win / avg loss | +365,01 / −67,01 → **payoff 5,45:1** |
| Holdout (23 señales) | WR 47,83 %, PF 1,60 |

Éste es el perfil real del canal: **acierta 1 de cada 4, y cada acierto vale 5,45 fallos.**

### Reset

Los cinco blobs borrados (`bot_state_daily_v1`, `bot_state_ls_v1`, `bot_state_rotation_v1`,
`heartbeat_meta` y el huérfano `bot_state_v2` del V4C parado). Store vacío, verificado. El estado
anterior queda archivado en **`state-archive/`** — incluidas las 7 únicas operaciones cerradas que
ha tenido el bot (−422,86 USDC realizados), por si hay que volver a ellas.

Tests: **81 en verde** (eran 61 al empezar la auditoría).

---

## 17. Stop de catástrofe del LARGO — torneo pre-registrado (2026-09-05)

### Origen

Revisión operativa: las 17 posiciones abiertas de los tres canales llevaban 3-7 días sin cerrarse.
**No era un fallo.** Los tres canales abren con `regimeMode: true` / `exitMode: 'signal'`, donde la
única salida es el cruce de la SMA150 (banda 0,75 %). Verificado contra mercado el 2026-09-05: las
17 daban señal `BUY` con márgenes de +4,3 % a +111,6 % sobre su umbral de venta. El heartbeat
(`2026-09-05T11:00Z`) y las entradas a `00:00:4x` confirman que el cron y la guarda de frescura
funcionan. Lo que sí quedaba establecido es que **el recorrido pico→SMA no está acotado**: SOL
entró a 105,63 con la SMA150 en 81,17 — un 30 % de margen por debajo antes de que la señal corte.

### Hipótesis y rejilla (declaradas ANTES de correr)

Simétrica a la del corto, que sí se adoptó (§L162) por pérdida no acotada. Predicción registrada:
*mejora `worstFold`, Δ media ≈ 0 y por tanto P < 0,80 → no adoptable*. Rejilla: 15/20/25/30 %,
cooldown 5 d (igual que el corto). Implementado en `backtestEngine.js` como `longStopPct` /
`longStopCooldown`, **default 0** — el baseline es provablemente idéntico (86/86 tests en verde
antes y después). Cooldown en mapa DEDICADO (`longCooldowns`): reutilizar `cooldowns` habría hecho
que un stop de corto bloquease también la entrada larga, y la variante dejaría de ser un solo cambio.

### Resultado — gate robusto, 8 permutaciones, semilla 42, 42 m / 8 folds

| variante | canal LS: Δ media / IC / P | canal long-only: Δ media / IC / P |
|---|---|---|
| LONGSTOP 30 % | +0,00 [0,00, 0,00] · 0,000 | +0,00 [0,00, 0,00] · 0,000 |
| LONGSTOP 25 % | +0,00 [0,00, 0,00] · 0,000 | +0,00 [0,00, 0,00] · 0,000 |
| LONGSTOP 20 % | +0,00 [0,00, 0,00] · 0,000 | +0,00 [0,00, 0,00] · 0,000 |
| LONGSTOP 15 % | +0,00 [0,00, 0,01] · 0,653 | +0,01 [0,00, 0,02] · 0,653 |

**🔻 RECHAZADO en los cuatro niveles y en los dos canales.** Ruido por orden del array: 1,18 (LS) y
0,07 (long-only) de Calmar mediano — el efecto medido está uno o dos órdenes de magnitud por debajo.

### Por qué: el stop es INERTE, no perjudicial

Conteo directo de salidas sobre 42 m × 8 símbolos (canal LS), que es el dato que explica la tabla:

| longStopPct | trades | STOP_LOSS | de los cuales, del largo |
|---|---|---|---|
| off (baseline) | 182 | 2 | 0 (los 2 son del corto) |
| 15 % | 181 | 4 | **2** |
| 20 % | 182 | 3 | **1** |
| 25 % | 182 | 3 | **1** |

El stop del largo dispara **1-2 veces en 42 meses**. La razón es estructural: para perder 20 % desde
la entrada, el precio casi siempre tiene que cruzar antes por debajo de una SMA de 150 días que en
el momento de entrar estaba cerca — y entonces sale por `SIGNAL`, no por stop. Solo escapa a esa
regla la entrada que ocurre muy por encima de la SMA (el caso SOL de arriba: reentrada tardía tras
un bloqueo del gate BTC), y es rara.

**Conclusión para el dueño del capital:** "los largos no llevan stop" es cierto y suena mal, pero
ponerlo no cambia nada medible — la salida de régimen ya llega primero en ~99 % de los casos. El
riesgo real de este diseño no es la ausencia de stop, es el **lag de la propia SMA150**, y eso no lo
arregla un backstop: lo arreglaría una salida más rápida, que es un cambio de estrategia distinto y
con su propia carga de la prueba.

Queda implementado y **apagado**, como `rotationDailyRiskOff`: el valor es el número medido, no la
opción. Ninguna regla de trading modificada. Tests: **90 en verde** (4 nuevos cubren el stop del largo).

---

## 18. Investigación de estrategias nuevas — y el gate resulta depender del universo (2026-09-05)

Encargo: buscar estrategias nuevas de señal para el bot. Dos candidatas medidas bajo el gate
robusto (8 permutaciones, semilla 42, 42 m / 8 folds, canal diario long-only). **Cero adopciones**,
y por el camino un hallazgo de método que afecta a TODAS las decisiones anteriores.

### 18.1 `MACRO_OSC` (V7) — estaba implementada y NUNCA medida

Presente desde el commit `abfa3691` en `indicators.js`, `backtestEngine.js` (case `MACRO_OSC`) y
`backtest.js` (`--v7`), con 82 líneas de test. **No aparecía en esta auditoría ni tenía resultados
archivados.** En `dailyBot.js:4` está importada pero **no se usa** — import muerto; la señal viva
sigue siendo `evaluateStrategySMA200`. Candidata legítima porque su salida `isPurpleTakeProfit`
corta por sobreextensión del oscilador, muy por delante del cruce de la SMA150 (la debilidad §17).

Rejilla pre-registrada con control de meseta sobre `purpleZoneThreshold` (22/28/34) y **mismo
`bufferSize`/`minCandles` en todas las variantes**, baseline incluida: con arranques distintos la
comparación mediría fechas de inicio, no estrategias.

| variante | Δ media large-caps USDC | Δ media large-caps USDT |
|---|---|---|
| MACRO_OSC p28 (default) | −0,39 [−1,27, +0,36] · P 0,19 | −1,43 [−3,82, +0,27] · P 0,08 |
| MACRO_OSC p22 | +0,56 [−0,73, +1,97] · P 0,77 | −1,24 [−3,60, +0,59] · P 0,13 |
| MACRO_OSC p34 | −0,11 [−1,16, +0,92] · P 0,44 | −1,12 [−3,49, +0,68] · P 0,18 |

**🔻 RECHAZADA**, veredicto coincidente, y el peor fold empeora en las seis celdas. Sin meseta: los
deltas van −0,39 → +0,56 → −0,11 al mover el umbral, que es ruido, no estructura.

**Aviso de lectura, idéntico al caso κ de §15:** el Calmar MEDIANO *sube* en las tres variantes
(2,95 → 3,05/3,05/3,11 en USDC; 1,27 → 2,18/2,17 en USDT) mientras la Δ pareada es negativa. Quien
mire solo la mediana adoptaría una estrategia que, fold a fold, pierde.

**Qué es en realidad** (walk-forward directo, USDC large-caps):

| | trades | ROI por fold |
|---|---|---|
| baseline SMA150 | 107 | 0 · 0 · 2,2 · **63,4** · −2,9 · −20,2 · 8,6 |
| MACRO_OSC p28 | **27** | 0 · 0 · 0 · **40,4** · +16,5 · −15,7 · 1,4 |

Opera **4× menos**, cede 23 puntos del mejor fold (la cola derecha) y mejora los dos malos. Es
**protección de drawdown, no alfa** — la misma firma que Donchian en §14.4 (WR 19→47 %, ROI −60 %).
La predicción pre-registrada ("ROI baja") se cumple en suma (51,1 → 42,6); sobre la MEDIANA no es
evaluable: vale 0 en ambas por los folds planos. Se reporta así, sin redondear a favor.

### 18.2 Salida asimétrica (SMA rápida) — el experimento que descompone el lag

`evaluateStrategySMA200` usaba UN solo periodo para entrar y salir. Se añade `exitSmaPeriod`
(default `undefined` = comportamiento histórico exacto, 90/90 tests en verde): la SMA lenta decide
SI se puede estar largo, una rápida decide CUÁNDO salir; se reentra al recuperar la rápida, para no
pagar un round-trip cada dip. Es la prueba limpia de la hipótesis del lag: **solo cambia la salida.**

| variante | large-caps USDC | large-caps USDT |
|---|---|---|
| SALIDA SMA100 | −0,19 [−0,89, +0,55] · P 0,30 | −0,16 [−0,75, +0,52] · P 0,30 |
| SALIDA SMA75 | **−0,57 [−0,88, −0,25]** · P 0,00 | **−0,28 [−0,55, −0,05]** · P 0,01 |
| SALIDA SMA50 | −0,07 [−0,36, +0,26] · P 0,33 | −0,04 [−0,31, +0,24] · P 0,36 |

**🔻 RECHAZADA.** En SMA75 el IC queda **enteramente por debajo de cero en las dos muestras**: no es
"ausencia de mejora", es **evidencia positiva de daño**. Y el peor fold empeora siempre
(−1,71 → −1,84/−2,31/−2,31).

**Predicción propia falsada, y así se reporta.** Se predijo "mejor peor-fold, más turnover". El
turnover NO se dispara (117 → 111 → 125 trades) y el peor fold mejora en **ROI** (−20,2 → −16,4)
pero empeora en **Calmar**, que es la métrica del gate: se pierde menos, por un camino de drawdown
peor. El ROI total cae 46,1 → 28,2 (SMA100) y 33,7 (SMA50).

**Respuesta a la pregunta abierta de §17:** en la cesta de producción, acelerar la salida no ayuda.
El lag de la SMA150 no es un coste recuperable por este camino.

### 18.3 🔴 El veredicto se INVIERTE al cambiar el universo

Mismo torneo, mismo gate, mismas permutaciones y mismo periodo, sobre 8 large-caps distintas
(BNB, ATOM, UNI, FIL, AAVE, ETC, NEAR, APT):

| variante | large-caps (producción) | universo disjunto |
|---|---|---|
| SALIDA SMA100 | −0,19 · P 0,30 · 🔻 | **+1,02 [+0,12, +2,13] · P 1,000 · ✅** |
| SALIDA SMA75 | −0,57 · P 0,00 · 🔻 | **+0,83 [−0,18, +2,05] · P 0,927 · ✅** |
| SALIDA SMA50 | −0,07 · P 0,33 · 🔻 | **+0,28 [−0,23, +0,93] · P 0,804 · ✅** |

Las tres **suspenden** en la cesta de producción y las tres **aprueban** —una con P = 1,000— en un
universo disjunto. No se adopta nada: **un efecto que cambia de signo con el universo no generaliza**,
y la cesta que opera el bot es la primera. Puede ser economía real (las mid-caps revierten más
bruscamente y salir antes compensa) o selección de universo; con 8 símbolos y series más cortas
(APT/NEAR) esta muestra no lo distingue. Lo que sí queda establecido es la **fragilidad del gate**.

### 18.4 El "criterio de doble muestra" no son dos muestras

Las dos muestras de la casa son las mismas monedas cotizadas en otra stablecoin. Medido:

| par | correlación de retornos diarios (n=399) |
|---|---|
| BTCUSDC vs BTCUSDT | **0,99995** |
| ETHUSDC vs ETHUSDT | **0,99998** |
| SOLUSDC vs SOLUSDT | **0,99997** |

Por eso el peor fold sale **idéntico a dos decimales** entre "ambas muestras" en varios torneos.
El criterio USDC/USDT es una comprobación de ruido de divisa y de vendedor de datos, **no una
réplica independiente**. No invalida los rechazos pasados (rechazar en muestras correlacionadas
sigue siendo rechazar), pero sí significa que **cualquier adopción futura justificada por "pasó en
las dos muestras" descansaría de hecho sobre una sola** — y §18.3 muestra que es justo ahí donde el
veredicto se da la vuelta.

**Propuesta de regla (no aplicada por mi cuenta):** exigir para adoptar un universo genuinamente
disjunto, no USDC/USDT. Es un endurecimiento del gate, y cambiar el criterio de adopción es
decisión del dueño del capital.

### 18.5 Defecto corregido — pérdida silenciosa de resultados

El nombre del fichero de salida de `robustgate.js` solo miraba la divisa del primer símbolo, así
que **dos universos distintos en la misma divisa escribían el MISMO fichero** y el segundo borraba
al primero sin avisar. Se detectó en caliente: la corrida de §18.3 sobrescribió el resultado de
large-caps. Corregido con una huella determinista del universo (`-u<hash>`) y `--tag=`; el archivo
destruido se regeneró. Afectaba a la reproducibilidad del archivo de auditoría, no a las cifras.

### 18.6 Qué NO se cambió

Ninguna regla de trading. `MACRO_OSC` sigue sin cablear (y su import muerto en `dailyBot.js` queda
señalado); `exitSmaPeriod` queda implementado y **apagado**, como `longStopPct` y
`rotationDailyRiskOff`: el valor entregado es el número medido, no la opción. Tests: **93 en verde** (3 nuevos cubren la salida asimétrica).

---

## 19. `/cerrar` — cierre discrecional desde Telegram (2026-09-05)

Primer comando del webhook que **muta estado** (los demás eran de consulta). Petición del dueño:
poder cerrar posiciones a mano, como haría operando de verdad.

**Decisión de contabilidad (la que importa), refinada tras la objeción del dueño:** la primera
versión metía `MANUAL_CLOSE` en `ADMIN_REASONS`, junto a `MANUAL_CLEANUP`. Era demasiado tosco y la
objeción es correcta: **la entrada SÍ la generó el bot**; lo que no es del bot es la salida. Un
cierre manual no es una no-señal, es una **señal TRUNCADA**. Ahora hay tres categorías:

| categoría | quién decide entrada / salida | ¿cuenta en `winRate`/PF? | ¿acredita al bot? |
|---|---|---|---|
| **Señal completa** (`SIGNAL`, `TAKE_PROFIT`, `STOP_LOSS`, `TRAILING_STOP`) | bot / bot | **Sí** — es el único material del perfil honesto | sí |
| **Truncada** (`MANUAL_CLOSE`) | **bot** / dueño | **No** | **Sí**, en su propio cajón |
| **Administrativa** (`MANUAL_CLEANUP`, `END_OF_BACKTEST`) | — / mantenimiento | No | No |

`getStats` expone `truncatedTrades`, `truncatedWins`, `truncatedWinRate`, `truncatedPnLUSDC` y
`botEntriesClosed` (= completas + truncadas), y `/status` las muestra en su propia línea. Así el
trabajo de generación de señal queda **registrado y visible** sin contaminar el win rate con una
decisión humana — descartarlo habría borrado trabajo real del bot; mezclarlo habría inflado la
métrica que el MODO SEÑAL (§16) existe para medir (WR 26,58 %, payoff 5,45:1).

**Lo que se pierde igualmente, y conviene no olvidar:** de una señal truncada se sabe lo que rindió
hasta el cierre, pero **nunca** qué habría rendido la salida de la estrategia. El repo ya midió esa
asimetría por el lado del backtest (`truncationCounterfactual`, §14.6): cortar ganadores sale caro.
Una cartera con muchas truncadas tiene un `winRate` estadísticamente más pobre, no por peor
estrategia sino por menor muestra.

**Salvaguardas:** confirmación explícita obligatoria (`/cerrar SOL si`) — sin ella solo hay vista
previa con el P&L de cada posición; el inventario (`/cerrar` a secas) no toca nada; y la escritura
usa el patrón de sesión, cuyo commit condicional (`onlyIfMatch`) hace que un choque con el cron
falle en vez de pisarlo, avisando al usuario de que reintente. Alcance = `activeChannels()`.

Tests: **96 en verde** (3 fijan los invariantes: el cierre manual mueve la caja, se registra como truncada, y NO se confunde con una limpieza administrativa).

---

## 20. Auditoría del algoritmo 2026-09-29 — producción ≠ lo que mide el gate

Encargo: auditar el algoritmo y buscar mejoras. Se leyó el camino vivo completo (`trader-cron` →
`dailyBot`/`longShortBot`/`rotationBot` → `shadowTrader`) contra el motor y el arnés de adopción,
y cada sospecha se midió con datos antes de reportarla. **Ninguna regla de trading ni `config.js`
se ha modificado**: lo aplicado son opciones del motor apagadas por defecto, un torneo nuevo y
3 tests. Tests: **99 en verde**.

### 20.1 🔴 Tres reglas vivas nunca pasaron por el gate — y una estaba rechazada

| regla en producción | entró en | ¿torneo? |
|---|---|---|
| `SMA_HYSTERESIS_BAND = 0.0075` | `815364c6` (24-jul, commit de circuit breaker) | **No.** §10 la había **rechazado** y dejado en 0 |
| Crash guard BTC −12 %/3 d | `815364c6` | No |
| Gate BTC sobre **cortos** (`shortAllowedByBtc`) | `7a22be78` (27-ago, commit de dashboard, §13) | No — reacción a los squeezes de agosto |

Además `wfcore.lsBaseEngineOpts` fija **`band: 0`** (`backtest.js`, `walkforward.js` y
`validate.js` sí usan la banda de config). **Todos los torneos de `abtest.js`/`robustgate.js`
desde el 24-jul han medido una estrategia que no es la que opera.** Y `shortAllowedByBtc` colgaba
de `btcGateLong`: el torneo `btcgate_off` de §15 quitaba **dos** reglas a la vez.

### 20.2 Torneo `unvalidated` — baseline = PRODUCCIÓN REAL, una regla por variante

Gate robusto, 8 permutaciones, semilla 42, 42 m / 8 folds, funding real. Rejilla y predicción
registradas en `robustgate.js` antes de correr. Universo disjunto = §18.3 **+ BTCUSDC** (sin BTC el
gate BTC es fail-open y las variantes serían inertes).

| variante | LS large-caps | LS universo disjunto | long-only large-caps |
|---|---|---|---|
| **SIN banda (band 0)** | +0,15 [−0,03, +0,48] · P 0,79 | **+0,08 [−0,01, +0,20] · P 0,94 ✅** | **+0,30 [−0,01, +0,76] · P 0,96 ✅** |
| SIN crash guard | −0,01 · P 0,00 | −0,05 · P 0,31 · peor↓ | 0,00 (inerte) |
| SIN gate BTC cortos | −0,02 [−0,47, +0,40] · P 0,48 | −0,22 [−0,75, +0,21] · P 0,20 · peor↓ | 0,00 (control ✔) |
| CHANDELIER FLAT | **−1,40 [−3,58, −0,00] · P 0,02** | −0,10 · P 0,45 | 0,00 (control ✔) |
| SIN chandelier | −0,86 [−2,05, +0,10] · P 0,05 | −0,08 · P 0,37 · peor↓ | 0,00 (control ✔) |

Ruido por orden del array en el baseline: 0,91 (LS) · 0,21 (disjunto) · 0,02 (long-only).

**Lectura:**
- **La banda de 0,75 % resta en las tres muestras** (mismo signo en un universo genuinamente
  disjunto, que es la réplica que §18.4 pedía) y quitarla pasa el gate en 2 de 3. Coincide con el
  rechazo original de §10. **Recomendación: volver a `SMA_HYSTERESIS_BAND = 0`.**
- **Crash guard y gate de cortos:** sin evidencia de que aporten, pero quitarlos empeora el peor
  fold en el universo disjunto. Se pueden mantener: dejan de estar "sin medir" y pasan a "medidos,
  neutros o con algo de protección de cola".
- **Mi hipótesis sobre el Chandelier queda FALSADA.** Predije que el re-short inmediato era un
  defecto; FLAT es peor (IC casi entero bajo cero) y quitar el Chandelier también. En el motor, el
  valor del Chandelier viene *con* la reentrada al día siguiente. Pero ver 20.3.
- **El universo disjunto rinde Calmar mediano −0,15** frente a 2,27 en la cesta de producción. El
  edge del canal LS está muy concentrado en las 8 large-caps elegidas. Es selección de universo o
  economía real, y esta muestra no lo distingue.

### 20.3 🔴 Paridad rota: el live re-entra en la MISMA vela; el motor, en la siguiente

Tras un `TRAILING_STOP`/`STOP_LOSS` el motor hace `continue` y el símbolo no vuelve a operar hasta
la vela siguiente. El live corre cada 15 min sobre la **misma** vela cerrada, así que el ciclo
siguiente reabre al **mismo precio**. Verificado en el estado real archivado (20-ago-2026): ETH y
SOL se cubrieron por Chandelier a las 00:00:27 y se abrieron **largos a las 00:15:07 a 2251,72 y
85,34, el precio exacto de salida**; §12 ya lo había visto ("stop ATR-trailing → re-short el mismo
día") sin reconocerlo como divergencia. En el backtest (`signal-backtest-ls.json`) **38 de 65**
Chandelier re-shortean a la vela siguiente.

El beneficio medido en 20.2 corresponde a "salir y quedarse fuera un día". Lo que corre en vivo es
"salir y volver a entrar al mismo precio": **un round-trip sin efecto, que ningún backtest ha
medido**. **Recomendación:** en `longShortBot.js`, guardar la vela de la última salida por
stop/trail y no abrir nada en ese símbolo mientras `candleTime` no la supere.

### 20.4 🟡 El gate de promoción a capital real no tiene potencia

Bootstrap sobre los trades de los backtests en modo señal (`signal-backtest-*.json`):

| trades cerrados | P(PF>1) con el edge del backtest | P(PF>1) con edge **cero** |
|---|---|---|
| 8 (el gate actual) | 0,52 (LO) · 0,55 (LS) | 0,32 · 0,37 |
| 30 | 0,68 · 0,67 | 0,39 · 0,39 |
| 60 | 0,79 · 0,76 | 0,43 · 0,44 |

Con WR ~22 % y payoff ~5:1, **8 trades es tirar una moneda**, y al ritmo del canal diario (~1,7
cierres/mes) 60 trades son ~3 años. El shadow no puede validar el edge en un plazo razonable; sí
puede validar la **ejecución**. **Recomendación:** que el gate de promoción sea de *paridad*
(re-ejecutar el motor sobre el periodo live y exigir que cada señal live tenga su gemela en el
motor el mismo día, a precio comparable) y que el juicio sobre el edge descanse en el walk-forward.

### 20.5 🟢 Hallazgos menores

- **Mensajes de Telegram del corto** dicen "sin TP/SL fijo", pero existen el Chandelier (3·ATR) y
  el stop del 25 %. El dueño opera a mano con esos mensajes: debería recibir los niveles.
- **Funding del corto:** el ledger live cobra el flat 0,03 %/día y el motor usa por defecto la
  serie real, así que el P&L de cortos del live no es comparable con el backtest.
- **Orden de eventos del motor:** con el mismo timestamp los símbolos se procesan en orden del
  array y el gate BTC lee el buffer de BTC en ese momento. Los símbolos anteriores a BTC ven el
  cierre de **ayer** (el live ve el de hoy). Es una fuente más del "ruido por orden" de §15.
  Arreglo: empujar primero todas las velas de un timestamp y evaluar después.
- **Calmar recortado a ±10** en `wfcore`: el fold 2 satura en todas las variantes y nunca aporta
  información al delta pareado.

### 20.6 Aplicado en este commit (sin cambio de comportamiento en vivo)

- `backtestEngine.js`: `shortTrailReentry` (`'immediate'` por defecto | `'flat'`) y `shortBtcGate`
  (`true` por defecto) para aislar la regla del corto del gate de largos.
- `robustgate.js`: torneo `unvalidated` con baseline = producción real (`PROD_REGIME`).
- Resultados archivados: `robustgate-unvalidated-usdc.json`, `-usdc-uyhd2tp.json`,
  `-usdc-longonly.json`.
- 3 tests nuevos en `test/longshort.test.js`.

**Estado de las cuatro decisiones:** las cuatro se aplicaron después, a petición del dueño — ver §20.7.

### 20.7 Aplicado a petición del dueño ("aplica todo", 2026-09-29) — SÍ cambia el comportamiento en vivo

| # | Cambio | Dónde |
|---|---|---|
| 1 | **`SMA_HYSTERESIS_BAND` 0,0075 → 0** | `config.js`. Las posiciones abiertas cambian de comportamiento: un largo con cierre entre `SMA·(1−0,75 %)` y la SMA ahora sale, antes esperaba |
| 2 | **Guarda de misma vela** tras stop/trail: no se reabre el símbolo hasta la vela siguiente | `longShortBot.js` + `indicators.exitedOnSameCandle`; estado persistido en `state.lastExitCandle` |
| 3 | **Un único perfil de producción**: `lsBaseEngineOpts` lee la banda de config; 3 tests fallan si el arnés y los bots divergen | `wfcore.js`, `test/parity_profile.test.js` |
| 4 | **Gate de promoción por paridad** | `parity.js` (puro) + `parity-check.js` (`npm run parity -- --state=sync_ls.json`) + 6 tests |
| 5 | Funding **real** al cubrir un corto en el ledger (fallback al plano si falla la API) | `longShortBot.coverShort` → `applySell(..., {fundingCostUSDC})` |
| 6 | Mensaje Telegram del corto con **stop duro y Chandelier reales** (nivel inicial ≈ entrada + 3·ATR14) | `shadowTrader.applyShort` |
| 7 | **Orden de eventos del motor**: se ingieren todas las velas de un timestamp antes de decidir | `backtestEngine.js`. Cambia el backtest de referencia |
| 8 | Pares con Calmar saturado en ±10 en baseline **y** variante se excluyen del bootstrap (`--keep-saturated` para restaurar) | `robustgate.js`, `wfcore.CALMAR_CLIP` |

Tests: **112 en verde** (eran 96 al empezar la auditoría). El test de orden de eventos se comprobó
contra el motor original: falla (`1 !== 0`) sin el arreglo y pasa con él.

**Lo que NO se tocó:** `/cerrar` (webhook) sigue cubriendo cortos con el funding plano; el
`dashboard-data.js` devenga el funding plano en la valoración de cortos abiertos.

#### Resultado del torneo con el motor corregido (baseline = producción real, banda 0)

Gate robusto, 8 permutaciones, semilla 42, 42 m / 8 folds. Δ de Calmar pareado [IC 95 %] · P(Δ>0):

| variante | LS large-caps | LS universo disjunto | long-only large-caps |
|---|---|---|---|
| CON banda 0,75 % (la anterior) | −0,22 [−0,66, +0,04] · 0,14 | −0,10 [−0,23, +0,00] · 0,03 | −0,34 [−0,86, +0,01] · 0,04 |
| SIN crash guard | −0,14 · 0,00 | −0,08 · 0,33 · peor↓ | 0,00 (inerte) |
| SIN gate BTC cortos | −0,30 [−0,73, +0,15] · 0,09 | −0,30 [−0,87, +0,21] · 0,14 · peor↓ | 0,00 (control ✔) |
| CHANDELIER FLAT | −1,40 [−3,95, −0,03] · 0,02 | −0,47 · 0,44 | 0,00 (control ✔) |
| SIN chandelier | −1,21 [−2,31, −0,11] · 0,00 | +0,36 [−0,79, +2,11] · 0,64 · peor↓ | 0,00 (control ✔) |

**Confirma lo decidido:** la banda antigua resta en las tres muestras (signo idéntico, incluido el
universo disjunto), así que volver a 0 es correcto. Crash guard y gate de cortos se mantienen. La
hipótesis "el re-short inmediato es un defecto" sigue falsada en el motor.

**Ruido por orden — NO puedo afirmar que mejorase.** Baseline LS large-caps: 0,91 → **2,26**
(disjunto 0,21 → 0,10; long-only 0,02 → 0,00). Las 8 permutaciones dan lo mismo en todos los folds
salvo el 4 (Calmar 2,7–5,0); la mediana de 7 valores recoge justo ese fold. Es la escalera
geométrica del sizing `cash` (H1), que no se ha tocado, y con este estadístico un cambio de banda
basta para mover qué fold es la mediana. El arreglo del orden de eventos es correcto por
construcción, pero **no hay evidencia de que reduzca el ruido medido**; la fuente dominante sigue
siendo el sizing (`equalN`, no adoptado, §15).

#### Primera prueba real del gate de paridad — estado live archivado (24-jul → 29-ago, banda 0,75 %)

`node parity-check.js --state=state-archive/sync_ls_2026-08-29.json --band=0.75` → ❌ **DIVERGENCIA**, y
las dos causas son defectos ya conocidos:

| hallazgo | causa |
|---|---|
| **SOL: live 85,34 vs motor 87,64 (−2,62 %)**; LINK y ETH casan al 0,00 % | El live reabrió SOL en la misma vela del trail; el motor, a la siguiente (§20.3). **Corregido por la guarda #2** |
| **3 señales del motor que el live se saltó** (BTC y XRP largos 20-ago, LTC 21-ago) | El estado tiene `circuitBreakerPausedUntil = 2026-08-30`: el breaker antiguo (mal medido, §14 H2: 14,07 % de "drawdown" falso sobre la caja) bloqueó las aperturas 10 días. **Corregido en §14 y inerte en modo señal** |

Ninguna de las dos habría saltado con un gate de "≥8 cierres con PF>1"; el de paridad las encuentra
en segundos. **Limitación:** solo 3 entradas comparables (las 7 cortas son del ciclo de arranque, que
se excluye a propósito) y 0 salidas comparables, así que esto prueba que la herramienta funciona y
detecta, no que el live actual tenga paridad. Hace falta volver a pasarla con estado live nuevo
(`npm run sync` y `npm run parity -- --state=sync_ls.json`); los blobs se resetearon el 29-ago.

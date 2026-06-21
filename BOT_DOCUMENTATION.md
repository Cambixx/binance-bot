# Documentación Técnica: Binance Trading Bot (Shadow Mode Serverless)

## 1. Visión General del Proyecto
Este proyecto es un bot de trading automatizado diseñado para operar en Binance. Actualmente, se encuentra configurado en **Shadow Mode** (Modo Simulador), lo que le permite analizar el mercado, detectar señales de compra/venta y registrar un historial de operaciones usando un saldo virtual (5000 USDC), sin arriesgar capital real.

**Arquitectura principal:**
El bot está construido en Node.js y diseñado para ejecutarse como una **función Serverless** en **Netlify**. Se ejecuta automáticamente cada 15 minutos mediante un Cron Job (`trader-cron.js`).

**Canales shadow en paralelo:** el cron corre carteras virtuales INDEPENDIENTES para comparar enfoques con datos reales:
- **📅 SMA150-1d** (`dailyBot.js` → blob `bot_state_daily_v1`): regime-timer DIARIO LONG-ONLY (estilo Faber). In-or-out: invertido si cierre diario > SMA150, **cash** si no. SMA **150**, **cesta fija de large-caps** (`DAILY_BASKET`), **vol-targeting por-canal**. La familia validada (§1.2). Idempotente intra-día.
- **↕️ SMA150-LS** (`longShortBot.js` → blob `bot_state_ls_v1`): **LONG/SHORT always-in** (reconvierte el hueco del parado V4C-15m, 2026-06-21). Misma señal SMA150 pero en bajista abre **CORTO** en vez de ir a cash; flip en el cruce. Kill-switch `LONGSHORT_ENABLED=false`. ⚠️ El lado corto NO está validado a largo plazo (ver §1.3).
- **🔄 ROT-dual-mom** (`rotationBot.js` → blob `bot_state_rotation_v1`): **EXPERIMENTAL**, rotación cross-sectional + dual-momentum. Opt-in `ROTATION_ENABLED=true`.
- **⏹️ V4C-15m** (`bot.js` → blob `bot_state_v2`): **PARADO (2026-06-21)** — sin edge neto de costes. `bot.js` se conserva como referencia pero ya NO se ejecuta; su blob queda congelado.

`/status` en Telegram muestra los canales activos lado a lado.

> **🔎 Auditoría LIVE 2026-06-19** (multi-agente, con backtests + verificación adversarial OOS): tras observar los 3 canales varios días. **SMA150-1d** (antes SMA200) mejora el riesgo-ajustado fuera de muestra: **Calmar 0.31→0.61, MaxDD −35.9%→−27.9%, holdout PF 0.80→1.55** (36m, cesta fija, costes 0.30%). **V4C-15m** deprecado a observación (sin edge). **ROT** confirmado (cash = gates funcionando). ⚠️ **Honestidad:** el holdout ROI del diario SIGUE siendo negativo (≈−13.5%) — el objetivo es **preservación de capital / mejor Calmar**, NO batir a BTC. El "positivo" live del diario es P&L **no realizado** (n=1 cerrado). **Gate de promoción a real:** ≥6-8 trades CERRADOS con PF>1; reportar siempre `realizedPnLUSDC`, nunca `totalProfitUSDC`.

> **🔎 Auditoría 2026-06-14:** auditoría profunda multi-agente (35 hallazgos verificados adversarialmente) + investigación cost-aware, con todas las correcciones y mejoras aplicadas. Ver **`AUDIT_REPORT.md`**. Cambios clave: paridad live↔backtest del trailing garantizada por `exits.js` (fuente única), MaxDrawdown medido por-vela, Sharpe/Sortino/Calmar computados de verdad, benchmark BTC HODL, lectura/escritura transaccional del estado, retry/backoff de la API, validación rigurosa (walk-forward / Monte Carlo / Deflated Sharpe / PBO) y suite de tests (`npm test`).

### 1.1 Enfoque del proyecto — leer antes de "optimizar"
Un barrido riguroso de 12 meses **con costes reales (0.30% round-trip)** sobre 19+ configuraciones (V3, V4C, V5, V6; 15m y 1h; ver `sweep.js`) demostró que **ninguna familia de TA intradía tiene un edge que sobreviva a los costes fuera de muestra** (todas con Profit Factor < 1.0 en el periodo completo). El alfa de análisis técnico retail en cripto líquido intradía neto de costes es prácticamente nulo.

**El bot 15m (V4C-COMBO) NO es una máquina de alfa**: es un generador de señales disciplinado con reporting honesto. No perseguir alfa afinando indicadores en 15m.

### 1.2 ✅ Familia DIARIA validada (2026-05-30) — el enfoque que SÍ funciona
Tras investigación online consciente de costes, se implementaron estrategias **diarias de baja frecuencia** (`evaluateStrategySMA200` / `evaluateStrategySupertrendDaily` / `evaluateStrategyDonchian`). Backtest 36 meses, 7 large-caps, costes 0.30%, OOS, **comparado contra buy&hold del mismo periodo** (no contra cash):

| Estrategia | Full ROI | Full MaxDD | Calmar | Holdout (= crash, HODL −44%/DD−64%) |
|---|---|---|---|---|
| **SMA200 diaria** | **+22.5%** (HODL +19.1%) | **−34.9%** (HODL −59.4%) | **0.64** (HODL 0.32) | −5.5%, DD −25.6% |
| Donchian 55/20 + regime | +6.3% | −27.5% | 0.23 | −0.3%, DD −12.6% (la más defensiva) |
| SuperTrend diario + regime | +13.6% | −30.9% | 0.44 | −2.8%, DD −20.4% |

**Hallazgo clave:** la familia diaria **sobrevive a los costes** (baja frecuencia) y **mejora el retorno-ajustado-a-riesgo vs buy&hold**: SMA200 bate a HODL equiponderado en retorno y recorta mucho el drawdown.

> ⚠️ **Actualización honesta (auditoría 2026-06-14):** el Sharpe/Calmar antes citados (Calmar 0.64) **nunca se computaban en el motor** — eran estimaciones. Ahora el motor los calcula de verdad (`computeRiskAdjusted`). Cifra real SMA200 diaria (40 meses, cesta fija large-caps, costes 0.30%, MaxDD medido **por-vela**): **ROI +28.7% vs HODL equiponderado −5.3%; MaxDD −35.9% vs HODL −63.9%; Calmar 0.31; Sharpe 0.34.** (BTC-solo HODL hizo +110% a DD −51% — en mercados monedireccionales alcistas HODL de BTC gana; el valor de la SMA200 es la **preservación de capital en bajistas**.)
>
> El `walkforward.js` añadido confirma el matiz: la SMA200 es **inconsistente fold-a-fold en retorno** pero preserva capital en crashes (p.ej. fold 2025-11→2026-06: 0% en cash mientras HODL hizo −44.9%). Correr `npm run walkforward -- --sma200` y `npm run validate -- --sma200 --permute` para el dato vigente.

> **NO es alfa, es reducción de drawdown / preservación de capital** — el objetivo realista y honesto. La decisión de qué canal llevar a real debe basarse en la comparación shadow OOS de los canales (`/status`), no en backtests in-sample.

### 1.3 ↕️ Canal LONG/SHORT (SMA150-LS) — 2026-06-21
Reconvierte el hueco del parado V4C-15m. Misma señal de régimen SMA150 que el canal diario, pero
"always-in": en bajista abre **CORTO** en vez de ir a cash (flip largo↔corto en el cruce). El usuario
opera a mano (corto y largo); el bot le da la señal de lado.

**Validación (walk-forward 40m, cesta fija, costes 0.30%, 6 folds), long/short vs long-only:**

| | Long/short (LS) | Long-only (1d) |
|---|---|---|
| ROI mediano por fold | **+14.4%** | +0.8% |
| Sharpe mediano | **1.06** | 0.02 |
| Folds ROI>0 | **4/5** | 3/5 |
| Folds PF≥1 | **5/5** | 4/5 |
| Fold del crash (HODL −45%) | **+14.3%** (cortos) | −2.4% |
| Full 40m | ROI +59%, Calmar 0.67, MaxDD −26% | ROI +49%, Calmar 0.61, MaxDD −28% |

> **Hallazgo (honesto):** en esta muestra el long/short batió al long-only de forma consistente entre
> regímenes, sobre todo capturando el bajista reciente con los cortos. **PERO** es ~1 ciclo de mercado,
> perfil trend-following (win-rate ~20%, rachas largas de pérdidas pequeñas), y cripto tiene sesgo
> alcista de fondo → la rentabilidad futura del lado corto NO está garantizada. Además, en real un
> corto tiene fricciones extra (borrow/funding) no modeladas. Por eso corre en **SHADOW** para
> observar; ejecución manual. Mismo gate de promoción (§1.2): ≥6-8 cierres con PF>1 antes de fiarse.

---

## 2. Estrategia de Trading (Evolución V1 → V4C-COMBO)

El bot utiliza actualmente la **Estrategia V4C-COMBO** (V3 + filtros de régimen de mercado), validada mediante backtesting con división out-of-sample y comparación contra V1, V2, V3 y dos variantes alternativas (V4-A Supertrend, V4-B ATR-exits).

### 2.1 Lógica de Entrada (V4C-COMBO)
La entrada combina **5 confirmaciones técnicas heredadas de V3** + **2 filtros de régimen** nuevos: 

#### Confirmaciones heredadas de V3
*   **Temporalidad:** 15 minutos (`15m`).
*   **Filtro de Tendencia (ADX):** Solo opera si el **ADX > 25**. Evita mercados laterales o ruidosos. *(Subido de 20 → 25 el 18/05/2026 tras auditoría V3.)*
*   **Cruce de Medias (EMA 12/26):** Cruce alcista confirmado durante 2 velas consecutivas para evitar "falsos cruces".
*   **Filtro de Precio (EMA 50):** El precio debe estar por encima de la EMA 50 para confirmar tendencia alcista saludable.
*   **RSI (Relative Strength Index):** RSI en zona de momentum saludable (**40 - 65**).
*   **Filtro de Volumen (MFI):** Money Flow Index **> 40** para confirmar presión compradora real.

#### Filtros de régimen V4-C (añadidos 21/05/2026)
*   **Choppiness Index (CHOP < 50):** Mide qué tan "ordenado" está el movimiento del precio frente a su rango. CHOP alto = lateral; CHOP bajo = tendencia clara. Bloquea entradas durante mercados sin dirección incluso si el ADX está alto. *(Indicador complementario al ADX: el ADX mide la magnitud, CHOP mide la estructura.)*
*   **Bollinger Band Width percentil > 20 (rolling 100):** Mide la volatilidad relativa del momento. Si la BBW está en el percentil más bajo de las últimas 100 velas (mercado dormido), bloquea la entrada — los breakouts en baja volatilidad suelen ser falsos.

> **Filosofía V4-C:** V3 detectaba bien la dirección pero entraba también en regímenes donde ningún momentum-system funciona. Los filtros CHOP + BBW actúan como "guardianes de régimen".

### 2.2 Gestión de Riesgo Dinámica (Trailing Stop)
*   **Stop Loss (SL):** -3.0% *(Ampliado de 2.5% → 3.0% el 18/05/2026 tras detectar ~0.5pp de slippage adverso en ejecución real del SL).*
*   **Trailing Stop Activation:** Se activa al alcanzar un **+1.5%** de beneficio. *(Optimizado el 13/05/2026 — antes 1.0%, causaba activaciones prematuras.)*
*   **Trailing Distance:** Protege el **45% del beneficio máximo** alcanzado. *(Revertido a 45% el 21/05/2026 — los nuevos filtros de régimen V4-C compensan el riesgo de proteger más, y el resultado es mejor WR y mejor Profit Factor en holdout.)*
*   **Take Profit (TP):** +5.0% (salida de emergencia por beneficio rápido).
*   **RSI Exit:** Si el RSI supera **80** (sobrecompra extrema), el bot cierra preventivamente.
*   **Cooldown post-SL:** Tras un Stop Loss, el símbolo queda en cooldown durante 12 velas (3h) para evitar re-entradas inmediatas.

### 2.3 Blacklist de Activos
Los siguientes activos están excluidos del escaneo:
*   **Stablecoins/Fiat:** LUNC, USD1, FDUSD, TUSD, DAI, EUR, GBP, BUSD, USDP, USTC, TST.
*   **Bajo rendimiento V3 (añadidos 13/05/2026):** TAO, ZEC, PEPE, ADA, INJ. 75-100% tasa de pérdidas en shadow trading; TAO acumuló -$34.95 en 4 trades (50% de las pérdidas totales).
*   **Añadido 18/05/2026 tras auditoría:** **DOGE**. En backtest de 12 meses acumuló -61.1% sobre la moneda en 114 trades.
*   **Añadido 21/05/2026 tras backtest V4C-COMBO:** **BCH**. Pérdidas consistentes en 3 y 6 meses (-63 a -95 USDC, WR 33-40%) en todas las variantes probadas.

### 2.4 Resultados de Backtest V4C-COMBO — con costes reales (HONESTO)

> ⚠️ **Importante (auditoría 2026-05-29):** las cifras anteriores se calcularon SIN comisiones ni slippage y sobreestimaban el edge. El motor ahora **netea costes** (0.30% round-trip por defecto, ver §2.6). Estos son los números honestos.

Impacto de los costes (V4C-COMBO, 3 meses, 7 monedas):

| Métrica | Sin costes (idealizado) | **Con costes (0.30% RT)** |
|---|---|---|
| ROI Full | 5.94% | **2.25%** |
| Win Rate | 79.22% | **72.73%** |
| Profit Factor | 1.75 | **1.26** |
| Expectancy | +$3.86/trade | **+$1.46/trade** |
| **Holdout PF (OOS)** | — | **0.93** ❌ |
| **Holdout ROI (OOS)** | — | **−0.25%** ❌ |

> **Veredicto honesto:** V4C-COMBO tiene un edge fino que apenas sobrevive a los costes in-sample y es **ligeramente negativo out-of-sample**. NO es una estrategia ganadora demostrada tras costes. El siguiente objetivo del proyecto es encontrar/diseñar una estrategia cuyo edge sobreviva el 0.30% round-trip TAMBIÉN fuera de muestra. (Las cifras dependen del periodo y universo; correr `npm run backtest` para el dato vigente.)

### 2.5 Variantes descartadas durante la investigación
*   **V4-A (Supertrend + Chandelier ATR):** ROI 4.15%, WR 34%, PF 1.12 → 450 trades, demasiado ruidoso en 15m crypto. La literatura cita Supertrend para timeframes 1h+. Implementación conservada en `indicators.js` para referencia.
*   **V4-B (V3 entries + ATR exits):** ROI -0.21%, WR 29%, PF 0.98 → SL 2×ATR y trailing Chandelier 3×ATR son multiplicadores demasiado apretados para 15m altcoins; los stop-hunts se llevan los trades antes de moverse. Implementación conservada para experimentación.
*   **V5 (trend-rider baja frecuencia) — FALLIDA:** la idea (operar poco, dejar correr tendencias) era buena, pero la implementación basada en "reclaim de EMA" resultó un generador de whipsaw (hasta 560 trades en 12m, PF 0.42-0.65, holdout ROI −26 a −29%). Conservada en `indicators.js` como `evaluateStrategyV5` documentada como experimento fallido. Un verdadero trend-rider pertenece a timeframe diario (Donchian), no a 15m.
*   **V6 (Adaptive SuperTrend — port del indicador "Self-Aware Trend System" de TradingView) — FALLIDA:** SuperTrend con ancho de banda modulado por un Trend Quality Index (ER de Kaufman + volumen + estructura + momento), ATR ponderado por eficiencia y bandas asimétricas. La promesa era reducir el whipsaw del SuperTrend simple (V4-A), pero hizo lo CONTRARIO: las bandas adaptativas (≈1.5×ATR efectivo + ATR reducido en ruido) flipean aún más → **3.700+ trades en 12m, full PF 0.48, holdout ROI −75%, MaxDD 99%**. Probada incluso con el suavizado de multiplicadores que el autor recomienda; sin cambio. El "character-flip" estrella del indicador está inerte por defecto (`close < source` con source=close). Lección: los dashboards de TradingView impresionan porque NO descuentan costes; nuestro backtest con 0.30% lo desenmascara en minutos. Conservada como `evaluateStrategyV6`.

### 2.6 Modelo de Costes (fees + slippage)
Tanto el backtest (`backtestEngine.js`) como el ledger live (`shadowTrader.js`) aplican costes realistas en cada operación, definidos en `config.js` (`COSTS`):
*   **Comisión (fee):** 0.10% por lado (taker spot de Binance).
*   **Slippage:** 0.05% por lado (estimado para altcoins en 15m).
*   **Round-trip total:** ≈ **0.30%** por operación completa.

Mecánica: en la COMPRA el slippage empeora el precio de llenado y la comisión reduce la cripto recibida; en la VENTA el slippage empeora el precio y la comisión reduce el retorno. Así un trade que entra y sale al mismo precio de mercado pierde exactamente el round-trip. Esto es **imprescindible**: sin costes el backtest sobreestima el edge (un backtest de 12 meses pasó de +8.17% a −7.61% al añadir costes — el signo se invierte).

Para comparar con/sin costes:
```bash
node backtest.js --v4c                # con costes (honesto, default)
node backtest.js --v4c --no-costs     # idealizado (sin fees)
node backtest.js --v4c --fee=0.075 --slippage=0.03   # costes custom (% por lado)
```

---

## 3. Sistema de Backtesting

El proyecto cuenta con un motor de simulación profesional (`backtestEngine.js`) con:
*   Descarga paginada de datos históricos de Binance.
*   División temporal **train/holdout** (default 70/30) con veredicto OOS automático.
*   Modo de salida configurable: `fixed` (TP/SL/trail %) o `atr` (Chandelier + SL en múltiplos de ATR + opcional toma parcial).
*   Filtros de régimen parametrizables vía CLI.

### 3.1 ⭐ Comandos que SÍ usas hoy (canales en producción)

En Mac, el backtest **abre solo** el reporte HTML al terminar (salvo `--no-open`).

```bash
# === Canal LONG/SHORT (SMA150-LS) — el nuevo, abre el HTML al terminar ===
node backtest.js --sma200 --longshort --months=40

# === Canal LONG-ONLY (SMA150-1d) — el validado ===
node backtest.js --sma200 --months=40

# Re-abrir el último reporte sin recalcular
open backtest-report-output.html

# Validación rigurosa del canal (sin red para los tests; los runners sí descargan datos)
npm test                                       # 37 tests (incluye cortos y motor long/short)
npm run walkforward -- --sma200 --longshort    # robustez fold-by-fold (long/short)
npm run walkforward -- --sma200                # robustez fold-by-fold (long-only)
npm run validate   -- --sma200 --permute=200   # bootstrap CI + Deflated Sharpe + Monte Carlo
node sweep.js                                   # barrido de hipótesis + DSR + PBO
```

> El default `--sma200` usa periodo SMA de `config.SMA_PERIOD` (150), la **cesta fija de large-caps**
> y **vol-targeting ON** → reproduce EXACTAMENTE los canales live. `--longshort` añade la pata corta.

### 3.2 Flags principales
| Flag | Default | Descripción |
|---|---|---|
| `--sma200` | — | Selecciona la estrategia de régimen SMA (periodo = `config.SMA_PERIOD`). |
| `--longshort` | off | Always-in: en bajista abre **CORTO** en vez de ir a cash. |
| `--no-voltarget` | (vol-target ON) | Desactiva el vol-targeting del canal SMA. |
| `--months=N` | `3` (SMA: 36) | Meses de historia a simular. |
| `--symbols=A,B,..` | cesta fija large-caps | Universo explícito. |
| `--universe=N` | — | ⚠️ Top-N dinámico de HOY (sesgo de supervivencia; etiquetado en el reporte). |
| `--band=N` | `0` | Banda de histéresis SMA en % (ej. `--band=1`). |
| `--sma=N` | `config.SMA_PERIOD` | Periodo SMA explícito. |
| `--oos-split=R` | `0.7` | Ratio train/holdout. |
| `--fee=N` / `--slippage=N` | config | Costes por lado (%). `--no-costs` los anula (idealizado). |
| `--output=FILE` | `backtest-results.json` | JSON de salida. |
| `--no-open` | off | No abrir el HTML al terminar (scripts/CI). |

*(Siguen disponibles las variantes legacy `--v1/--v2/--v3/--v4a/--v4b/--v4c`, `--donchian`, `--stday`, y los flags de modo `atr` `--tp/--sl/--trail-act/--trail-dist/--atr-sl/--atr-trail/--partial-r` para experimentación; ver `backtest.js`.)*

### 3.3 Reporte Visual enriquecido (`backtest-report-output.html`)
Al abrirlo en el navegador verás:
*   **KPIs riesgo-ajustados:** ROI, **Sharpe, Sortino, Calmar**, ret./vol anualizados, Profit Factor (∞ si no hay pérdidas), Max Drawdown, Win Rate, Expectancy.
*   **Equity Curve** con el **HODL equiponderado superpuesto** (línea punteada gris) y una **línea vertical** que marca el inicio del holdout OOS.
*   **Benchmarks** lado a lado: estrategia vs HODL equiponderado vs **BTC HODL** (ROI + MaxDD, con indicador ✅/🔻 de si los bate).
*   **Tabla OOS** train vs holdout (Trades, WR, PF, ROI, Sharpe, MaxDD) + veredicto automático.
*   **Desglose Long / Short** (trades, WR y P&L por lado) cuando es `--longshort`.
*   Drawdown, donut de motivos de cierre, rendimiento por moneda, e historial completo de operaciones con su **lado** (LONG/SHORT).
*   Procedencia: costes round-trip, fecha de fin de datos, ratio del split.

### 3.4 Veredicto OOS automático (consola + HTML)
*   🔴 PF < 1 en alguna fase → no rentable.
*   🟡 PF cae > 25% en holdout → posible overfit.
*   🟡 WR cae > 15pp relativo en holdout.
*   ✅ Si ninguna alarma se dispara: "Estrategia robusta".

### 3.5 Validación rigurosa (anti-overfitting)
*   **`npm run walkforward`** — ventana anclada expansiva; reporta la **distribución** de ROI/Sharpe/PF/MaxDD por fold (no un único número) y un veredicto de robustez entre regímenes.
*   **`npm run validate`** — bootstrap de trades (IC del ROI, prob. de pérdida), **Deflated Sharpe** (corrige multiple-testing) y **Monte Carlo de permutación** (`--permute=N`, p-value vs azar).
*   **`node sweep.js`** — barrido de hipótesis con costes + OOS + **Deflated Sharpe y PBO/CSCV** (probabilidad de overfitting).

---

## 4. Estructura de Módulos

*   **`config.js`:** ⭐ Configuración CENTRALIZADA (fuente única): blacklist, `RISK` (incl. caps de cartera), `COSTS`, `STRATEGY_OPTS`, `LOOKBACK_15M`, `SMA_HYSTERESIS_BAND`, `VOLTARGET`, `REGIME` (gate BTC), `ROTATION`. Importado por todo para paridad total.
*   **`indicators.js`:** Estrategias y primitivas.
    *   Estrategias: V1-V6, familia diaria (`evaluateStrategySMA200` con banda, `evaluateStrategySupertrendDaily`, `evaluateStrategyDonchian`).
    *   Helpers: `calculateEMA/RSI/ATR/Supertrend/ChoppinessIndex/BBW`.
    *   Primitivas de cartera (nuevas): `computeVolTargetWeight`, `periodsPerYearFor`, `trailingReturn`, `btcRegimeOn`, `computeRotationTargets`.
*   **`exits.js`:** ⭐ `evaluateFixedExit(pos, price, params)` — lógica de salida TP/SL/Trailing **compartida por el motor y el bot live** (garantiza paridad por construcción; fix auditoría #2).
*   **`backtestEngine.js`:** Motor. Descarga paginada, cronología unificada, dispatcher por versión, exits `fixed`/`atr`/`signal`, split train/holdout, MaxDD **por-vela**, métricas riesgo-ajustadas (Sharpe/Sortino/Calmar), benchmarks (cesta equiponderada + BTC HODL), vol-targeting opcional y caps. Exporta `STRATEGY_NAMES`/`strategyName`.
*   **`backtest.js`:** Runner de consola (flags CLI, JSON, HTML).
*   **`bot.js`:** Canal 15m (V4C-COMBO) — **PARADO**, conservado como referencia. Transaccional, salidas vía `exits.js`.
*   **`dailyBot.js`:** Canal diario SMA150 LONG-ONLY. Transaccional, idempotente intra-día, vol-targeting, alerta de fallo.
*   **`longShortBot.js`:** Canal SMA150 LONG/SHORT always-in (`longShortTrader`, blob `bot_state_ls_v1`). Flip largo↔corto en el cruce de la SMA; `LONGSHORT_ENABLED=false` lo apaga. Ver §1.3.
*   **`rotationBot.js`:** Canal de rotación cross-sectional + dual-momentum (experimental, `ROTATION_ENABLED`).
*   **`shadowTrader.js`:** Estado en **Netlify Blobs** con patrón transaccional. **Side-aware** (`applyBuy` largo / `applyShort` corto / `applySell` cierra ambos / `getStats` valora cortos a margen+P&L). Cada canal su cartera (`storeKey`/`label`). Costes en ambos lados, `profitUSDC` numérico, escape HTML.
*   **`binanceService.js`:** Cliente HTTP con timeout + retry/backoff (429/418), host de datos y host firmado separados.
*   **`telegramService.js`:** Notificaciones (+ `escape` para HTML).
*   **`validation.js`:** Estadística de validación (bootstrap CI, block bootstrap, Deflated Sharpe, PBO/CSCV, normal CDF/inv, PRNG determinista).
*   **`walkforward.js`:** Walk-forward de ventana anclada expansiva (distribución de métricas por fold).
*   **`validate.js`:** Bootstrap de trades + significancia (Deflated Sharpe) + Monte Carlo de permutación.
*   **`sweep.js`:** Barrido de hipótesis con costes + OOS + corrección de multiple-testing (Deflated Sharpe + PBO).
*   **`shadow-report.js` / `*.html`:** Reportes HTML auditables.
*   **`test/`:** Suite de tests (`npm test`, node:test, 29 tests).

---

## 5. Referencia de Comandos

| Comando | Acción |
|---|---|
| `npm test` | Corre la suite de tests (node:test, zero-dep). |
| `npm run backtest` | Backtest V4C-COMBO sobre la **cesta fija de large-caps** (sin sesgo de supervivencia). |
| `npm run backtest -- --sma200 --months=36` | Backtest de la familia diaria validada. |
| `npm run backtest -- --universe=10` | Top-10 dinámico de Binance (⚠️ sesgo de supervivencia, etiquetado). |
| `npm run backtest -- --voltarget` | Backtest con vol-targeting activado. |
| `npm run walkforward -- --sma200` | Validación walk-forward (distribución por fold). |
| `npm run validate -- --sma200 --permute=200` | Bootstrap CI + Deflated Sharpe + Monte Carlo de permutación. |
| `node sweep.js` | Barrido de hipótesis con DSR + PBO (multiple-testing). |
| `npm run shadow-report` | Descarga `bot_state_v2` desde Netlify Blobs y genera `shadow-report-output.html`. |
| `npm run sync` | Descarga el estado de la nube a un archivo local (`shadow_trades_sync.json`) para auditoría. |
| `npm run reset` | Borra todo el historial y resetea el capital a 5000 USDC. |
| `npm run clear-blobs` | Alias de `reset`. |
| `npm run dev` | Levanta el servidor local de Netlify Dev. |
| `npx netlify deploy --prod` | Sube los cambios y activa la nueva estrategia en la nube. |

---

## 6. Variables de Entorno
Configuradas en el panel de Netlify (ver `.env.example`):
*   `BINANCE_API_KEY` / `BINANCE_API_SECRET` — **opcionales** (el bot shadow usa datos públicos; solo necesarias para `test_connection.js` o trading real). Si una clave se filtró, **rótala**.
*   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
*   `TELEGRAM_ENABLED`: "true"
*   `TELEGRAM_WEBHOOK_SECRET` — secret token del webhook (recomendado; ver §5 de `AUDIT_REPORT.md`). Registra el webhook con `secret_token` y este valor.
*   `LONGSHORT_ENABLED`: "false" para apagar el canal SMA150-LS (default ON).
*   `ROTATION_ENABLED`: "true" para activar el canal experimental de rotación.

---

## 7. Paridad bot ↔ backtest

Desde 2026-05-29 **todos los parámetros viven en `config.js`** (fuente única de verdad), importado por `bot.js`, `backtest.js`, `backtestEngine.js` y `shadowTrader.js`. Esto elimina el drift: cambiar un valor en `config.js` se propaga a live y backtest a la vez.

| Parámetro | Valor (config.js) | Notas de paridad |
|---|---|---|
| Estrategia | `evaluateStrategyV4C` + `STRATEGY_OPTS {chopMax:50, bbwPctMin:20}` | idéntica en live y backtest |
| Stop Loss / Take Profit | `RISK.stopLossPct 3.0%` / `RISK.takeProfitPct 5.0%` | — |
| Trailing | activación `1.5%`, distancia `0.45` | — |
| **Cooldown post-SL** | `RISK.cooldownCandles 12` (3h) | ✅ ahora **también en live** (`shadowTrader.sell` lo fija, `bot.js` lo respeta). Antes solo existía en el backtest. |
| **Costes** | `COSTS` 0.1% fee + 0.05% slippage / lado | ✅ aplicados en backtest Y en ledger live |
| % balance por trade | `RISK.positionSizePct 0.20` | — |
| Blacklist | `BLACKLIST` (stablecoins + TAO/ZEC/PEPE/ADA/INJ/DOGE/BCH) | una sola definición importada en 3 sitios |
| Universo | top 10 por volumen, post-blacklist | `TOP_COINS_LIMIT` |
| **Vela en curso** | descartada en live | ✅ `bot.js` pide 131 velas y descarta la última (sin cerrar) → sin repaint, igual que el backtest que solo usa velas cerradas |
| **Orden de salidas** | TP → Trailing → SL | ✅ alineado en `bot.js` con `applyFixedExits` del backtest |

### 7.1 Bugs corregidos en la auditoría 2026-05-29
*   **Cooldown ausente en live** → portado a `shadowTrader`/`bot.js` (timestamp-based, robusto al cron).
*   **Repaint de vela en curso** → `bot.js` descarta la vela sin cerrar.
*   **`getStats` valoraba a coste** → ahora valora a mercado y separa P&L realizado / no realizado (`/status` de Telegram lo muestra).
*   **Mensaje Telegram con datos obsoletos** (SL −2.5%, "V3", trail 1.0%) → ahora lee de `config.js` (SL real, "V4C-COMBO", trail 1.5%).
*   **Backtest sin costes** → modelo de fees+slippage en motor y ledger (§2.6).
*   **Blacklist/params triplicados** → centralizados en `config.js`.

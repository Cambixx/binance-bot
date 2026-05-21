# Documentación Técnica: Binance Trading Bot (Shadow Mode Serverless)

## 1. Visión General del Proyecto
Este proyecto es un bot de trading automatizado diseñado para operar en Binance. Actualmente, se encuentra configurado en **Shadow Mode** (Modo Simulador), lo que le permite analizar el mercado, detectar señales de compra/venta y registrar un historial de operaciones usando un saldo virtual (5000 USDC), sin arriesgar capital real.

**Arquitectura principal:**
El bot está construido en Node.js y diseñado para ejecutarse como una **función Serverless** en **Netlify**. Se ejecuta automáticamente cada 15 minutos mediante un Cron Job (`trader-cron.js`).

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

### 2.4 Resultados de Backtest V4C-COMBO (3 meses, 7 monedas) — paridad live
Comparativa frente al baseline V3 con los mismos símbolos y periodo:

| Métrica | V3 baseline | **V4C-COMBO** | Mejora |
|---|---|---|---|
| ROI Full | 10.41% | **11.69%** | +12% |
| Win Rate | 74.74% | **82.89%** | +8pp |
| Profit Factor | 2.11 | **2.67** | +27% |
| Max Drawdown | 3.07% | **2.59%** | -16% |
| Expectancy | +$5.48/trade | **+$7.69/trade** | +40% |
| Holdout PF (OOS) | 1.40 | **3.09** | +121% |
| Holdout WR (OOS) | 65.2% | **80.0%** | +15pp |
| ΔPF degradación train→holdout | -0.94 (overfit) | **+0.53** (mejora en OOS) | ✅ Robusta |

> **Veredicto OOS automático del engine:** "✅ Estrategia robusta: métricas consistentes train ↔ holdout".

### 2.5 Variantes descartadas durante la investigación
*   **V4-A (Supertrend + Chandelier ATR):** ROI 4.15%, WR 34%, PF 1.12 → 450 trades, demasiado ruidoso en 15m crypto. La literatura cita Supertrend para timeframes 1h+. Implementación conservada en `indicators.js` para referencia.
*   **V4-B (V3 entries + ATR exits):** ROI -0.21%, WR 29%, PF 0.98 → SL 2×ATR y trailing Chandelier 3×ATR son multiplicadores demasiado apretados para 15m altcoins; los stop-hunts se llevan los trades antes de moverse. Implementación conservada para experimentación.

---

## 3. Sistema de Backtesting

El proyecto cuenta con un motor de simulación profesional (`backtestEngine.js`) con:
*   Descarga paginada de datos históricos de Binance.
*   División temporal **train/holdout** (default 70/30) con veredicto OOS automático.
*   Modo de salida configurable: `fixed` (TP/SL/trail %) o `atr` (Chandelier + SL en múltiplos de ATR + opcional toma parcial).
*   Filtros de régimen parametrizables vía CLI.

### 3.1 Cómo ejecutar Backtests

#### Comandos rápidos
| Comando | Qué hace |
|---|---|
| `npm run backtest` | Corre la estrategia productiva **V4C-COMBO** sobre los últimos 3 meses con el top dinámico de Binance (paridad con `bot.js`). |
| `npm run backtest -- --v3` | Compara contra el baseline V3 (regresión). |
| `npm run backtest -- --v2` | Compara contra V2 (EMA confirmada). |
| `npm run backtest -- --v1` | Compara contra V1 (original sin filtros de tendencia). |
| `npm run backtest -- --v4a` | Variante Supertrend + Chandelier (modo `atr` automático). |
| `npm run backtest -- --v4b` | Variante V3 entries + ATR exits (modo `atr` automático). |
| `npm run backtest -- --v4c` | V4-C explícito (alias del default). |

#### Flags universales

**Periodo y universo**
| Flag | Default | Descripción |
|---|---|---|
| `--months=N` | `3` | Cuántos meses de historia simular. |
| `--symbols=SYM1,SYM2,...` | top dinámico de Binance | Lista explícita de pares. Si se omite, descarga el top de volumen y aplica la blacklist. |
| `--universe=N` | `10` | Tamaño del top dinámico cuando no se pasa `--symbols`. |
| `--balance=N` | `5000` | Capital virtual inicial en USDC. |
| `--oos-split=R` | `0.7` | Ratio train/holdout (0.7 = 70% train, 30% holdout). |

**Estrategia y parámetros V4-C**
| Flag | Default | Descripción |
|---|---|---|
| `--chop-max=N` | `50` | CHOP máximo permitido para entrar (V4-C). Más bajo = más selectivo. |
| `--bbw-pct=N` | `20` | Percentil BBW mínimo rolling 100 velas (V4-C). Más alto = sólo entornos con vol notable. |

**Gestión de riesgo (modo `fixed` — default para V3 y V4-C)**
| Flag | Default | Descripción |
|---|---|---|
| `--tp=N` | `5.0` | Take Profit fijo (%). |
| `--sl=N` | `3.0` | Stop Loss fijo (%). |
| `--trail-act=N` | `1.5` | Beneficio (%) al que se activa el trailing stop. |
| `--trail-dist=N` | `0.45` | Fracción del peak protegida (0.45 = trailing al 45% del beneficio máximo). |

**Salidas adaptativas (modo `atr` — automático en V4-A y V4-B, manual con `--exit-mode=atr`)**
| Flag | Default | Descripción |
|---|---|---|
| `--exit-mode=MODE` | auto | `fixed` o `atr`. |
| `--atr-sl=N` | `2.0` | SL = entry − N × ATR(14). |
| `--atr-trail=N` | `3.0` | Chandelier exit = peak − N × ATR(14). |
| `--partial-r=N` | `0` (off) | Si >0, vende 50% al alcanzar N × R inicial y mueve el SL a breakeven. |

**Salida del reporte**
| Flag | Default | Descripción |
|---|---|---|
| `--output=FILE` | `backtest-results.json` | Nombre del JSON de resultados. Útil para correr varias variantes en paralelo. |
| `--no-open` | falso | No abrir automáticamente el HTML al terminar (útil en scripts y CI). |

### 3.2 Ejemplos prácticos

```bash
# Comparativa rápida: baseline V3 vs V4C-COMBO en 6 meses
node backtest.js --months=6 --symbols=BTCUSDC,ETHUSDC,SOLUSDC,XRPUSDC --v3 --output=bt-v3.json --no-open
node backtest.js --months=6 --symbols=BTCUSDC,ETHUSDC,SOLUSDC,XRPUSDC --output=bt-v4c.json --no-open

# Variante V4-C estricta (sólo regímenes muy claros)
node backtest.js --v4c --chop-max=40 --bbw-pct=40

# Probar trailing más conservador (proteger 60% del peak)
node backtest.js --v4c --trail-dist=0.60

# V4-B con ATR menos agresivo
node backtest.js --v4b --atr-sl=3 --atr-trail=4

# V4-B con toma parcial a 1×R y SL a breakeven
node backtest.js --v4b --partial-r=1.0

# Walk-forward manual: train con primer 50%, validar últimos 50%
node backtest.js --months=6 --oos-split=0.5
```

### 3.3 Reporte Visual
Cada ejecución genera **`backtest-report-output.html`**. Al abrirlo en el navegador, verás:
*   **Equity Curve:** Gráfica del crecimiento del capital con marca del split OOS.
*   **Drawdown:** Visualización del riesgo máximo asumido.
*   **Estadísticas:** Win Rate, Profit Factor, Expectancy, ROI, distribución por motivo de salida y por moneda.

### 3.4 Veredicto OOS automático
El runner imprime un bloque al final con la comparativa **train vs holdout** y emite alertas si:
*   🔴 PF < 1 en alguna fase → estrategia no rentable.
*   🟡 PF cae > 25% en holdout → posible overfit.
*   🟡 WR cae > 15pp relativo en holdout.
*   🟡 MaxDD holdout 50% peor que train.
*   ✅ Si ninguna alarma se dispara: "Estrategia robusta".

---

## 4. Estructura de Módulos

*   **`indicators.js`:** Estrategias y helpers de indicadores.
    *   Estrategias: `evaluateStrategy` (V1), `evaluateStrategyV2`, `evaluateStrategyV3`, `evaluateStrategyV4A` (Supertrend), `evaluateStrategyV4B` (V3 + ATR exits), `evaluateStrategyV4C` (V3 + regime gate — la productiva).
    *   Helpers: `calculateEMA`, `calculateRSI`, `calculateATR`, `calculateSupertrend`, `calculateChoppinessIndex`, `calculateBBW`.
*   **`backtestEngine.js`:** Motor de simulación. Descarga datos paginada, cronología unificada de eventos por símbolo, dispatcher de estrategia por versión, dos modos de exit (`fixed` y `atr`), división train/holdout y métricas completas.
*   **`backtest.js`:** Runner de consola. Parsea flags CLI, ejecuta el engine, escribe JSON e inyecta los resultados en el HTML.
*   **`backtest-report.html`:** Plantilla del reporte visual.
*   **`bot.js`:** Bot productivo (V4C-COMBO). Importa `evaluateStrategyV4C`, gestiona TP/SL/trailing, llama a `shadowTrader` para persistir posiciones.
*   **`shadowTrader.js`:** Gestiona el estado en **Netlify Blobs**. Persiste el `peakPrice` y `trailingActivated` para mantener el trailing stop entre ejecuciones serverless.
*   **`binanceService.js`:** Cliente HTTP de Binance (klines y top por volumen).
*   **`telegramService.js`:** Notificaciones de trades al canal de Telegram.
*   **`shadow-report.js`:** Genera un HTML auditable con el estado real del bot (descarga el blob y lo renderiza).

---

## 5. Referencia de Comandos

| Comando | Acción |
|---|---|
| `npm run backtest` | Ejecuta backtest V4C-COMBO (default productivo). |
| `npm run backtest -- --months=N` | Backtest sobre N meses. |
| `npm run backtest -- --v3` | Backtest con el baseline V3 (regresión). |
| `npm run shadow-report` | Descarga `bot_state_v2` desde Netlify Blobs y genera `shadow-report-output.html` con el estado real del bot. |
| `npm run sync` | Descarga el estado de la nube a un archivo local (`shadow_trades_sync.json`) para auditoría. |
| `npm run reset` | Borra todo el historial y resetea el capital a 5000 USDC. |
| `npm run clear-blobs` | Alias de `reset`. |
| `npm run dev` | Levanta el servidor local de Netlify Dev. |
| `npx netlify deploy --prod` | Sube los cambios y activa la nueva estrategia en la nube. |

---

## 6. Variables de Entorno
Configuradas en el panel de Netlify:
*   `BINANCE_API_KEY` / `BINANCE_API_SECRET`
*   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
*   `TELEGRAM_ENABLED`: "true"

---

## 7. Paridad bot ↔ backtest

Todos los parámetros del bot productivo (`bot.js`) coinciden con los defaults del backtest engine para que `npm run backtest` reproduzca exactamente la lógica que está corriendo en Netlify:

| Parámetro | Valor | Ubicación |
|---|---|---|
| Estrategia | `evaluateStrategyV4C` | `bot.js`, `backtestEngine.js` (default `'4C'`) |
| Opts de régimen | `{ chopMax: 50, bbwPctMin: 20 }` | `bot.js: STRATEGY_OPTS`, `backtest.js: regimeOpts` |
| Trailing distance | `0.45` | `bot.js: TRAIL_DISTANCE`, `backtestEngine.js: trailingDistance` |
| Stop Loss | `3.0%` | `bot.js: RISK_SL`, `backtestEngine.js: stopLossPct` |
| Take Profit | `5.0%` | `bot.js: RISK_TP`, `backtestEngine.js: takeProfitPct` |
| Trailing activation | `1.5%` | `bot.js: TRAIL_ACTIVATION`, `backtestEngine.js: trailingActivation` |
| Cooldown post-SL | 12 velas (3h) | `backtestEngine.js: cooldownCandles` |
| Velas mínimas | 125 (de 130 pedidas) | `bot.js`; el engine usa buffer 120 |
| Blacklist | Stablecoins + TAO/ZEC/PEPE/ADA/INJ/DOGE/BCH | Idéntica en `bot.js`, `backtest.js`, `backtestEngine.js` |
| Universo | top 10 por volumen, post-blacklist | `bot.js: TOP_COINS_LIMIT`, `backtest.js: --universe` |
| % balance por trade | 20% | `backtestEngine.js: executeBuy` |

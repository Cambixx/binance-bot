# Documentación Técnica: Binance Trading Bot (Shadow Mode Serverless)

## 1. Visión General del Proyecto
Este proyecto es un bot de trading automatizado diseñado para operar en Binance. Actualmente, se encuentra configurado en **Shadow Mode** (Modo Simulador), lo que le permite analizar el mercado, detectar señales de compra/venta y registrar un historial de operaciones usando un saldo virtual (5000 USDC), sin arriesgar capital real.

**Arquitectura principal:**
El bot está construido en Node.js y diseñado para ejecutarse como una **función Serverless** en **Netlify**. Se ejecuta automáticamente cada 15 minutos mediante un Cron Job (`trader-cron.js`).

---

## 2. Estrategia de Trading (Evolución a V3)

El bot utiliza actualmente la **Estrategia V3**, optimizada mediante backtesting intensivo.

### 2.1 Lógica de Entrada (V3 - ADX + Momentum + Volumen)
*   **Temporalidad:** 15 minutos (`15m`).
*   **Filtro de Tendencia (ADX):** Solo opera si el **ADX > 20**. Esto asegura que el bot no entre en mercados laterales o ruidosos.
*   **Cruce de Medias (EMA 12/26):** Cruce alcista confirmado durante 2 velas consecutivas para evitar "falsos cruces".
*   **Filtro de Precio (EMA 50):** El precio debe estar por encima de la EMA 50 para confirmar una tendencia alcista saludable.
*   **RSI (Relative Strength Index):** El RSI debe estar en zona de momentum saludable (**40 - 65**).
*   **Filtro de Volumen (MFI):** El Money Flow Index debe ser **> 40** para confirmar que el movimiento viene respaldado por presión compradora real.

### 2.2 Gestión de Riesgo Dinámica (Trailing Stop)
A diferencia de las versiones anteriores con objetivos fijos, la V3 utiliza una gestión inteligente:
*   **Stop Loss (SL):** -2.5% (Ajustado para absorber el ruido del mercado).
*   **Trailing Stop Activation:** Se activa automáticamente al alcanzar un **+1.0%** de beneficio.
*   **Trailing Distance:** Una vez activado, el bot protege el **60% del beneficio máximo** alcanzado. Si el precio retrocede por debajo de ese nivel dinámico, la posición se cierra.
*   **Take Profit (TP):** +5.0% (Como salida de emergencia por beneficio rápido).
*   **RSI Exit:** Si el RSI supera **80** (sobrecompra extrema), el bot cierra la posición preventivamente.

---

## 3. Sistema de Backtesting
El proyecto cuenta con un motor de simulación profesional (`backtestEngine.js`) que permite auditar estrategias antes de pasarlas a producción.

### 3.1 Cómo ejecutar Backtests
Puedes pasar parámetros directamente desde la consola:
*   **Básico (3 meses, top monedas):** `npm run backtest`
*   **Personalizado (Meses y Monedas):** `npm run backtest -- --months=6 --symbols=BTCUSDC,ETHUSDC,SOLUSDC`
*   **Comparar Versiones:** 
    *   V1 (Original): `npm run backtest -- --v1`
    *   V2 (Optimizada): `npm run backtest -- --v2`
    *   V3 (Actual): Es la versión por defecto.

### 3.2 Reporte Visual
Cada ejecución genera un archivo **`backtest-report-output.html`**. Al abrirlo en el navegador, verás:
*   **Equity Curve:** Gráfica del crecimiento del capital.
*   **Drawdown:** Visualización del riesgo máximo asumido.
*   **Estadísticas:** Win Rate, Profit Factor, Expectancy y ROI.

---

## 4. Estructura de Módulos
*   **`indicators.js`:** Contiene las tres versiones de la estrategia (`evaluateStrategy`, `V2` y `V3`).
*   **`backtestEngine.js`:** Motor de simulación con descarga de datos históricos paginada y gestión de Trailing Stop.
*   **`backtest.js`:** Runner de consola que inyecta los resultados en el HTML de reporte.
*   **`shadowTrader.js`:** Gestiona el estado en **Netlify Blobs**. Ahora persiste el `peakPrice` y `trailingActivated` para dar soporte al Trailing Stop en tiempo real.

---

## 5. Referencia de Comandos
*   **`npm run backtest`**: Ejecuta simulación con los últimos resultados.
*   **`npm run backtest -- --months=N`**: Simulación de N meses atrás.
*   **`npm run sync`**: Descarga el estado de la nube a un archivo local para auditoría.
*   **`npm run reset`**: Borra todo el historial y resetea el capital a 5000 USDC.
*   **`npm run clear-blobs`**: Alias de `reset`.
*   **`npx netlify deploy --prod`**: Sube los cambios y activa la nueva estrategia en la nube.

---

## 6. Variables de Entorno
Configuradas en el panel de Netlify:
*   `BINANCE_API_KEY` / `BINANCE_API_SECRET`
*   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
*   `TELEGRAM_ENABLED`: "true"

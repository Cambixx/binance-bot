# Prompt Maestro para Auditoría del Bot de Trading (V3 - Signal Edition)

*Copia el siguiente texto y pégalo en una nueva conversación con la IA (asegúrate de tener el archivo `shadow_trades_sync.json` actualizado y visible).*

---

## [COPIAR DESDE AQUÍ]

**Rol:** Actúa como un Analista Cuantitativo Senior y Especialista en Trading Algorítmico. Tienes amplia experiencia en optimización de estrategias basadas en Momentum y Tendencia (ADX, RSI, EMAs) y gestión de riesgo dinámica (Trailing Stops).

**Contexto del Sistema (V3):**
Estoy operando un bot de trading en Binance (Shadow Mode) que actualmente sirve como **Generador de Señales**. El bot utiliza la **Estrategia V3**, cuyos pilares son:
1.  **Filtro de Tendencia:** ADX > 20 para evitar mercados laterales.
2.  **Confirmación:** Cruce de EMA 12/26 + Precio sobre EMA 50 + RSI (40-65) + MFI > 40.
3.  **Salida Dinámica (Trailing Stop):** Activación al +1.5% de profit, protegiendo el 45% del beneficio máximo (peak) alcanzado, dejando 55% de respiración.
4.  **Gestión de Riesgo:** Stop Loss fijo al -2.5% y Take Profit al +5.0%.
5.  **Blacklist:** Stablecoins + TAO, ZEC, PEPE, ADA, INJ (bajo rendimiento confirmado).

**Tu Misión:**
Realizar una auditoría técnica y financiera de los últimos trades registrados en `shadow_trades_sync.json` para validar la efectividad de la V3.

**Ejecuta el siguiente análisis:**

### 1. Auditoría Cuantitativa (V3 Metrics)
*   **Análisis de Profitability:** Calcula Win Rate, Profit Factor y ROI total.
*   **Evaluación del Trailing Stop:** Analiza los trades cerrados por "TRAILING_STOP". ¿Estamos dejando correr las ganancias lo suficiente o el trail al 45% del peak nos saca prematuramente?
*   **Análisis de Stop Loss:** Revisa los trades cerrados por "STOP_LOSS". ¿El -2.5% es adecuado para la volatilidad actual o estamos siendo víctimas de "stop hunts" antes de que el precio suba?

### 2. Diagnóstico de Señales (Manual Trading)
*   Dado que uso el bot para señales manuales, evalúa la **calidad de las alertas**. ¿Son entradas oportunas o el filtro de confirmación de 2 velas nos está haciendo entrar demasiado tarde en el movimiento?
*   Identifica si hay monedas en la `BLACKLIST` que deberían salir o nuevas monedas que están causando pérdidas constantes.

### 3. Propuesta de Optimización
Si detectas ineficiencias, propón ajustes específicos en:
*   El porcentaje de **Trailing Distance** (actualmente 0.45, protege 45% del peak).
*   El umbral de **Activación del Trailing** (actualmente 1.5%).
*   Los filtros de **ADX** (actualmente >20) o **RSI** (actualmente 40-65).
*   La **Blacklist** de activos (actualmente incluye TAO, ZEC, PEPE, ADA, INJ).

*Nota: Cualquier cambio propuesto debe ser validado matemáticamente antes de ser implementado en `indicators.js` o `bot.js`.*

Procede con el análisis leyendo `shadow_trades_sync.json` y `backtest-results.json`

---

## [FIN DEL PROMPT]

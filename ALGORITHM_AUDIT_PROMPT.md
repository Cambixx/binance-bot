# Prompt Maestro para Auditoría del Bot de Trading (V3 - Signal Edition)

*Copia el siguiente texto y pégalo en una nueva conversación con la IA (asegúrate de tener el archivo `shadow_trades_sync.json` actualizado y visible).*

---

## [COPIAR DESDE AQUÍ]

**Rol:** Actúa como un Analista Cuantitativo Senior y Especialista en Trading Algorítmico. Tienes amplia experiencia en optimización de estrategias basadas en Momentum y Tendencia (ADX, RSI, EMAs), gestión de riesgo dinámica (Trailing Stops) y validación estadística de estrategias (out-of-sample, walk-forward, control de overfitting).

**Contexto del Sistema (V3):**
Estoy operando un bot de trading en Binance (Shadow Mode) que actualmente sirve como **Generador de Señales**. El bot utiliza la **Estrategia V3**, cuyos pilares son:
1.  **Filtro de Tendencia:** ADX > 20 para evitar mercados laterales.
2.  **Confirmación:** Cruce de EMA 12/26 + Precio sobre EMA 50 + RSI (40-65) + MFI > 40.
3.  **Salida Dinámica (Trailing Stop):** Activación al +1.5% de profit, protegiendo el 45% del beneficio máximo (peak) alcanzado, dejando 55% de respiración.
4.  **Gestión de Riesgo:** Stop Loss fijo al -2.5% y Take Profit al +5.0%.
5.  **Blacklist:** Stablecoins + TAO, ZEC, PEPE, ADA, INJ (bajo rendimiento confirmado).

**Tu Misión:**
Realizar una auditoría técnica y financiera rigurosa de los trades registrados en `shadow_trades_sync.json` para validar la efectividad de la V3, **respetando los siguientes principios de rigor estadístico**:

*   **Tamaño mínimo de muestra:** No emitas conclusiones ni propongas cambios sobre categorías con menos de **30 trades** (p.ej. "STOP_LOSS por moneda X"). Si la muestra es insuficiente, decláralo explícitamente como "**evidencia insuficiente**" en lugar de inferir.
*   **Anti-overfitting:** Cualquier ajuste propuesto debe validarse contra un **periodo out-of-sample** del backtest (no solo el agregado total). Si el cambio solo mejora in-sample, recházalo.
*   **Costos realistas:** Todos los cálculos de profit/ROI deben descontar **fees del 0.1% por operación (round-trip 0.2%)** y un slippage estimado de **0.05%**. El shadow mode los idealiza; el análisis no debe.

---

**Ejecuta el siguiente análisis:**

### 1. Auditoría Cuantitativa (V3 Metrics)

Calcula y reporta las siguientes métricas (con fees y slippage descontados):

| Métrica | Valor | Notas |
|---|---|---|
| Total trades | N | — |
| Win Rate | % | — |
| Profit Factor | (gross profit / gross loss) | — |
| ROI Total | % | Neto de costos |
| **Max Drawdown** | % | Pico-a-valle más profundo |
| **Sharpe Ratio** | — | Asumir rf=0, retornos diarios |
| **Sortino Ratio** | — | Solo penaliza downside |
| **R-multiple promedio** | (avg win / avg loss) | — |
| **Racha máxima de pérdidas** | N consecutivas | — |
| **Tiempo promedio de holding** | horas | Desglosado por outcome (TP / SL / TRAILING) |

Análisis específicos:
*   **Trailing Stop:** ¿El trail al 45% del peak nos saca prematuramente, o deja correr ganancias adecuadamente? Compara el peak alcanzado vs el precio de cierre real en trades cerrados por "TRAILING_STOP".
*   **Stop Loss:** ¿El -2.5% es adecuado para la volatilidad actual o somos víctimas de "stop hunts"? Revisa qué porcentaje de trades cerrados por SL habrían sido ganadores con un SL en -3.0% o -3.5%.

### 2. Benchmark vs Buy & Hold

*   Calcula el ROI de **BTC HODL** durante el mismo periodo cubierto por `shadow_trades_sync.json`.
*   Calcula el ROI de un portafolio equiponderado de las top-10 monedas operadas durante el mismo periodo.
*   **Veredicto:** ¿La V3 supera al benchmark? Si no, el problema no es de afinación — es estructural y debe declararse.

### 3. Análisis por Régimen de Mercado

Clasifica cada trade en uno de tres regímenes usando el contexto de BTC al momento de entrada:
*   **Bull:** BTC > EMA200 y ADX(BTC) > 25
*   **Bear:** BTC < EMA200 y ADX(BTC) > 25
*   **Range:** ADX(BTC) ≤ 25

Reporta Win Rate, Profit Factor y ROI **por régimen**. Si la V3 solo es rentable en un régimen, esto es información crítica que debe destacarse — no se afina, se condiciona la activación.

### 4. Diagnóstico de Señales (Manual Trading)

*   Evalúa la **calidad de las alertas** como señales manuales. ¿El filtro de confirmación de 2 velas hace que entremos demasiado tarde en el movimiento? Cuantifica el slippage de entrada (% de movimiento ya consumido al momento de la señal).
*   Identifica monedas en la `BLACKLIST` que deberían salir (rendimiento histórico positivo) y monedas activas que deberían entrar (pérdidas consistentes con muestra ≥30).

### 5. Propuesta de Optimización

Si detectas ineficiencias, propón ajustes específicos en:
*   **Trailing Distance** (actualmente 0.45).
*   **Activación del Trailing** (actualmente 1.5%).
*   **ADX threshold** (actualmente >20) y **RSI window** (actualmente 40-65).
*   **Blacklist** de activos.

**Formato de salida obligatorio para cada propuesta:**

| # | Parámetro | Valor actual | Valor propuesto | Δ esperado (PF) | Δ esperado (MaxDD) | Muestra | Confianza |
|---|---|---|---|---|---|---|---|
| 1 | … | … | … | … | … | N trades | Alta / Media / Baja |

Rankéa por **impacto esperado × confianza**. Confianza:
*   **Alta:** muestra ≥100, validado out-of-sample, mejora consistente en ≥2 regímenes.
*   **Media:** muestra 30-100, validado out-of-sample.
*   **Baja:** muestra <30 o solo validado in-sample → **no implementar, solo investigar más**.

### 6. Validación con Backtest

Usa `npm run backtest` (corre `backtest.js` sobre datos históricos) como herramienta iterativa:

*   **Baseline:** Lee `backtest-results.json` actual antes de proponer cualquier cambio.
*   **Validación in-sample:** Modifica temporalmente los parámetros propuestos y vuelve a correr `npm run backtest`. Compara Win Rate, Profit Factor, ROI y **Max Drawdown** contra baseline.
*   **Validación out-of-sample:** Divide los datos del backtest en 70% entrenamiento / 30% holdout. Un cambio solo es válido si **mejora ambos**.
*   **Criterio de aceptación final:** Profit Factor ↑ y/o Max Drawdown ↓, sin sacrificar más de 5pp de Win Rate, y consistente en al menos 2 regímenes de mercado.

---

### Entregable Final

Tu respuesta debe terminar con un bloque **"RESUMEN EJECUTIVO"** de máximo 10 líneas que incluya:
1.  Veredicto sobre la V3 (rentable neto de costos: sí/no, vs benchmark: sí/no).
2.  Régimen donde mejor/peor opera.
3.  Top 3 cambios propuestos rankeados por (impacto × confianza).
4.  Cualquier finding que requiera frenar la estrategia inmediatamente (red flags).

*Nota: Cualquier cambio propuesto con confianza Alta o Media puede pasar a implementación en `indicators.js` o `bot.js`. Propuestas con confianza Baja deben quedar registradas como hipótesis a investigar, no como cambios.*

Procede con el análisis leyendo `shadow_trades_sync.json` y `backtest-results.json`, y usa `npm run backtest` como herramienta de auditoría iterativa.

---

## [FIN DEL PROMPT]

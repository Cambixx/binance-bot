import { EMA, RSI, ADX, MFI, MACD } from 'technicalindicators';

/**
 * Calcula la Media Móvil Exponencial (EMA) para una serie de precios de cierre
 * @param {Array<number>} closePrices Array de precios de cierre
 * @param {number} period Periodo de la EMA (ej: 9, 21, 50)
 * @returns {Array<number>} Array con los valores calculados de la EMA
 */
export function calculateEMA(closePrices, period) {
  if (closePrices.length < period) return [];
  
  return EMA.calculate({
    period: period,
    values: closePrices
  });
}

/**
 * Calcula el Relative Strength Index (RSI) para una serie de precios de cierre
 * @param {Array<number>} closePrices Array de precios de cierre
 * @param {number} period Periodo del RSI (típicamente 14)
 * @returns {Array<number>} Array con los valores calculados del RSI
 */
export function calculateRSI(closePrices, period = 14) {
  if (closePrices.length < period) return [];

  return RSI.calculate({
    period: period,
    values: closePrices
  });
}

/**
 * Evalúa las condiciones de la estrategia clásica (EMA Crossover + RSI)
 * 
 * LÓGICA:
 * - COMPRA (BUY) si: La EMA rápida cruza por encima de la EMA lenta Y el RSI no indica sobrecompra (< 70).
 * - VENTA (SELL) si: La EMA rápida cruza por debajo de la lenta O el RSI indica sobrecompra extrema (> 80).
 * 
 * @param {Array<number>} closes Precios de cierre históricos
 * @returns {string} 'BUY', 'SELL', o 'HOLD'
 */
export function evaluateStrategy(closes) {
  const EMA_FAST_PERIOD = 9;
  const EMA_SLOW_PERIOD = 21;
  const EMA_TREND_PERIOD = 100; // Filtro de tendencia de largo plazo
  const RSI_PERIOD = 14;

  if (closes.length <= Math.max(EMA_TREND_PERIOD, RSI_PERIOD)) {
    return 'HOLD'; // No hay suficientes datos para la EMA 100
  }

  const emaFast = calculateEMA(closes, EMA_FAST_PERIOD);
  const emaSlow = calculateEMA(closes, EMA_SLOW_PERIOD);
  const emaTrend = calculateEMA(closes, EMA_TREND_PERIOD);
  const rsi = calculateRSI(closes, RSI_PERIOD);

  // Obtener los últimos valores
  const currentPrice = closes[closes.length - 1];
  const currentEmaFast = emaFast[emaFast.length - 1];
  const prevEmaFast = emaFast[emaFast.length - 2];

  const currentEmaSlow = emaSlow[emaSlow.length - 1];
  const prevEmaSlow = emaSlow[emaSlow.length - 2];

  const currentEmaTrend = emaTrend[emaTrend.length - 1];
  const currentRsi = rsi[rsi.length - 1];

  // Evaluar Cruce Alcista (Golden Cross)
  const isGoldenCross = prevEmaFast <= prevEmaSlow && currentEmaFast > currentEmaSlow;
  // Evaluar Cruce Bajista (Death Cross)
  const isDeathCross = prevEmaFast >= prevEmaSlow && currentEmaFast < currentEmaSlow;

  // Lógica de COMPRA: Golden Cross + RSI Saludable + Precio sobre EMA 100 (Tendencia alcista)
  if (isGoldenCross && currentRsi < 70 && currentPrice > currentEmaTrend) {
    return 'BUY';
  } 
  // Lógica de VENTA: Death Cross O RSI muy sobrecomprado (> 80)
  else if (isDeathCross || currentRsi > 80) {
    return 'SELL';
  }

  return 'HOLD';
}

/**
 * Estrategia V2 Optimizada para Backtesting
 * 
 * Cambios vs V1:
 * - EMAs más lentas (12/26) para reducir whipsaws
 * - Cruce confirmado: EMA rápida debe estar CONSISTENTEMENTE encima/debajo (2 velas)
 * - RSI en zona saludable (40-65) para comprar → evita entrar en sobrecompra/sobreventa
 * - Precio debe estar > 0.3% encima de EMA 100 para confirmar tendencia real
 * - Venta: Death Cross confirmado O RSI > 75 (más sensible que 80)
 * 
 * @param {Array<number>} closes Precios de cierre históricos
 * @returns {string} 'BUY', 'SELL', o 'HOLD'
 */
export function evaluateStrategyV2(closes) {
  const EMA_FAST_PERIOD = 12;
  const EMA_SLOW_PERIOD = 26;
  const EMA_TREND_PERIOD = 100;
  const RSI_PERIOD = 14;

  if (closes.length <= Math.max(EMA_TREND_PERIOD, RSI_PERIOD) + 2) {
    return 'HOLD';
  }

  const emaFast = calculateEMA(closes, EMA_FAST_PERIOD);
  const emaSlow = calculateEMA(closes, EMA_SLOW_PERIOD);
  const emaTrend = calculateEMA(closes, EMA_TREND_PERIOD);
  const rsi = calculateRSI(closes, RSI_PERIOD);

  const currentPrice = closes[closes.length - 1];

  // Últimos 3 valores para confirmar tendencia
  const fastNow = emaFast[emaFast.length - 1];
  const fastPrev = emaFast[emaFast.length - 2];
  const fastPrev2 = emaFast[emaFast.length - 3];

  const slowNow = emaSlow[emaSlow.length - 1];
  const slowPrev = emaSlow[emaSlow.length - 2];
  const slowPrev2 = emaSlow[emaSlow.length - 3];

  const trendNow = emaTrend[emaTrend.length - 1];
  const rsiNow = rsi[rsi.length - 1];

  // Cruce Alcista CONFIRMADO: la EMA rápida cruzó por encima Y se mantiene arriba
  const isConfirmedGoldenCross = fastPrev2 <= slowPrev2 && fastPrev > slowPrev && fastNow > slowNow;
  
  // Cruce Bajista CONFIRMADO: la EMA rápida cruzó por debajo Y se mantiene abajo
  const isConfirmedDeathCross = fastPrev2 >= slowPrev2 && fastPrev < slowPrev && fastNow < slowNow;

  // Filtro de tendencia: precio debe estar > 0.3% por encima de EMA 100
  const trendMargin = trendNow * 0.003;
  const isStrongUptrend = currentPrice > (trendNow + trendMargin);

  // COMPRA: Cruce confirmado + RSI saludable (40-65) + Tendencia alcista fuerte
  if (isConfirmedGoldenCross && rsiNow > 40 && rsiNow < 65 && isStrongUptrend) {
    return 'BUY';
  }
  // VENTA: Death Cross confirmado O RSI sobrecomprado (>75)
  else if (isConfirmedDeathCross || rsiNow > 75) {
    return 'SELL';
  }

  return 'HOLD';
}

/**
 * Estrategia V3 — ADX Trend + MFI Volume + Smart Exits
 * 
 * DIAGNÓSTICO de V2:
 * - 90% de los trades se cierran por señal de Death Cross (demasiado ruidoso en 15m)
 * - El bot entra bien pero sale antes de que el trade pueda desarrollarse
 * 
 * CAMBIOS V3:
 * - ENTRADA: Cruce EMA 12/26 + ADX > 20 (confirma que hay tendencia real, no ruido)
 *            + RSI 40-65 + Precio > EMA 50 (tendencia más reactiva que EMA 100)
 * - SALIDA: ELIMINAMOS el Death Cross como señal de venta (demasiado ruidoso)
 *           Solo salimos por RSI > 78 (sobrecompra extrema) 
 *           El trailing stop del engine se encarga del resto
 * 
 * @param {object} candles Datos OHLCV { closes, highs, lows, volumes }
 * @returns {string} 'BUY', 'SELL', o 'HOLD'
 */
export function evaluateStrategyV3(candles) {
  const { closes, highs, lows, volumes } = candles;
  
  const EMA_FAST = 12;
  const EMA_SLOW = 26;
  const EMA_TREND = 50;  // Más reactiva que 100
  const ADX_PERIOD = 14;
  const RSI_PERIOD = 14;

  if (closes.length < 105) return 'HOLD';

  // Indicadores base
  const emaFast = calculateEMA(closes, EMA_FAST);
  const emaSlow = calculateEMA(closes, EMA_SLOW);
  const emaTrend = calculateEMA(closes, EMA_TREND);
  const rsi = calculateRSI(closes, RSI_PERIOD);

  // ADX — Fuerza de la tendencia (necesita high, low, close)
  const adxValues = ADX.calculate({
    period: ADX_PERIOD,
    high: highs,
    low: lows,
    close: closes
  });

  if (adxValues.length < 2 || emaFast.length < 3 || emaSlow.length < 3) return 'HOLD';

  const price = closes[closes.length - 1];
  const rsiNow = rsi[rsi.length - 1];
  const adxNow = adxValues[adxValues.length - 1].adx;

  // EMAs
  const fastNow = emaFast[emaFast.length - 1];
  const fastPrev = emaFast[emaFast.length - 2];
  const fastPrev2 = emaFast[emaFast.length - 3];
  const slowNow = emaSlow[emaSlow.length - 1];
  const slowPrev = emaSlow[emaSlow.length - 2];
  const slowPrev2 = emaSlow[emaSlow.length - 3];
  const trendNow = emaTrend[emaTrend.length - 1];

  // Cruce confirmado (2 velas)
  const isGoldenCross = fastPrev2 <= slowPrev2 && fastPrev > slowPrev && fastNow > slowNow;

  // Filtros de entrada
  const hasTrend = adxNow > 20;           // Hay una tendencia real (no choppy market)
  const isUptrend = price > trendNow;      // Precio sobre EMA 50
  const rsiHealthy = rsiNow > 40 && rsiNow < 65;

  // COMPRA: Golden Cross confirmado + ADX confirma tendencia + RSI saludable + uptrend
  if (isGoldenCross && hasTrend && rsiHealthy && isUptrend) {
    return 'BUY';
  }
  // VENTA: SOLO por RSI extremo — el trailing stop del engine maneja el resto
  else if (rsiNow > 78) {
    return 'SELL';
  }

  return 'HOLD';
}

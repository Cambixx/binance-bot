import { EMA, RSI, ADX, MFI, MACD, ATR, BollingerBands } from 'technicalindicators';

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
 * - ENTRADA: Cruce EMA 12/26 + ADX > 25 (confirma que hay tendencia real fuerte, no ruido)
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
  const MFI_PERIOD = 14;

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

  // MFI — Confirmación de volumen
  const mfiValues = MFI.calculate({
    period: MFI_PERIOD,
    high: highs,
    low: lows,
    close: closes,
    volume: volumes
  });

  if (adxValues.length < 2 || mfiValues.length === 0 || emaFast.length < 3 || emaSlow.length < 3) return 'HOLD';

  const price = closes[closes.length - 1];
  const rsiNow = rsi[rsi.length - 1];
  const adxNow = adxValues[adxValues.length - 1].adx;
  const mfiNow = mfiValues[mfiValues.length - 1];

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

  // Filtros de entrada (post-audit 2026-05-18: ADX subido 20→25 para filtro más estricto)
  const hasTrend = adxNow > 25;           // Hay una tendencia real fuerte (no choppy market)
  const isUptrend = price > trendNow;      // Precio sobre EMA 50
  const rsiHealthy = rsiNow > 40 && rsiNow < 65;
  const mfiHealthy = mfiNow > 40;          // Confirmación de volumen de compra

  // COMPRA: Golden Cross confirmado + ADX confirma tendencia + RSI saludable + uptrend + MFI saludable
  if (isGoldenCross && hasTrend && rsiHealthy && isUptrend && mfiHealthy) {
    return 'BUY';
  }
  // VENTA: SOLO por RSI extremo — el trailing stop del engine maneja el resto
  else if (rsiNow > 80) {
    return 'SELL';
  }

  return 'HOLD';
}

// ============================================================
//  HELPERS V4 — ATR, Supertrend, Choppiness Index, BBW
// ============================================================

export function calculateATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return [];
  return ATR.calculate({ period, high: highs, low: lows, close: closes });
}

/**
 * Supertrend (period=10, mult=3 por defecto)
 * Devuelve un array { value, trend } donde trend = 1 (up) o -1 (down)
 */
export function calculateSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
  const atr = calculateATR(highs, lows, closes, period);
  if (atr.length === 0) return [];

  const offset = closes.length - atr.length;
  const result = [];
  let prevFinalUpper = 0;
  let prevFinalLower = 0;
  let prevSupertrend = 0;
  let prevTrend = 1;

  for (let i = 0; i < atr.length; i++) {
    const idx = i + offset;
    const high = highs[idx];
    const low = lows[idx];
    const close = closes[idx];
    const prevClose = idx > 0 ? closes[idx - 1] : close;
    const hl2 = (high + low) / 2;
    const upperBasic = hl2 + multiplier * atr[i];
    const lowerBasic = hl2 - multiplier * atr[i];

    const finalUpper = (upperBasic < prevFinalUpper || prevClose > prevFinalUpper)
      ? upperBasic : prevFinalUpper;
    const finalLower = (lowerBasic > prevFinalLower || prevClose < prevFinalLower)
      ? lowerBasic : prevFinalLower;

    let trend;
    if (i === 0) {
      trend = close > upperBasic ? 1 : -1;
    } else if (prevSupertrend === prevFinalUpper && close <= finalUpper) {
      trend = -1;
    } else if (prevSupertrend === prevFinalUpper && close > finalUpper) {
      trend = 1;
    } else if (prevSupertrend === prevFinalLower && close >= finalLower) {
      trend = 1;
    } else if (prevSupertrend === prevFinalLower && close < finalLower) {
      trend = -1;
    } else {
      trend = prevTrend;
    }

    const supertrend = trend === 1 ? finalLower : finalUpper;

    result.push({ value: supertrend, trend });
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
    prevSupertrend = supertrend;
    prevTrend = trend;
  }

  return result;
}

/**
 * Choppiness Index (CHOP). >61.8 = mercado lateral, <38.2 = tendencia fuerte.
 */
export function calculateChoppinessIndex(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return [];

  const trList = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trList.push(tr);
  }

  const result = [];
  for (let i = period - 1; i < trList.length; i++) {
    let sumTR = 0;
    let maxH = -Infinity;
    let minL = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      sumTR += trList[j];
      // highs/lows están desplazados +1 respecto a trList (TR usa index i+1 del original)
      maxH = Math.max(maxH, highs[j + 1]);
      minL = Math.min(minL, lows[j + 1]);
    }
    const range = maxH - minL;
    if (range <= 0) {
      result.push(50);
      continue;
    }
    const chop = 100 * Math.log10(sumTR / range) / Math.log10(period);
    result.push(chop);
  }
  return result;
}

/**
 * Bollinger Band Width — normalized (upper-lower)/middle
 */
export function calculateBBW(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return [];
  const bb = BollingerBands.calculate({ period, stdDev, values: closes });
  return bb.map(b => (b.upper - b.lower) / b.middle);
}

/**
 * Percentile rank de un valor dentro de una serie
 */
function percentileRank(series, value) {
  if (series.length === 0) return 0;
  let count = 0;
  for (const v of series) if (v <= value) count++;
  return (count / series.length) * 100;
}

// ============================================================
//  ESTRATEGIA V4-A — Adaptive Trend (Supertrend + Chandelier)
// ============================================================
/**
 * Filosofía: menos parámetros, indicadores adaptativos a volatilidad.
 *  - ENTRADA: Supertrend(10,3) cruce a +1 + Precio > EMA50 + CHOP(14) < 50 + MFI > 40
 *  - SALIDA: SOLO por engine (Chandelier ATR trail) — sin condiciones por indicador
 */
export function evaluateStrategyV4A(candles) {
  const { closes, highs, lows, volumes } = candles;
  if (closes.length < 105) return 'HOLD';

  const st = calculateSupertrend(highs, lows, closes, 10, 3);
  const emaTrend = calculateEMA(closes, 50);
  const chop = calculateChoppinessIndex(highs, lows, closes, 14);
  const mfi = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });

  if (st.length < 3 || chop.length === 0 || mfi.length === 0) return 'HOLD';

  const stNow = st[st.length - 1];
  const stPrev = st[st.length - 2];
  const price = closes[closes.length - 1];
  const trendNow = emaTrend[emaTrend.length - 1];
  const chopNow = chop[chop.length - 1];
  const mfiNow = mfi[mfi.length - 1];

  // Cruce ALCISTA del Supertrend (trend pasó de -1 → 1)
  const supertrendFlippedUp = stPrev.trend === -1 && stNow.trend === 1;

  if (supertrendFlippedUp && price > trendNow && chopNow < 50 && mfiNow > 40) {
    return 'BUY';
  }

  // Cruce BAJISTA — señal explícita de salida (engine también maneja Chandelier)
  if (stPrev.trend === 1 && stNow.trend === -1) {
    return 'SELL';
  }

  return 'HOLD';
}

// ============================================================
//  ESTRATEGIA V4-B — V3 entries + ATR-adaptive exits
// ============================================================
/**
 * Mismas entradas que V3 (probadas) pero deja el manejo de exit al engine
 * con modo ATR (SL = 2×ATR, Chandelier trail = 3×ATR). No emite señal SELL
 * salvo RSI > 82 (más permisivo que V3 para evitar salidas prematuras).
 */
export function evaluateStrategyV4B(candles) {
  const { closes, highs, lows, volumes } = candles;
  if (closes.length < 105) return 'HOLD';

  const emaFast = calculateEMA(closes, 12);
  const emaSlow = calculateEMA(closes, 26);
  const emaTrend = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const adxValues = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const mfiValues = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });

  if (adxValues.length < 2 || mfiValues.length === 0 || emaFast.length < 3 || emaSlow.length < 3) {
    return 'HOLD';
  }

  const price = closes[closes.length - 1];
  const rsiNow = rsi[rsi.length - 1];
  const adxNow = adxValues[adxValues.length - 1].adx;
  const mfiNow = mfiValues[mfiValues.length - 1];

  const fastNow = emaFast[emaFast.length - 1];
  const fastPrev = emaFast[emaFast.length - 2];
  const fastPrev2 = emaFast[emaFast.length - 3];
  const slowNow = emaSlow[emaSlow.length - 1];
  const slowPrev = emaSlow[emaSlow.length - 2];
  const slowPrev2 = emaSlow[emaSlow.length - 3];
  const trendNow = emaTrend[emaTrend.length - 1];

  const isGoldenCross = fastPrev2 <= slowPrev2 && fastPrev > slowPrev && fastNow > slowNow;
  const hasTrend = adxNow > 25;
  const isUptrend = price > trendNow;
  const rsiHealthy = rsiNow > 40 && rsiNow < 65;
  const mfiHealthy = mfiNow > 40;

  if (isGoldenCross && hasTrend && rsiHealthy && isUptrend && mfiHealthy) {
    return 'BUY';
  }
  // Sólo salida por RSI muy extremo — deja al engine el trabajo
  if (rsiNow > 82) return 'SELL';
  return 'HOLD';
}

// ============================================================
//  ESTRATEGIA V4-C — V3 + regime gate (CHOP + BBW)
// ============================================================
/**
 * V3 entries idénticas + dos filtros adicionales para evitar mercados
 * incompatibles:
 *  - CHOP(14) < 45 → mercado en tendencia clara
 *  - BBW(20) en percentil > 30 del rolling 100 → hay vol suficiente
 */
export function evaluateStrategyV4C(candles, opts = {}) {
  const chopMax = opts.chopMax ?? 45;
  const bbwPctMin = opts.bbwPctMin ?? 30;
  const { closes, highs, lows, volumes } = candles;
  if (closes.length < 120) return 'HOLD';

  const emaFast = calculateEMA(closes, 12);
  const emaSlow = calculateEMA(closes, 26);
  const emaTrend = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const adxValues = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
  const mfiValues = MFI.calculate({ period: 14, high: highs, low: lows, close: closes, volume: volumes });
  const chop = calculateChoppinessIndex(highs, lows, closes, 14);
  const bbw = calculateBBW(closes, 20, 2);

  if (adxValues.length < 2 || mfiValues.length === 0 || emaFast.length < 3 ||
      emaSlow.length < 3 || chop.length === 0 || bbw.length < 50) {
    return 'HOLD';
  }

  const price = closes[closes.length - 1];
  const rsiNow = rsi[rsi.length - 1];
  const adxNow = adxValues[adxValues.length - 1].adx;
  const mfiNow = mfiValues[mfiValues.length - 1];
  const chopNow = chop[chop.length - 1];

  // Rolling percentile rank de BBW sobre últimas 100 velas
  const bbwWindow = bbw.slice(-100);
  const bbwNow = bbwWindow[bbwWindow.length - 1];
  const bbwPctRank = percentileRank(bbwWindow, bbwNow);

  const fastNow = emaFast[emaFast.length - 1];
  const fastPrev = emaFast[emaFast.length - 2];
  const fastPrev2 = emaFast[emaFast.length - 3];
  const slowNow = emaSlow[emaSlow.length - 1];
  const slowPrev = emaSlow[emaSlow.length - 2];
  const slowPrev2 = emaSlow[emaSlow.length - 3];
  const trendNow = emaTrend[emaTrend.length - 1];

  const isGoldenCross = fastPrev2 <= slowPrev2 && fastPrev > slowPrev && fastNow > slowNow;
  const hasTrend = adxNow > 25;
  const isUptrend = price > trendNow;
  const rsiHealthy = rsiNow > 40 && rsiNow < 65;
  const mfiHealthy = mfiNow > 40;

  // Nuevos filtros de régimen
  const trendingRegime = chopNow < chopMax;
  const livelyVol = bbwPctRank > bbwPctMin;

  if (isGoldenCross && hasTrend && rsiHealthy && isUptrend && mfiHealthy &&
      trendingRegime && livelyVol) {
    return 'BUY';
  }
  if (rsiNow > 80) return 'SELL';
  return 'HOLD';
}

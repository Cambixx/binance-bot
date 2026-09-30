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
      // Seed canónico nz(trend,1) = +1 (fix #22): el SuperTrend de TradingView arranca en
      // alcista y deja que el cruce de bandas tome el control. Sembrar con close>upperBasic
      // daba casi siempre -1 (upperBasic ≫ close) → downtrend espurio + flip-up extra en warmup.
      trend = 1;
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
 *  - CHOP(14) < chopMax → mercado en tendencia clara
 *  - BBW(20) en percentil > bbwPctMin del rolling 100 → hay vol suficiente
 *
 * Defaults alineados con config.js STRATEGY_OPTS (chopMax 50, bbwPctMin 20) — fix #24:
 * antes los defaults (45/30) divergían de la config productiva y el docstring estaba obsoleto.
 * En producción los valores SIEMPRE vienen de config.js; estos defaults solo aplican si se
 * llama sin opts (p.ej. en tests).
 */
export function evaluateStrategyV4C(candles, opts = {}) {
  const chopMax = opts.chopMax ?? 50;
  const bbwPctMin = opts.bbwPctMin ?? 20;
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

  // Rolling percentile rank de BBW sobre últimas 100 velas. Rankea contra el HISTORIAL
  // (excluye el valor actual, fix #23) para no auto-inflar el percentil en ~100/W puntos.
  const bbwWindow = bbw.slice(-100);
  const bbwNow = bbwWindow[bbwWindow.length - 1];
  const bbwPctRank = percentileRank(bbwWindow.slice(0, -1), bbwNow);

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

// ============================================================
//  ESTRATEGIA V5 — Trend-Rider de BAJA FRECUENCIA
// ============================================================
/**
 * Tesis (auditoría 2026-05-29): con 0.30% de coste round-trip por trade, hay que
 * OPERAR MENOS y CAPTURAR MOVIMIENTOS GRANDES. En vez del churn de cruces EMA12/26
 * (sin edge tras costes), V5:
 *   - Solo opera en régimen alcista CONFIRMADO de fondo: EMA50 > EMA200 y precio > EMA200.
 *   - Entra en el RECLAIM de la EMA de disparo (pullback que recupera) con ADX fuerte.
 *   - SALE solo al romper la tendencia (cierre < EMA de salida) → deja correr la tendencia.
 * Pocas señales, cada una persiguiendo un tramo grande de tendencia. El engine debe
 * correr con TP "apagado" (alto) para no cortar al rider; el SL amplio es red de seguridad.
 *
 * @param {object} candles { closes, highs, lows }
 * @param {object} opts { emaFast=50, emaSlow=200, exitEma=50, adxMin=20 }
 */
export function evaluateStrategyV5(candles, opts = {}) {
  const emaFastP = opts.emaFast ?? 50;
  const emaSlowP = opts.emaSlow ?? 200;
  const exitEmaP = opts.exitEma ?? 50;
  const adxMin = opts.adxMin ?? 20;
  const { closes, highs, lows } = candles;

  if (closes.length < emaSlowP + 5) return 'HOLD';

  const emaFast = calculateEMA(closes, emaFastP);
  const emaSlow = calculateEMA(closes, emaSlowP);
  const exitEma = calculateEMA(closes, exitEmaP);
  const adxValues = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (emaFast.length < 2 || emaSlow.length < 2 || exitEma.length < 2 || adxValues.length < 1) {
    return 'HOLD';
  }

  const price = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2];
  const fastNow = emaFast[emaFast.length - 1];
  const slowNow = emaSlow[emaSlow.length - 1];
  const exitNow = exitEma[exitEma.length - 1];
  const exitPrev = exitEma[exitEma.length - 2];
  const adxNow = adxValues[adxValues.length - 1].adx;

  // Régimen alcista de fondo
  const uptrendRegime = fastNow > slowNow && price > slowNow;
  // Reclaim: el precio recupera la EMA de disparo desde abajo (entrada en pullback)
  const reclaim = prevPrice <= exitPrev && price > exitNow;

  if (uptrendRegime && adxNow > adxMin && reclaim) return 'BUY';
  // Salida: ruptura de tendencia (cierre bajo la EMA de salida)
  if (price < exitNow) return 'SELL';
  return 'HOLD';
}

// ============================================================
//  ESTRATEGIA V6 — Adaptive SuperTrend (port de "Self-Aware Trend System")
// ============================================================
/**
 * Adaptación LONG-ONLY del indicador SATS de WillyAlgoTrader. Núcleo destilado:
 *  - SuperTrend cuyo ANCHO DE BANDA se modula por un Trend Quality Index (TQI 0..1)
 *    de 4 factores: Efficiency Ratio (Kaufman), régimen de volatilidad (Z de volumen),
 *    estructura (posición en rango) y persistencia de momento.
 *  - Alta calidad → bandas estrechas (sigue de cerca); baja calidad → bandas anchas
 *    (menos whipsaw). Ataca directamente el churn que hundió a V4-A (SuperTrend simple).
 *  - ATR ponderado por eficiencia: effATR = ATR*(0.5 + 0.5*ER).
 *  - Bandas asimétricas: el lado activo (dirección de tendencia) se estrecha.
 * Señal: BUY en giro alcista del SuperTrend, SELL (a cash) en giro bajista.
 * Omitido respecto al original: short, auto-calibración experimental, scoring de display,
 * y el character-flip (inerte en su config por defecto: la condición close<source nunca
 * se cumple con source=close).
 *
 * @param {object} candles { closes, highs, lows, volumes }
 * @param {object} opts parámetros (ver defaults abajo)
 */
export function evaluateStrategyV6(candles, opts = {}) {
  const atrLen    = opts.atrLen ?? 13;
  const baseMult  = opts.baseMult ?? 2.0;
  const erLen     = opts.erLen ?? 20;
  const qStr      = opts.qStrength ?? 0.4;     // influencia de la calidad sobre el ancho
  const qCurve    = opts.qCurve ?? 1.5;        // no-linealidad
  const useAsym   = opts.useAsym ?? true;
  const asymStr   = opts.asymStrength ?? 0.5;
  const useEffAtr = opts.useEffAtr ?? true;
  const structLen = opts.structLen ?? 20;
  const momLen    = opts.momLen ?? 10;
  const volLen    = opts.volLen ?? 20;
  const baseLen   = opts.atrBaseLen ?? 100;
  const wEr = 0.35, wVol = 0.20, wStruct = 0.25, wMom = 0.20;
  const wSum = wEr + wVol + wStruct + wMom;

  const { closes, highs, lows, volumes } = candles;
  const n = closes.length;
  const need = Math.max(atrLen, erLen, structLen, momLen, volLen, baseLen) + 5;
  if (n < need + 5) return 'HOLD';

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const mapClamp = (v, inLo, inHi, outLo, outHi) => {
    const t = clamp((v - inLo) / (inHi - inLo || 1), 0, 1);
    return outLo + t * (outHi - outLo);
  };

  // True Range + ATR (Wilder RMA), alineado al índice de close
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  const atr = new Array(n).fill(NaN);
  let seed = 0;
  for (let i = 1; i <= atrLen; i++) seed += tr[i];
  atr[atrLen] = seed / atrLen;
  for (let i = atrLen + 1; i < n; i++) atr[i] = (atr[i - 1] * (atrLen - 1) + tr[i]) / atrLen;

  const hasVolume = volumes && volumes.some(v => v > 0);

  // Construir la serie del SuperTrend adaptativo (estado vía ratchet de bandas)
  const startIdx = need;
  let prevTrend = 1;
  let prevUpper = NaN;
  let prevLower = NaN;
  let lastFlip = 'HOLD';
  // Suavizado EMA de multiplicadores (autor: "RECOMMENDED ON", evita compresión brusca)
  const useMultSmooth = opts.multSmooth ?? true;
  const SMOOTH_ALPHA = 0.15;
  let activeMultSm = NaN, passiveMultSm = NaN;

  for (let i = startIdx; i < n; i++) {
    const atrV = atr[i];
    if (!isFinite(atrV)) continue;

    // Efficiency Ratio (Kaufman)
    let recorrido = 0;
    for (let k = i - erLen + 1; k <= i; k++) recorrido += Math.abs(closes[k] - closes[k - 1]);
    const er = recorrido !== 0 ? Math.abs(closes[i] - closes[i - erLen]) / recorrido : 0;

    // Régimen de volatilidad
    let atrSum = 0, atrCnt = 0;
    for (let k = i - baseLen + 1; k <= i; k++) { if (isFinite(atr[k])) { atrSum += atr[k]; atrCnt++; } }
    const atrBase = atrCnt > 0 ? atrSum / atrCnt : atrV;
    const volRatio = atrBase !== 0 ? atrV / atrBase : 1;
    let tqiVol;
    if (hasVolume) {
      let vMean = 0; for (let k = i - volLen + 1; k <= i; k++) vMean += volumes[k]; vMean /= volLen;
      let vVar = 0; for (let k = i - volLen + 1; k <= i; k++) vVar += (volumes[k] - vMean) ** 2; vVar /= volLen;
      const vStd = Math.sqrt(vVar);
      const volZ = vStd !== 0 ? (volumes[i] - vMean) / vStd : 0;
      tqiVol = mapClamp(volZ, -1, 2, 0, 1);
    } else {
      tqiVol = mapClamp(volRatio, 0.6, 1.8, 0, 1);
    }

    // Estructura (posición en el rango)
    let hi = -Infinity, lo = Infinity;
    for (let k = i - structLen + 1; k <= i; k++) { if (highs[k] > hi) hi = highs[k]; if (lows[k] < lo) lo = lows[k]; }
    const rng = hi - lo;
    const pricePos = rng !== 0 ? (closes[i] - lo) / rng : 0.5;
    const tqiStruct = clamp(Math.abs(pricePos - 0.5) * 2, 0, 1);

    // Persistencia de momento
    const windowChange = closes[i] - closes[i - momLen];
    let aligned = 0;
    for (let k = 0; k < momLen; k++) {
      const barChange = closes[i - k] - closes[i - k - 1];
      if ((windowChange > 0 && barChange > 0) || (windowChange < 0 && barChange < 0)) aligned++;
    }
    const tqiMom = aligned / momLen;

    const tqiEr = clamp(er, 0, 1);
    const tqi = clamp((tqiEr * wEr + tqiVol * wVol + tqiStruct * wStruct + tqiMom * wMom) / wSum, 0, 1);

    // ATR ponderado por eficiencia
    const effAtr = useEffAtr ? atrV * (0.5 + 0.5 * er) : atrV;

    // Multiplicador adaptativo (no-lineal según calidad)
    const qualityDev = Math.pow(1 - tqi, qCurve);
    const tqiMult = 1 - qStr + qStr * (0.6 + 0.8 * qualityDev);
    const symMult = baseMult * tqiMult;
    let activeMultRaw = symMult, passiveMultRaw = symMult;
    if (useAsym) {
      activeMultRaw = symMult * (1 - asymStr * tqi * 0.3);
      passiveMultRaw = symMult * (1 + asymStr * tqi * 0.4);
    }
    // EMA-smooth de los multiplicadores antes de aplicarlos
    activeMultSm = isNaN(activeMultSm) ? activeMultRaw : (useMultSmooth ? activeMultSm * (1 - SMOOTH_ALPHA) + activeMultRaw * SMOOTH_ALPHA : activeMultRaw);
    passiveMultSm = isNaN(passiveMultSm) ? passiveMultRaw : (useMultSmooth ? passiveMultSm * (1 - SMOOTH_ALPHA) + passiveMultRaw * SMOOTH_ALPHA : passiveMultRaw);
    const activeMult = activeMultSm;
    const passiveMult = passiveMultSm;
    const lowerMult = prevTrend === 1 ? activeMult : passiveMult;
    const upperMult = prevTrend === 1 ? passiveMult : activeMult;

    const lowerRaw = closes[i] - lowerMult * effAtr;
    const upperRaw = closes[i] + upperMult * effAtr;

    // Ratchet de bandas (igual que SuperTrend clásico)
    const lower = isNaN(prevLower) ? lowerRaw : (closes[i - 1] > prevLower ? Math.max(lowerRaw, prevLower) : lowerRaw);
    const upper = isNaN(prevUpper) ? upperRaw : (closes[i - 1] < prevUpper ? Math.min(upperRaw, prevUpper) : upperRaw);

    const flipUp = prevTrend === -1 && closes[i] > (isNaN(prevUpper) ? upperRaw : prevUpper);
    const flipDown = prevTrend === 1 && closes[i] < (isNaN(prevLower) ? lowerRaw : prevLower);
    const trend = flipUp ? 1 : (flipDown ? -1 : prevTrend);

    if (i === n - 1) {
      if (trend === 1 && prevTrend === -1) lastFlip = 'BUY';
      else if (trend === -1 && prevTrend === 1) lastFlip = 'SELL';
      else lastFlip = 'HOLD';
    }

    prevTrend = trend;
    prevUpper = upper;
    prevLower = lower;
  }

  return lastFlip;
}

// ============================================================
//  FAMILIA DIARIA (baja frecuencia) — investigación 2026-05-30
// ============================================================
// Objetivo realista: participar de la subida con MUCHO menos drawdown,
// NO generar alfa. Supervivencia a costes garantizada por baja frecuencia
// (1-8 trades/año/activo). Diseñadas para 'signal' exit (la propia regla
// es el trailing stop; sin TP/SL fijo) y timeframe DIARIO.

/** SMA simple del último valor sobre los últimos `period` cierres */
function smaLast(closes, period) {
  const n = closes.length;
  if (n < period) return NaN;
  let s = 0;
  for (let i = n - period; i < n; i++) s += closes[i];
  return s / period;
}

/** Volatilidad diaria (stdev de retornos log) sobre las últimas `n` velas, como fracción. */
export function dailyVol(closes, n = 20) {
  const c = closes.length;
  if (c < n + 1) return NaN;
  const rets = [];
  for (let i = c - n; i < c; i++) if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 2) return NaN;
  const m = rets.reduce((a, r) => a + r, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

/**
 * Filtro de ENTRADA del corto (research 2026-07 #8/#7b) — función PURA compartida por el motor y
 * el bot live para paridad. Devuelve true si se permite ABRIR un corto ahora. La señal larga NO
 * se toca (preserva el canal long-only validado). Todas las opciones off/0 → true (comportamiento
 * actual). Las variantes son SUSTITUTOS: no combinar band+confirm (infla el PBO), usar torneo.
 *
 * @param {Array<number>} closes  cierres diarios
 * @param {object} opts {
 *   smaPeriod,
 *   minDistBelowSigma  // banda: exigir precio ≤ SMA·(1 − k·σ20) → no shortear pegado a la media (#8A)
 *   requireSlopeDown, slopeLookback  // exigir SMA cayendo: SMA_t < SMA_{t−L} (#8A)
 *   confirmDays        // exigir N cierres consecutivos bajo la SMA (#8B)
 *   maxDistBelowSigma  // veto: NO shortear si el precio ya está ≥ k·σ20 bajo la SMA (sobre-extendido, #7b)
 * }
 */
export function shortEntryAllowed(closes, opts = {}) {
  const smaPeriod = opts.smaPeriod ?? 150;
  const sma = smaLast(closes, smaPeriod);
  const price = closes[closes.length - 1];
  if (!(sma > 0) || !(price > 0)) return true; // sin datos → no filtrar
  const distBelow = (sma - price) / sma; // >0 si el precio está por debajo de la SMA

  const sigma = dailyVol(closes, 20);
  const s = Number.isFinite(sigma) ? sigma : 0;

  // #8A banda: mínima distancia bajo la SMA (escalada por vol)
  if (opts.minDistBelowSigma > 0 && s > 0) {
    if (distBelow < opts.minDistBelowSigma * s) return false;
  }
  // #8A pendiente: la SMA debe estar cayendo
  if (opts.requireSlopeDown) {
    const L = opts.slopeLookback ?? 10;
    const smaPrev = smaLast(closes.slice(0, closes.length - L), smaPeriod);
    if (Number.isFinite(smaPrev) && !(sma < smaPrev)) return false;
  }
  // #8B confirmación: N cierres consecutivos bajo su SMA
  if (opts.confirmDays > 0) {
    const N = opts.confirmDays;
    for (let j = 0; j < N; j++) {
      const sub = closes.slice(0, closes.length - j);
      const smaJ = smaLast(sub, smaPeriod);
      if (!(sub[sub.length - 1] < smaJ)) return false;
    }
  }
  // #7b veto anti-rebote: no shortear si ya está demasiado por debajo (riesgo de squeeze)
  if (opts.maxDistBelowSigma > 0 && s > 0) {
    if (distBelow > opts.maxDistBelowSigma * s) return false;
  }
  return true;
}

/**
 * ESTRATEGIA SMA200 (Faber / market-timing de régimen) — rank 3 de la investigación.
 * La mejor evidencia cost-aware/OOS. In-or-out: invertido si close > SMA(period), cash si no.
 * BUY/SELL se emiten de forma continua; el engine compra una vez y vende una vez (in-or-out).
 */
export function evaluateStrategySMA200(candles, opts = {}) {
  const period = opts.smaPeriod ?? 200;
  // Banda de histéresis (fix #11 / investigación P2): solo entra si close > sma*(1+band)
  // y solo sale si close < sma*(1-band). band=0 → comportamiento histórico. Reduce el
  // whipsaw (cada round-trip in/out paga ~0.30%) cuando el cierre orbita la SMA.
  const band = opts.band ?? 0;
  // SALIDA ASIMÉTRICA (candidata 2026-09-05). `exitSmaPeriod` desacopla el timing de salida del
  // filtro de régimen: la SMA lenta sigue decidiendo SI se puede estar largo, y una SMA más
  // rápida decide CUÁNDO salir. Ataca el lag identificado en §17 (el recorrido pico→SMA150 no
  // está acotado). undefined = comportamiento histórico EXACTO (una sola SMA para ambos lados).
  //
  // Formulación coherente (evita el churn): se está DENTRO mientras el precio está por encima de
  // AMBAS; se sale al perder la rápida; se reentra al recuperarla (con la lenta aún válida). Sin
  // la condición de entrada sobre la rápida, cada caída bajo la SMA rápida saldría y recompraría
  // al día siguiente pagando el round-trip.
  const exitPeriod = opts.exitSmaPeriod;
  const { closes } = candles;
  if (closes.length < period + 1) return 'HOLD';
  const sma = smaLast(closes, period);
  const price = closes[closes.length - 1];

  if (exitPeriod && closes.length >= exitPeriod + 1) {
    const smaFast = smaLast(closes, exitPeriod);
    // La SALIDA manda: si se ha perdido la rápida, se sale aunque la lenta siga alcista.
    if (price < smaFast * (1 - band)) return 'SELL';
    if (price > sma * (1 + band) && price > smaFast) return 'BUY';
    return 'HOLD';
  }

  if (price > sma * (1 + band)) return 'BUY';
  if (price < sma * (1 - band)) return 'SELL';
  return 'HOLD';
}

/**
 * ESTRATEGIA SuperTrend DIARIO — rank 1. Reutiliza calculateSupertrend(10,3).
 * BUY mientras la tendencia del SuperTrend es alcista (+ gate opcional close>SMA200),
 * SELL cuando flipea a bajista. La banda ATR ES el trailing stop adaptativo.
 */
export function evaluateStrategySupertrendDaily(candles, opts = {}) {
  const period = opts.stPeriod ?? 10;
  const mult = opts.stMult ?? 3.0;
  const smaPeriod = opts.smaPeriod ?? 200;
  const useRegime = opts.useRegime ?? false;
  const { closes, highs, lows } = candles;
  const n = closes.length;
  const need = Math.max(period + 2, useRegime ? smaPeriod : 0) + 2;
  if (n < need) return 'HOLD';

  const st = calculateSupertrend(highs, lows, closes, period, mult);
  if (st.length < 1) return 'HOLD';
  const trend = st[st.length - 1].trend;

  let regimeOK = true;
  if (useRegime) regimeOK = closes[n - 1] > smaLast(closes, smaPeriod);

  if (trend === 1 && regimeOK) return 'BUY';
  if (trend === -1) return 'SELL';
  return 'HOLD';
}

/**
 * ESTRATEGIA Donchian / Turtle System 2 (55/20) DIARIO — rank 2.
 * BUY si close rompe el máximo de los `entryLen` días previos (+ gate close>SMA200);
 * SELL si close cae por debajo del mínimo de los `exitLen` días previos; si no, HOLD
 * (mantiene la posición → deja correr la tendencia). El canal de salida es el trailing stop.
 */
export function evaluateStrategyDonchian(candles, opts = {}) {
  const entryLen = opts.entryLen ?? 55;
  const exitLen = opts.exitLen ?? 20;
  const smaPeriod = opts.smaPeriod ?? 200;
  const useRegime = opts.useRegime ?? true;
  const { closes, highs, lows } = candles;
  const n = closes.length;
  const need = Math.max(entryLen, exitLen, useRegime ? smaPeriod : 0) + 2;
  if (n < need) return 'HOLD';

  const price = closes[n - 1];
  // Canales basados en CIERRES previos (coherente con ejecución a cierre del bot/backtest):
  //   entrada = ruptura del máximo cierre de los `entryLen` días previos
  //   salida  = pérdida del mínimo cierre de los `exitLen` días previos
  let maxC = -Infinity;
  for (let i = n - 1 - entryLen; i < n - 1; i++) if (closes[i] > maxC) maxC = closes[i];
  let minC = Infinity;
  for (let i = n - 1 - exitLen; i < n - 1; i++) if (closes[i] < minC) minC = closes[i];

  let regimeOK = true;
  if (useRegime) regimeOK = price > smaLast(closes, smaPeriod);

  if (price > maxC && regimeOK) return 'BUY';
  if (price < minC) return 'SELL';
  return 'HOLD';
}

// ============================================================
//  PRIMITIVAS DE CARTERA — vol-targeting, régimen BTC, rotación (investigación §2 + P3/P4)
// ============================================================

/** Periodos por año según el timeframe (cripto 24/7). Para anualizar vol/Sharpe. */
export function periodsPerYearFor(interval = '1d') {
  const map = {
    '1m': 365 * 24 * 60, '5m': 365 * 24 * 12, '15m': 365 * 24 * 4,
    '30m': 365 * 24 * 2, '1h': 365 * 24, '2h': 365 * 12, '4h': 365 * 6,
    '6h': 365 * 4, '12h': 365 * 2, '1d': 365, '3d': Math.round(365 / 3),
    '1w': 52,
  };
  return map[interval] || 365;
}

/**
 * Peso de vol-targeting (investigación §2.1, evidencia alta): w = clamp(targetVol/realizedVol, 0, wMax).
 * realizedVol = vol EWMA (RiskMetrics, λ=0.94) de retornos log, anualizada. En régimen tranquilo
 * w→wMax (invierte el tamaño base completo); en régimen volátil w→0 (recorta tamaño).
 * Spot long-only: wMax=1 (sin apalancamiento).
 *
 * @param {Array<number>} closes  cierres (timeframe del canal)
 * @param {object} opts { targetVolAnnual, lambda=0.94, wMax=1, periodsPerYear, minWeight=0 }
 * @returns {number} peso en [0, wMax]
 */
export function computeVolTargetWeight(closes, opts = {}) {
  // ⚠️ Auditoría 2026-08-29 (A5): esta función IGNORABA `opts.enabled`. `config.js` declaraba
  // `VOLTARGET.enabled = false` mientras dailyBot y longShortBot la llamaban incondicionalmente
  // → el vol-targeting estaba VIVO en los dos canales diarios y la config decía lo contrario.
  // Ahora se honra el flag y el default de config se ha puesto en `true`, que es la verdad
  // (y lo que `wfcore.lsBaseEngineOpts` ya forzaba para el backtest → paridad preservada).
  // enabled:false ⇒ peso wMax ⇒ sizing fijo por `RISK.positionSizePct`, sin escalar.
  const wMaxOff = opts.wMax ?? 1.0;
  if (opts.enabled === false) return wMaxOff;
  const targetVolAnnual = opts.targetVolAnnual ?? 0.5;
  const lambda = opts.lambda ?? 0.94;
  const wMax = opts.wMax ?? 1.0;
  const periodsPerYear = opts.periodsPerYear ?? 365;
  if (!closes || closes.length < 20) return wMax; // sin datos suficientes, no recortar

  // Retornos log
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return wMax;

  // Varianza EWMA: var_t = λ·var_{t-1} + (1-λ)·r_t². Semilla = varianza simple inicial.
  const seedWin = Math.min(20, rets.length);
  let mean0 = 0;
  for (let i = 0; i < seedWin; i++) mean0 += rets[i];
  mean0 /= seedWin;
  let varEwma = 0;
  for (let i = 0; i < seedWin; i++) varEwma += (rets[i] - mean0) ** 2;
  varEwma /= seedWin;
  for (let i = seedWin; i < rets.length; i++) {
    varEwma = lambda * varEwma + (1 - lambda) * rets[i] * rets[i];
  }
  const realizedVolAnnual = Math.sqrt(varEwma * periodsPerYear);
  if (!isFinite(realizedVolAnnual) || realizedVolAnnual <= 0) return wMax;

  let w = targetVolAnnual / realizedVolAnnual;
  if (w > wMax) w = wMax;
  if (w < 0) w = 0;
  if (w < (opts.minWeight ?? 0)) w = 0;
  return w;
}

/**
 * Vol-targeting CONDICIONAL por quintiles (research 2026-07 #4). En vez de escalar el tamaño de
 * forma continua, solo lo recorta cuando la vol EWMA está en el quintil ALTO (>P80) de su propia
 * distribución trailing; por debajo → exposición plena (wMax). Reduce el "churn" de re-sizing.
 * (En este bot el sizing solo aplica AL ENTRAR, así que el efecto es: no recortar el tamaño de
 * entrada salvo que se entre en un régimen de vol extrema.)
 */
export function computeVolTargetWeightConditional(closes, opts = {}) {
  const targetVolAnnual = opts.targetVolAnnual ?? 0.5;
  const lambda = opts.lambda ?? 0.94;
  const wMax = opts.wMax ?? 1.0;
  const periodsPerYear = opts.periodsPerYear ?? 365;
  const hiPct = opts.hiPct ?? 0.80;
  if (!closes || closes.length < 40) return wMax;

  const rets = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 30) return wMax;

  // Serie de varianza EWMA (guardamos cada paso para el percentil expanding)
  const seedWin = Math.min(20, rets.length);
  let mean0 = 0; for (let i = 0; i < seedWin; i++) mean0 += rets[i]; mean0 /= seedWin;
  let varE = 0; for (let i = 0; i < seedWin; i++) varE += (rets[i] - mean0) ** 2; varE /= seedWin;
  const series = [varE];
  for (let i = seedWin; i < rets.length; i++) { varE = lambda * varE + (1 - lambda) * rets[i] * rets[i]; series.push(varE); }

  const cur = series[series.length - 1];
  let below = 0; for (const v of series) if (v <= cur) below++;
  const pct = below / series.length;

  if (pct <= hiPct) return wMax; // vol normal/baja → exposición plena
  const realizedVolAnnual = Math.sqrt(cur * periodsPerYear);
  if (!(realizedVolAnnual > 0)) return wMax;
  let w = targetVolAnnual / realizedVolAnnual;
  if (w > wMax) w = wMax;
  if (w < 0) w = 0;
  return w;
}

/** Retorno trailing simple sobre los últimos `lookback` cierres (close[-1]/close[-1-lookback] - 1). */
export function trailingReturn(closes, lookback) {
  const n = closes.length;
  if (n < lookback + 1) return null;
  const a = closes[n - 1 - lookback];
  const b = closes[n - 1];
  if (!(a > 0)) return null;
  return b / a - 1;
}

/**
 * Detecta desplomes acelerados en BTC (crash de pánico).
 * Devuelve true si el retorno de BTC en los últimos `crashGuardLookbackDays` días fue menor a `-crashGuardMaxDropPct`.
 */
export function btcCrashGuard(btcCloses, opts = {}) {
  const lookback = opts.crashGuardLookbackDays ?? 3;
  const maxDropPct = opts.crashGuardMaxDropPct ?? 0.12;
  if (!btcCloses || btcCloses.length < lookback + 1) return false;
  const now = btcCloses[btcCloses.length - 1];
  const prev = btcCloses[btcCloses.length - 1 - lookback];
  if (!(prev > 0)) return false;
  const drop = (now - prev) / prev;
  return drop < -maxDropPct;
}

/**
 * Filtro maestro de régimen BTC (investigación §2.2 + mejora 2026-07-24): risk-on si el último cierre de BTC
 * está por encima de su SMA(period) Y no ha sufrido un desplome de pánico reciente (Crash Guard).
 */
export function btcRegimeOn(btcCloses, smaPeriod = 200, opts = {}) {
  if (!btcCloses || btcCloses.length < smaPeriod + 1) return true; // sin datos → no bloquear
  const crashGuardEnabled = opts.crashGuardEnabled ?? true;
  if (crashGuardEnabled && btcCrashGuard(btcCloses, opts)) return false;
  const sma = smaLast(btcCloses, smaPeriod);
  return btcCloses[btcCloses.length - 1] > sma;
}

/**
 * Rotación cross-sectional + dual-momentum (investigación P3+P4 + mejora 2026-07-24). Devuelve el set de símbolos
 * objetivo a mantener (equiponderados). Pasos:
 *  1) Relativo: rankea por retorno ajustado a volatilidad (Sharpe de 30d) o retorno bruto.
 *  2) Gate absoluto: solo conserva los que tienen momentum propio > 0 (sobre `absMomLookback`).
 *  3) Gate BTC: si BTC risk-off (SMA + Crash Guard), devuelve set vacío (todo a cash).
 *
 * @param {Object<string, Array<number>>} closesBySymbol  cierres diarios por símbolo
 * @param {object} opts { lookbackDays, topN, absMomLookback, btcCloses, useBtcRegime, btcSmaPeriod, useRiskAdjusted }
 * @returns {{ targets: string[], ranked: Array<{symbol,ret,score}>, riskOff: boolean }}
 */
export function computeRotationTargets(closesBySymbol, opts = {}) {
  const lookbackDays = opts.lookbackDays ?? 30;
  const topN = opts.topN ?? 5;
  const absMomLookback = opts.absMomLookback ?? 30;
  const useBtcRegime = opts.useBtcRegime ?? true;
  const btcSmaPeriod = opts.btcSmaPeriod ?? 200;
  const useRiskAdjusted = opts.useRiskAdjusted ?? true;

  // Gate maestro BTC (con crash guard)
  if (useBtcRegime && opts.btcCloses && !btcRegimeOn(opts.btcCloses, btcSmaPeriod, opts)) {
    return { targets: [], ranked: [], riskOff: true };
  }

  const ranked = [];
  for (const sym in closesBySymbol) {
    const closes = closesBySymbol[sym];
    const ret = trailingReturn(closes, lookbackDays);
    if (ret != null) {
      let score = ret;
      if (useRiskAdjusted && closes.length >= lookbackDays + 1) {
        // Volatilidad realizada de retornos log
        const rets = [];
        const slice = closes.slice(closes.length - 1 - lookbackDays);
        for (let i = 1; i < slice.length; i++) {
          if (slice[i - 1] > 0 && slice[i] > 0) rets.push(Math.log(slice[i] / slice[i - 1]));
        }
        if (rets.length > 5) {
          const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
          const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
          const std = Math.sqrt(variance);
          score = ret / Math.max(std * Math.sqrt(365), 0.05); // retorno ajustado a vol anualizada
        }
      }
      ranked.push({ symbol: sym, ret, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score);

  // Top-N relativo + gate de momentum absoluto propio
  const targets = [];
  for (const r of ranked) {
    if (targets.length >= topN) break;
    const absMom = trailingReturn(closesBySymbol[r.symbol], absMomLookback);
    if (absMom != null && absMom > 0) targets.push(r.symbol);
  }
  return { targets, ranked, riskOff: false };
}

/**
 * ¿Es la última vela CERRADA lo bastante reciente como para entrar a su precio de cierre?
 *
 * El canal diario ejecuta al cierre de la última vela cerrada — igual que el motor de backtest.
 * Si el cron dispara muchas horas más tarde (jitter del scheduler, recuperación de un fallo,
 * arranque en frío tras un deploy), ese precio ya no es el precio al que se puede operar, y el
 * backtest sobreestima el fill. Auditoría 2026-08-29 (H8): sesgo medido +0,25 %..+0,73 % del
 * nocional, contra un presupuesto TOTAL de costes del 0,30 %.
 *
 * Pura y fail-open: sin datos utilizables devuelve true (nunca bloquea por no saber).
 *
 * @param {Array<{closeTime:number}>} rawKlines  velas TAL CUAL las devuelve binanceService
 *   (incluida la vela EN FORMACIÓN al final, que es la que da el cierre de la anterior)
 * @param {number} maxHours  antigüedad máxima admitida desde el cierre
 * @param {number} now
 */
export function entriesAreFresh(rawKlines, maxHours = 6, now = Date.now()) {
  if (!Array.isArray(rawKlines) || rawKlines.length < 2) return true; // fail-open
  // La última vela está EN FORMACIÓN; la última CERRADA es la penúltima.
  const lastClosed = rawKlines[rawKlines.length - 2];
  const closeTime = Number(lastClosed && lastClosed.closeTime);
  if (!Number.isFinite(closeTime)) return true; // fail-open
  const ageHours = (now - closeTime) / 3600000;
  if (!Number.isFinite(ageHours) || ageHours < 0) return true; // reloj raro → no bloquear
  return ageHours <= maxHours;
}

/**
 * ¿Salió este símbolo por stop/trail en la vela `candleTime` (o una posterior a ella)?
 * El motor de backtest no re-entra tras un stop hasta la vela SIGUIENTE; el cron live corre cada
 * 15 min sobre la MISMA vela cerrada, así que sin esta guarda reabría al mismo precio de salida
 * (auditoría 2026-09-29 §20.3). Pura: `lastExitCandle` es { SYMBOL: openTime de la vela de salida }.
 */
export function exitedOnSameCandle(lastExitCandle, symbol, candleTime) {
  const t = lastExitCandle && lastExitCandle[symbol];
  return t != null && Number.isFinite(t) && candleTime <= t;
}

// ============================================================
//  MACRO OSCILLATOR & ANTI-FOMO (Videos 1 & 2)
// ============================================================

/**
 * Calcula la serie completa del oscilador macro normalizado: (SMA_fast - SMA_slow) / SMA_slow * 100
 * @param {number[]} closes 
 * @param {number} fastPeriod (default 50)
 * @param {number} slowPeriod (default 200)
 * @returns {Array<number|null>}
 */
export function calculateMacroOscillator(closes, fastPeriod = 50, slowPeriod = 200) {
  const n = closes.length;
  const osc = new Array(n).fill(null);
  if (n < slowPeriod) return osc;

  let sumFast = 0;
  let sumSlow = 0;

  for (let i = 0; i < n; i++) {
    sumFast += closes[i];
    sumSlow += closes[i];

    if (i >= fastPeriod) sumFast -= closes[i - fastPeriod];
    if (i >= slowPeriod) sumSlow -= closes[i - slowPeriod];

    if (i >= slowPeriod - 1) {
      const smaFast = sumFast / fastPeriod;
      const smaSlow = sumSlow / slowPeriod;
      osc[i] = smaSlow !== 0 ? ((smaFast - smaSlow) / smaSlow) * 100 : 0;
    }
  }
  return osc;
}

/**
 * Calcula la Bull Market Support Band: EMA 20 semanas (~140 días) + SMA 21 semanas (~147 días)
 * @param {number[]} closes
 * @param {number} emaPeriod (default 140)
 * @param {number} smaPeriod (default 147)
 */
export function calculateBullMarketSupportBand(closes, emaPeriod = 140, smaPeriod = 147) {
  const emaVals = calculateEMA(closes, emaPeriod);
  const ema20w = new Array(closes.length).fill(null);
  if (Array.isArray(emaVals) && emaVals.length > 0) {
    const offset = closes.length - emaVals.length;
    for (let i = 0; i < emaVals.length; i++) {
      ema20w[offset + i] = emaVals[i];
    }
  }

  const sma21w = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= smaPeriod) sum -= closes[i - smaPeriod];
    if (i >= smaPeriod - 1) sma21w[i] = sum / smaPeriod;
  }

  return { ema20w, sma21w };
}

/**
 * Calcula la racha (streak) de días/velas consecutivas sin una corrección >= thresholdPct (15%) desde el último pico.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} thresholdPct (default 0.15 = 15%)
 */
export function calculateCorrectionStreak(highs, lows, closes, thresholdPct = 0.15) {
  const n = closes.length;
  const streaks = new Array(n).fill(0);
  if (n === 0) return streaks;

  let peak = highs && highs[0] != null ? highs[0] : closes[0];
  let currentStreak = 0;

  for (let i = 0; i < n; i++) {
    const h = (highs && highs[i] != null) ? highs[i] : closes[i];
    const l = (lows && lows[i] != null) ? lows[i] : closes[i];

    if (h > peak) peak = h;

    const dd = peak > 0 ? (peak - l) / peak : 0;
    if (dd >= thresholdPct) {
      currentStreak = 0;
      peak = closes[i];
    } else {
      currentStreak++;
    }
    streaks[i] = currentStreak;
  }
  return streaks;
}

/**
 * ESTRATEGIA MACRO OSCILLATOR & ANTI-FOMO (Videos 1 & 2)
 * 
 * - Entrada BUY:
 *   1. Divergencia alcista en Zona Verde (descuento extremo < -6%).
 *   2. Apoyo / Rebote en Línea Cero (Osc ~ 0 con precio > SMA200).
 *   3. Cruce alcista de Cero estándar (si el filtro Anti-FOMO lo permite).
 *   4. Buy The Dip en la Bull Market Support Band tras racha prolongada.
 * - Salida SELL:
 *   1. Take profit en Zona Morada (sobreextensión extrema > 28% y desaceleración).
 *   2. Pérdida del soporte en Cero (Osc < -2% con precio < SMA200).
 *   3. Death cross confirmada (cierre bajo SMA200 y Osc <= 0).
 */
export function evaluateStrategyMacroOscillator(candles, opts = {}) {
  const fastPeriod = opts.fastPeriod ?? 50;
  const slowPeriod = opts.slowPeriod ?? 200;
  const greenZone = opts.greenZoneThreshold ?? -6.0;
  const purpleZone = opts.purpleZoneThreshold ?? 28.0;
  const zeroExit = opts.zeroExitThreshold ?? -2.0;
  const fomoStreakDays = opts.fomoStreakDays ?? 85;
  const correctionPct = opts.correctionPct ?? 0.15;
  const emaWeekly = opts.bmsbEmaPeriod ?? 140;
  const smaWeekly = opts.bmsbSmaPeriod ?? 147;

  const { closes, highs, lows } = candles;
  const n = closes ? closes.length : 0;
  if (n < slowPeriod + 10) return 'HOLD';

  const osc = calculateMacroOscillator(closes, fastPeriod, slowPeriod);
  const currentOsc = osc[n - 1];
  const prevOsc = osc[n - 2];
  const prev2Osc = osc[n - 3];

  if (currentOsc === null || prevOsc === null) return 'HOLD';

  const currentPrice = closes[n - 1];
  const smaSlow = smaLast(closes, slowPeriod);

  // Bull Market Support Band
  const { ema20w, sma21w } = calculateBullMarketSupportBand(closes, emaWeekly, smaWeekly);
  const bmsbLow = Math.min(ema20w[n - 1] || smaSlow, sma21w[n - 1] || smaSlow);
  const bmsbHigh = Math.max(ema20w[n - 1] || smaSlow, sma21w[n - 1] || smaSlow);

  // Racha sin corrección >= 15%
  const streaks = calculateCorrectionStreak(highs || closes, lows || closes, closes, correctionPct);
  const currentStreak = streaks[n - 1];
  const isOverextendedStreak = currentStreak >= fomoStreakDays;

  // 1. Detección de Divergencia Alcista en Zona Verde
  let isBullDiv = false;
  if (currentOsc < greenZone) {
    let lookbackMinOsc = Infinity;
    let lookbackMinPrice = Infinity;
    const lookbackStart = Math.max(0, n - 45);
    const lookbackEnd = Math.max(0, n - 10);
    const lowSeries = lows || closes;

    for (let k = lookbackStart; k <= lookbackEnd; k++) {
      if (osc[k] !== null) {
        if (osc[k] < lookbackMinOsc) lookbackMinOsc = osc[k];
        if (lowSeries[k] < lookbackMinPrice) lookbackMinPrice = lowSeries[k];
      }
    }

    const currentLow = lowSeries[n - 1];
    const priceNearOrLower = currentLow <= lookbackMinPrice * 1.04;
    const oscHigher = currentOsc > lookbackMinOsc + 2.5;
    const oscTurningUp = currentOsc > prevOsc && prevOsc >= (prev2Osc ?? prevOsc);

    if (priceNearOrLower && oscHigher && oscTurningUp) {
      isBullDiv = true;
    }
  }

  // 2. Apoyo en Línea Cero durante tendencia alcista macro
  const isZeroBounce = prevOsc >= -1.0 && prevOsc <= 3.5 && currentOsc > prevOsc && currentPrice > smaSlow;

  // 3. Cruce alcista de Cero estándar
  const isStandardCross = prevOsc < 0 && currentOsc >= 0;

  // 4. Testeo de Bull Market Support Band
  const isTouchingBMSB = (lows ? lows[n - 1] : currentPrice) <= bmsbHigh * 1.02 && currentPrice >= bmsbLow * 0.97;

  // Evaluar condiciones de BUY
  let canBuy = false;
  if (isBullDiv) {
    canBuy = true;
  } else if (isZeroBounce) {
    canBuy = true;
  } else if (isStandardCross) {
    if (!isOverextendedStreak || isTouchingBMSB) {
      canBuy = true;
    }
  } else if (isOverextendedStreak && isTouchingBMSB && currentPrice > bmsbLow && currentOsc > 0 && currentPrice > smaSlow) {
    canBuy = true;
  }

  // Evaluar condiciones de SELL / Salida
  const isPurpleTakeProfit = currentOsc > purpleZone && currentOsc < prevOsc && prevOsc > (prev2Osc ?? prevOsc);
  const isZeroLossExit = currentOsc < zeroExit && currentPrice < smaSlow;
  const isDeathCross = prevOsc > 0 && currentOsc <= 0 && currentPrice < smaSlow;

  if (isPurpleTakeProfit || isZeroLossExit || isDeathCross) {
    return 'SELL';
  }
  if (canBuy) {
    return 'BUY';
  }
  return 'HOLD';
}


/**
 * validation.js — Estadística de validación rigurosa de estrategias (investigación §3).
 *
 * Funciones PURAS (testables) para combatir el overfitting y el data-snooping:
 *  - bootstrapTradeCI: intervalos de confianza por remuestreo de la secuencia de trades (§3.2a)
 *  - blockBootstrapReturns: surrogate de retornos preservando clústeres de volatilidad (§3.2b)
 *  - deflatedSharpe: Sharpe deflactado por nº de pruebas (Bailey & López de Prado, §3.3)
 *  - probabilityOfBacktestOverfitting: PBO vía CSCV (§3.4)
 * El audit (#17/#34) señaló que el proyecto reportaba PF/WR/Sharpe sin IC, sobre muestras
 * pequeñas, y elegía el mejor de ~18 configs sin corrección de multiple-testing.
 */

export const EULER_MASCHERONI = 0.5772156649015329;

// ───────────────────────── Estadística básica ─────────────────────────
export function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
export function variance(xs, m = mean(xs)) {
  return xs.length ? xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length : 0;
}
export function std(xs) { return Math.sqrt(variance(xs)); }

export function skewness(xs) {
  const n = xs.length; if (n < 3) return 0;
  const m = mean(xs); const s = std(xs); if (s === 0) return 0;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / n;
}
export function kurtosis(xs) {
  const n = xs.length; if (n < 4) return 3;
  const m = mean(xs); const s = std(xs); if (s === 0) return 3;
  return xs.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n; // kurtosis NO en exceso
}

// CDF normal estándar (Abramowitz & Stegun 7.1.26)
export function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Inversa de la CDF normal (Peter Acklam). Para E[max Sharpe] de la DSR.
export function normalInvCDF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

// PRNG determinista (Mulberry32) → resultados reproducibles sin Math.random.
export function makeRng(seed = 12345) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Bootstrap de la secuencia de trades (§3.2a). Remuestrea los retornos POR TRADE con reemplazo
 * y compone el ROI; devuelve IC del ROI, prob. de pérdida y prob. de drawdown severo.
 *
 * @param {Array<number>} tradeProfitPcts  retorno % por trade (sobre el capital arriesgado)
 * @param {object} opts { iters=5000, seed=12345, ruinThresholdPct=-20 }
 */
export function bootstrapTradeCI(tradeProfitPcts, opts = {}) {
  const iters = opts.iters ?? 5000;
  const ruinPct = opts.ruinThresholdPct ?? -20;
  const rng = makeRng(opts.seed ?? 12345);
  const n = tradeProfitPcts.length;
  if (n < 5) return { n, insufficient: true };

  const rois = [];
  let nLoss = 0, nRuin = 0;
  for (let it = 0; it < iters; it++) {
    let growth = 1;
    for (let k = 0; k < n; k++) {
      const r = tradeProfitPcts[Math.floor(rng() * n)];
      growth *= (1 + r / 100);
    }
    const roi = (growth - 1) * 100;
    rois.push(roi);
    if (roi < 0) nLoss++;
    if (roi <= ruinPct) nRuin++;
  }
  rois.sort((a, b) => a - b);
  return {
    n,
    medianROI: parseFloat(percentile(rois, 0.5).toFixed(2)),
    ci5: parseFloat(percentile(rois, 0.05).toFixed(2)),
    ci95: parseFloat(percentile(rois, 0.95).toFixed(2)),
    pLoss: parseFloat((nLoss / iters).toFixed(3)),
    [`pBelow${ruinPct}pct`]: parseFloat((nRuin / iters).toFixed(3)),
  };
}

/**
 * Block bootstrap de una serie de RETORNOS (§3.2b): preserva el clúster de volatilidad
 * (autocorrelación) reordenando bloques contiguos. Para tests de permutación de precios.
 */
export function blockBootstrapReturns(returns, blockSize = 20, rng = makeRng()) {
  const n = returns.length;
  if (n === 0) return [];
  const out = [];
  while (out.length < n) {
    const start = Math.floor(rng() * n);
    for (let i = 0; i < blockSize && out.length < n; i++) {
      out.push(returns[(start + i) % n]);
    }
  }
  return out.slice(0, n);
}

/** Reconstruye una serie de precios a partir de retornos log y un precio inicial. */
export function pricesFromLogReturns(logRets, p0 = 100) {
  const out = [p0];
  let p = p0;
  for (const r of logRets) { p *= Math.exp(r); out.push(p); }
  return out;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado, §3.3). Descuenta el Sharpe observado por el
 * nº de pruebas N y la varianza entre Sharpes de las pruebas. Devuelve la probabilidad de que
 * el Sharpe verdadero sea > 0 dado el data-snooping. Requiere DSR > 0.95 para fiarse.
 *
 * @param {object} p { sharpe, nTrials, varTrialSharpe, T, skew=0, kurt=3 }
 *   sharpe: Sharpe observado (no anualizado, por-periodo); T: nº de observaciones de retorno.
 */
export function deflatedSharpe({ sharpe, nTrials, varTrialSharpe, T, skew = 0, kurt = 3 }) {
  if (!(T > 1) || !(nTrials >= 1)) return null;
  const sqrtVar = Math.sqrt(Math.max(varTrialSharpe, 1e-12));
  // E[max Sharpe] bajo el nulo (N pruebas independientes). Con nTrials=1 no hay deflación
  // (expectedMax=0) → la DSR se reduce a un test de significancia del Sharpe.
  let expectedMax = 0;
  if (nTrials > 1) {
    const z1 = normalInvCDF(1 - 1 / nTrials);
    const z2 = normalInvCDF(1 - 1 / (nTrials * Math.E));
    expectedMax = sqrtVar * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2);
  }
  // DSR = Φ( (SR - E[maxSR]) * sqrt(T-1) / sqrt(1 - skew·SR + (kurt-1)/4·SR²) )
  const denom = Math.sqrt(Math.max(1e-12, 1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe));
  const dsr = normalCDF(((sharpe - expectedMax) * Math.sqrt(T - 1)) / denom);
  return {
    expectedMaxSharpe: parseFloat(expectedMax.toFixed(4)),
    deflatedSharpe: parseFloat(dsr.toFixed(4)),
    passes: dsr > 0.95,
  };
}

/**
 * Probability of Backtest Overfitting vía CSCV (§3.4). perfMatrix[chunk][config] = performance
 * de cada config en cada bloque temporal (p.ej. suma de retornos del bloque). Particiona los
 * S bloques en IS/OOS, elige el mejor config IS y mide su rango OOS. PBO = fracción de
 * combinaciones donde el ganador IS cae en la mitad inferior OOS. PBO < 0.5 (ideal < 0.2).
 *
 * @param {number[][]} perfMatrix  filas=bloques temporales (S), columnas=configs (Nc)
 */
export function probabilityOfBacktestOverfitting(perfMatrix) {
  const S = perfMatrix.length;
  if (S < 4 || S % 2 !== 0) return { error: `Se requiere S par y >=4 (S=${S})` };
  const Nc = perfMatrix[0].length;
  if (Nc < 2) return { error: 'Se requieren >=2 configs' };

  const idx = [...Array(S).keys()];
  // Todas las combinaciones de S/2 bloques como IS
  const combos = [];
  const choose = (start, picked) => {
    if (picked.length === S / 2) { combos.push([...picked]); return; }
    for (let i = start; i < S; i++) { picked.push(i); choose(i + 1, picked); picked.pop(); }
  };
  choose(0, []);

  let belowMedian = 0;
  const logits = [];
  for (const isSet of combos) {
    const isMask = new Set(isSet);
    const oosSet = idx.filter(i => !isMask.has(i));
    // Performance IS y OOS por config = suma sobre los bloques
    const isPerf = new Array(Nc).fill(0);
    const oosPerf = new Array(Nc).fill(0);
    for (const c of isSet) for (let j = 0; j < Nc; j++) isPerf[j] += perfMatrix[c][j];
    for (const c of oosSet) for (let j = 0; j < Nc; j++) oosPerf[j] += perfMatrix[c][j];
    // Mejor config IS
    let best = 0; for (let j = 1; j < Nc; j++) if (isPerf[j] > isPerf[best]) best = j;
    // Rango OOS del ganador (1 = peor, Nc = mejor)
    const sortedOOS = [...oosPerf].sort((a, b) => a - b);
    const rank = sortedOOS.indexOf(oosPerf[best]) + 1;
    const relRank = rank / Nc; // (0,1]
    if (relRank <= 0.5) belowMedian++;
    // logit del rango relativo (evitando 0/1)
    const w = Math.min(0.999, Math.max(0.001, relRank));
    logits.push(Math.log(w / (1 - w)));
  }
  return {
    pbo: parseFloat((belowMedian / combos.length).toFixed(3)),
    combinations: combos.length,
    medianLogit: parseFloat((logits.slice().sort((a, b) => a - b)[Math.floor(logits.length / 2)]).toFixed(3)),
    passes: (belowMedian / combos.length) < 0.5,
  };
}

import BacktestEngine from './backtestEngine.js';
import { VOLTARGET, LONGSHORT, STRATEGY_OPTS, SMA_PERIOD } from './config.js';

/**
 * Núcleo de walk-forward de VENTANA ANCLADA EXPANSIVA, reutilizable por walkforward.js y abtest.js.
 * Para cada fold i (1..folds-1): dataset = TODO hasta el fin del fold (warmup completo), evaluado
 * SOLO en el segmento OOS [from_i, to_i) vía el split del motor. Devuelve filas por fold + resumen.
 *
 * @param {Object} dataBySymbol  datos ya descargados { SYMBOL: [{time,open,high,low,close,volume}] }
 * @param {Object} cfg  { folds, engineOpts }  engineOpts = overrides del BacktestEngine (mergeados)
 */
export async function runWalkForward(dataBySymbol, cfg = {}) {
  const folds = cfg.folds ?? 8;
  const symbols = Object.keys(dataBySymbol).filter(s => (dataBySymbol[s] || []).length > 0);
  let tMin = Infinity, tMax = -Infinity;
  for (const s of symbols) for (const k of dataBySymbol[s]) { if (k.time < tMin) tMin = k.time; if (k.time > tMax) tMax = k.time; }
  const foldLen = (tMax - tMin) / folds;

  const rows = [];
  for (let i = 1; i < folds; i++) {
    const from = tMin + i * foldLen;
    const to = i === folds - 1 ? tMax + 1 : tMin + (i + 1) * foldLen;
    const anchored = {};
    for (const s of symbols) anchored[s] = dataBySymbol[s].filter(k => k.time < to);
    const total = Object.values(anchored).reduce((a, d) => a + d.length, 0);
    if (total < 50) { rows.push({ fold: i + 1, skipped: true }); continue; }
    const oosRatio = (from - tMin) / (to - tMin);

    const orig = console.log; console.log = () => {};
    let r;
    try {
      // `engineClass` permite validar canales con motor propio (p.ej. RotationBacktestEngine)
      // por el MISMO walk-forward pareado y el MISMO gate de adopción.
      const Engine = cfg.engineClass || BacktestEngine;
      const engine = new Engine({
        symbols: [...symbols], dataBySymbol: anchored, oosSplitRatio: oosRatio,
        ...cfg.engineOpts,
      });
      r = await engine.run();
    } finally { console.log = orig; }

    const s = r.holdoutSummary || r.summary;
    const calmarW = s.calmar == null ? null : Math.max(-10, Math.min(10, s.calmar));
    rows.push({
      fold: i + 1,
      from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10),
      trades: s.totalTrades, roi: s.roi, pf: s.profitFactor, sharpe: s.sharpe, calmar: calmarW,
      maxDD: s.maxDrawdown,
      hodlRoi: (s.buyHold && s.buyHold.roi != null) ? s.buyHold.roi : (r.summary.buyHold ? r.summary.buyHold.roi : null),
    });
  }
  return { rows, summary: summarize(rows) };
}

/**
 * Resumen por folds.
 *
 * ⚠️ Auditoría 2026-08-29 (H7): antes esto era `rows.filter(r => !r.skipped && r.trades > 0)`,
 * es decir los folds SIN TRADES se BORRABAN del resumen. Eso rompe el emparejamiento que da
 * nombre al "gate pareado": una variante que se va a cash en un fold malo simplemente pierde
 * ese fold del cómputo y mejora mediana, IQR y peor-fold sin haber ganado nada. Irse a cash es
 * un RESULTADO (roi 0, calmar 0), no un dato ausente — y ahora se cuenta como tal.
 *
 * `valid` pasa a ser el nº de folds EVALUADOS (no saltados), de modo que dos variantes solo son
 * comparables si coinciden. `withTrades` conserva el conteo antiguo para diagnóstico.
 */
export function summarize(rows, opts = {}) {
  const includeFlat = opts.includeFlatFolds !== false;
  const evaluated = rows.filter(r => !r.skipped);
  const valid = includeFlat
    ? evaluated.map(r => (r.trades > 0 ? r : { ...r, roi: 0, calmar: 0, sharpe: 0, maxDD: 0, pf: null, flat: true }))
    : evaluated.filter(r => r.trades > 0);
  if (valid.length === 0) return { valid: 0, withTrades: 0 };
  const sorted = (key) => valid.map(r => r[key]).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : null;
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null;
  const cal = sorted('calmar');
  return {
    valid: valid.length,
    withTrades: valid.filter(r => !r.flat).length,
    flatFolds: valid.filter(r => r.flat).length,
    medianROI: median(sorted('roi')),
    medianSharpe: median(sorted('sharpe')),
    medianCalmar: median(cal),
    iqrCalmar: cal.length >= 4 ? parseFloat((q(cal, 0.75) - q(cal, 0.25)).toFixed(2)) : null,
    worstCalmar: cal.length ? cal[0] : null,
    foldsPosRoi: valid.filter(r => r.roi > 0).length,
    foldsPfOk: valid.filter(r => r.pf == null || r.pf >= 1).length,
  };
}

// Config base del canal LS (reproduce el live) para las variantes de abtest.
export function lsBaseEngineOpts(extra = {}) {
  return {
    interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal', longShort: true,
    regimeOpts: { ...STRATEGY_OPTS, smaPeriod: SMA_PERIOD, band: 0 },
    volTarget: { ...VOLTARGET, enabled: true },
    shortStopPct: LONGSHORT.shortStopPct, shortStopCooldown: LONGSHORT.shortStopCooldownDays,
    maxConcurrentPositions: LONGSHORT.maxConcurrentPositions, maxExposurePct: LONGSHORT.maxExposurePct,
    fundingMode: 'real',
    bufferSize: SMA_PERIOD + 60, minCandles: SMA_PERIOD + 10,
    ...extra,
  };
}

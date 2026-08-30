/**
 * build-dashboard-data.js — Destila los artefactos de análisis en `public/data/analysis.json`.
 *
 * Los artefactos crudos pesan ~800 KB entre todos (curvas de equity a resolución diaria, historiales
 * completos, matrices de permutaciones). Servir eso a un navegador sería absurdo. Este script se
 * queda solo con lo que el panel dibuja, submuestreando las curvas y recortando los trades.
 *
 * No recalcula NADA: si una cifra no está en el artefacto, no aparece en el panel. Así el panel no
 * puede discrepar de `AUDIT_REPORT.md` — ambos leen la misma fuente.
 *
 * Uso:  node build-dashboard-data.js
 */
import fs from 'fs';
import path from 'path';

const OUT_DIR = 'public/data';
const MAX_CURVE_POINTS = 220;

const read = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
};

/**
 * Submuestreo que CONSERVA los extremos: un mínimo de drawdown no puede desaparecer del plot.
 * Devuelve ARRAYS PARALELOS `{t:[epochMs], v:[valor]}` en vez de un array de objetos: el mismo
 * dibujo ocupa ~4× menos, que en una página que carga todo de golpe sí se nota.
 */
function compactCurve(curve, key = 'equity', max = MAX_CURVE_POINTS) {
  const pts = downsample(curve, key, max);
  const t = [], v = [];
  for (const p of pts) {
    const ms = new Date(p.time).getTime();
    if (!Number.isFinite(ms)) continue;
    t.push(ms);
    v.push(Math.round((p[key] ?? 0) * 100) / 100);
  }
  return { t, v };
}

function downsample(curve, key = 'equity', max = MAX_CURVE_POINTS) {
  if (!Array.isArray(curve) || curve.length <= max) return curve || [];
  const bucket = Math.ceil(curve.length / max);
  const out = [];
  for (let i = 0; i < curve.length; i += bucket) {
    const slice = curve.slice(i, i + bucket);
    let lo = slice[0], hi = slice[0];
    for (const p of slice) {
      if (p[key] < lo[key]) lo = p;
      if (p[key] > hi[key]) hi = p;
    }
    // Orden temporal dentro del bucket, para no dibujar dientes de sierra falsos.
    const pair = new Date(lo.time) <= new Date(hi.time) ? [lo, hi] : [hi, lo];
    out.push(pair[0]);
    if (pair[1] !== pair[0]) out.push(pair[1]);
  }
  const last = curve[curve.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function pruneBacktest(raw, label) {
  if (!raw || !raw.summary) return null;
  const s = raw.summary;
  const pick = (m) => m && ({
    totalTrades: m.totalTrades, winRate: m.winRate, profitFactor: m.profitFactor,
    roi: m.roi, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe, calmar: m.calmar,
    avgWin: m.avgWin, avgLoss: m.avgLoss, expectancy: m.expectancy,
    books: m.booksSignalOnly || m.books || null,
  });
  return {
    label,
    strategy: s.strategy,
    months: s.periodMonths,
    symbols: s.symbols,
    costs: s.costs,
    signalMode: !!s.signalMode,
    benchmark: { basket: s.buyHold || null, btc: s.btcHold || null },
    full: pick(s),
    train: pick(raw.trainSummary),
    holdout: pick(raw.holdoutSummary),
    entryInWindow: raw.holdoutSummary?.entryInWindow || null,
    truncation: s.truncation || null,
    byReason: s.byReason || null,
    bySymbol: s.bySymbol || null,
    curves: {
      equity: compactCurve(raw.equityCurve, 'equity'),
      benchmark: compactCurve(raw.benchmarkCurve, 'equity'),
      drawdown: compactCurve(raw.drawdownCurve, 'drawdown'),
    },
    // Los trades alimentan el histograma de resultados y la tabla; sin precios ni fase.
    trades: (raw.trades || []).map((t) => ({
      s: t.symbol, d: t.side || 'long',
      p: t.profit, pc: t.profitPct,
      i: new Date(t.buyTime).getTime(), o: new Date(t.sellTime).getTime(),
      r: t.reason,
    })),
  };
}

function pruneRobustGate(raw) {
  if (!raw || !raw.rows) return null;
  return {
    tournament: raw.tournament, months: raw.months, folds: raw.folds,
    perms: raw.perms, seed: raw.seed, longOnly: raw.longOnly,
    quote: (raw.symbols?.[0] || '').endsWith('USDT') ? 'USDT' : 'USDC',
    rows: raw.rows.map((r) => ({
      name: r.name, medianCalmar: r.medianCalmar, iqrCalmar: r.iqrCalmar,
      worstCalmar: r.worstCalmar, spreadByOrder: r.spreadByOrder,
      meanDelta: r.meanDelta, ci: r.ci, p: r.p, verdict: r.verdict,
    })),
  };
}

const analysis = {
  generatedAt: new Date().toISOString(),

  // Backtests en MODO SEÑAL: miden lo mismo que el bot live desde 2026-08-29.
  signalBacktests: [
    pruneBacktest(read('signal-backtest-daily.json'), 'SMA150-1d · long-only'),
    pruneBacktest(read('signal-backtest-ls.json'), 'SMA150-LS · long/short'),
  ].filter(Boolean),

  // Backtest en modo CARTERA: el que sostiene el gate de adopción (con drawdown y Calmar reales).
  // Del backtest en modo CARTERA solo interesan sus métricas y el contrafactual: su curva no se
  // dibuja (el panel es de señales), así que no se embarca.
  portfolioBacktest: (() => {
    const b = pruneBacktest(read('backtest-results.json'), 'SMA150-LS · cartera');
    if (b) { b.curves = null; b.trades = []; }
    return b;
  })(),

  rotation: {
    backtest: (() => {
      const b = pruneBacktest(read('rotation-backtest-results.json'), 'ROT-dual-mom');
      if (b) b.trades = [];   // la tabla de ROT no se pinta; sus métricas sí
      return b;
    })(),
    walkforward: read('rotation-walkforward-results.json'),
    walkforwardRiskOff: read('rotation-walkforward-riskoff.json'),
  },

  walkforward: read('walkforward-results.json'),

  // Torneos con el gate ROBUSTO (permutaciones + bootstrap de clúster). Es lo que decide.
  robustGate: [
    'robustgate-kappa-usdc.json', 'robustgate-kappa-usdt.json',
    'robustgate-sizing-usdc.json', 'robustgate-sizing-usdt.json',
    'robustgate-btcgate-usdc.json', 'robustgate-btcgate-usdt.json',
    'robustgate-btcgate_off-usdc.json', 'robustgate-btcgate_off-usdt.json',
  ].map((f) => pruneRobustGate(read(f))).filter(Boolean),
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'analysis.json');
fs.writeFileSync(outFile, JSON.stringify(analysis));

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`📊 ${outFile} — ${kb} KB`);
console.log(`   backtests en modo señal : ${analysis.signalBacktests.length}`);
console.log(`   torneos del gate robusto: ${analysis.robustGate.length}`);
console.log(`   rotación                : ${analysis.rotation.backtest ? 'sí' : 'no'}`);
for (const b of analysis.signalBacktests) {
  console.log(`   · ${b.label}: ${b.curves.equity.t.length} puntos de curva, ${b.trades.length} operaciones`);
}

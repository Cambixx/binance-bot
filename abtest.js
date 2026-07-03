/**
 * abtest.js — Torneo de VARIANTES vs baseline con walk-forward pareado (research 2026-07 #2).
 *
 * Descarga los datos UNA sola vez y corre cada variante por los MISMOS folds → comparación pareada
 * justa. Aplica el gate de adopción: una variante se ADOPTA solo si Calmar mediano ≥ baseline,
 * IQR de Calmar ≤ baseline (menos dependencia de régimen) y el peor fold no empeora.
 *
 * Uso:  node abtest.js [--months=42] [--folds=8] [--symbols=A,B,...]
 * Edita VARIANTS para definir el torneo (patrón sweep.js). Cada `opts` se mergea sobre el baseline.
 */
import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import binance from './binanceService.js';
import { runWalkForward, lsBaseEngineOpts } from './wfcore.js';
import { BLACKLIST, VOLTARGET } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };
const MONTHS = getNum('--months=', 42);
const FOLDS = getNum('--folds=', 8);
let SYMBOLS = getStr('--symbols=', '') ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
SYMBOLS = SYMBOLS.filter(s => !BLACKLIST.some(b => s.includes(b)));

// ─────────── TORNEO: baseline + variantes (opts = overrides del engine sobre lsBaseEngineOpts) ───────────
// El baseline SIEMPRE va primero. Edita esta lista para cada experimento.
// Baseline = config actual (confirm3d + ATR-trail 3.0 + funding real). Se prueban #6/#7a ENCIMA.
const VARIANTS = [
  { name: 'baseline (adoptado)', opts: {} },
  // #7a: de-risk del corto en PÁNICO (BTC 60d < −30% Y vol > P80) → corto al 50%
  { name: '#7a panic-derisk', opts: { panicDerisk: { btcLookback: 60, btcThreshold: -0.30, volPct: 0.80, multiplier: 0.5 } } },
  // #6: kill-switch de funding negativo persistente (30d acumulado < 0) → corto al 50%
  { name: '#6 funding-kill', opts: { fundingKill: { avgDays: 30, threshold: 0, multiplier: 0.5 } } },
  { name: '#6+#7a combinado', opts: {
    panicDerisk: { btcLookback: 60, btcThreshold: -0.30, volPct: 0.80, multiplier: 0.5 },
    fundingKill: { avgDays: 30, threshold: 0, multiplier: 0.5 },
  } },
];

function pad(v, n) { return String(v ?? '—').padEnd(n); }

async function main() {
  console.error(`\n🔬 ABTEST — ${MONTHS}m · ${FOLDS} folds · ${SYMBOLS.join(',')} · ${VARIANTS.length} variantes`);
  console.error('📥 Descargando datos (una vez)...');
  const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval: '1d' });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const dataBySymbol = {};
  for (const s of fetcher.symbols) dataBySymbol[s] = await fetcher.fetchHistoricalData(s);

  // Prefetch del funding real UNA vez (todas las variantes LS lo comparten).
  let tMin = Infinity, tMax = -Infinity;
  for (const s in dataBySymbol) for (const k of dataBySymbol[s]) { if (k.time < tMin) tMin = k.time; if (k.time > tMax) tMax = k.time; }
  console.error('💱 Descargando funding real...');
  const fundingSeries = await binance.getFundingCumSeries([...fetcher.symbols], tMin, tMax + 86400000);

  const results = [];
  for (const v of VARIANTS) {
    const engineOpts = lsBaseEngineOpts({ months: MONTHS, fundingSeries, ...v.opts });
    const { rows, summary } = await runWalkForward(dataBySymbol, { folds: FOLDS, engineOpts });
    results.push({ ...v, rows, summary });
    console.error(`   ✓ ${v.name}`);
  }

  const base = results[0].summary;
  console.error('\n══════════════════ RESULTADOS (holdout por fold) ══════════════════');
  console.error(pad('VARIANTE', 26) + pad('nFolds', 7) + pad('CalmarMed', 11) + pad('IQR', 7) + pad('Peor', 7) + pad('SharpeMed', 10) + pad('ROIMed', 8) + 'GATE');
  console.error('─'.repeat(92));
  for (const r of results) {
    const s = r.summary;
    let gate = '— (baseline)';
    if (r !== results[0]) {
      const passCalmar = s.medianCalmar != null && base.medianCalmar != null && s.medianCalmar >= base.medianCalmar;
      const passIqr = s.iqrCalmar != null && base.iqrCalmar != null && s.iqrCalmar <= base.iqrCalmar + 0.01;
      const passWorst = s.worstCalmar != null && base.worstCalmar != null && s.worstCalmar >= base.worstCalmar - 0.01;
      gate = (passCalmar && passIqr && passWorst) ? '✅ ADOPTAR' :
             `🔻 (${[!passCalmar && 'Calmar<', !passIqr && 'IQR↑', !passWorst && 'peor↓'].filter(Boolean).join(' ')})`;
    }
    console.error(
      pad(r.name, 26) + pad(s.valid, 7) + pad(s.medianCalmar, 11) + pad(s.iqrCalmar, 7) +
      pad(s.worstCalmar, 7) + pad(s.medianSharpe, 10) + pad(s.medianROI, 8) + gate
    );
  }
  console.error('\nGate: Calmar mediano ≥ baseline, IQR ≤ baseline, y peor fold no peor. Comparación pareada (mismos folds/datos).');

  fs.writeFileSync('abtest-results.json', JSON.stringify({ months: MONTHS, folds: FOLDS, symbols: SYMBOLS, results }, null, 2));
  console.error('📄 Detalle en abtest-results.json');
}

main();

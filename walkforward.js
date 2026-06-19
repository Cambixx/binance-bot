/**
 * walkforward.js — Validación WALK-FORWARD (investigación §3.1, fix audit #6).
 *
 * Un único split 70/30 es un solo sorteo de régimen: el veredicto depende de qué fue el último
 * 30% (aquí, un bear). Walk-forward parte el histórico en K folds rodantes y evalúa la estrategia
 * en CADA fold out-of-fold, reportando la DISTRIBUCIÓN de PF/ROI/Sharpe/MaxDD por fold (no un
 * único número). Se selecciona por ESTABILIDAD entre folds, no por el pico de uno.
 *
 * Descarga los datos UNA vez y reparte por ventana temporal (reutiliza dataBySymbol del engine).
 *
 * Uso: node walkforward.js [--sma200|--donchian|--stday|--v4c] [--months=24] [--folds=6]
 *                          [--symbols=A,B,C] [--band=1] [--voltarget]
 */
import fs from 'fs';
import BacktestEngine, { strategyName } from './backtestEngine.js';
import { BLACKLIST, STRATEGY_OPTS, SMA_HYSTERESIS_BAND, VOLTARGET, SMA_PERIOD } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };

let strategyVersion = '4C';
if (args.includes('--sma200')) strategyVersion = 'SMA200';
else if (args.includes('--donchian')) strategyVersion = 'DONCHIAN';
else if (args.includes('--stday')) strategyVersion = 'STDAY';
else if (args.includes('--v4c')) strategyVersion = '4C';

const isDaily = ['SMA200', 'STDAY', 'DONCHIAN'].includes(strategyVersion);
const MONTHS = getNum('--months=', isDaily ? 36 : 12);
const FOLDS = getNum('--folds=', 6);
const interval = getStr('--interval=', isDaily ? '1d' : '15m');
const exitMode = isDaily ? 'signal' : (strategyVersion === '4A' || strategyVersion === '4B' ? 'atr' : 'fixed');

let SYMBOLS = getStr('--symbols=', '')
  ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
SYMBOLS = SYMBOLS.filter(s => !BLACKLIST.some(b => s.includes(b)));

function buildRegimeOpts() {
  const ro = { ...STRATEGY_OPTS };
  if (strategyVersion === 'SMA200') {
    ro.smaPeriod = getNum('--sma=', SMA_PERIOD);              // default = config (paridad live)
    ro.band = getNum('--band=', SMA_HYSTERESIS_BAND * 100) / 100;
  }
  return ro;
}

async function main() {
  console.log(`\n🔬 WALK-FORWARD — ${strategyName(strategyVersion)} | ${MONTHS} meses | ${FOLDS} folds | ${interval}`);
  console.log(`   símbolos: ${SYMBOLS.join(', ')}\n`);

  // 1. Descargar datos una vez
  const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const dataBySymbol = {};
  for (const s of fetcher.symbols) dataBySymbol[s] = await fetcher.fetchHistoricalData(s);

  // 2. Rango temporal global
  let tMin = Infinity, tMax = -Infinity;
  for (const s in dataBySymbol) for (const k of dataBySymbol[s]) { if (k.time < tMin) tMin = k.time; if (k.time > tMax) tMax = k.time; }
  const span = tMax - tMin;
  const foldLen = span / FOLDS;

  const regimeOpts = buildRegimeOpts();
  // Vol-target ON por defecto en el canal diario SMA (paridad con el live); --no-voltarget lo apaga.
  const volTargetOn = args.includes('--voltarget') || (strategyVersion === 'SMA200' && !args.includes('--no-voltarget'));
  const volTarget = volTargetOn ? { ...VOLTARGET, enabled: true } : null;
  // Buffer escalado con el periodo SMA (no hardcode 260/210 → soporta SMA150).
  const sp = Math.max(regimeOpts.smaPeriod || 200, regimeOpts.entryLen || 0);
  const engineExtra = isDaily ? { bufferSize: sp + 60, minCandles: sp + 10 } : {};

  // 3. Walk-forward de VENTANA ANCLADA EXPANSIVA: para cada fold i, el dataset incluye TODO el
  //    histórico desde tMin hasta el fin del fold (warmup completo para indicadores de lookback
  //    largo como SMA200) y se evalúa SOLO el segmento OOS [from_i, to_i) vía el split del motor.
  //    El primer fold suele ser warmup puro (sin trades) para las estrategias diarias.
  const rows = [];
  for (let i = 1; i < FOLDS; i++) {
    const from = tMin + i * foldLen;
    const to = i === FOLDS - 1 ? tMax + 1 : tMin + (i + 1) * foldLen;
    const anchored = {};
    for (const s in dataBySymbol) anchored[s] = dataBySymbol[s].filter(k => k.time < to);
    const total = Object.values(anchored).reduce((a, d) => a + d.length, 0);
    if (total < 50) { rows.push({ fold: i + 1, skipped: true }); continue; }
    const oosRatio = (from - tMin) / (to - tMin); // holdout = [from, to)

    const orig = console.log; console.log = () => {};
    let r;
    try {
      const engine = new BacktestEngine({
        symbols: [...SYMBOLS], months: MONTHS, interval, strategyVersion,
        exitMode, regimeOpts, volTarget, dataBySymbol: anchored, oosSplitRatio: oosRatio, ...engineExtra,
      });
      r = await engine.run();
    } finally { console.log = orig; }

    // Métricas del HOLDOUT (segmento OOS de este fold), no del acumulado.
    const s = r.holdoutSummary || r.summary;
    rows.push({
      fold: i + 1,
      from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10),
      trades: s.totalTrades, roi: s.roi, pf: s.profitFactor, sharpe: s.sharpe,
      maxDD: s.maxDrawdown, hodlRoi: (s.buyHold && s.buyHold.roi != null) ? s.buyHold.roi : (r.summary.buyHold ? r.summary.buyHold.roi : null),
    });
  }

  // 4. Reporte de la distribución
  const valid = rows.filter(r => !r.skipped && r.trades > 0);
  const pad = (v, n) => String(v ?? '—').padEnd(n);
  console.log('FOLD  PERIODO                 TRADES  ROI%    PF     SHARPE  MaxDD%  HODL%');
  console.log('─'.repeat(78));
  rows.forEach(r => {
    if (r.skipped) { console.log(`${pad(r.fold, 6)}(sin datos)`); return; }
    console.log(
      pad(r.fold, 6) + pad(`${r.from}→${r.to}`, 24) + pad(r.trades, 8) +
      pad(r.roi, 8) + pad(r.pf == null ? '∞' : r.pf, 7) + pad(r.sharpe, 8) +
      pad(r.maxDD, 8) + pad(r.hodlRoi, 6)
    );
  });

  if (valid.length > 0) {
    const med = (key) => {
      const xs = valid.map(r => r[key]).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)] : null;
    };
    const posRoi = valid.filter(r => r.roi > 0).length;
    const pfOk = valid.filter(r => r.pf == null || r.pf >= 1).length;
    const beatHodl = valid.filter(r => r.hodlRoi != null && r.roi >= r.hodlRoi).length;
    console.log('\n📊 DISTRIBUCIÓN (folds con trades = ' + valid.length + '):');
    console.log(`   ROI mediano: ${med('roi')}%  | Sharpe mediano: ${med('sharpe')}  | MaxDD mediano: ${med('maxDD')}%`);
    console.log(`   Folds ROI>0: ${posRoi}/${valid.length}  | Folds PF≥1: ${pfOk}/${valid.length}  | Folds ≥HODL: ${beatHodl}/${valid.length}`);
    const robust = posRoi / valid.length >= 0.6 && pfOk / valid.length >= 0.6;
    console.log(`   Veredicto: ${robust ? '✅ Robusto entre regímenes' : '🔻 Inconsistente entre folds (frágil/dependiente de régimen)'}`);
  }

  fs.writeFileSync('walkforward-results.json', JSON.stringify({ strategy: strategyName(strategyVersion), months: MONTHS, folds: FOLDS, interval, symbols: SYMBOLS, rows }, null, 2));
  console.log('\n📄 Guardado en walkforward-results.json');
}

main();

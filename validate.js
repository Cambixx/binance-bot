/**
 * validate.js — Valida UNA estrategia con estadística rigurosa (investigación §3, fix audit #17).
 *
 * Corre el backtest y aplica:
 *  1) Bootstrap de trades → IC del ROI, prob. de pérdida, prob. de drawdown severo (§3.2a)
 *  2) Test de significancia del Sharpe (Deflated Sharpe con nTrials configurable) (§3.3)
 *  3) (opcional --permute) Monte Carlo de permutación por block-bootstrap del precio: re-corre
 *     la estrategia sobre series surrogate y calcula p-value = fracción con Sharpe ≥ real (§3.2b)
 *
 * Uso: node validate.js [--sma200|--donchian|--v4c] [--months=36] [--symbols=A,B]
 *                       [--permute=200] [--trials=18] [--band=1]
 */
import BacktestEngine, { strategyName } from './backtestEngine.js';
import {
  bootstrapTradeCI, deflatedSharpe, blockBootstrapReturns, pricesFromLogReturns,
  makeRng, mean, std, skewness, kurtosis,
} from './validation.js';
import { BLACKLIST, STRATEGY_OPTS, SMA_HYSTERESIS_BAND, VOLTARGET, SMA_PERIOD } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };

let strategyVersion = '4C';
if (args.includes('--sma200')) strategyVersion = 'SMA200';
else if (args.includes('--donchian')) strategyVersion = 'DONCHIAN';
else if (args.includes('--stday')) strategyVersion = 'STDAY';

const isDaily = ['SMA200', 'STDAY', 'DONCHIAN'].includes(strategyVersion);
const MONTHS = getNum('--months=', isDaily ? 36 : 12);
const interval = getStr('--interval=', isDaily ? '1d' : '15m');
const exitMode = isDaily ? 'signal' : 'fixed';
const PERMUTE = args.includes('--permute') ? (getNum('--permute=', 200) || 200) : 0;
const TRIALS = getNum('--trials=', 1);

let SYMBOLS = getStr('--symbols=', '')
  ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
SYMBOLS = SYMBOLS.filter(s => !BLACKLIST.some(b => s.includes(b)));

function regimeOpts() {
  const ro = { ...STRATEGY_OPTS };
  if (strategyVersion === 'SMA200') {
    ro.smaPeriod = getNum('--sma=', SMA_PERIOD);             // default = config (paridad live)
    ro.band = getNum('--band=', SMA_HYSTERESIS_BAND * 100) / 100;
  }
  return ro;
}
function engineExtra() {
  if (!isDaily) return {};
  const ro = regimeOpts();
  const sp = Math.max(ro.smaPeriod || 200, ro.entryLen || 0);
  return { bufferSize: sp + 60, minCandles: sp + 10 };
}

function perPeriodSharpeFromEquity(equityCurve) {
  const pts = (equityCurve || []).filter(p => p.equity > 0);
  const rets = [];
  for (let i = 1; i < pts.length; i++) rets.push(Math.log(pts[i].equity / pts[i - 1].equity));
  if (rets.length < 3) return { sharpe: 0, T: rets.length, skew: 0, kurt: 3 };
  const m = mean(rets), s = std(rets);
  return { sharpe: s > 0 ? m / s : 0, T: rets.length, skew: skewness(rets), kurt: kurtosis(rets), rets };
}

function mute(fn) { const o = console.log; console.log = () => {}; return Promise.resolve().then(fn).finally(() => { console.log = o; }); }

async function main() {
  console.log(`\n🧪 VALIDATE — ${strategyName(strategyVersion)} | ${MONTHS} meses | ${interval} | ${SYMBOLS.join(',')}`);

  // 1. Descargar datos una vez
  const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const dataBySymbol = {};
  for (const s of fetcher.symbols) dataBySymbol[s] = await fetcher.fetchHistoricalData(s);

  // Vol-target ON por defecto en el canal diario SMA (paridad live); --no-voltarget lo apaga.
  const volTargetOn = args.includes('--voltarget') || (strategyVersion === 'SMA200' && !args.includes('--no-voltarget'));
  const volTarget = volTargetOn ? { ...VOLTARGET, enabled: true } : null;
  const baseOpts = {
    symbols: [...SYMBOLS], months: MONTHS, interval, strategyVersion, exitMode,
    regimeOpts: regimeOpts(), volTarget, oosSplitRatio: 0.7, ...engineExtra(),
  };

  // 2. Backtest real
  const real = await mute(() => new BacktestEngine({ ...baseOpts, dataBySymbol }).run());
  const s = real.summary;
  console.log(`\n📊 Real: ROI ${s.roi}% | PF ${s.profitFactor == null ? '∞' : s.profitFactor} | Sharpe ${s.sharpe} | MaxDD ${s.maxDrawdown}% | trades ${s.totalTrades}`);
  if (s.buyHold) console.log(`   HODL equiponderado: ROI ${s.buyHold.roi}% | MaxDD ${s.buyHold.maxDrawdown}%${s.btcHold ? ` | BTC HODL ROI ${s.btcHold.roi}%` : ''}`);

  // 3. Bootstrap de trades (IC)
  const tradePcts = real.trades.map(t => t.profitPct).filter(v => isFinite(v));
  const boot = bootstrapTradeCI(tradePcts, { iters: 5000, ruinThresholdPct: -20 });
  console.log('\n🎲 Bootstrap de trades (5000 iters):');
  if (boot.insufficient) console.log(`   ⚠️ Muestra insuficiente (n=${boot.n}) — métricas no fiables`);
  else {
    console.log(`   ROI mediano ${boot.medianROI}% | IC90% [${boot.ci5}%, ${boot.ci95}%]`);
    console.log(`   P(ROI<0) = ${boot.pLoss} | P(ROI≤-20%) = ${boot['pBelow-20pct']}`);
    if (boot.ci5 <= 0 && boot.ci95 >= 0) console.log('   🔻 El IC del ROI cruza 0 → edge no significativo');
  }

  // 4. Significancia del Sharpe (Deflated Sharpe)
  const pp = perPeriodSharpeFromEquity(real.equityCurve);
  const dsr = deflatedSharpe({ sharpe: pp.sharpe, nTrials: TRIALS, varTrialSharpe: 0.5, T: pp.T, skew: pp.skew, kurt: pp.kurt });
  if (dsr) {
    console.log(`\n📐 Deflated Sharpe (nTrials=${TRIALS}, T=${pp.T}): DSR ${dsr.deflatedSharpe} ${dsr.passes ? '✅ (>0.95)' : '🔻 (<0.95, no fiable)'}`);
  }

  // 5. Monte Carlo de permutación (block bootstrap del precio)
  if (PERMUTE > 0) {
    console.log(`\n🔀 Monte Carlo de permutación (${PERMUTE} surrogates, block bootstrap)...`);
    const rng = makeRng(98765);
    // Pre-calcular retornos log por símbolo
    const logRetsBySym = {};
    for (const sym in dataBySymbol) {
      const d = dataBySymbol[sym];
      const lr = [];
      for (let i = 1; i < d.length; i++) if (d[i - 1].close > 0 && d[i].close > 0) lr.push(Math.log(d[i].close / d[i - 1].close));
      logRetsBySym[sym] = { lr, p0: d.length ? d[0].close : 100, times: d.map(k => k.time) };
    }
    const blockSize = isDaily ? 20 : 96; // ~20 días o ~1 día en 15m
    let ge = 0;
    const realSharpe = s.sharpe;
    for (let it = 0; it < PERMUTE; it++) {
      const surrogate = {};
      for (const sym in logRetsBySym) {
        const { lr, p0, times } = logRetsBySym[sym];
        const shuffled = blockBootstrapReturns(lr, blockSize, rng);
        const prices = pricesFromLogReturns(shuffled, p0);
        surrogate[sym] = prices.map((c, i) => ({ time: times[i] ?? (times[times.length - 1] + i), open: c, high: c, low: c, close: c, volume: 1000 }));
      }
      const r = await mute(() => new BacktestEngine({ ...baseOpts, dataBySymbol: surrogate }).run());
      if (r.summary.sharpe >= realSharpe) ge++;
    }
    const pValue = (ge + 1) / (PERMUTE + 1);
    console.log(`   p-value = ${pValue.toFixed(4)}  (${ge}/${PERMUTE} surrogates con Sharpe ≥ ${realSharpe})`);
    console.log(`   ${pValue < 0.05 ? '✅ Sharpe real significativo (top 5% vs aleatorio)' : '🔻 Sharpe NO distinguible de azar (overfit/sin edge)'}`);
  }

  console.log('\n— Recordatorio: con costes OOS, el listón es real. Edge no significativo = no llevar a producción.');
}

main();

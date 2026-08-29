/**
 * rotation-backtest.js — Runner del canal 🔄 ROT (auditoría 2026-08-29, H3).
 *
 * El canal de rotación aportaba el 88 % del beneficio reportado del bot SIN backtest alguno.
 * Esto lo valida por el mismo camino que los demás: costes 0,30 %, split train/holdout,
 * walk-forward pareado y el gate de adopción de la casa.
 *
 * Uso:
 *   node rotation-backtest.js [--months=42] [--symbols=A,B,...] [--folds=8] [--wf]
 *   node rotation-backtest.js --wf --daily-riskoff     (variante: gate BTC diario entre rebalanceos)
 */
import fs from 'fs';
import RotationBacktestEngine from './rotationBacktest.js';
import { runWalkForward } from './wfcore.js';
import { isBlacklisted, ROTATION } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };
const MONTHS = getNum('--months=', 42);
const FOLDS = getNum('--folds=', 8);
const DAILY_RISKOFF = args.includes('--daily-riskoff');
const WF = args.includes('--wf');

// Universo FIJO y amplio de large/mid-caps con histórico. NO reconstruye el top-N por volumen
// point-in-time del live (imposible con la API pública) — queda declarado en el summary.
const DEFAULT_UNIVERSE = [
  'BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC',
  'BNBUSDC', 'ATOMUSDC', 'UNIUSDC', 'FILUSDC', 'AAVEUSDC', 'ETCUSDC', 'NEARUSDC', 'APTUSDC',
];
const SYMBOLS = (getStr('--symbols=', '') ? getStr('--symbols=', '').split(',') : DEFAULT_UNIVERSE)
  .filter(s => !isBlacklisted(s));

const engineOpts = {
  months: MONTHS,
  rotationDailyRiskOff: DAILY_RISKOFF,
  rotationCashBuffer: getNum('--cash-buffer=', 0),
};

async function main() {
  console.log(`\n🔄 BACKTEST ROTACIÓN — ${MONTHS}m · ${SYMBOLS.length} símbolos · riskOff diario: ${DAILY_RISKOFF ? 'ON' : 'off'}`);
  const fetcher = new RotationBacktestEngine({ symbols: [...SYMBOLS], months: MONTHS });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const dataBySymbol = {};
  for (const s of fetcher.symbols) {
    try { dataBySymbol[s] = await fetcher.fetchHistoricalData(s); }
    catch (e) { console.log(`   ⚠️ ${s}: ${e.message} — fuera del universo`); }
  }

  if (WF) {
    const { rows, summary } = await runWalkForward(dataBySymbol, {
      folds: FOLDS, engineClass: RotationBacktestEngine, engineOpts,
    });
    console.log('\nfold  desde       hasta       trades   roi%     pf    sharpe  calmar  maxDD%   hodl%');
    for (const r of rows) {
      if (r.skipped) { console.log(`${String(r.fold).padEnd(5)} (saltado)`); continue; }
      console.log(
        String(r.fold).padEnd(5), r.from, r.to,
        String(r.trades).padStart(6), String(r.roi).padStart(8), String(r.pf).padStart(7),
        String(r.sharpe).padStart(7), String(r.calmar).padStart(7), String(r.maxDD).padStart(7),
        String(r.hodlRoi).padStart(8)
      );
    }
    console.log('\nRESUMEN:', JSON.stringify(summary));
    fs.writeFileSync(DAILY_RISKOFF ? 'rotation-walkforward-riskoff.json' : 'rotation-walkforward-results.json', JSON.stringify({ months: MONTHS, folds: FOLDS, symbols: SYMBOLS, dailyRiskOff: DAILY_RISKOFF, rows, summary }, null, 2));
    console.log('📄 escrito');
    return;
  }

  const engine = new RotationBacktestEngine({ symbols: [...SYMBOLS], dataBySymbol, oosSplitRatio: 0.7, ...engineOpts });
  const r = await engine.run();
  const s = r.summary, h = r.holdoutSummary;
  const line = (label, m) => m && console.log(
    `${label.padEnd(9)} trades ${String(m.totalTrades).padStart(4)} | WR ${String(m.winRate).padStart(6)}% | PF ${String(m.profitFactor).padStart(6)} | ROI ${String(m.roi).padStart(8)}% | maxDD ${String(m.maxDrawdown).padStart(6)}% | Calmar ${String(m.calmar).padStart(6)}`
  );
  console.log(`\n💰 ${s.initialBalance} → ${s.finalBalance} USDC`);
  line('FULL', s); line('TRAIN', r.trainSummary); line('HOLDOUT', h);
  console.log(`\nBenchmark: cesta HODL ${s.buyHold?.roi}% (maxDD ${s.buyHold?.maxDrawdown}%) | BTC HODL ${s.btcHold?.roi}%`);
  if (s.books) {
    console.log(`\nPanel por libro (full): WR ${s.books.global.winRate}% vs breakeven ${s.books.global.breakevenWR}% → margen ${s.books.global.marginPP} pp`);
    console.log(`N efectivo (fechas de entrada distintas): ${s.books.global.nEffective} sobre ${s.books.global.trades} posiciones`);
  }
  console.log(`\n⚠️ ${s.universeNote}`);
  fs.writeFileSync('rotation-backtest-results.json', JSON.stringify(r, null, 2));
  console.log('📄 rotation-backtest-results.json');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

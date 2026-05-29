import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import binance from './binanceService.js';
import { exec } from 'child_process';
import { BLACKLIST, STRATEGY_OPTS, COSTS } from './config.js';

async function main() {
  const args = process.argv.slice(2);
  const monthsArg = args.find(a => a.startsWith('--months='));
  const symbolsArg = args.find(a => a.startsWith('--symbols='));
  const balanceArg = args.find(a => a.startsWith('--balance='));
  // Default = V4C-COMBO (paridad con bot.js productivo)
  let strategyVersion = '4C';
  if (args.includes('--v1')) strategyVersion = 1;
  else if (args.includes('--v2')) strategyVersion = 2;
  else if (args.includes('--v3')) strategyVersion = 3;
  else if (args.includes('--v4a')) strategyVersion = '4A';
  else if (args.includes('--v4b')) strategyVersion = '4B';
  else if (args.includes('--v4c')) strategyVersion = '4C';
  else if (args.includes('--sma200')) strategyVersion = 'SMA200';
  else if (args.includes('--stday')) strategyVersion = 'STDAY';
  else if (args.includes('--donchian')) strategyVersion = 'DONCHIAN';

  // Familia diaria (baja frecuencia): salida por señal, no TP/SL
  const isDaily = ['SMA200', 'STDAY', 'DONCHIAN'].includes(strategyVersion);

  // Timeframe: --interval=, o 1d automático para la familia diaria, o 15m por defecto
  const intervalArg = args.find(a => a.startsWith('--interval='));
  const interval = intervalArg ? intervalArg.split('=')[1] : (isDaily ? '1d' : '15m');

  // Exit mode auto: familia diaria=signal; V4-A/B=atr; resto=fixed
  const exitModeArg = args.find(a => a.startsWith('--exit-mode='));
  const exitMode = exitModeArg
    ? exitModeArg.split('=')[1]
    : (isDaily ? 'signal' : (strategyVersion === '4A' || strategyVersion === '4B' ? 'atr' : 'fixed'));

  const atrSLArg = args.find(a => a.startsWith('--atr-sl='));
  const atrTrailArg = args.find(a => a.startsWith('--atr-trail='));
  const partialArg = args.find(a => a.startsWith('--partial-r='));
  const chopArg = args.find(a => a.startsWith('--chop-max='));
  const bbwArg = args.find(a => a.startsWith('--bbw-pct='));
  const trailDistArg = args.find(a => a.startsWith('--trail-dist='));
  const trailActArg = args.find(a => a.startsWith('--trail-act='));
  const slArg = args.find(a => a.startsWith('--sl='));
  const tpArg = args.find(a => a.startsWith('--tp='));
  const feeArg = args.find(a => a.startsWith('--fee='));         // % por lado (ej: 0.1)
  const slipArg = args.find(a => a.startsWith('--slippage='));   // % por lado (ej: 0.05)
  const noCosts = args.includes('--no-costs');                   // backtest idealizado (sin fees)

  const months = monthsArg ? parseInt(monthsArg.split('=')[1]) : 3;
  const initialBalance = balanceArg ? parseFloat(balanceArg.split('=')[1]) : 5000;
  const oosArg = args.find(a => a.startsWith('--oos-split='));
  const oosSplitRatio = oosArg ? parseFloat(oosArg.split('=')[1]) : 0.7;
  const universeArg = args.find(a => a.startsWith('--universe='));
  // Universo por defecto = 10, coincide con TOP_COINS_LIMIT en bot.js (paridad live)
  const universeSize = universeArg ? parseInt(universeArg.split('=')[1]) : 10;

  let symbols = ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'BNBUSDC', 'XRPUSDC'];

  if (symbolsArg) {
    symbols = symbolsArg.split('=')[1].split(',');
  } else {
    try {
      console.log(`🔍 Obteniendo top ${universeSize} monedas por volumen (paridad con bot.js)...`);
      // Pedimos universeSize + 5 para tener colchón tras filtrar blacklist (igual que bot.js)
      const topSymbols = await binance.getTopVolumeSymbols(universeSize + 5);
      if (topSymbols && topSymbols.length > 0) {
        symbols = topSymbols.filter(s => !BLACKLIST.some(bad => s.includes(bad))).slice(0, universeSize);
      }
    } catch (e) {
      console.log('⚠️ No se pudo obtener el top de Binance, usando defaults.');
    }
  }

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           BINANCE BOT BACKTESTING SYSTEM             ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`📅 Periodo: ${months} meses`);
  console.log(`💰 Balance Inicial: ${initialBalance} USDC`);
  console.log(`🪙 Símbolos: ${symbols.join(', ')}`);
  const stratNames = {
    1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)',
    '4A': 'V4-A (Supertrend+Chandelier)', '4B': 'V4-B (V3+ATR-exits)', '4C': 'V4-C (V3+RegimeGate)',
    'SMA200': 'SMA200 (Faber regime, diaria)', 'STDAY': 'SuperTrend diario', 'DONCHIAN': 'Donchian 55/20 (diaria)'
  };
  console.log(`📋 Estrategia: ${stratNames[strategyVersion]}`);
  console.log(`⏱️  Timeframe: ${interval}`);
  console.log(`🚪 Exit mode: ${exitMode}`);
  console.log('--------------------------------------------------------');

  // Defaults V4C-COMBO centralizados en config.js (paridad bot.js)
  const regimeOpts = { ...STRATEGY_OPTS };
  if (chopArg) regimeOpts.chopMax = parseFloat(chopArg.split('=')[1]);
  if (bbwArg) regimeOpts.bbwPctMin = parseFloat(bbwArg.split('=')[1]);

  // Parámetros de la familia diaria
  const regimeArg = args.find(a => a.startsWith('--regime='));   // on/off del gate SMA200
  const smaArg = args.find(a => a.startsWith('--sma='));
  const entryLenArg = args.find(a => a.startsWith('--entry-len='));
  const exitLenArg = args.find(a => a.startsWith('--exit-len='));
  const stMultArg = args.find(a => a.startsWith('--st-mult='));
  const stPeriodArg = args.find(a => a.startsWith('--st-period='));
  if (regimeArg) regimeOpts.useRegime = regimeArg.split('=')[1] !== 'off';
  if (smaArg) regimeOpts.smaPeriod = parseInt(smaArg.split('=')[1]);
  if (entryLenArg) regimeOpts.entryLen = parseInt(entryLenArg.split('=')[1]);
  if (exitLenArg) regimeOpts.exitLen = parseInt(exitLenArg.split('=')[1]);
  if (stMultArg) regimeOpts.stMult = parseFloat(stMultArg.split('=')[1]);
  if (stPeriodArg) regimeOpts.stPeriod = parseInt(stPeriodArg.split('=')[1]);

  // Costes: por defecto los de config.js; --no-costs los anula; --fee/--slippage los sobreescriben
  const feePct = noCosts ? 0 : (feeArg ? parseFloat(feeArg.split('=')[1]) / 100 : COSTS.feePct);
  const slippagePct = noCosts ? 0 : (slipArg ? parseFloat(slipArg.split('=')[1]) / 100 : COSTS.slippagePct);

  const engineOpts = {
    initialBalance,
    symbols,
    months,
    interval,
    strategyVersion,
    oosSplitRatio,
    exitMode,
    atrSLMult: atrSLArg ? parseFloat(atrSLArg.split('=')[1]) : 2.0,
    atrTrailMult: atrTrailArg ? parseFloat(atrTrailArg.split('=')[1]) : 3.0,
    partialExitAtR: partialArg ? parseFloat(partialArg.split('=')[1]) : 0,
    regimeOpts,
    feePct,
    slippagePct
  };
  // La familia diaria necesita ventana grande (SMA200 / canal 55) → buffer > 220
  if (isDaily) { engineOpts.bufferSize = 260; engineOpts.minCandles = 210; }
  if (trailDistArg) engineOpts.trailingDistance = parseFloat(trailDistArg.split('=')[1]);
  if (trailActArg) engineOpts.trailingActivation = parseFloat(trailActArg.split('=')[1]);
  if (slArg) engineOpts.stopLossPct = parseFloat(slArg.split('=')[1]);
  if (tpArg) engineOpts.takeProfitPct = parseFloat(tpArg.split('=')[1]);

  const engine = new BacktestEngine(engineOpts);

  try {
    const results = await engine.run();

    const outputArg = args.find(a => a.startsWith('--output='));
    const noOpen = args.includes('--no-open');
    const outputFilename = outputArg ? outputArg.split('=')[1] : 'backtest-results.json';
    fs.writeFileSync(outputFilename, JSON.stringify(results, null, 2));
    
    // Inyectar datos directamente en el HTML para evitar problemas de CORS con file://
    const templateHtml = fs.readFileSync('backtest-report.html', 'utf-8');
    const injectedHtml = templateHtml.replace(
      'window.onload = loadData;',
      `window.__BACKTEST_DATA__ = ${JSON.stringify(results)};\nwindow.onload = loadData;`
    );
    fs.writeFileSync('backtest-report-output.html', injectedHtml);
    
    const s = results.summary;
    const roiColor = s.roi >= 0 ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    console.log('\n════════════════════════════════════════════════════════');
    console.log('                   📊 RESULTADOS                       ');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  ROI:              ${roiColor}${s.roi >= 0 ? '+' : ''}${s.roi}%${reset}`);
    console.log(`  Profit Neto:      ${roiColor}${s.totalProfit >= 0 ? '+' : ''}${s.totalProfit} USDC${reset}`);
    console.log(`  Balance Final:    ${s.finalBalance} USDC`);
    console.log(`  Win Rate:         ${s.winRate}%`);
    console.log(`  Profit Factor:    ${s.profitFactor}`);
    console.log(`  Max Drawdown:     -${s.maxDrawdown}%`);
    if (s.buyHold) {
      const bh = s.buyHold;
      const beatRoi = s.roi >= bh.roi;
      const beatDD = s.maxDrawdown <= bh.maxDrawdown;
      console.log('  ┌─ vs BUY & HOLD (equiponderado) ─────────────');
      console.log(`  │ HODL ROI:        ${bh.roi >= 0 ? '+' : ''}${bh.roi}%   (estrategia ${beatRoi ? '✅ ≥' : '🔻 <'} HODL)`);
      console.log(`  │ HODL Max DD:     -${bh.maxDrawdown}%   (estrategia ${beatDD ? '✅ menor DD' : '🔻 peor DD'})`);
      console.log('  └──────────────────────────────────────────────');
    }
    console.log(`  Expectancy:       ${s.expectancy >= 0 ? '+' : ''}${s.expectancy} USDC/trade`);
    console.log(`  Trades Totales:   ${s.totalTrades} (${s.winningTrades}W / ${s.losingTrades}L)`);
    console.log(`  Duración Media:   ${s.avgDurationHours}h`);
    console.log(`  Avg Win:          +${s.avgWin} USDC`);
    console.log(`  Avg Loss:         -${s.avgLoss} USDC`);
    console.log('────────────────────────────────────────────────────────');
    console.log('  Trades por motivo:');
    for (const [reason, count] of Object.entries(s.byReason)) {
      console.log(`    ${reason}: ${count}`);
    }
    console.log('────────────────────────────────────────────────────────');
    console.log('  Rendimiento por moneda:');
    for (const [sym, data] of Object.entries(s.bySymbol)) {
      const wr = data.trades > 0 ? ((data.wins / data.trades) * 100).toFixed(1) : '0';
      const pColor = data.profit >= 0 ? '\x1b[32m' : '\x1b[31m';
      console.log(`    ${sym}: ${data.trades} trades | ${pColor}${data.profit >= 0 ? '+' : ''}${data.profit.toFixed(2)} USDC${reset} | WR: ${wr}%`);
    }
    console.log('════════════════════════════════════════════════════════');

    // --- Reporte comparativo Train vs Holdout (validación out-of-sample) ---
    if (results.trainSummary && results.holdoutSummary) {
      const tr = results.trainSummary;
      const ho = results.holdoutSummary;
      const splitDate = (tr.splitTime || '').slice(0, 10);
      const arrow = (a, b, lowerIsBetter = false) => {
        if (b === 0 && a === 0) return '—';
        const better = lowerIsBetter ? b <= a : b >= a;
        const c = better ? '\x1b[32m' : '\x1b[31m';
        const sign = b >= a ? '+' : '';
        return `${c}${sign}${(b - a).toFixed(2)}${reset}`;
      };
      console.log('\n══════════ 🧪 VALIDACIÓN OUT-OF-SAMPLE ══════════════════');
      console.log(`Split: ${(engine.oosSplitRatio*100).toFixed(0)}% train / ${((1-engine.oosSplitRatio)*100).toFixed(0)}% holdout (corte: ${splitDate})\n`);
      const row = (label, a, b, lowerIsBetter = false) => console.log(`  ${label.padEnd(18)} train=${String(a).padEnd(10)} holdout=${String(b).padEnd(10)} Δ=${arrow(a, b, lowerIsBetter)}`);
      row('Trades', tr.totalTrades, ho.totalTrades);
      row('Win Rate %', tr.winRate, ho.winRate);
      row('Profit Factor', tr.profitFactor, ho.profitFactor);
      row('ROI %', tr.roi, ho.roi);
      row('Max Drawdown %', tr.maxDrawdown, ho.maxDrawdown, true);
      row('Expectancy', tr.expectancy, ho.expectancy);

      // Veredicto OOS automático
      console.log('\n  Veredicto OOS:');
      const verdicts = [];
      const degraded = (a, b, threshPct) => a !== 0 && ((a - b) / Math.abs(a)) * 100 > threshPct;
      if (tr.profitFactor < 1 || ho.profitFactor < 1) verdicts.push('🔴 PF<1 en alguna fase → no rentable');
      if (degraded(tr.profitFactor, ho.profitFactor, 25)) verdicts.push('🟡 PF cae >25% en holdout → posible overfit');
      if (degraded(tr.winRate, ho.winRate, 15)) verdicts.push('🟡 WR cae >15pp relativo en holdout');
      if (ho.maxDrawdown > tr.maxDrawdown * 1.5 && ho.maxDrawdown > 5) verdicts.push('🟡 MaxDD holdout 50%+ peor que train');
      if (verdicts.length === 0) verdicts.push('✅ Estrategia robusta: métricas consistentes train ↔ holdout');
      verdicts.forEach(v => console.log('    ' + v));
      console.log('════════════════════════════════════════════════════════');
    }

    console.log(`📄 Resultados guardados en: ${outputFilename}`);

    console.log('\n🖥️  Abre backtest-report-output.html en tu navegador para ver los detalles.');

    if (process.platform === 'darwin' && !noOpen) {
      exec(`open backtest-report-output.html`);
    }

  } catch (error) {
    console.error('❌ Error durante el backtest:', error);
  }
}

main();

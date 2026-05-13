import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import binance from './binanceService.js';
import { exec } from 'child_process';

// Blacklist centralizada (igual que bot.js)
const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ'
];

async function main() {
  const args = process.argv.slice(2);
  const monthsArg = args.find(a => a.startsWith('--months='));
  const symbolsArg = args.find(a => a.startsWith('--symbols='));
  const balanceArg = args.find(a => a.startsWith('--balance='));
  const strategyVersion = args.includes('--v1') ? 1 : args.includes('--v2') ? 2 : 3;

  const months = monthsArg ? parseInt(monthsArg.split('=')[1]) : 3;
  const initialBalance = balanceArg ? parseFloat(balanceArg.split('=')[1]) : 5000;
  
  let symbols = ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'BNBUSDC', 'XRPUSDC'];
  
  if (symbolsArg) {
    symbols = symbolsArg.split('=')[1].split(',');
  } else {
    try {
      console.log('🔍 Obteniendo top monedas por volumen para el backtest...');
      const topSymbols = await binance.getTopVolumeSymbols(10);
      if (topSymbols && topSymbols.length > 0) {
        // Filtrar blacklist ANTES de seleccionar
        symbols = topSymbols.filter(s => !BLACKLIST.some(bad => s.includes(bad))).slice(0, 5);
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
  const stratNames = { 1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)' };
  console.log(`📋 Estrategia: ${stratNames[strategyVersion]}`);
  console.log('--------------------------------------------------------');

  const engine = new BacktestEngine({
    initialBalance,
    symbols,
    months,
    interval: '15m',
    strategyVersion
  });

  try {
    const results = await engine.run();

    const outputFilename = 'backtest-results.json';
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
    console.log(`📄 Resultados guardados en: ${outputFilename}`);
    
    console.log('\n🖥️  Abre backtest-report-output.html en tu navegador para ver los detalles.');
    
    if (process.platform === 'darwin') {
      exec(`open backtest-report-output.html`);
    }

  } catch (error) {
    console.error('❌ Error durante el backtest:', error);
  }
}

main();

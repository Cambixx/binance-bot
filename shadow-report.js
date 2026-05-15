import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import binance from './binanceService.js';

const STORE_NAME = 'shadow_trading_state';
const STORE_KEY = 'bot_state_v2';
const DEFAULT_SYNC_FILE = 'shadow_trades_sync.json';
const DEFAULT_DATA_FILE = 'shadow-report-results.json';
const DEFAULT_HTML_OUTPUT = 'shadow-report-output.html';
const INITIAL_BALANCE = 5000;
const TRAIL_DISTANCE = 0.45;

function parseArgs() {
  const args = process.argv.slice(2);
  const findValue = (prefix) => args.find(arg => arg.startsWith(prefix))?.split('=').slice(1).join('=');

  return {
    input: findValue('--input='),
    syncFile: findValue('--sync-file=') || DEFAULT_SYNC_FILE,
    jsonOutput: findValue('--json-output=') || DEFAULT_DATA_FILE,
    htmlOutput: findValue('--html-output=') || DEFAULT_HTML_OUTPUT,
    syncTimeoutMs: Number(findValue('--sync-timeout-ms=')) || 15000,
    skipSync: args.includes('--skip-sync'),
    noOpen: args.includes('--no-open')
  };
}

function round(value, decimals = 2) {
  return Number.parseFloat(Number(value || 0).toFixed(decimals));
}

function parsePercent(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number.parseFloat(value.replace('%', '')) || 0;
  return 0;
}

function parseDate(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function syncBlobState(outputFile, timeoutMs) {
  console.log('☁️ Descargando estado actual desde Netlify Blobs...');

  const result = spawnSync(
    'npx',
    ['netlify', 'blobs:get', STORE_NAME, STORE_KEY, '--output', outputFile],
    { encoding: 'utf-8', timeout: timeoutMs }
  );

  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`La descarga desde Netlify superó el timeout de ${timeoutMs}ms`);
  }

  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || 'Error desconocido';
    throw new Error(`No se pudo descargar el blob ${STORE_NAME}/${STORE_KEY}: ${details}`);
  }

  console.log(`✅ Estado sincronizado en ${outputFile}`);
}

function loadState(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const state = JSON.parse(raw);

  return {
    balanceUSDC: Number(state.balanceUSDC || 0),
    openPositions: state.openPositions || {},
    tradeHistory: Array.isArray(state.tradeHistory) ? state.tradeHistory : []
  };
}

async function fetchCurrentPrices(symbols) {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      const candles = await binance.getKlines(symbol, '15m', 1);
      const currentPrice = candles[0]?.close || null;
      return [symbol, currentPrice];
    })
  );

  return Object.fromEntries(entries);
}

function normalizeTrades(tradeHistory) {
  return tradeHistory
    .map((trade) => ({
      symbol: trade.symbol,
      buyPrice: Number(trade.buyPrice || 0),
      sellPrice: Number(trade.sellPrice || 0),
      amount: Number(trade.amount || 0),
      profit: round(trade.profitUSDC ?? trade.profit ?? 0),
      profitPct: round(parsePercent(trade.profitPercentage ?? trade.profitPct ?? 0)),
      buyTime: trade.buyTime,
      sellTime: trade.sellTime,
      reason: trade.reason || 'SIGNAL'
    }))
    .sort((a, b) => (parseDate(a.sellTime) || 0) - (parseDate(b.sellTime) || 0));
}

function buildTradeStats(trades) {
  const totalTrades = trades.length;
  const winners = trades.filter((trade) => trade.profit > 0);
  const losers = trades.filter((trade) => trade.profit <= 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

  const grossProfit = winners.reduce((sum, trade) => sum + trade.profit, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.profit, 0));
  const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
  const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
  const expectancy = totalTrades > 0
    ? ((winRate / 100) * avgWin) - (((100 - winRate) / 100) * avgLoss)
    : 0;

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const totalDuration = trades.reduce((sum, trade) => {
    const buyTime = parseDate(trade.buyTime);
    const sellTime = parseDate(trade.sellTime);
    if (!buyTime || !sellTime) return sum;
    return sum + (sellTime - buyTime);
  }, 0);

  const byReason = {};
  const bySymbol = {};

  trades.forEach((trade) => {
    byReason[trade.reason] = (byReason[trade.reason] || 0) + 1;

    if (!bySymbol[trade.symbol]) {
      bySymbol[trade.symbol] = { trades: 0, profit: 0, wins: 0 };
    }

    bySymbol[trade.symbol].trades += 1;
    bySymbol[trade.symbol].profit += trade.profit;
    if (trade.profit > 0) bySymbol[trade.symbol].wins += 1;
  });

  Object.values(bySymbol).forEach((stats) => {
    stats.profit = round(stats.profit);
  });

  return {
    totalTrades,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: round(winRate),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    profitFactor: profitFactor === null ? null : round(profitFactor),
    avgWin: round(avgWin),
    avgLoss: round(avgLoss),
    expectancy: round(expectancy),
    avgDurationHours: totalTrades > 0 ? round(totalDuration / totalTrades / 3600000, 1) : 0,
    byReason,
    bySymbol
  };
}

function buildOpenPositions(openPositions, priceMap) {
  return Object.entries(openPositions)
    .map(([symbol, position]) => {
      const currentPrice = Number(priceMap[symbol] || position.buyPrice || 0);
      const invested = Number(position.investedUSDC || 0);
      const amount = Number(position.amount || 0);
      const marketValue = amount * currentPrice;
      const unrealizedProfit = marketValue - invested;
      const unrealizedProfitPct = invested > 0 ? (unrealizedProfit / invested) * 100 : 0;
      const peakPrice = Number(position.peakPrice || position.buyPrice || 0);
      const peakProfitPct = position.buyPrice > 0
        ? ((peakPrice - position.buyPrice) / position.buyPrice) * 100
        : 0;
      const trailingStopPrice = position.trailingActivated
        ? position.buyPrice * (1 + ((peakProfitPct * TRAIL_DISTANCE) / 100))
        : null;

      return {
        symbol,
        amount,
        buyPrice: Number(position.buyPrice || 0),
        currentPrice,
        investedUSDC: round(invested),
        marketValue: round(marketValue),
        unrealizedProfit: round(unrealizedProfit),
        unrealizedProfitPct: round(unrealizedProfitPct),
        buyTime: position.timestamp,
        peakPrice: round(peakPrice, 6),
        trailingActivated: Boolean(position.trailingActivated),
        trailingStopPrice: trailingStopPrice === null ? null : round(trailingStopPrice, 6)
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);
}

function buildEquityCurve(trades, openPositions, initialBalance, currentTotalEquity, generatedAt) {
  const candidateTimes = [
    ...trades.map((trade) => parseDate(trade.buyTime)).filter(Boolean),
    ...openPositions.map((position) => parseDate(position.buyTime)).filter(Boolean)
  ];
  const startTime = candidateTimes.length > 0 ? Math.min(...candidateTimes) : parseDate(generatedAt);

  const curve = [{ time: startTime, equity: round(initialBalance) }];
  let realizedProfit = 0;

  trades.forEach((trade) => {
    realizedProfit += trade.profit;
    const time = parseDate(trade.sellTime) || parseDate(generatedAt);
    curve.push({
      time,
      equity: round(initialBalance + realizedProfit)
    });
  });

  const lastPoint = curve[curve.length - 1];
  const nowTime = parseDate(generatedAt);

  if (!lastPoint || lastPoint.time !== nowTime || lastPoint.equity !== round(currentTotalEquity)) {
    curve.push({ time: nowTime, equity: round(currentTotalEquity) });
  }

  let maxEquity = curve[0]?.equity || initialBalance;
  let maxDrawdown = 0;

  const drawdownCurve = curve.map((point) => {
    if (point.equity > maxEquity) maxEquity = point.equity;
    const drawdown = maxEquity > 0 ? ((maxEquity - point.equity) / maxEquity) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    return {
      time: point.time,
      drawdown: round(drawdown)
    };
  });

  return {
    equityCurve: curve,
    drawdownCurve,
    maxDrawdown: round(maxDrawdown)
  };
}

function buildReportData(state, openPositions, trades, tradeStats, curveData, meta) {
  const availableBalance = round(state.balanceUSDC);
  const investedCost = round(openPositions.reduce((sum, position) => sum + position.investedUSDC, 0));
  const currentMarketValue = round(openPositions.reduce((sum, position) => sum + position.marketValue, 0));
  const realizedProfit = round(trades.reduce((sum, trade) => sum + trade.profit, 0));
  const currentTotalEquity = round(availableBalance + currentMarketValue);
  const unrealizedProfit = round(currentMarketValue - investedCost);
  const totalProfit = round(currentTotalEquity - meta.initialBalance);
  const roi = meta.initialBalance > 0 ? round((totalProfit / meta.initialBalance) * 100) : 0;
  const trailingActiveCount = openPositions.filter((position) => position.trailingActivated).length;
  const activeSinceCandidates = [
    ...trades.map((trade) => parseDate(trade.buyTime)).filter(Boolean),
    ...openPositions.map((position) => parseDate(position.buyTime)).filter(Boolean)
  ];

  const activeSince = activeSinceCandidates.length > 0
    ? new Date(Math.min(...activeSinceCandidates)).toISOString()
    : meta.generatedAt;

  return {
    summary: {
      reportType: 'Shadow Mode',
      generatedAt: meta.generatedAt,
      stateSource: meta.stateSource,
      blobStore: STORE_NAME,
      blobKey: STORE_KEY,
      initialBalance: meta.initialBalance,
      availableBalance,
      investedCost,
      currentMarketValue,
      currentTotalEquity,
      realizedProfit,
      unrealizedProfit,
      totalProfit,
      roi,
      activeSince,
      totalTrades: tradeStats.totalTrades,
      winningTrades: tradeStats.winningTrades,
      losingTrades: tradeStats.losingTrades,
      winRate: tradeStats.winRate,
      profitFactor: tradeStats.profitFactor,
      avgWin: tradeStats.avgWin,
      avgLoss: tradeStats.avgLoss,
      expectancy: tradeStats.expectancy,
      avgDurationHours: tradeStats.avgDurationHours,
      maxDrawdown: curveData.maxDrawdown,
      openPositionsCount: openPositions.length,
      trailingActiveCount,
      byReason: tradeStats.byReason,
      bySymbol: tradeStats.bySymbol,
      reconstructionNote: 'La curva y el drawdown se reconstruyen con cierres realizados y un snapshot actual de posiciones abiertas.'
    },
    trades,
    openPositions,
    equityCurve: curveData.equityCurve,
    drawdownCurve: curveData.drawdownCurve
  };
}

function injectDataIntoTemplate(templatePath, outputPath, data) {
  const templateHtml = fs.readFileSync(templatePath, 'utf-8');
  const injectedHtml = templateHtml.replace(
    'window.onload = loadData;',
    `window.__SHADOW_DATA__ = ${JSON.stringify(data)};\nwindow.onload = loadData;`
  );

  fs.writeFileSync(outputPath, injectedHtml);
}

async function main() {
  const args = parseArgs();
  const syncFilePath = path.resolve(args.syncFile);
  const inputPath = path.resolve(args.input || args.syncFile);
  const jsonOutputPath = path.resolve(args.jsonOutput);
  const htmlOutputPath = path.resolve(args.htmlOutput);
  const templatePath = path.resolve('shadow-report.html');

  try {
    if (!args.skipSync && !args.input) {
      try {
        syncBlobState(syncFilePath, args.syncTimeoutMs);
      } catch (syncError) {
        if (!fs.existsSync(syncFilePath)) {
          throw syncError;
        }

        console.warn(`⚠️ ${syncError.message}`);
        console.warn(`⚠️ Usando la última copia local disponible en ${syncFilePath}`);
      }
    } else if (!fs.existsSync(inputPath)) {
      throw new Error(`No existe el archivo de entrada: ${inputPath}`);
    }

    const state = loadState(inputPath);
    const symbols = Object.keys(state.openPositions);
    const priceMap = symbols.length > 0 ? await fetchCurrentPrices(symbols) : {};
    const openPositions = buildOpenPositions(state.openPositions, priceMap);
    const trades = normalizeTrades(state.tradeHistory);
    const tradeStats = buildTradeStats(trades);
    const generatedAt = new Date().toISOString();
    const currentTotalEquity = round(
      state.balanceUSDC + openPositions.reduce((sum, position) => sum + position.marketValue, 0)
    );
    const curveData = buildEquityCurve(trades, openPositions, INITIAL_BALANCE, currentTotalEquity, generatedAt);
    const reportData = buildReportData(state, openPositions, trades, tradeStats, curveData, {
      initialBalance: INITIAL_BALANCE,
      generatedAt,
      stateSource: inputPath
    });

    fs.writeFileSync(jsonOutputPath, JSON.stringify(reportData, null, 2));
    injectDataIntoTemplate(templatePath, htmlOutputPath, reportData);

    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║            BINANCE BOT SHADOW REPORT                ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`💼 Equity actual:     ${reportData.summary.currentTotalEquity.toFixed(2)} USDC`);
    console.log(`📈 ROI total:         ${reportData.summary.roi >= 0 ? '+' : ''}${reportData.summary.roi}%`);
    console.log(`💵 P&L realizado:     ${reportData.summary.realizedProfit >= 0 ? '+' : ''}${reportData.summary.realizedProfit.toFixed(2)} USDC`);
    console.log(`📍 P&L no realizado:  ${reportData.summary.unrealizedProfit >= 0 ? '+' : ''}${reportData.summary.unrealizedProfit.toFixed(2)} USDC`);
    console.log(`🔓 Posiciones abiertas:${reportData.summary.openPositionsCount}`);
    console.log(`📊 Trades cerrados:   ${reportData.summary.totalTrades}`);
    console.log(`🗂️ JSON guardado en:   ${jsonOutputPath}`);
    console.log(`🖥️ HTML guardado en:   ${htmlOutputPath}`);

    if (process.platform === 'darwin' && !args.noOpen) {
      spawnSync('open', [htmlOutputPath], { stdio: 'ignore' });
    }
  } catch (error) {
    console.error('❌ Error generando shadow report:', error.message);
    process.exitCode = 1;
  }
}

main();

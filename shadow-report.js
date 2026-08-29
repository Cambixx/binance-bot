import fs from 'fs';
import path from 'path';
import { SIGNAL_MODE } from './config.js';
import { spawnSync } from 'child_process';
import binance from './binanceService.js';

const STORE_NAME = 'shadow_trading_state';
const CHANNELS_CONFIG = {
  daily: {
    id: 'daily',
    title: '📅 SMA150-1d (Long-Only)',
    storeKey: 'bot_state_daily_v1',
    syncFile: 'sync_daily.json',
    initialBalance: 5000
  },
  ls: {
    id: 'ls',
    title: '↕️ SMA150-LS (Long/Short)',
    storeKey: 'bot_state_ls_v1',
    syncFile: 'sync_ls.json',
    initialBalance: 5000
  },
  rotation: {
    id: 'rotation',
    // ⚠️ La etiqueta EXPERIMENTAL existía en botStatus.js y en la documentación, pero se perdía
    // justo en la capa que el usuario mira. El canal aportó el 88 % del beneficio reportado y su
    // primer backtest honesto (2026-08-29) da holdout PF 0,83 / ROI −23,49 %.
    title: '🔄 ROT-dual-mom (Rotación) · EXPERIMENTAL',
    experimental: true,
    storeKey: 'bot_state_rotation_v1',
    syncFile: 'sync_rotation.json',
    initialBalance: 5000
  }
};

const DEFAULT_DATA_FILE = 'shadow-report-results.json';
const DEFAULT_HTML_OUTPUT = 'shadow-report-output.html';
const TRAIL_DISTANCE = 0.45;

function parseArgs() {
  const args = process.argv.slice(2);
  const findValue = (prefix) => args.find(arg => arg.startsWith(prefix))?.split('=').slice(1).join('=');

  return {
    channel: findValue('--channel=') || 'all',
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

function syncBlobState(storeKey, outputFile, timeoutMs) {
  console.log(`☁️ Descargando ${storeKey} desde Netlify Blobs...`);
  const result = spawnSync(
    'npx',
    ['netlify', 'blobs:get', STORE_NAME, storeKey, '--output', outputFile],
    { encoding: 'utf-8', timeout: timeoutMs }
  );

  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`La descarga de ${storeKey} superó el timeout de ${timeoutMs}ms`);
  }

  if (result.status !== 0) {
    const details = result.stderr?.trim() || result.stdout?.trim() || 'Error desconocido';
    throw new Error(`No se pudo descargar el blob ${STORE_NAME}/${storeKey}: ${details}`);
  }

  console.log(`✅ Estado ${storeKey} sincronizado en ${outputFile}`);
}

function loadState(filePath, initialBalance = 5000) {
  if (!fs.existsSync(filePath)) {
    return {
      balanceUSDC: initialBalance,
      openPositions: {},
      tradeHistory: []
    };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw);
    return {
      balanceUSDC: Number(state.balanceUSDC ?? initialBalance),
      openPositions: state.openPositions || {},
      tradeHistory: Array.isArray(state.tradeHistory) ? state.tradeHistory : [],
      circuitBreakerPausedUntil: state.circuitBreakerPausedUntil || null,
      lastRebalanceTime: state.lastRebalanceTime || null
    };
  } catch (err) {
    console.warn(`⚠️ Error leyendo ${filePath}:`, err.message);
    return {
      balanceUSDC: initialBalance,
      openPositions: {},
      tradeHistory: []
    };
  }
}

function normalizeTrades(tradeHistory) {
  return tradeHistory
    .map((trade) => ({
      symbol: trade.symbol,
      side: trade.side || 'long',
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
  // Convención alineada con el motor (fix #27): perdedoras profit<0; los breakeven (profit==0)
  // van a su propio bucket y NO se cuentan como pérdidas. Aquí decía `<= 0`, que inflaba
  // grossLoss y hundía el profit factor con cada cierre exactamente plano.
  const losers = trades.filter((trade) => trade.profit < 0);
  const breakeven = trades.filter((trade) => trade.profit === 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

  const grossProfit = winners.reduce((sum, trade) => sum + trade.profit, 0);
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.profit, 0));
  const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
  const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
  const expectancy = totalTrades > 0
    ? ((winRate / 100) * avgWin) - (((100 - winRate) / 100) * avgLoss)
    : 0;

  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  // ── Cifras de decisión (auditoría 2026-08-29) ────────────────────────────────────────────
  // El win rate SOLO no dice nada: al lado va siempre el mínimo necesario para no perder dinero
  // dado el payoff, y el margen entre ambos. En este bot el libro corto tiene WR ALTA (40,7 %) y
  // margen de +1,6 pp, y el largo WR BAJA (23,3 %) y margen de +14 pp.
  const payoff = avgLoss > 0 ? avgWin / avgLoss : null;
  const breakevenWR = payoff != null ? (1 / (1 + payoff)) * 100 : null;
  // N EFECTIVO: fechas de entrada distintas. 7 cortos abiertos el mismo día sobre activos con
  // ρ̄≈0,73 son ~1 apuesta, no 7 — y con ~1 observación no se puede concluir nada del win rate.
  const nEffective = new Set(trades.map((t) => String(t.buyTime || '').slice(0, 10))).size;
  // Intervalo de Wilson: con n pequeño es el único honesto. Wilson(0/7) = [0 % ; 35,4 %].
  const wilson = (() => {
    if (!(totalTrades > 0)) return null;
    const z = 1.96, pHat = winners.length / totalTrades;
    const d = 1 + (z * z) / totalTrades;
    const c = pHat + (z * z) / (2 * totalTrades);
    const h = z * Math.sqrt((pHat * (1 - pHat)) / totalTrades + (z * z) / (4 * totalTrades * totalTrades));
    return { low: round(Math.max(0, (c - h) / d) * 100), high: round(Math.min(1, (c + h) / d) * 100) };
  })();
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
    breakevenTrades: breakeven.length,
    winRate: round(winRate),
    payoff: payoff === null ? null : round(payoff),
    breakevenWR: breakevenWR === null ? null : round(breakevenWR),
    marginPP: breakevenWR === null ? null : round(winRate - breakevenWR),
    nEffective,
    wilson95: wilson,
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
      const isShort = position.side === 'short';
      const entryPrice = Number(position.entryPrice ?? position.buyPrice ?? 0);
      const invested = Number(position.investedUSDC || position.marginUSDC || 0);
      const amount = Number(position.amount || 0);

      let marketValue = 0;
      let unrealizedProfit = 0;
      let unrealizedProfitPct = 0;

      if (isShort) {
        unrealizedProfit = (entryPrice - currentPrice) * amount;
        marketValue = invested + unrealizedProfit;
        unrealizedProfitPct = invested > 0 ? (unrealizedProfit / invested) * 100 : 0;
      } else {
        marketValue = amount * currentPrice;
        unrealizedProfit = marketValue - invested;
        unrealizedProfitPct = invested > 0 ? (unrealizedProfit / invested) * 100 : 0;
      }

      const peakPrice = Number(position.peakPrice || entryPrice);
      const peakProfitPct = entryPrice > 0
        ? ((peakPrice - entryPrice) / entryPrice) * 100
        : 0;
      const trailingStopPrice = position.trailingActivated
        ? entryPrice * (1 + ((peakProfitPct * TRAIL_DISTANCE) / 100))
        : null;

      return {
        symbol,
        side: isShort ? 'short' : 'long',
        amount,
        buyPrice: entryPrice,
        entryPrice,
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

function processChannelData(channelKey, cfg, priceMap, generatedAt) {
  const filePath = path.resolve(cfg.syncFile);
  const state = loadState(filePath, cfg.initialBalance);
  const openPositions = buildOpenPositions(state.openPositions, priceMap);
  const trades = normalizeTrades(state.tradeHistory);
  const tradeStats = buildTradeStats(trades);

  const availableBalance = round(state.balanceUSDC);
  const investedCost = round(openPositions.reduce((sum, p) => sum + p.investedUSDC, 0));
  const currentMarketValue = round(openPositions.reduce((sum, p) => sum + p.marketValue, 0));
  const realizedProfit = round(trades.reduce((sum, t) => sum + t.profit, 0));
  const currentTotalEquity = round(availableBalance + currentMarketValue);
  const unrealizedProfit = round(openPositions.reduce((sum, p) => sum + p.unrealizedProfit, 0));
  const totalProfit = round(currentTotalEquity - cfg.initialBalance);
  const roi = cfg.initialBalance > 0 ? round((totalProfit / cfg.initialBalance) * 100) : 0;

  // ── MODO SEÑAL ──────────────────────────────────────────────────────────────────────────────
  // Con capital ilimitado, el ROI sobre el saldo inicial deja de significar nada (crece con el nº
  // de señales abiertas, no con la calidad). El denominador honesto es el CAPITAL DESPLEGADO:
  // nocional × nº de operaciones. Y la métrica de calidad es el % MEDIO POR SEÑAL.
  const deployedOpen = openPositions.reduce((sum, p) => sum + p.investedUSDC, 0);
  const deployedClosed = trades.length * (SIGNAL_MODE.notionalPerSignal || 0);
  const deployedCapital = round(deployedOpen + deployedClosed);
  const returnOnDeployed = deployedCapital > 0 ? round(((realizedProfit + unrealizedProfit) / deployedCapital) * 100) : null;
  const avgPctPerTrade = trades.length > 0
    ? round(trades.reduce((sum, t) => sum + (t.profitPct || 0), 0) / trades.length)
    : null;
  const signalMode = SIGNAL_MODE.enabled ? {
    enabled: true,
    notionalPerSignal: SIGNAL_MODE.notionalPerSignal,
    signalsOpen: openPositions.length,
    signalsClosed: trades.length,
    deployedCapital,
    returnOnDeployed,
    avgPctPerTrade,
    // En modo señal `availableBalance` ya no es caja disponible: es el nominal menos lo desplegado.
    // Negativo = se han tomado más señales de las que el nominal habría permitido. Es esperado.
    balanceIsAccumulator: true,
  } : { enabled: false };

  const curveData = buildEquityCurve(trades, openPositions, cfg.initialBalance, currentTotalEquity, generatedAt);

  return {
    id: channelKey,
    title: cfg.title,
    signalMode,
    storeKey: cfg.storeKey,
    initialBalance: cfg.initialBalance,
    availableBalance,
    investedCost,
    currentMarketValue,
    currentTotalEquity,
    realizedProfit,
    unrealizedProfit,
    totalProfit,
    roi,
    circuitBreakerPausedUntil: state.circuitBreakerPausedUntil,
    lastRebalanceTime: state.lastRebalanceTime,
    openPositions,
    trades,
    tradeStats,
    equityCurve: curveData.equityCurve,
    drawdownCurve: curveData.drawdownCurve,
    maxDrawdown: curveData.maxDrawdown
  };
}

function processPortfolio(channelResults, generatedAt) {
  let initialBalance = 0;
  let availableBalance = 0;
  let investedCost = 0;
  let currentMarketValue = 0;
  let currentTotalEquity = 0;
  let realizedProfit = 0;
  let unrealizedProfit = 0;
  const allOpenPositions = [];
  const allTrades = [];

  for (const ch of Object.values(channelResults)) {
    initialBalance += ch.initialBalance;
    availableBalance += ch.availableBalance;
    investedCost += ch.investedCost;
    currentMarketValue += ch.currentMarketValue;
    currentTotalEquity += ch.currentTotalEquity;
    realizedProfit += ch.realizedProfit;
    unrealizedProfit += ch.unrealizedProfit;
    ch.openPositions.forEach(p => allOpenPositions.push({ ...p, channel: ch.title }));
    ch.trades.forEach(t => allTrades.push({ ...t, channel: ch.title }));
  }

  const totalProfit = round(currentTotalEquity - initialBalance);
  const roi = initialBalance > 0 ? round((totalProfit / initialBalance) * 100) : 0;
  const tradeStats = buildTradeStats(allTrades);
  const curveData = buildEquityCurve(allTrades, allOpenPositions, initialBalance, currentTotalEquity, generatedAt);

  return {
    id: 'portfolio',
    title: '🌐 Cartera Global Consolidada',
    initialBalance: round(initialBalance),
    availableBalance: round(availableBalance),
    investedCost: round(investedCost),
    currentMarketValue: round(currentMarketValue),
    currentTotalEquity: round(currentTotalEquity),
    realizedProfit: round(realizedProfit),
    unrealizedProfit: round(unrealizedProfit),
    totalProfit: round(totalProfit),
    roi,
    openPositions: allOpenPositions.sort((a, b) => b.marketValue - a.marketValue),
    trades: allTrades.sort((a, b) => (parseDate(b.sellTime) || 0) - (parseDate(a.sellTime) || 0)),
    tradeStats,
    equityCurve: curveData.equityCurve,
    drawdownCurve: curveData.drawdownCurve,
    maxDrawdown: curveData.maxDrawdown
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
  const jsonOutputPath = path.resolve(args.jsonOutput);
  const htmlOutputPath = path.resolve(args.htmlOutput);
  const templatePath = path.resolve('shadow-report.html');
  const generatedAt = new Date().toISOString();

  try {
    if (!args.skipSync) {
      console.log('🔄 Sincronizando estados desde Netlify Blobs...');
      for (const key of Object.keys(CHANNELS_CONFIG)) {
        const cfg = CHANNELS_CONFIG[key];
        const syncPath = path.resolve(cfg.syncFile);
        try {
          syncBlobState(cfg.storeKey, syncPath, args.syncTimeoutMs);
        } catch (err) {
          console.warn(`⚠️ No se pudo sincronizar ${cfg.storeKey} (${err.message}). Usando local.`);
        }
      }
    }

    // 1. Recopilar todos los símbolos abiertos en todos los canales
    const allSymbols = new Set();
    for (const key of Object.keys(CHANNELS_CONFIG)) {
      const cfg = CHANNELS_CONFIG[key];
      const state = loadState(path.resolve(cfg.syncFile), cfg.initialBalance);
      Object.keys(state.openPositions).forEach(s => allSymbols.add(s));
    }

    // 2. Precios en tiempo real
    const priceMap = allSymbols.size > 0 ? await binance.getPrices([...allSymbols]) : {};

    // 3. Procesar cada canal
    const channels = {};
    for (const key of Object.keys(CHANNELS_CONFIG)) {
      const cfg = CHANNELS_CONFIG[key];
      channels[key] = processChannelData(key, cfg, priceMap, generatedAt);
    }

    // 4. Procesar cartera consolidada
    const portfolio = processPortfolio(channels, generatedAt);

    // Consolidado SIN los canales experimentales. El titular +5,36 % venía en un 88 % del canal
    // de rotación, que no tenía validación ninguna: sin él, el bot está en +0,94 %. Reportar solo
    // la cifra agregada oculta de dónde sale el resultado.
    const validated = Object.fromEntries(
      Object.entries(channels).filter(([key]) => !CHANNELS_CONFIG[key] || !CHANNELS_CONFIG[key].experimental)
    );
    const portfolioValidated = Object.keys(validated).length > 0
      ? processPortfolio(validated, generatedAt)
      : null;

    const reportData = {
      summary: {
        reportType: 'Multi-Channel Shadow Mode',
        generatedAt,
        initialBalance: portfolio.initialBalance,
        availableBalance: portfolio.availableBalance,
        investedCost: portfolio.investedCost,
        currentMarketValue: portfolio.currentMarketValue,
        currentTotalEquity: portfolio.currentTotalEquity,
        realizedProfit: portfolio.realizedProfit,
        unrealizedProfit: portfolio.unrealizedProfit,
        totalProfit: portfolio.totalProfit,
        roi: portfolio.roi,
        totalTrades: portfolio.tradeStats.totalTrades,
        openPositionsCount: portfolio.openPositions.length,
        maxDrawdown: portfolio.maxDrawdown,
        // Cifra honesta al lado del titular: qué queda al excluir lo no validado.
        roiExcludingExperimental: portfolioValidated ? portfolioValidated.roi : null,
        experimentalChannels: Object.entries(CHANNELS_CONFIG).filter(([, c]) => c.experimental).map(([k]) => k),
      },
      portfolio,
      portfolioValidated,
      channels
    };

    fs.writeFileSync(jsonOutputPath, JSON.stringify(reportData, null, 2));
    injectDataIntoTemplate(templatePath, htmlOutputPath, reportData);

    console.log('\n╔═════════════════════════════════════════════════════════════════╗');
    console.log('║            BINANCE BOT MULTI-CHANNEL SHADOW REPORT              ║');
    console.log('╚═════════════════════════════════════════════════════════════════╝');
    console.log(`💼 Equity Total Global:  ${portfolio.currentTotalEquity.toFixed(2)} USDC (Inicial: ${portfolio.initialBalance.toFixed(2)} USDC)`);
    console.log(`📈 ROI Global:           ${portfolio.roi >= 0 ? '+' : ''}${portfolio.roi}% (${portfolio.totalProfit >= 0 ? '+' : ''}${portfolio.totalProfit.toFixed(2)} USDC)`);
    console.log(`💵 P&L Realizado:        ${portfolio.realizedProfit >= 0 ? '+' : ''}${portfolio.realizedProfit.toFixed(2)} USDC`);
    console.log(`📍 P&L Latente:          ${portfolio.unrealizedProfit >= 0 ? '+' : ''}${portfolio.unrealizedProfit.toFixed(2)} USDC`);
    console.log(`🔓 Posiciones Abiertas:  ${portfolio.openPositions.length}`);
    console.log('─────────────────────────────────────────────────────────────────');
    for (const ch of Object.values(channels)) {
      console.log(`  ${ch.title.padEnd(30)} Equity: ${ch.currentTotalEquity.toFixed(2)} USDC | ROI: ${(ch.roi >= 0 ? '+' : '') + ch.roi}% | Pos: ${ch.openPositions.length}`);
    }
    console.log('─────────────────────────────────────────────────────────────────');
    console.log(`🗂️ JSON guardado en:      ${jsonOutputPath}`);
    console.log(`🖥️ HTML guardado en:      ${htmlOutputPath}\n`);

    if (process.platform === 'darwin' && !args.noOpen) {
      spawnSync('open', [htmlOutputPath], { stdio: 'ignore' });
    }
  } catch (error) {
    console.error('❌ Error generando shadow report:', error.message);
    process.exitCode = 1;
  }
}

main();

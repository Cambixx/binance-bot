import axios from 'axios';
import {
  evaluateStrategy, evaluateStrategyV2, evaluateStrategyV3,
  evaluateStrategyV4A, evaluateStrategyV4B, evaluateStrategyV4C,
  calculateATR
} from './indicators.js';

const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

// Misma Blacklist que bot.js para coherencia total
const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ', 'DOGE', 'BCH'
];

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 5000;
    this.symbols = options.symbols || ['BTCUSDC', 'ETHUSDC', 'SOLUSDC'];
    this.interval = options.interval || '15m';
    this.months = options.months || 3;
    this.strategyVersion = options.strategyVersion || '4C'; // default paridad bot.js (V4C-COMBO)

    // Risk management (V4C-COMBO post-backtest 2026-05-21)
    this.takeProfitPct = options.takeProfitPct || 5.0;
    this.stopLossPct = options.stopLossPct || 3.0;
    this.trailingActivation = options.trailingActivation || 1.5;
    this.trailingDistance = options.trailingDistance || 0.45;     // V4C-COMBO: protege 45% del pico
    this.cooldownCandles = options.cooldownCandles || 12; // 12 velas (3h) de cooldown tras un SL

    // Exit mode: 'fixed' = TP/SL/trailing% clásicos | 'atr' = Chandelier (ATR-based) + ATR SL
    this.exitMode = options.exitMode || 'fixed';
    this.atrPeriod = options.atrPeriod || 14;
    this.atrSLMult = options.atrSLMult || 2.0;        // SL = entry - 2×ATR
    this.atrTrailMult = options.atrTrailMult || 3.0;  // Chandelier trail = peak - 3×ATR
    this.partialExitAtR = options.partialExitAtR || 0; // 0 = off, >0 = vende 50% al alcanzar X·R

    // Regime-gate params (V4-C)
    this.regimeOpts = options.regimeOpts || {};

    // Validación out-of-sample: split temporal train/holdout
    this.oosSplitRatio = options.oosSplitRatio ?? 0.7; // 70% train, 30% holdout
    this.splitTime = null;  // se calcula en run() una vez conocidos los datos

    this.state = {
      balance: this.initialBalance,
      openPositions: {},
      tradeHistory: [],
      equityCurve: [],
      cooldowns: {}
    };
  }

  filterSymbols(symbols) {
    return symbols.filter(symbol => {
      const isBlacklisted = BLACKLIST.some(badCoin => symbol.includes(badCoin));
      if (isBlacklisted) console.log(`🚫 ${symbol} eliminado por Blacklist`);
      return !isBlacklisted;
    });
  }

  async fetchHistoricalData(symbol) {
    const limit = 1000;
    const msInMonth = 30 * 24 * 60 * 60 * 1000;
    const endTime = Date.now();
    const startTime = endTime - (this.months * msInMonth);
    
    let allKlines = [];
    let currentStartTime = startTime;

    console.log(`📥 Descargando datos para ${symbol}...`);

    while (currentStartTime < endTime) {
      try {
        const response = await axios.get(`${BINANCE_API_BASE}/klines`, {
          params: { symbol, interval: this.interval, limit, startTime: currentStartTime }
        });

        const klines = response.data;
        if (klines.length === 0) break;

        allKlines = allKlines.concat(klines.map(k => ({
          time: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        })));

        currentStartTime = klines[klines.length - 1][0] + 1;
        if (klines.length < limit) break;
      } catch (error) {
        console.error(`Error descargando data para ${symbol}:`, error.message);
        break;
      }
    }

    console.log(`   ✅ ${allKlines.length} velas descargadas para ${symbol}`);
    return allKlines;
  }

  async run() {
    const strategyNames = {
      1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)',
      '4A': 'V4-A (Supertrend+Chandelier)', '4B': 'V4-B (V3+ATR-exits)', '4C': 'V4-C (V3+RegimeGate)'
    };
    const strategyName = strategyNames[this.strategyVersion] || 'V3 (ADX+Trailing)';

    console.log('🚀 Iniciando simulación...');
    console.log(`📋 Estrategia: ${strategyName}`);
    if (this.exitMode === 'atr') {
      console.log(`🎯 EXIT=ATR | SL=${this.atrSLMult}×ATR | Chandelier=${this.atrTrailMult}×ATR | partial@${this.partialExitAtR}R`);
    } else {
      console.log(`🎯 TP: +${this.takeProfitPct}% | SL: -${this.stopLossPct}% | Trail: +${this.trailingActivation}%→${(this.trailingDistance * 100).toFixed(0)}%peak`);
    }
    
    this.symbols = this.filterSymbols(this.symbols);
    console.log(`🪙 Símbolos válidos: ${this.symbols.join(', ')}`);
    
    // 1. Descargar todos los datos
    const dataBySymbol = {};
    for (const symbol of this.symbols) {
      dataBySymbol[symbol] = await this.fetchHistoricalData(symbol);
    }

    // 2. Crear eventos cronológicos unificados
    const allEvents = [];
    for (const symbol in dataBySymbol) {
      dataBySymbol[symbol].forEach(k => allEvents.push({ ...k, symbol }));
    }
    allEvents.sort((a, b) => a.time - b.time);

    // Calcular timestamp de split train/holdout
    if (allEvents.length > 0) {
      const startTime = allEvents[0].time;
      const endTime = allEvents[allEvents.length - 1].time;
      this.splitTime = startTime + (endTime - startTime) * this.oosSplitRatio;
      const splitDate = new Date(this.splitTime).toISOString().slice(0, 10);
      console.log(`🔀 OOS split (${(this.oosSplitRatio*100).toFixed(0)}/${((1-this.oosSplitRatio)*100).toFixed(0)}): train hasta ${splitDate}, holdout después`);
    }

    // Buffers OHLCV por símbolo (V3 necesita high, low, volume además de close)
    const candleBuffers = {};
    const currentPrices = {};
    this.symbols.forEach(s => {
      candleBuffers[s] = { closes: [], highs: [], lows: [], volumes: [] };
      currentPrices[s] = 0;
    });

    console.log(`📈 Procesando ${allEvents.length} eventos históricos...`);

    for (const event of allEvents) {
      const { symbol, close, high, low, volume, time } = event;
      const buf = candleBuffers[symbol];
      
      buf.closes.push(close);
      buf.highs.push(high);
      buf.lows.push(low);
      buf.volumes.push(volume);
      currentPrices[symbol] = close;
      
      // Mantener buffer de 120 velas
      const maxBuf = 120;
      if (buf.closes.length > maxBuf) {
        buf.closes.shift();
        buf.highs.shift();
        buf.lows.shift();
        buf.volumes.shift();
      }

      // Decrementar cooldowns
      if (this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0) {
        this.state.cooldowns[symbol]--;
      }

      if (buf.closes.length < 105) continue;

      // Evaluar Estrategia según versión
      let signal;
      switch (String(this.strategyVersion)) {
        case '1':  signal = evaluateStrategy(buf.closes); break;
        case '2':  signal = evaluateStrategyV2(buf.closes); break;
        case '3':  signal = evaluateStrategyV3(buf); break;
        case '4A': signal = evaluateStrategyV4A(buf); break;
        case '4B': signal = evaluateStrategyV4B(buf); break;
        case '4C': signal = evaluateStrategyV4C(buf, this.regimeOpts); break;
        default:   signal = evaluateStrategyV3(buf);
      }

      const hasPosition = !!this.state.openPositions[symbol];
      const isOnCooldown = this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0;

      // Lógica de Compra
      if (signal === 'BUY' && !hasPosition && !isOnCooldown) {
        // Si modo ATR, anclar SL/peak iniciales con ATR del momento
        const entryATR = this.exitMode === 'atr'
          ? this.getCurrentATR(buf)
          : null;
        this.executeBuy(symbol, close, time, entryATR);
      }
      // Lógica de Venta por señal
      else if (signal === 'SELL' && hasPosition) {
        this.executeSell(symbol, close, time, 'SIGNAL');
      }

      // Lógica de salida (ATR vs fixed)
      if (hasPosition && this.state.openPositions[symbol]) {
        const pos = this.state.openPositions[symbol];

        // Actualizar precio máximo alcanzado (común a ambos modos)
        if (close > (pos.peakPrice || pos.buyPrice)) {
          pos.peakPrice = close;
        }

        if (this.exitMode === 'atr') {
          this.applyATRExits(symbol, close, time, pos);
        } else {
          this.applyFixedExits(symbol, close, time, pos);
        }
      }

      this.recordEquity(time, currentPrices);
    }

    // Cerrar posiciones al final
    for (const symbol in this.state.openPositions) {
      if (currentPrices[symbol]) {
        this.executeSell(symbol, currentPrices[symbol], Date.now(), 'END_OF_BACKTEST');
      }
    }

    return this.generateReport();
  }

  executeBuy(symbol, price, time, entryATR = null) {
    const investAmount = this.state.balance * 0.20;
    // Eliminado el bloqueo de saldo < 10 para ver todas las operaciones


    const amountCrypto = investAmount / price;
    this.state.balance -= investAmount;
    this.state.openPositions[symbol] = {
      amount: amountCrypto,
      buyPrice: price,
      invested: investAmount,
      time: new Date(time).toISOString(),
      trailingActivated: false,
      trailingSL: 0,
      peakPrice: price,
      // ATR-mode bookkeeping
      entryATR: entryATR,
      atrSL: entryATR ? price - this.atrSLMult * entryATR : null,
      partialTaken: false
    };
  }

  getCurrentATR(buf) {
    const atrArr = calculateATR(buf.highs, buf.lows, buf.closes, this.atrPeriod);
    return atrArr.length > 0 ? atrArr[atrArr.length - 1] : null;
  }

  applyFixedExits(symbol, close, time, pos) {
    const profitPct = ((close - pos.buyPrice) / pos.buyPrice) * 100;

    if (profitPct >= this.trailingActivation) {
      pos.trailingActivated = true;
      const peakProfit = ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100;
      const trailLevel = peakProfit * this.trailingDistance;
      pos.trailingSL = pos.buyPrice * (1 + trailLevel / 100);
    }

    if (profitPct >= this.takeProfitPct) {
      this.executeSell(symbol, close, time, 'TAKE_PROFIT');
    } else if (pos.trailingActivated && close <= pos.trailingSL) {
      this.executeSell(symbol, close, time, 'TRAILING_STOP');
    } else if (profitPct <= -this.stopLossPct) {
      this.executeSell(symbol, close, time, 'STOP_LOSS');
      this.state.cooldowns[symbol] = this.cooldownCandles;
    }
  }

  applyATRExits(symbol, close, time, pos) {
    if (!pos.entryATR) {
      // fallback a fixed si no hay ATR válido
      this.applyFixedExits(symbol, close, time, pos);
      return;
    }
    const R = this.atrSLMult * pos.entryATR; // unidad de riesgo (precio)

    // Partial profit-taking opcional a Nx ese R inicial
    if (this.partialExitAtR > 0 && !pos.partialTaken) {
      const targetPrice = pos.buyPrice + this.partialExitAtR * R;
      if (close >= targetPrice) {
        const halfAmount = pos.amount * 0.5;
        const returnAmount = halfAmount * close;
        const halfInvested = pos.invested * 0.5;
        const partialProfit = returnAmount - halfInvested;
        const partialPct = (partialProfit / halfInvested) * 100;
        this.state.balance += returnAmount;
        this.state.tradeHistory.push({
          symbol, buyPrice: pos.buyPrice, sellPrice: close,
          profit: parseFloat(partialProfit.toFixed(2)),
          profitPct: parseFloat(partialPct.toFixed(2)),
          buyTime: pos.time, sellTime: new Date(time).toISOString(),
          reason: 'PARTIAL_TP',
          phase: (this.splitTime && new Date(pos.time).getTime() >= this.splitTime) ? 'holdout' : 'train'
        });
        pos.amount -= halfAmount;
        pos.invested -= halfInvested;
        pos.partialTaken = true;
        // tras parcial: mover SL a breakeven
        pos.atrSL = pos.buyPrice;
      }
    }

    // Chandelier trail: SL dinámico = peak - atrTrailMult × ATR(entry)
    const chandelierSL = pos.peakPrice - this.atrTrailMult * pos.entryATR;
    if (chandelierSL > pos.atrSL) pos.atrSL = chandelierSL;

    if (close <= pos.atrSL) {
      const reason = pos.peakPrice > pos.buyPrice * 1.01 ? 'TRAILING_STOP' : 'STOP_LOSS';
      this.executeSell(symbol, close, time, reason);
      if (reason === 'STOP_LOSS') this.state.cooldowns[symbol] = this.cooldownCandles;
    }
  }

  executeSell(symbol, price, time, reason) {
    const pos = this.state.openPositions[symbol];
    if (!pos) return;

    const returnAmount = pos.amount * price;
    const profit = returnAmount - pos.invested;
    const profitPct = (profit / pos.invested) * 100;

    this.state.balance += returnAmount;
    const buyTimeMs = new Date(pos.time).getTime();
    const phase = (this.splitTime && buyTimeMs >= this.splitTime) ? 'holdout' : 'train';
    this.state.tradeHistory.push({
      symbol,
      buyPrice: pos.buyPrice,
      sellPrice: price,
      profit: parseFloat(profit.toFixed(2)),
      profitPct: parseFloat(profitPct.toFixed(2)),
      buyTime: pos.time,
      sellTime: new Date(time).toISOString(),
      reason,
      phase
    });

    delete this.state.openPositions[symbol];
  }

  recordEquity(time, currentPrices) {
    const lastRecord = this.state.equityCurve[this.state.equityCurve.length - 1];
    if (lastRecord && (time - lastRecord.time) < 3600000) return;

    let investedValue = 0;
    for (const s in this.state.openPositions) {
      const pos = this.state.openPositions[s];
      investedValue += pos.amount * (currentPrices[s] || pos.buyPrice);
    }
    
    const totalEquity = this.state.balance + investedValue;
    this.state.equityCurve.push({ time, equity: parseFloat(totalEquity.toFixed(2)) });
  }

  computeMetrics(trades, balanceStart, balanceEnd, equityCurveSubset) {
    const totalTrades = trades.length;
    const winners = trades.filter(t => t.profit > 0);
    const losers = trades.filter(t => t.profit <= 0);
    const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

    const totalProfit = parseFloat((balanceEnd - balanceStart).toFixed(2));
    const roi = balanceStart > 0 ? (totalProfit / balanceStart) * 100 : 0;

    const grossProfit = winners.reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

    let maxEquity = balanceStart;
    let maxDD = 0;
    (equityCurveSubset || []).forEach(p => {
      if (p.equity > maxEquity) maxEquity = p.equity;
      const dd = (maxEquity - p.equity) / maxEquity * 100;
      if (dd > maxDD) maxDD = dd;
    });

    const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
    const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
    const expectancy = totalTrades > 0
      ? ((winRate / 100) * avgWin) - (((100 - winRate) / 100) * avgLoss)
      : 0;

    let totalDuration = 0;
    trades.forEach(t => {
      totalDuration += new Date(t.sellTime).getTime() - new Date(t.buyTime).getTime();
    });
    const avgDurationHours = totalTrades > 0 ? (totalDuration / totalTrades / 3600000) : 0;

    const byReason = {};
    trades.forEach(t => { byReason[t.reason] = (byReason[t.reason] || 0) + 1; });

    const bySymbol = {};
    trades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
      bySymbol[t.symbol].trades++;
      bySymbol[t.symbol].profit += t.profit;
      if (t.profit > 0) bySymbol[t.symbol].wins++;
    });

    return {
      totalTrades,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: parseFloat(winRate.toFixed(2)),
      totalProfit,
      roi: parseFloat(roi.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      avgDurationHours: parseFloat(avgDurationHours.toFixed(1)),
      byReason,
      bySymbol
    };
  }

  generateReport() {
    const strategyNames = { 1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)' };

    // Full curve & drawdown
    let maxEquity = this.initialBalance;
    const drawdownCurve = [];
    this.state.equityCurve.forEach(p => {
      if (p.equity > maxEquity) maxEquity = p.equity;
      const dd = (maxEquity - p.equity) / maxEquity * 100;
      drawdownCurve.push({ time: p.time, drawdown: parseFloat(dd.toFixed(2)) });
    });

    // Full metrics
    const fullMetrics = this.computeMetrics(
      this.state.tradeHistory,
      this.initialBalance,
      this.state.balance,
      this.state.equityCurve
    );

    // Train/holdout split
    let trainMetrics = null, holdoutMetrics = null;
    if (this.splitTime) {
      const splitIso = new Date(this.splitTime).toISOString();
      const trainTrades = this.state.tradeHistory.filter(t => t.phase === 'train');
      const holdoutTrades = this.state.tradeHistory.filter(t => t.phase === 'holdout');
      const trainCurve = this.state.equityCurve.filter(p => p.time < this.splitTime);
      const holdoutCurve = this.state.equityCurve.filter(p => p.time >= this.splitTime);

      const balanceAtSplit = trainCurve.length > 0
        ? trainCurve[trainCurve.length - 1].equity
        : this.initialBalance;

      trainMetrics = this.computeMetrics(
        trainTrades, this.initialBalance, balanceAtSplit, trainCurve
      );
      holdoutMetrics = this.computeMetrics(
        holdoutTrades, balanceAtSplit, this.state.balance, holdoutCurve
      );
      trainMetrics.splitTime = splitIso;
      holdoutMetrics.splitTime = splitIso;
    }

    return {
      summary: {
        initialBalance: this.initialBalance,
        finalBalance: parseFloat(this.state.balance.toFixed(2)),
        periodMonths: this.months,
        symbols: this.symbols,
        strategy: strategyNames[this.strategyVersion] || 'V3 (ADX+Trailing)',
        oosSplitRatio: this.oosSplitRatio,
        ...fullMetrics
      },
      trainSummary: trainMetrics,
      holdoutSummary: holdoutMetrics,
      trades: this.state.tradeHistory,
      equityCurve: this.state.equityCurve,
      drawdownCurve
    };
  }
}

export default BacktestEngine;

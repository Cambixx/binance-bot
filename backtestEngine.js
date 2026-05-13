import axios from 'axios';
import { evaluateStrategy, evaluateStrategyV2, evaluateStrategyV3 } from './indicators.js';

const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

// Misma Blacklist que bot.js para coherencia total
const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ'
];

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 5000;
    this.symbols = options.symbols || ['BTCUSDC', 'ETHUSDC', 'SOLUSDC'];
    this.interval = options.interval || '15m';
    this.months = options.months || 3;
    this.strategyVersion = options.strategyVersion || 3; // 1, 2, or 3

    // Risk management
    this.takeProfitPct = options.takeProfitPct || 5.0;
    this.stopLossPct = options.stopLossPct || 2.5;
    this.trailingActivation = options.trailingActivation || 1.5; // A +1.5%, activar trailing (V3 optimizado)
    this.trailingDistance = options.trailingDistance || 0.45;     // Trail a 45% del pico, 55% de respiración
    this.cooldownCandles = options.cooldownCandles || 12; // 12 velas (3h) de cooldown tras un SL

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
    const strategyNames = { 1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)' };
    const strategyName = strategyNames[this.strategyVersion] || 'V3 (ADX+Trailing)';

    console.log('🚀 Iniciando simulación...');
    console.log(`📋 Estrategia: ${strategyName}`);
    console.log(`🎯 TP: +${this.takeProfitPct}% | SL: -${this.stopLossPct}% | Trail: +${this.trailingActivation}%→${(this.trailingDistance * 100).toFixed(0)}%peak`);
    
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
      if (this.strategyVersion === 3) {
        signal = evaluateStrategyV3(buf);
      } else if (this.strategyVersion === 2) {
        signal = evaluateStrategyV2(buf.closes);
      } else {
        signal = evaluateStrategy(buf.closes);
      }
      
      const hasPosition = !!this.state.openPositions[symbol];
      const isOnCooldown = this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0;

      // Lógica de Compra
      if (signal === 'BUY' && !hasPosition && !isOnCooldown) {
        this.executeBuy(symbol, close, time);
      } 
      // Lógica de Venta por señal
      else if (signal === 'SELL' && hasPosition) {
        this.executeSell(symbol, close, time, 'SIGNAL');
      }

      // Lógica de TP / SL / Trailing Stop dinámico
      if (hasPosition && this.state.openPositions[symbol]) {
        const pos = this.state.openPositions[symbol];
        const profitPct = ((close - pos.buyPrice) / pos.buyPrice) * 100;

        // Actualizar precio máximo alcanzado
        if (close > (pos.peakPrice || pos.buyPrice)) {
          pos.peakPrice = close;
        }

        // Trailing Stop dinámico: una vez activado, el SL sube con el precio
        if (profitPct >= this.trailingActivation) {
          pos.trailingActivated = true;
          // SL = precio_pico × (1 - (1 - trailingDistance) × distancia_original)
          // Simplificado: trail al X% del beneficio máximo alcanzado
          const peakProfit = ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100;
          const trailLevel = peakProfit * this.trailingDistance; // Proteger 60% del pico
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

  executeBuy(symbol, price, time) {
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
      peakPrice: price
    };
  }

  executeSell(symbol, price, time, reason) {
    const pos = this.state.openPositions[symbol];
    if (!pos) return;

    const returnAmount = pos.amount * price;
    const profit = returnAmount - pos.invested;
    const profitPct = (profit / pos.invested) * 100;

    this.state.balance += returnAmount;
    this.state.tradeHistory.push({
      symbol,
      buyPrice: pos.buyPrice,
      sellPrice: price,
      profit: parseFloat(profit.toFixed(2)),
      profitPct: parseFloat(profitPct.toFixed(2)),
      buyTime: pos.time,
      sellTime: new Date(time).toISOString(),
      reason
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

  generateReport() {
    const strategyNames = { 1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)' };

    const totalTrades = this.state.tradeHistory.length;
    const winners = this.state.tradeHistory.filter(t => t.profit > 0);
    const losers = this.state.tradeHistory.filter(t => t.profit <= 0);
    const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;
    
    const totalProfit = parseFloat((this.state.balance - this.initialBalance).toFixed(2));
    const roi = (totalProfit / this.initialBalance) * 100;

    const grossProfit = winners.reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.profit, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 0;

    let maxEquity = this.initialBalance;
    let maxDD = 0;
    const drawdownCurve = [];
    this.state.equityCurve.forEach(p => {
      if (p.equity > maxEquity) maxEquity = p.equity;
      const dd = (maxEquity - p.equity) / maxEquity * 100;
      if (dd > maxDD) maxDD = dd;
      drawdownCurve.push({ time: p.time, drawdown: parseFloat(dd.toFixed(2)) });
    });

    let totalDuration = 0;
    this.state.tradeHistory.forEach(t => {
      totalDuration += new Date(t.sellTime).getTime() - new Date(t.buyTime).getTime();
    });
    const avgDurationHours = totalTrades > 0 ? (totalDuration / totalTrades / 3600000) : 0;

    const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
    const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;

    const expectancy = totalTrades > 0 
      ? ((winRate / 100) * avgWin) - (((100 - winRate) / 100) * avgLoss)
      : 0;

    const byReason = {};
    this.state.tradeHistory.forEach(t => {
      byReason[t.reason] = (byReason[t.reason] || 0) + 1;
    });

    const bySymbol = {};
    this.state.tradeHistory.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
      bySymbol[t.symbol].trades++;
      bySymbol[t.symbol].profit += t.profit;
      if (t.profit > 0) bySymbol[t.symbol].wins++;
    });

    return {
      summary: {
        initialBalance: this.initialBalance,
        finalBalance: parseFloat(this.state.balance.toFixed(2)),
        totalProfit,
        roi: parseFloat(roi.toFixed(2)),
        winRate: parseFloat(winRate.toFixed(2)),
        totalTrades,
        winningTrades: winners.length,
        losingTrades: losers.length,
        maxDrawdown: parseFloat(maxDD.toFixed(2)),
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        avgWin: parseFloat(avgWin.toFixed(2)),
        avgLoss: parseFloat(avgLoss.toFixed(2)),
        expectancy: parseFloat(expectancy.toFixed(2)),
        avgDurationHours: parseFloat(avgDurationHours.toFixed(1)),
        periodMonths: this.months,
        symbols: this.symbols,
        strategy: strategyNames[this.strategyVersion] || 'V3 (ADX+Trailing)',
        byReason,
        bySymbol
      },
      trades: this.state.tradeHistory,
      equityCurve: this.state.equityCurve,
      drawdownCurve
    };
  }
}

export default BacktestEngine;

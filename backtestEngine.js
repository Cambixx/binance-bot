import axios from 'axios';
import {
  evaluateStrategy, evaluateStrategyV2, evaluateStrategyV3,
  evaluateStrategyV4A, evaluateStrategyV4B, evaluateStrategyV4C,
  evaluateStrategyV5, evaluateStrategyV6,
  evaluateStrategySMA200, evaluateStrategySupertrendDaily, evaluateStrategyDonchian,
  calculateATR, computeVolTargetWeight, periodsPerYearFor
} from './indicators.js';
import { evaluateFixedExit } from './exits.js';
import { BLACKLIST, RISK, COSTS, LOOKBACK_15M } from './config.js';

const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

// Mapa único de nombres de estrategia (fix auditoría #25: antes había dos mapas locales
// desincronizados y generateReport etiquetaba TODO como "V3").
export const STRATEGY_NAMES = {
  1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)',
  '4A': 'V4-A (Supertrend+Chandelier)', '4B': 'V4-B (V3+ATR-exits)', '4C': 'V4-C (V3+RegimeGate)',
  '5': 'V5 (Trend-rider)', '6': 'V6 (Adaptive SuperTrend)',
  'SMA200': 'SMA200 (Faber regime, diaria)', 'STDAY': 'SuperTrend diario', 'DONCHIAN': 'Donchian 55/20 (diaria)',
};

export function strategyName(v) {
  return STRATEGY_NAMES[v] || STRATEGY_NAMES[String(v)] || `Estrategia ${v}`;
}

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 5000;
    this.symbols = options.symbols || ['BTCUSDC', 'ETHUSDC', 'SOLUSDC'];
    this.interval = options.interval || '15m';
    this.months = options.months || 3;
    this.strategyVersion = options.strategyVersion || '4C'; // default paridad bot.js (V4C-COMBO)

    // Risk management (defaults centralizados en config.js → paridad live)
    this.takeProfitPct = options.takeProfitPct ?? RISK.takeProfitPct;
    this.stopLossPct = options.stopLossPct ?? RISK.stopLossPct;
    this.trailingActivation = options.trailingActivation ?? RISK.trailingActivation;
    this.trailingDistance = options.trailingDistance ?? RISK.trailingDistance;
    this.cooldownCandles = options.cooldownCandles ?? RISK.cooldownCandles;
    this.positionSizePct = options.positionSizePct ?? RISK.positionSizePct;
    // Caps de cartera (fix #26). null = sin límite (preserva comportamiento histórico).
    this.maxConcurrentPositions = options.maxConcurrentPositions ?? RISK.maxConcurrentPositions ?? null;
    this.maxExposurePct = options.maxExposurePct ?? RISK.maxExposurePct ?? null;

    // Costes de transacción (fees + slippage) — netados en cada trade. Ver config.js / auditoría.
    this.feePct = options.feePct ?? COSTS.feePct;
    this.slippagePct = options.slippagePct ?? COSTS.slippagePct;

    // Exit mode: 'fixed' = TP/SL/trailing% clásicos | 'atr' = Chandelier (ATR-based) + ATR SL
    this.exitMode = options.exitMode || 'fixed';
    this.atrPeriod = options.atrPeriod || 14;
    this.atrSLMult = options.atrSLMult || 2.0;        // SL = entry - 2×ATR
    this.atrTrailMult = options.atrTrailMult || 3.0;  // Chandelier trail = peak - 3×ATR
    this.partialExitAtR = options.partialExitAtR || 0; // 0 = off, >0 = vende 50% al alcanzar X·R

    // Regime-gate params (V4-C)
    this.regimeOpts = options.regimeOpts || {};

    // Vol-targeting (sizing dinámico). null/disabled = sizing fijo histórico (investigación §2.1).
    this.volTarget = options.volTarget || null;

    // Datos pre-descargados (sweep.js reutiliza una sola descarga entre combos)
    this.dataBySymbol = options.dataBySymbol || null;

    // Buffer/warmup configurables (V5 usa EMA200 → necesita ventana mayor).
    // Default alineado con LOOKBACK_15M para PARIDAD EXACTA del último valor de los indicadores
    // recursivos (EMA/ADX/MFI/CHOP) entre live y backtest (fix auditoría #10).
    this.bufferSize = options.bufferSize ?? LOOKBACK_15M;
    this.minCandles = options.minCandles ?? 120;

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

    // Trackers de drawdown a RESOLUCIÓN COMPLETA (fix #1): el equityCurve almacenado se
    // submuestrea a ~1h para el plot, pero el MaxDD se mide en CADA vela aquí, por fase.
    this.ddTrack = {
      full:    { peak: -Infinity, maxDD: 0 },
      train:   { peak: -Infinity, maxDD: 0 },
      holdout: { peak: -Infinity, maxDD: 0 },
    };
    this.lastEventTime = 0; // máximo timestamp de vela visto (para cierres END_OF_BACKTEST)
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
    console.log('🚀 Iniciando simulación...');
    console.log(`📋 Estrategia: ${strategyName(this.strategyVersion)}`);
    if (this.exitMode === 'atr') {
      console.log(`🎯 EXIT=ATR | SL=${this.atrSLMult}×ATR | Chandelier=${this.atrTrailMult}×ATR | partial@${this.partialExitAtR}R`);
    } else {
      console.log(`🎯 TP: +${this.takeProfitPct}% | SL: -${this.stopLossPct}% | Trail: +${this.trailingActivation}%→${(this.trailingDistance * 100).toFixed(0)}%peak`);
    }
    const rtCost = ((this.feePct + this.slippagePct) * 2 * 100).toFixed(2);
    console.log(`💸 Costes: fee ${(this.feePct*100).toFixed(2)}%/lado + slippage ${(this.slippagePct*100).toFixed(2)}%/lado = ${rtCost}% round-trip`);

    this.symbols = this.filterSymbols(this.symbols);
    console.log(`🪙 Símbolos válidos: ${this.symbols.join(', ')}`);

    // 1. Datos: usar los inyectados (sweep reutiliza la descarga) o descargar
    let dataBySymbol;
    if (this.dataBySymbol) {
      dataBySymbol = {};
      for (const symbol of this.symbols) dataBySymbol[symbol] = this.dataBySymbol[symbol] || [];
    } else {
      dataBySymbol = {};
      for (const symbol of this.symbols) {
        dataBySymbol[symbol] = await this.fetchHistoricalData(symbol);
      }
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

    // Benchmark buy&hold equiponderado por fase (referencia honesta: el objetivo es mejor
    // Sharpe/drawdown que HODL del MISMO periodo, no batir a cash)
    this.buyHold = this.computeBuyHold(dataBySymbol);
    this.buyHoldTrain = this.computeBuyHold(dataBySymbol, null, this.splitTime);
    this.buyHoldHoldout = this.computeBuyHold(dataBySymbol, this.splitTime, null);
    // Benchmark BTC-only HODL (fix #19): aísla el alfa de la estrategia del azar de selección
    // de la cesta. Solo se computa si BTC está en el universo.
    const btcSym = Object.keys(dataBySymbol).find(s => s.includes('BTC'));
    this.btcHold = btcSym ? this.computeBuyHold({ [btcSym]: dataBySymbol[btcSym] }) : null;

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
      if (time > this.lastEventTime) this.lastEventTime = time;

      // Mantener buffer (configurable; V5 necesita >200 para EMA200)
      const maxBuf = this.bufferSize;
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

      if (buf.closes.length < this.minCandles) continue;

      // Evaluar Estrategia según versión
      let signal;
      switch (String(this.strategyVersion)) {
        case '1':  signal = evaluateStrategy(buf.closes); break;
        case '2':  signal = evaluateStrategyV2(buf.closes); break;
        case '3':  signal = evaluateStrategyV3(buf); break;
        case '4A': signal = evaluateStrategyV4A(buf); break;
        case '4B': signal = evaluateStrategyV4B(buf); break;
        case '4C': signal = evaluateStrategyV4C(buf, this.regimeOpts); break;
        case '5':  signal = evaluateStrategyV5(buf, this.regimeOpts); break;
        case '6':  signal = evaluateStrategyV6(buf, this.regimeOpts); break;
        case 'SMA200':   signal = evaluateStrategySMA200(buf, this.regimeOpts); break;
        case 'STDAY':    signal = evaluateStrategySupertrendDaily(buf, this.regimeOpts); break;
        case 'DONCHIAN': signal = evaluateStrategyDonchian(buf, this.regimeOpts); break;
        default:   signal = evaluateStrategyV3(buf);
      }

      const hasPosition = !!this.state.openPositions[symbol];
      const isOnCooldown = this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0;

      // Lógica de Compra (con caps de cartera, fix #26)
      if (signal === 'BUY' && !hasPosition && !isOnCooldown && this.canOpenPosition(currentPrices)) {
        // Si modo ATR, anclar SL/peak iniciales con ATR del momento
        const entryATR = this.exitMode === 'atr'
          ? this.getCurrentATR(buf)
          : null;
        this.executeBuy(symbol, close, time, entryATR, buf);
      }
      // Lógica de Venta por señal
      else if (signal === 'SELL' && hasPosition) {
        this.executeSell(symbol, close, time, 'SIGNAL');
      }

      // Lógica de salida. 'signal' = la propia estrategia (SELL) gestiona la salida;
      // sin TP/SL/trailing (la regla del indicador ES el trailing stop). Para la familia diaria.
      if (this.exitMode !== 'signal' && hasPosition && this.state.openPositions[symbol]) {
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

      this.trackDrawdown(time, currentPrices); // MaxDD a resolución completa (fix #1)
      this.recordEquity(time, currentPrices);  // curva submuestreada para el plot
    }

    // Cerrar posiciones al final usando el ÚLTIMO timestamp de vela (no Date.now(), fix #9):
    // evita duraciones infladas cuando los datos terminan en el pasado.
    const closeTime = this.lastEventTime || Date.now();
    for (const symbol in this.state.openPositions) {
      if (currentPrices[symbol]) {
        this.executeSell(symbol, currentPrices[symbol], closeTime, 'END_OF_BACKTEST');
      }
    }
    // Punto final de equity (sin throttle) para que la curva acabe en finalBalance
    this.trackDrawdown(closeTime, currentPrices);
    this.recordEquity(closeTime, currentPrices, true);

    return this.generateReport();
  }

  // Fracción del balance a invertir en una nueva posición. Por defecto positionSizePct;
  // con vol-targeting activado (config VOLTARGET) escala el tamaño base por volatilidad
  // realizada: menos tamaño cuando la moneda está volátil (investigación §2.1).
  computeSizeFraction(buf) {
    let frac = this.positionSizePct;
    if (this.volTarget && this.volTarget.enabled && buf && buf.closes.length > 20) {
      const w = computeVolTargetWeight(buf.closes, {
        ...this.volTarget,
        periodsPerYear: periodsPerYearFor(this.interval),
      });
      frac = this.positionSizePct * w;
      if (w <= (this.volTarget.minWeight ?? 0)) frac = 0;
    }
    return frac;
  }

  // Caps de cartera (fix #26): nº máximo de posiciones simultáneas y exposición agregada.
  canOpenPosition(currentPrices) {
    const openCount = Object.keys(this.state.openPositions).length;
    if (this.maxConcurrentPositions != null && openCount >= this.maxConcurrentPositions) return false;
    if (this.maxExposurePct != null) {
      const eq = this.currentEquity(currentPrices);
      let invested = 0;
      for (const s in this.state.openPositions) {
        const p = this.state.openPositions[s];
        invested += p.amount * (currentPrices[s] || p.buyPrice);
      }
      if (eq > 0 && invested / eq >= this.maxExposurePct) return false;
    }
    return true;
  }

  executeBuy(symbol, price, time, entryATR = null, buf = null) {
    const sizeFrac = this.computeSizeFraction(buf);
    if (sizeFrac <= 0) return; // vol-targeting devolvió peso 0 (régimen demasiado volátil)
    const investAmount = this.state.balance * sizeFrac;

    // Costes de entrada: slippage (peor precio de compra) + comisión sobre el notional.
    // amountCrypto se reduce por ambos → el coste queda baked-in en el P&L y la equity.
    const fillPrice = price * (1 + this.slippagePct);
    const buyFee = investAmount * this.feePct;
    const amountCrypto = (investAmount - buyFee) / fillPrice;

    this.state.balance -= investAmount;
    this.state.openPositions[symbol] = {
      amount: amountCrypto,
      buyPrice: price,        // precio de mercado RAW (base de los umbrales TP/SL/trailing)
      invested: investAmount, // capital comprometido (incluye fee de entrada)
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
    // Decisión vía la FUENTE ÚNICA compartida con el bot live (fix #2 → paridad garantizada).
    const d = evaluateFixedExit(pos, close, {
      takeProfitPct: this.takeProfitPct,
      stopLossPct: this.stopLossPct,
      trailingActivation: this.trailingActivation,
      trailingDistance: this.trailingDistance,
    });
    pos.peakPrice = d.peakPrice;
    pos.trailingActivated = d.trailingActivated;
    pos.trailingSL = d.trailingSL;

    if (d.action === 'TAKE_PROFIT') {
      this.executeSell(symbol, close, time, 'TAKE_PROFIT');
    } else if (d.action === 'TRAILING_STOP') {
      this.executeSell(symbol, close, time, 'TRAILING_STOP');
    } else if (d.action === 'STOP_LOSS') {
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
        // Costes de salida también en la toma parcial
        const fillPrice = close * (1 - this.slippagePct);
        const grossReturn = halfAmount * fillPrice;
        const returnAmount = grossReturn - grossReturn * this.feePct;
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
          // Fase por sellTime (fix #7/#20): el P&L se realiza al CIERRE, así la métrica por
          // trade coincide con el tramo de equity donde realmente impacta.
          phase: (this.splitTime && time >= this.splitTime) ? 'holdout' : 'train'
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

    // Costes de salida: slippage (peor precio de venta) + comisión sobre el retorno bruto.
    const fillPrice = price * (1 - this.slippagePct);
    const grossReturn = pos.amount * fillPrice;
    const sellFee = grossReturn * this.feePct;
    const returnAmount = grossReturn - sellFee;
    const profit = returnAmount - pos.invested;
    const profitPct = (profit / pos.invested) * 100;

    this.state.balance += returnAmount;
    // Fase por sellTime (fix #7/#20): el P&L se realiza al cerrar, así la métrica por trade
    // queda atribuida a la misma fase (train/holdout) donde mueve la equity.
    const phase = (this.splitTime && time >= this.splitTime) ? 'holdout' : 'train';
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

  // Buy&hold equiponderado opcionalmente acotado a [fromTime, toTime). Normaliza CADA
  // símbolo a su primer close DENTRO de la ventana → ROI y MaxDD del índice equiponderado.
  computeBuyHold(dataBySymbol, fromTime = null, toTime = null) {
    const syms = Object.keys(dataBySymbol).filter(s => (dataBySymbol[s] || []).length > 0);
    if (syms.length === 0) return { roi: 0, maxDrawdown: 0 };
    const inWin = t => (fromTime === null || t >= fromTime) && (toTime === null || t < toTime);
    const norm = {};
    syms.forEach(s => {
      const d = dataBySymbol[s].filter(k => inWin(k.time));
      if (d.length === 0) { norm[s] = new Map(); return; }
      const first = d[0].close;
      const m = new Map();
      d.forEach(k => m.set(k.time, k.close / first));
      norm[s] = m;
    });
    const times = [...new Set(syms.flatMap(s => [...norm[s].keys()]))].sort((a, b) => a - b);
    let peak = -Infinity, maxDD = 0, firstVal = null, lastVal = null;
    for (const t of times) {
      let sum = 0, cnt = 0;
      for (const s of syms) { const v = norm[s].get(t); if (v !== undefined) { sum += v; cnt++; } }
      if (cnt === 0) continue;
      const val = sum / cnt;
      if (firstVal === null) firstVal = val;
      lastVal = val;
      if (val > peak) peak = val;
      const dd = (peak - val) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
    const roi = firstVal ? (lastVal / firstVal - 1) * 100 : 0;
    return { roi: parseFloat(roi.toFixed(2)), maxDrawdown: parseFloat(maxDD.toFixed(2)) };
  }

  // Equity total (cash + posiciones valoradas a mercado) en este instante.
  currentEquity(currentPrices) {
    let investedValue = 0;
    for (const s in this.state.openPositions) {
      const pos = this.state.openPositions[s];
      investedValue += pos.amount * (currentPrices[s] || pos.buyPrice);
    }
    return this.state.balance + investedValue;
  }

  // MaxDrawdown a RESOLUCIÓN COMPLETA: se llama en CADA vela (fix #1). Mantiene un peak/maxDD
  // por fase, independiente del equityCurve submuestreado (que es solo para el plot). Así el
  // DD reportado y el de computeBuyHold se miden con la misma granularidad por-vela.
  trackDrawdown(time, currentPrices) {
    const eq = this.currentEquity(currentPrices);
    const update = (acc) => {
      if (eq > acc.peak) acc.peak = eq;
      if (acc.peak > 0) {
        const dd = (acc.peak - eq) / acc.peak * 100;
        if (dd > acc.maxDD) acc.maxDD = dd;
      }
    };
    update(this.ddTrack.full);
    if (this.splitTime == null || time < this.splitTime) update(this.ddTrack.train);
    else update(this.ddTrack.holdout);
  }

  recordEquity(time, currentPrices, force = false) {
    const lastRecord = this.state.equityCurve[this.state.equityCurve.length - 1];
    if (!force && lastRecord && (time - lastRecord.time) < 3600000) return;

    const totalEquity = this.currentEquity(currentPrices);
    this.state.equityCurve.push({ time, equity: parseFloat(totalEquity.toFixed(2)) });
  }

  // Métricas riesgo-ajustadas (fix #18) sobre la serie de retornos de la curva de equity.
  // Sharpe/Sortino anualizados con periodsPerYear inferido del espaciado mediano de la curva.
  // Calmar = retorno anualizado / |MaxDD|. rf=0 (típico en cripto).
  computeRiskAdjusted(equityCurve, maxDDpct) {
    const pts = (equityCurve || []).filter(p => isFinite(p.equity) && p.equity > 0);
    if (pts.length < 3) return { sharpe: 0, sortino: 0, calmar: 0, annReturn: 0, annVol: 0 };
    const rets = [];
    const dts = [];
    for (let i = 1; i < pts.length; i++) {
      rets.push(Math.log(pts[i].equity / pts[i - 1].equity));
      dts.push(pts[i].time - pts[i - 1].time);
    }
    dts.sort((a, b) => a - b);
    const medianDt = dts[Math.floor(dts.length / 2)] || 3600000;
    const periodsPerYear = medianDt > 0 ? (365 * 24 * 3600000) / medianDt : 365;
    const n = rets.length;
    const mean = rets.reduce((s, r) => s + r, 0) / n;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const downside = rets.filter(r => r < 0);
    const downVar = downside.length > 0 ? downside.reduce((s, r) => s + r * r, 0) / n : 0;
    const downStd = Math.sqrt(downVar);
    const annReturn = (Math.exp(mean * periodsPerYear) - 1) * 100;
    const annVol = std * Math.sqrt(periodsPerYear) * 100;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
    const sortino = downStd > 0 ? (mean / downStd) * Math.sqrt(periodsPerYear) : 0;
    const calmar = maxDDpct > 0 ? annReturn / maxDDpct : 0;
    return {
      sharpe: parseFloat(sharpe.toFixed(2)),
      sortino: parseFloat(sortino.toFixed(2)),
      calmar: parseFloat(calmar.toFixed(2)),
      annReturn: parseFloat(annReturn.toFixed(2)),
      annVol: parseFloat(annVol.toFixed(2)),
    };
  }

  computeMetrics(trades, balanceStart, balanceEnd, equityCurveSubset, precomputedMaxDD = null) {
    const totalTrades = trades.length;
    // Convención de clasificación (fix #27): ganadoras profit>0, perdedoras profit<0,
    // breakeven profit==0 en su propio bucket (no infla las pérdidas).
    const winners = trades.filter(t => t.profit > 0);
    const losers = trades.filter(t => t.profit < 0);
    const breakeven = trades.filter(t => t.profit === 0);
    const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

    const totalProfit = parseFloat((balanceEnd - balanceStart).toFixed(2));
    const roi = balanceStart > 0 ? (totalProfit / balanceStart) * 100 : 0;

    const grossProfit = winners.reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.profit, 0));
    // profitFactor (fix #8): sin pérdidas y con ganancias = Infinity (no 0, que es el peor valor).
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

    // MaxDD: usa el tracker per-bar si está disponible (fix #1); si no, cae a la curva.
    let maxDD;
    if (precomputedMaxDD != null) {
      maxDD = precomputedMaxDD;
    } else {
      let maxEquity = balanceStart;
      maxDD = 0;
      (equityCurveSubset || []).forEach(p => {
        if (p.equity > maxEquity) maxEquity = p.equity;
        const dd = (maxEquity - p.equity) / maxEquity * 100;
        if (dd > maxDD) maxDD = dd;
      });
    }

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

    const risk = this.computeRiskAdjusted(equityCurveSubset, maxDD);

    return {
      totalTrades,
      winningTrades: winners.length,
      losingTrades: losers.length,
      breakevenTrades: breakeven.length,
      winRate: parseFloat(winRate.toFixed(2)),
      totalProfit,
      roi: parseFloat(roi.toFixed(2)),
      profitFactor: isFinite(profitFactor) ? parseFloat(profitFactor.toFixed(2)) : null, // null = sin pérdidas (PF=∞)
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      sharpe: risk.sharpe,
      sortino: risk.sortino,
      calmar: risk.calmar,
      annReturn: risk.annReturn,
      annVol: risk.annVol,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      avgDurationHours: parseFloat(avgDurationHours.toFixed(1)),
      byReason,
      bySymbol
    };
  }

  generateReport() {
    // Full curve & drawdown (plot). El DD reportado de las métricas usa el tracker per-bar.
    let maxEquity = this.initialBalance;
    const drawdownCurve = [];
    this.state.equityCurve.forEach(p => {
      if (p.equity > maxEquity) maxEquity = p.equity;
      const dd = (maxEquity - p.equity) / maxEquity * 100;
      drawdownCurve.push({ time: p.time, drawdown: parseFloat(dd.toFixed(2)) });
    });

    // Full metrics (MaxDD per-bar de ddTrack.full)
    const fullMetrics = this.computeMetrics(
      this.state.tradeHistory,
      this.initialBalance,
      this.state.balance,
      this.state.equityCurve,
      this.ddTrack.full.maxDD
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
        trainTrades, this.initialBalance, balanceAtSplit, trainCurve, this.ddTrack.train.maxDD
      );
      holdoutMetrics = this.computeMetrics(
        holdoutTrades, balanceAtSplit, this.state.balance, holdoutCurve, this.ddTrack.holdout.maxDD
      );
      trainMetrics.splitTime = splitIso;
      holdoutMetrics.splitTime = splitIso;
      trainMetrics.buyHold = this.buyHoldTrain || null;
      holdoutMetrics.buyHold = this.buyHoldHoldout || null;
    }

    return {
      summary: {
        initialBalance: this.initialBalance,
        finalBalance: parseFloat(this.state.balance.toFixed(2)),
        periodMonths: this.months,
        interval: this.interval,
        symbols: this.symbols,
        strategy: strategyName(this.strategyVersion),
        strategyVersion: this.strategyVersion,
        oosSplitRatio: this.oosSplitRatio,
        costs: {
          feePct: this.feePct,
          slippagePct: this.slippagePct,
          roundTripPct: parseFloat(((this.feePct + this.slippagePct) * 2 * 100).toFixed(3))
        },
        buyHold: this.buyHold || null,
        btcHold: this.btcHold || null,
        dataEndTime: this.lastEventTime ? new Date(this.lastEventTime).toISOString() : null,
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

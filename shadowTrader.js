import { getStore } from '@netlify/blobs';
import telegramService from './telegramService.js';
import { RISK, COSTS, INITIAL_BALANCE } from './config.js';

/**
 * Gestor del Modo Simulador (Shadow Mode) usando Netlify Blobs
 * Mantiene el estado persistente de manera asíncrona en la nube.
 *
 * Modela costes reales (fees + slippage) y cooldown post-SL para PARIDAD
 * con el backtest (ver config.js y auditoría 2026-05-29).
 */
class ShadowTrader {
  /**
   * @param {object} opts
   *  - storeKey: clave del blob (cada canal/cartera usa la suya). Default 'bot_state_v2' (V4C-15m).
   *  - label: etiqueta del canal para logs/Telegram. Default 'V4C-15m'.
   */
  constructor(opts = {}) {
    this.initialBalance = INITIAL_BALANCE;
    this.storeName = 'shadow_trading_state';
    this.storeKey = opts.storeKey || 'bot_state_v2';
    this.label = opts.label || 'V4C-15m';
  }

  // Inicialización de la tienda
  getStore() {
    return getStore(this.storeName);
  }

  async _loadState() {
    const store = this.getStore();
    const state = await store.get(this.storeKey, { type: 'json' });

    if (state) {
      return state;
    }

    // Estado por defecto si es la primera ejecución en la nube
    return {
      balanceUSDC: this.initialBalance,
      openPositions: {},
      tradeHistory: [],
      cooldowns: {}
    };
  }

  async _saveState(state) {
    const store = this.getStore();
    await store.setJSON(this.storeKey, state);
  }

  async getOpenPositions() {
    const state = await this._loadState();
    return Object.keys(state.openPositions);
  }
  
  async getFullState() {
    return await this._loadState();
  }

  /**
   * Métricas del bot. Pasa currentPrices ({SYMBOL: precio}) para valorar las
   * posiciones abiertas A MERCADO y exponer el P&L no realizado. Sin precios,
   * cae a coste (buyPrice) y marca pricedAtMarket=false.
   */
  async getStats(currentPrices = {}) {
    const state = await this._loadState();

    const totalTrades = state.tradeHistory.length;
    let winningTrades = 0;
    let realizedPnL = 0;
    state.tradeHistory.forEach(trade => {
      const p = parseFloat(trade.profitUSDC);
      realizedPnL += p;
      if (p > 0) winningTrades++;
    });
    const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : '0.00';

    // Valorar posiciones abiertas a precio de mercado (no a coste)
    let investedEquity = 0;
    let unrealizedPnL = 0;
    let pricedAtMarket = true;
    for (const key in state.openPositions) {
      const pos = state.openPositions[key];
      const mkt = currentPrices[key];
      const valuationPrice = (mkt && mkt > 0) ? mkt : pos.buyPrice;
      if (!(mkt && mkt > 0)) pricedAtMarket = false;
      const value = pos.amount * valuationPrice;
      investedEquity += value;
      unrealizedPnL += value - pos.investedUSDC;
    }

    const currentTotalEquity = state.balanceUSDC + investedEquity;
    const totalProfit = currentTotalEquity - this.initialBalance; // = realizado + no realizado

    return {
      initialBalance: this.initialBalance,
      availableBalance: state.balanceUSDC.toFixed(2),
      investedEquity: investedEquity.toFixed(2),
      currentTotalEquity: currentTotalEquity.toFixed(2),
      realizedPnLUSDC: realizedPnL.toFixed(2),
      unrealizedPnLUSDC: unrealizedPnL.toFixed(2),
      totalProfitUSDC: totalProfit.toFixed(2),
      pricedAtMarket,
      winRate: `${winRate}%`,
      totalTrades,
      winningTrades,
      openPositionsCount: Object.keys(state.openPositions).length
    };
  }

  async buy(symbol, price, options = {}) {
    const state = await this._loadState();

    if (state.openPositions[symbol]) {
      console.log(`[Shadow] Ya tienes una posición abierta en ${symbol}.`);
      return false;
    }

    // Invertimos el % de capital definido en config por operación
    const investAmountUSDC = state.balanceUSDC * RISK.positionSizePct;

    // Costes de entrada (paridad backtest): slippage en el precio + fee sobre el notional.
    const fillPrice = price * (1 + COSTS.slippagePct);
    const buyFee = investAmountUSDC * COSTS.feePct;
    const amountCrypto = price > 0 ? (investAmountUSDC - buyFee) / fillPrice : 0;

    state.balanceUSDC -= investAmountUSDC;
    state.openPositions[symbol] = {
      amount: amountCrypto,
      buyPrice: price,        // precio de mercado RAW (base de los umbrales TP/SL/trailing)
      peakPrice: price,
      trailingActivated: false,
      investedUSDC: investAmountUSDC,
      timestamp: new Date().toISOString()
    };

    // Niveles sugeridos para operativa manual (coinciden con la config real)
    const tpPct = Number(options.takeProfitPct ?? RISK.takeProfitPct);
    const slPct = Number(options.stopLossPct ?? RISK.stopLossPct);
    const trailActivationPct = Number(options.trailActivationPct ?? RISK.trailingActivation);
    const tpPrice = price * (1 + tpPct / 100);
    const slPrice = price * (1 - slPct / 100);
    const trailActivationPrice = price * (1 + trailActivationPct / 100);

    console.log(`🟢 [${this.label}] BUY ${symbol} a ${price} USDC`);
    await this._saveState(state);

    const riskUSDC = investAmountUSDC * (slPct / 100);
    try {
      // Modo régimen (SMA200 diaria): in-or-out, sin TP/SL fijo
      const nivelesBlock = options.regimeMode
        ? `📊 <b>Gestión:</b> mantener mientras cierre diario > SMA${options.smaPeriod || 200}; salir a cash si cae por debajo (sin TP/SL fijo).\n\n`
        : `📊 <b>Niveles:</b>\n` +
          `🎯 TP: ${tpPrice.toFixed(4)} (+${tpPct.toFixed(1)}%)\n` +
          `🛑 SL: ${slPrice.toFixed(4)} (-${slPct.toFixed(1)}%) · riesgo ≈ ${riskUSDC.toFixed(2)} USDC\n` +
          `📈 Trailing al +${trailActivationPct.toFixed(1)}% (protege ${(RISK.trailingDistance * 100).toFixed(0)}% del pico)\n\n`;
      await telegramService.sendMessage(
        `🚨 <b>SEÑAL DE COMPRA</b> · ${this.label}\n\n` +
        `<b>Moneda:</b> #${symbol.replace('USDC', '')}\n` +
        `<b>Precio Entrada:</b> ${price.toFixed(4)} USDC\n` +
        `<b>Tamaño sugerido:</b> ${investAmountUSDC.toFixed(2)} USDC (${(RISK.positionSizePct * 100).toFixed(0)}% del saldo)\n\n` +
        nivelesBlock +
        `<i>Señal probabilística, no garantía. Neto de ~0.30% de costes. Registrada en el simulador.</i>`
      );
    } catch (error) {
      console.error(`[Telegram] No se pudo enviar señal de compra para ${symbol}:`, error.message);
    }

    return true;
  }

  async sell(symbol, price, reason = 'SIGNAL') {
    const state = await this._loadState();
    const position = state.openPositions[symbol];
    
    if (!position) {
      return false;
    }

    // Costes de salida (paridad backtest): slippage en el precio + fee sobre el retorno bruto.
    const fillPrice = price * (1 - COSTS.slippagePct);
    const grossReturn = position.amount * fillPrice;
    const sellFee = grossReturn * COSTS.feePct;
    const returnUSDC = grossReturn - sellFee;
    const profitUSDC = returnUSDC - position.investedUSDC;
    const profitPercentage = (profitUSDC / position.investedUSDC) * 100;

    state.balanceUSDC += returnUSDC;

    const tradeRecord = {
      symbol,
      buyPrice: position.buyPrice,
      sellPrice: price,
      amount: position.amount,
      profitUSDC: profitUSDC.toFixed(2),
      profitPercentage: profitPercentage.toFixed(2) + '%',
      buyTime: position.timestamp,
      sellTime: new Date().toISOString(),
      reason
    };

    state.tradeHistory.push(tradeRecord);
    delete state.openPositions[symbol];

    // Cooldown tras STOP_LOSS: bloquea recompra del símbolo durante N velas (paridad backtest)
    if (reason === 'STOP_LOSS') {
      if (!state.cooldowns) state.cooldowns = {};
      const cooldownMs = RISK.cooldownCandles * 15 * 60 * 1000;
      state.cooldowns[symbol] = new Date(Date.now() + cooldownMs).toISOString();
    }

    console.log(`🔴 [SHADOW SELL] Vendidos ${position.amount.toFixed(4)} ${symbol} a ${price} USDC`);
    console.log(`   Beneficio: ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%)`);
    console.log(`   Saldo total virtual: ${state.balanceUSDC.toFixed(2)} USDC`);
    await this._saveState(state);
    
    try {
      const icon = profitUSDC >= 0 ? '🎯' : '🛑';
      const motivos = { TAKE_PROFIT: 'Take Profit', STOP_LOSS: 'Stop Loss', TRAILING_STOP: 'Trailing Stop', SIGNAL: 'Señal (RSI extremo)' };
      const heldH = ((Date.now() - new Date(position.timestamp).getTime()) / 3600000).toFixed(1);
      await telegramService.sendMessage(
        `${icon} <b>SEÑAL DE CIERRE</b> · ${this.label}\n\n` +
        `<b>Moneda:</b> #${symbol.replace('USDC', '')}\n` +
        `<b>Entrada → Salida:</b> ${position.buyPrice.toFixed(4)} → ${price.toFixed(4)} USDC\n` +
        `<b>Motivo:</b> ${motivos[reason] || reason}\n` +
        `<b>Duración:</b> ${heldH} h\n` +
        `<b>Resultado (neto de costes):</b> ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%)\n\n` +
        `<i>Si replicaste la operación manual, cierra ahora.</i>`
      );
    } catch (error) {
      console.error(`[Telegram] No se pudo enviar señal de cierre para ${symbol}:`, error.message);
    }

    return true;
  }

  /**
   * Actualiza datos de una posición (ej: peakPrice, trailingActivated)
   */
  async updatePosition(symbol, updates) {
    const state = await this._loadState();
    if (state.openPositions[symbol]) {
      state.openPositions[symbol] = { ...state.openPositions[symbol], ...updates };
      await this._saveState(state);
    }
  }
}

// Canal 15m (V4C-COMBO) — cartera por defecto, compatible con el código existente
export default new ShadowTrader();

// Canal diario (SMA200 regime-timer) — cartera independiente para correr en paralelo
export const dailyTrader = new ShadowTrader({ storeKey: 'bot_state_daily_v1', label: 'SMA200-1d' });

// Exportar la clase por si se quieren más canales en el futuro
export { ShadowTrader };

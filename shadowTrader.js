import { getStore } from '@netlify/blobs';
import telegramService from './telegramService.js';

/**
 * Gestor del Modo Simulador (Shadow Mode) usando Netlify Blobs
 * Mantiene el estado persistente de manera asíncrona en la nube.
 */
class ShadowTrader {
  constructor() {
    this.initialBalance = 5000; // Saldo inicial en USDC incrementado
    this.storeName = 'shadow_trading_state';
  }

  // Inicialización de la tienda
  getStore() {
    return getStore(this.storeName);
  }

  async _loadState() {
    const store = this.getStore();
    // Usamos bot_state_v2 para forzar un "reseteo" con los 5000 de capital
    const state = await store.get('bot_state_v2', { type: 'json' });
    
    if (state) {
      return state;
    }

    // Estado por defecto si es la primera ejecución en la nube
    return {
      balanceUSDC: this.initialBalance,
      openPositions: {},
      tradeHistory: []
    };
  }

  async _saveState(state) {
    const store = this.getStore();
    await store.setJSON('bot_state_v2', state);
  }

  async getOpenPositions() {
    const state = await this._loadState();
    return Object.keys(state.openPositions);
  }
  
  async getFullState() {
    return await this._loadState();
  }

  async getStats() {
    const state = await this._loadState();
    
    let totalTrades = state.tradeHistory.length;
    let winningTrades = 0;
    
    state.tradeHistory.forEach(trade => {
      if (parseFloat(trade.profitUSDC) > 0) {
        winningTrades++;
      }
    });

    const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : '0.00';
    
    // Calcular dinero inmovilizado en posiciones abiertas
    let investedEquity = 0;
    for (const key in state.openPositions) {
      investedEquity += state.openPositions[key].investedUSDC;
    }

    const currentTotalEquity = state.balanceUSDC + investedEquity;
    const totalProfit = currentTotalEquity - this.initialBalance;

    return {
      initialBalance: this.initialBalance,
      availableBalance: state.balanceUSDC.toFixed(2),
      investedEquity: investedEquity.toFixed(2),
      currentTotalEquity: currentTotalEquity.toFixed(2),
      totalProfitUSDC: totalProfit.toFixed(2),
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

    // Invertimos el 20% del capital por operación
    const investAmountUSDC = state.balanceUSDC * 0.20; 
    const amountCrypto = price > 0 ? investAmountUSDC / price : 0;
    
    state.balanceUSDC -= investAmountUSDC;
    state.openPositions[symbol] = {
      amount: amountCrypto,
      buyPrice: price,
      peakPrice: price,
      trailingActivated: false,
      investedUSDC: investAmountUSDC,
      timestamp: new Date().toISOString()
    };

    // Niveles sugeridos para operativa manual
    const tpPrice = price * 1.05;
    const slPrice = price * 0.975;
    const trailActivationPct = Number(options.trailActivationPct ?? 1.0);
    const trailActivationPrice = price * (1 + trailActivationPct / 100);

    console.log(`🟢 [SIGNAL] ${symbol} a ${price} USDC (Rastreo activado)`);
    await this._saveState(state);
    
    try {
      await telegramService.sendMessage(
        `🚨 <b>SEÑAL DE COMPRA DETECTADA</b>\n\n` +
        `<b>Moneda:</b> #${symbol.replace('USDC', '')}\n` +
        `<b>Precio Entrada:</b> ${price.toFixed(4)} USDC\n\n` +
        `📊 <b>Niveles Sugeridos (Estrategia V3):</b>\n` +
        `🎯 <b>Take Profit:</b> ${tpPrice.toFixed(4)} (+5%)\n` +
        `🛑 <b>Stop Loss:</b> ${slPrice.toFixed(4)} (-2.5%)\n` +
        `📈 <b>Activar Trailing:</b> ${trailActivationPrice.toFixed(4)} (+${trailActivationPct.toFixed(1)}%)\n\n` +
        `<i>Nota: Operación registrada en el simulador para seguimiento de salida.</i>`
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

    const returnUSDC = position.amount * price;
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

    console.log(`🔴 [SHADOW SELL] Vendidos ${position.amount.toFixed(4)} ${symbol} a ${price} USDC`);
    console.log(`   Beneficio: ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%)`);
    console.log(`   Saldo total virtual: ${state.balanceUSDC.toFixed(2)} USDC`);
    await this._saveState(state);
    
    try {
      const icon = profitUSDC >= 0 ? '🎯' : '🛑';
      await telegramService.sendMessage(
        `${icon} <b>SEÑAL DE CIERRE DETECTADA</b>\n\n` +
        `<b>Moneda:</b> #${symbol.replace('USDC', '')}\n` +
        `<b>Precio de salida:</b> ${price.toFixed(4)} USDC\n` +
        `<b>Motivo:</b> ${tradeRecord.reason.replace('_', ' ')}\n` +
        `<b>Resultado Simulado:</b> ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%)\n\n` +
        `<i>Recomendación: Cierra tu posición manual si aún no lo has hecho.</i>`
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

export default new ShadowTrader();

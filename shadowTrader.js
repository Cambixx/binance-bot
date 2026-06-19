import { getStore } from '@netlify/blobs';
import telegramService from './telegramService.js';
import { RISK, COSTS, INITIAL_BALANCE } from './config.js';

/**
 * Gestor del Modo Simulador (Shadow Mode) usando Netlify Blobs.
 *
 * PATRÓN TRANSACCIONAL (fix auditoría #3/#12): para evitar el race de lost-update y la
 * amplificación de I/O (decenas de read-modify-write por ciclo), el bot debe:
 *   1) `const session = await trader.beginSession()`  → UNA sola lectura del blob
 *   2) mutar en memoria con applyBuy/applySell/applyUpdatePosition(session, ...)
 *   3) `await trader.commitSession(session)`          → UNA sola escritura + envía Telegram
 * Las notificaciones se acumulan y se envían DESPUÉS de persistir (no se notifica un trade
 * que no llegó a guardarse).
 *
 * Los métodos legacy buy()/sell()/updatePosition() (load+apply+commit) se conservan para
 * compatibilidad y tests, pero el bot productivo usa el patrón de sesión.
 *
 * Modela costes reales (fees + slippage) y cooldown post-SL anclado a tiempo de vela
 * para PARIDAD con el backtest (ver config.js).
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

  getStore() {
    return getStore(this.storeName);
  }

  _defaultState() {
    return {
      balanceUSDC: this.initialBalance,
      openPositions: {},
      tradeHistory: [],
      cooldowns: {}
    };
  }

  async _loadState() {
    const store = this.getStore();
    const state = await store.get(this.storeKey, { type: 'json' });
    if (!state) return this._defaultState();
    if (!state.cooldowns) state.cooldowns = {};
    if (!state.openPositions) state.openPositions = {};
    if (!state.tradeHistory) state.tradeHistory = [];
    return state;
  }

  async _saveState(state) {
    const store = this.getStore();
    await store.setJSON(this.storeKey, state);
  }

  // ───────────────────── Sesión transaccional (read-modify-write único) ─────────────────────

  async beginSession() {
    const state = await this._loadState();
    return { state, notifications: [] };
  }

  async commitSession(session) {
    await this._saveState(session.state);
    for (const msg of session.notifications) {
      try {
        await telegramService.sendMessage(msg);
      } catch (error) {
        console.error('[Telegram] No se pudo enviar notificación:', error.message);
      }
    }
    session.notifications = [];
  }

  // ───────────────────── Lecturas ─────────────────────

  async getOpenPositions() {
    const state = await this._loadState();
    return Object.keys(state.openPositions);
  }

  async getFullState() {
    return await this._loadState();
  }

  /**
   * Métricas del bot. Pasa currentPrices ({SYMBOL: precio}) para valorar las posiciones
   * abiertas A MERCADO y exponer el P&L no realizado. Sin precios, cae a coste (buyPrice).
   *
   * winRate y realizedPnL son de trades CERRADOS; totalProfit incluye el no realizado
   * (fix #28: se exponen por separado y etiquetados sin ambigüedad).
   */
  async getStats(currentPrices = {}) {
    const state = await this._loadState();

    const totalTrades = state.tradeHistory.length;
    let winningTrades = 0;
    let realizedPnL = 0;
    state.tradeHistory.forEach(trade => {
      const p = Number(trade.profitUSDC) || 0;
      realizedPnL += p;
      if (p > 0) winningTrades++;
    });
    const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(2) : '0.00';

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
      realizedTotalProfitUSDC: realizedPnL.toFixed(2), // alias explícito: solo trades cerrados
      unrealizedPnLUSDC: unrealizedPnL.toFixed(2),
      totalProfitUSDC: totalProfit.toFixed(2),         // realizado + latente
      pricedAtMarket,
      winRate: `${winRate}%`,                          // sobre trades CERRADOS
      totalTrades,
      winningTrades,
      openPositionsCount: Object.keys(state.openPositions).length
    };
  }

  // ───────────────────── Mutadores puros (operan sobre la sesión) ─────────────────────

  /**
   * Abre una posición en la sesión (sin persistir). options:
   *  - takeProfitPct/stopLossPct/trailActivationPct: niveles sugeridos para el mensaje
   *  - regimeMode/smaPeriod: modo régimen (in-or-out, sin TP/SL fijo)
   *  - sizeFraction: fracción del cash a invertir (default RISK.positionSizePct).
   *    Permite vol-targeting desde el caller (investigación §2.1).
   */
  applyBuy(session, symbol, price, options = {}) {
    const state = session.state;
    if (state.openPositions[symbol]) {
      console.log(`[Shadow] Ya tienes una posición abierta en ${symbol}.`);
      return false;
    }

    const sizeFraction = Number(options.sizeFraction ?? RISK.positionSizePct);
    const investAmountUSDC = state.balanceUSDC * sizeFraction;
    if (!(investAmountUSDC > 0) || !(price > 0)) return false;

    // Costes de entrada (paridad backtest): slippage en el precio + fee sobre el notional.
    const fillPrice = price * (1 + COSTS.slippagePct);
    const buyFee = investAmountUSDC * COSTS.feePct;
    const amountCrypto = (investAmountUSDC - buyFee) / fillPrice;

    state.balanceUSDC -= investAmountUSDC;
    state.openPositions[symbol] = {
      amount: amountCrypto,
      buyPrice: price,        // precio de mercado RAW (base de los umbrales TP/SL/trailing)
      peakPrice: price,
      trailingActivated: false,
      trailingSL: 0,          // nivel de trailing PERSISTIDO (fix #2: paridad con el engine)
      investedUSDC: investAmountUSDC,
      timestamp: new Date().toISOString()
    };

    const tpPct = Number(options.takeProfitPct ?? RISK.takeProfitPct);
    const slPct = Number(options.stopLossPct ?? RISK.stopLossPct);
    const trailActivationPct = Number(options.trailActivationPct ?? RISK.trailingActivation);
    const tpPrice = price * (1 + tpPct / 100);
    const slPrice = price * (1 - slPct / 100);
    const trailActivationPrice = price * (1 + trailActivationPct / 100);
    const riskUSDC = investAmountUSDC * (slPct / 100);
    const tag = telegramService.escape(symbol.replace('USDC', ''));

    const nivelesBlock = options.regimeMode
      ? `📊 <b>Gestión:</b> mantener mientras cierre diario > SMA${options.smaPeriod || 200}; salir a cash si cae por debajo (sin TP/SL fijo).\n\n`
      : `📊 <b>Niveles:</b>\n` +
        `🎯 TP: ${tpPrice.toFixed(4)} (+${tpPct.toFixed(1)}%)\n` +
        `🛑 SL: ${slPrice.toFixed(4)} (-${slPct.toFixed(1)}%) · riesgo ≈ ${riskUSDC.toFixed(2)} USDC\n` +
        `📈 Trailing al +${trailActivationPct.toFixed(1)}% (protege ${(RISK.trailingDistance * 100).toFixed(0)}% del pico)\n\n`;

    session.notifications.push(
      `🚨 <b>SEÑAL DE COMPRA</b> · ${telegramService.escape(this.label)}\n\n` +
      `<b>Moneda:</b> #${tag}\n` +
      `<b>Precio Entrada:</b> ${price.toFixed(4)} USDC\n` +
      `<b>Tamaño sugerido:</b> ${investAmountUSDC.toFixed(2)} USDC (${(sizeFraction * 100).toFixed(0)}% del saldo)\n\n` +
      nivelesBlock +
      `<i>Señal probabilística, no garantía. Neto de ~0.30% de costes. Registrada en el simulador.</i>`
    );

    console.log(`🟢 [${this.label}] BUY ${symbol} a ${price} USDC (size ${(sizeFraction * 100).toFixed(0)}%)`);
    return true;
  }

  /**
   * Cierra una posición en la sesión (sin persistir). options:
   *  - cooldownMs: duración del cooldown post-SL (default RISK.cooldownCandles × 15m)
   *  - candleTime: timestamp de la vela de la señal (ancla del cooldown, fix #30).
   *    Usar el openTime de la última vela CERRADA para que el cooldown cuente VELAS, no
   *    wall-clock (robusto a jitter del cron). Default Date.now().
   */
  applySell(session, symbol, price, reason = 'SIGNAL', options = {}) {
    const state = session.state;
    const position = state.openPositions[symbol];
    if (!position) return false;

    // Costes de salida (paridad backtest): slippage en el precio + fee sobre el retorno bruto.
    const fillPrice = price * (1 - COSTS.slippagePct);
    const grossReturn = position.amount * fillPrice;
    const sellFee = grossReturn * COSTS.feePct;
    const returnUSDC = grossReturn - sellFee;
    const profitUSDC = returnUSDC - position.investedUSDC;
    const profitPercentage = (profitUSDC / position.investedUSDC) * 100;

    state.balanceUSDC += returnUSDC;

    // Precisión: guardar profit como Number a precisión completa (fix #29) → realizedPnL
    // reconcilia con el balance hasta epsilon. El formateo se hace al mostrar.
    state.tradeHistory.push({
      symbol,
      buyPrice: position.buyPrice,
      sellPrice: price,
      amount: position.amount,
      profitUSDC: parseFloat(profitUSDC.toFixed(8)),
      profitPercentage: parseFloat(profitPercentage.toFixed(4)),
      buyTime: position.timestamp,
      sellTime: new Date().toISOString(),
      reason
    });
    delete state.openPositions[symbol];

    // Cooldown post-SL anclado a tiempo de vela (fix #30): bloquea hasta N velas después.
    if (reason === 'STOP_LOSS') {
      if (!state.cooldowns) state.cooldowns = {};
      const cooldownMs = Number(options.cooldownMs ?? RISK.cooldownCandles * 15 * 60 * 1000);
      const anchor = Number(options.candleTime ?? Date.now());
      state.cooldowns[symbol] = new Date(anchor + cooldownMs).toISOString();
    }

    const icon = profitUSDC >= 0 ? '🎯' : '🛑';
    const motivos = { TAKE_PROFIT: 'Take Profit', STOP_LOSS: 'Stop Loss', TRAILING_STOP: 'Trailing Stop', SIGNAL: 'Señal' };
    const heldH = ((Date.now() - new Date(position.timestamp).getTime()) / 3600000).toFixed(1);
    const tag = telegramService.escape(symbol.replace('USDC', ''));
    session.notifications.push(
      `${icon} <b>SEÑAL DE CIERRE</b> · ${telegramService.escape(this.label)}\n\n` +
      `<b>Moneda:</b> #${tag}\n` +
      `<b>Entrada → Salida:</b> ${position.buyPrice.toFixed(4)} → ${price.toFixed(4)} USDC\n` +
      `<b>Motivo:</b> ${telegramService.escape(motivos[reason] || reason)}\n` +
      `<b>Duración:</b> ${heldH} h\n` +
      `<b>Resultado (neto de costes):</b> ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%)\n\n` +
      `<i>Si replicaste la operación manual, cierra ahora.</i>`
    );

    console.log(`🔴 [${this.label}] SELL ${symbol} a ${price} → ${profitUSDC > 0 ? '+' : ''}${profitUSDC.toFixed(2)} USDC (${profitPercentage.toFixed(2)}%) | saldo ${state.balanceUSDC.toFixed(2)}`);
    return true;
  }

  applyUpdatePosition(session, symbol, updates) {
    const pos = session.state.openPositions[symbol];
    if (pos) session.state.openPositions[symbol] = { ...pos, ...updates };
  }

  // ───────────────────── Métodos legacy (load+apply+commit) ─────────────────────

  async buy(symbol, price, options = {}) {
    const session = await this.beginSession();
    const ok = this.applyBuy(session, symbol, price, options);
    await this.commitSession(session);
    return ok;
  }

  async sell(symbol, price, reason = 'SIGNAL', options = {}) {
    const session = await this.beginSession();
    const ok = this.applySell(session, symbol, price, reason, options);
    await this.commitSession(session);
    return ok;
  }

  async updatePosition(symbol, updates) {
    const session = await this.beginSession();
    this.applyUpdatePosition(session, symbol, updates);
    await this._saveState(session.state); // sin notificaciones
  }
}

// Canal 15m (V4C-COMBO) — cartera por defecto, compatible con el código existente
export default new ShadowTrader();

// Canal diario (SMA regime-timer, SMA150 tras auditoría 2026-06-19) — cartera independiente.
// storeKey se mantiene 'bot_state_daily_v1' para conservar el estado live existente.
export const dailyTrader = new ShadowTrader({ storeKey: 'bot_state_daily_v1', label: 'SMA150-1d' });

// Canal de rotación cross-sectional + dual-momentum (investigación P3+P4) — cartera independiente
export const rotationTrader = new ShadowTrader({ storeKey: 'bot_state_rotation_v1', label: 'ROT-dual-mom' });

// Exportar la clase por si se quieren más canales en el futuro
export { ShadowTrader };

import binance from './binanceService.js';
import { rotationTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { computeRotationTargets } from './indicators.js';
import { TOP_COINS_LIMIT, isBlacklisted, ROTATION, REGIME } from './config.js';

/**
 * BOT DE ROTACIÓN — cross-sectional momentum + dual-momentum (investigación P3+P4). CANAL SHADOW.
 *
 * Tesis honesta (verificada): el edge robusto NO viene del ranking relativo sino de los GATES
 * (momentum absoluto propio > 0 + BTC risk-on); en bajista todo se va a cash. Es protección de
 * drawdown, no alfa de retorno. Por eso se corre en shadow y se compara OOS antes de darle peso.
 *
 * Mecánica (sobre velas DIARIAS cerradas, idempotente intra-día):
 *  - Rankea el universo por retorno trailing `lookbackDays`, toma top-N con momentum absoluto>0.
 *  - Si BTC < SMA → risk-off → todo a cash.
 *  - Rebalanceo cada `rebalanceDays` (bi-semanal): vende lo que ya no está en target, compra lo
 *    nuevo equiponderado. Entre rebalanceos no hace nada (baja frecuencia → sobrevive costes).
 */
const DAILY = '1d';
const ROT_UNIVERSE = Math.max(TOP_COINS_LIMIT * 2, 20); // universo más ancho para rankear

export async function runRotationBot() {
  try {
    await _runRotationCycle();
  } catch (error) {
    console.error('❌ [ROT] Error en runRotationBot:', error.message);
    try {
      await telegramService.sendMessage(`⚠️ <b>FALLO BOT ROT-dual-mom</b>\n<code>${telegramService.escape(error.message)}</code>`);
    } catch (_) { /* noop */ }
  }
}

async function _runRotationCycle() {
  console.log('\n🔄 [ROT] Iniciando canal de rotación (cross-sectional + dual-momentum)...');
  const session = await rotationTrader.beginSession();
  const state = session.state;
  console.log(`📊 [ROT] Saldo Virtual: ${state.balanceUSDC.toFixed(2)} USDC`);

  // Universo: top por volumen (más ancho), post-blacklist
  let symbols = await binance.getTopVolumeSymbols(ROT_UNIVERSE + 5);
  symbols = symbols.filter(s => !isBlacklisted(s)).slice(0, ROT_UNIVERSE);

  // Guarda de integridad (auditoría 2026-07-09): si la API falla, getTopVolumeSymbols cae a un
  // fallback de 4 monedas → el ranking degenerado sacaría de target (y VENDERÍA) posiciones sanas.
  // Con universo sospechosamente pequeño se aborta el ciclo y se reintenta en el próximo cron.
  if (symbols.length < Math.max(ROTATION.topN * 2, 10)) {
    throw new Error(`Universo degenerado (${symbols.length} símbolos; ¿fallo de API?) — ciclo abortado sin operar.`);
  }

  const needDays = Math.max(ROTATION.lookbackDays, ROTATION.absMomLookback) + 5;

  // Descargar cierres diarios (vela en formación descartada) del universo + BTC para el gate.
  // En paralelo (auditoría 2026-07-09): ~25 símbolos secuenciales arriesgaban el timeout del cron.
  const closesBySymbol = {};
  await Promise.all(symbols.map(async (sym) => {
    const raw = await binance.getKlines(sym, DAILY, needDays + 2);
    const k = raw.length > 1 ? raw.slice(0, -1) : raw;
    if (k.length >= needDays) closesBySymbol[sym] = k.map(c => c.close);
  }));
  let btcCloses = null;
  if (ROTATION.useBtcRegime) {
    const raw = await binance.getKlines(REGIME.btcSymbol, DAILY, REGIME.btcSmaPeriod + 5);
    const k = raw.length > 1 ? raw.slice(0, -1) : raw;
    btcCloses = k.map(c => c.close);
  }

  // ¿Toca rebalancear? Idempotente: ancla en el openTime de la última vela diaria cerrada.
  const anyRaw = await binance.getKlines(REGIME.btcSymbol, DAILY, 2);
  const lastDailyOpen = anyRaw.length > 0 ? anyRaw[anyRaw.length - (anyRaw.length > 1 ? 2 : 1)].openTime : Date.now();
  const lastRebalance = state.lastRebalanceTime ? new Date(state.lastRebalanceTime).getTime() : 0;
  const dueForRebalance = (lastDailyOpen - lastRebalance) >= ROTATION.rebalanceDays * 86400000;

  if (!dueForRebalance) {
    console.log(`⏳ [ROT] Sin rebalanceo hoy (próximo en ${ROTATION.rebalanceDays}d desde el último).`);
    await rotationTrader.commitSession(session);
    return;
  }

  const { targets, riskOff } = computeRotationTargets(closesBySymbol, {
    lookbackDays: ROTATION.lookbackDays,
    topN: ROTATION.topN,
    absMomLookback: ROTATION.absMomLookback,
    useBtcRegime: ROTATION.useBtcRegime,
    btcCloses,
    btcSmaPeriod: REGIME.btcSmaPeriod,
  });
  console.log(`🎯 [ROT] ${riskOff ? 'RISK-OFF (BTC<SMA) → cash' : 'targets: ' + (targets.join(', ') || '(ninguno)')}`);

  const held = Object.keys(state.openPositions);
  const needPrices = [...new Set([...held, ...targets])];
  const prices = await binance.getPrices(needPrices);

  // Guarda de integridad (auditoría 2026-07-09): sin precio de algún símbolo implicado, el
  // rebalanceo quedaría a medias PERO se estamparía lastRebalanceTime → 14 días con cartera
  // inconsistente. Mejor abortar sin persistir y reintentar en el próximo cron.
  const missing = needPrices.filter(s => !(prices[s] > 0));
  if (missing.length > 0) {
    throw new Error(`Sin precio para ${missing.join(', ')} — rebalanceo abortado sin operar.`);
  }

  // 1) Vender lo que ya no está en target
  for (const sym of held) {
    if (!targets.includes(sym)) {
      const px = prices[sym];
      if (px > 0) rotationTrader.applySell(session, sym, px, 'SIGNAL');
    }
  }

  // 2) Comprar los nuevos targets equiponderados (1/topN del equity por posición)
  const toBuy = targets.filter(t => !state.openPositions[t]);
  if (toBuy.length > 0) {
    // equity = cash + valor de mercado de lo retenido (tras las ventas previas)
    let invested = 0;
    for (const s in state.openPositions) invested += state.openPositions[s].amount * (prices[s] || state.openPositions[s].buyPrice);
    const equity = state.balanceUSDC + invested;
    const perPosUSDC = equity / ROTATION.topN;
    for (const sym of toBuy) {
      const px = prices[sym];
      if (!(px > 0) || !(state.balanceUSDC > 0)) continue;
      const sizeFraction = Math.min(1, perPosUSDC / state.balanceUSDC);
      rotationTrader.applyBuy(session, sym, px, { regimeMode: true, sizeFraction, smaPeriod: ROTATION.absMomLookback });
    }
  }

  state.lastRebalanceTime = new Date(lastDailyOpen).toISOString();
  await rotationTrader.commitSession(session);
  console.log('✅ [ROT] Rebalanceo terminado.');
}

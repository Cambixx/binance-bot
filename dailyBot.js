import binance from './binanceService.js';
import { dailyTrader, isCircuitBreakerActive } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { evaluateStrategySMA200, computeVolTargetWeight, btcRegimeOn } from './indicators.js';
import { isBlacklisted, SMA_HYSTERESIS_BAND, SMA_PERIOD, DAILY_BASKET, VOLTARGET, RISK, REGIME } from './config.js';

/**
 * BOT DIARIO — Market-timing de régimen SMA (estilo Faber). CANAL PARALELO al 15m.
 */
const DAILY_INTERVAL = '1d';

export async function runDailyBot() {
  try {
    await _runDailyCycle();
  } catch (error) {
    console.error('❌ [SMA-1d] Error en runDailyBot:', error.message);
    try {
      await telegramService.sendMessage(`⚠️ <b>FALLO BOT SMA${SMA_PERIOD}-1d</b>\n<code>${telegramService.escape(error.message)}</code>`);
    } catch (_) { /* noop */ }
  }
}

async function _runDailyCycle() {
  console.log(`\n📅 [SMA${SMA_PERIOD}-1d] Iniciando canal diario (regime-timer)...`);

  // UNA sola lectura/escritura por ciclo (fix #3/#12)
  const session = await dailyTrader.beginSession();
  console.log(`📊 [SMA${SMA_PERIOD}-1d] Saldo Virtual: ${session.state.balanceUSDC.toFixed(2)} USDC`);

  const cbActive = isCircuitBreakerActive(session.state);
  if (cbActive) {
    console.log(`⛔ [SMA${SMA_PERIOD}-1d] Circuit Breaker activo → pausa temporizada por Max Drawdown rolling (no se abren largos nuevos).`);
  }

  // Universo: cesta FIJA de large-caps (no el top-10 volátil) — paridad con el backtest.
  const symbols = DAILY_BASKET.filter(s => !isBlacklisted(s));

  // Además gestionamos cualquier posición abierta aunque ya no esté en la cesta (se vende normal).
  const openSymbols = Object.keys(session.state.openPositions);
  const monitored = [...new Set([...symbols, ...openSymbols])];
  console.log(`🔍 [SMA${SMA_PERIOD}-1d] Evaluando régimen diario (band ${(SMA_HYSTERESIS_BAND * 100).toFixed(2)}%): ${monitored.join(', ')}`);

  const rawBySymbol = {};
  const toFetch = [...new Set([...monitored, ...(REGIME.btcEnabled ? [REGIME.btcSymbol] : [])])];
  await Promise.all(toFetch.map(async (s) => {
    rawBySymbol[s] = await binance.getKlines(s, DAILY_INTERVAL, SMA_PERIOD + 61, {}, { cacheMs: 120000 });
  }));

  // Gate maestro BTC para entradas LARGAS (con Crash Guard)
  let btcRiskOn = true;
  if (REGIME.btcEnabled) {
    const btcRaw = rawBySymbol[REGIME.btcSymbol] || [];
    const btcCloses = (btcRaw.length > 0 ? btcRaw.slice(0, -1) : btcRaw).map(k => k.close);
    btcRiskOn = btcRegimeOn(btcCloses, REGIME.btcSmaPeriod, REGIME);
    if (!btcRiskOn) console.log(`⛔ [SMA${SMA_PERIOD}-1d] Gate BTC: BTC risk-off (SMA${REGIME.btcSmaPeriod} o Crash Guard) → no se abren largos nuevos este ciclo.`);
  }

  for (const symbol of monitored) {
    const raw = rawBySymbol[symbol] || [];
    const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
    if (klines.length < SMA_PERIOD + 1) continue;

    const closes = klines.map(k => k.close);
    const currentPrice = closes[closes.length - 1];
    const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND });

    const hasPos = !!session.state.openPositions[symbol];
    const canOpen = symbols.includes(symbol) && !cbActive;

    if (signal === 'BUY' && !hasPos && canOpen && btcRiskOn && !isBlacklisted(symbol)) {
      const w = computeVolTargetWeight(closes, { ...VOLTARGET, periodsPerYear: 365 });
      let frac = RISK.positionSizePct * w;
      if (w <= (VOLTARGET.minWeight ?? 0)) frac = 0;
      if (frac > 0) {
        console.log(`🟢 [SMA${SMA_PERIOD}-1d] RÉGIMEN ALCISTA: ${symbol} (close > SMA${SMA_PERIOD}) a ${currentPrice} (size ${(frac * 100).toFixed(0)}%)`);
        dailyTrader.applyBuy(session, symbol, currentPrice, { regimeMode: true, smaPeriod: SMA_PERIOD, sizeFraction: frac });
      } else {
        console.log(`⚪ [SMA${SMA_PERIOD}-1d] ${symbol} alcista pero vol-target → peso 0 (régimen demasiado volátil)`);
      }
    } else if (signal === 'SELL' && hasPos) {
      console.log(`🔴 [SMA${SMA_PERIOD}-1d] RÉGIMEN BAJISTA: ${symbol} (close < SMA${SMA_PERIOD}) → cash a ${currentPrice}`);
      dailyTrader.applySell(session, symbol, currentPrice, 'SIGNAL');
    }
  }

  await dailyTrader.commitSession(session);
  console.log(`✅ [SMA${SMA_PERIOD}-1d] Ciclo diario terminado.`);
}


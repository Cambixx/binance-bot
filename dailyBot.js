import binance from './binanceService.js';
import { dailyTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { evaluateStrategySMA200 } from './indicators.js';
import { TOP_COINS_LIMIT, isBlacklisted, SMA_HYSTERESIS_BAND } from './config.js';

/**
 * BOT DIARIO — Market-timing de régimen SMA200 (estilo Faber). CANAL PARALELO al 15m.
 *
 * Estrategia validada (backtest 36m, costes 0.30%, OOS): bate a buy&hold en
 * retorno-ajustado-a-riesgo y recorta el drawdown (ver BOT_DOCUMENTATION §1.2).
 *
 * Lógica in-or-out por moneda: invertido si cierre DIARIO > SMA200·(1+band), cash si
 * < SMA200·(1-band). La banda de histéresis (fix #11) corta el whipsaw alrededor de la SMA.
 * - Frecuencia bajísima → costes irrelevantes.
 * - Sin TP/SL fijo: la SMA200 ES el stop. La salida la dicta la señal.
 * - Idempotente: aunque el cron lo invoque cada 15m, solo opera cuando la señal diaria
 *   (sobre velas CERRADAS) cambia. Entre cierres diarios no hace nada.
 */
const SMA_PERIOD = 200;
const DAILY_INTERVAL = '1d';

export async function runDailyBot() {
  try {
    await _runDailyCycle();
  } catch (error) {
    console.error('❌ [SMA200-1d] Error en runDailyBot:', error.message);
    try {
      await telegramService.sendMessage(`⚠️ <b>FALLO BOT SMA200-1d</b>\n<code>${telegramService.escape(error.message)}</code>`);
    } catch (_) { /* noop */ }
  }
}

async function _runDailyCycle() {
  console.log('\n📅 [SMA200-1d] Iniciando canal diario (regime-timer)...');

  // UNA sola lectura/escritura por ciclo (fix #3/#12)
  const session = await dailyTrader.beginSession();
  console.log(`📊 [SMA200-1d] Saldo Virtual: ${session.state.balanceUSDC.toFixed(2)} USDC`);

  // Universo: mismo top por volumen que el bot 15m, tras blacklist
  let symbols = await binance.getTopVolumeSymbols(TOP_COINS_LIMIT + 5);
  symbols = symbols.filter(s => !isBlacklisted(s)).slice(0, TOP_COINS_LIMIT);

  const openSymbols = Object.keys(session.state.openPositions);
  const monitored = [...new Set([...symbols, ...openSymbols])];
  console.log(`🔍 [SMA200-1d] Evaluando régimen diario (band ${(SMA_HYSTERESIS_BAND * 100).toFixed(1)}%): ${monitored.join(', ')}`);

  for (const symbol of monitored) {
    // Velas DIARIAS. Pedimos SMA_PERIOD+11 y descartamos la última (vela en formación).
    const raw = await binance.getKlines(symbol, DAILY_INTERVAL, SMA_PERIOD + 11);
    const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
    if (klines.length < SMA_PERIOD + 1) continue;

    const closes = klines.map(k => k.close);
    const currentPrice = closes[closes.length - 1];
    const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND });

    const hasPos = !!session.state.openPositions[symbol];
    const canOpen = symbols.includes(symbol);

    if (signal === 'BUY' && !hasPos && canOpen && !isBlacklisted(symbol)) {
      console.log(`🟢 [SMA200-1d] RÉGIMEN ALCISTA: ${symbol} (close > SMA200) a ${currentPrice}`);
      dailyTrader.applyBuy(session, symbol, currentPrice, { regimeMode: true, smaPeriod: SMA_PERIOD });
    } else if (signal === 'SELL' && hasPos) {
      console.log(`🔴 [SMA200-1d] RÉGIMEN BAJISTA: ${symbol} (close < SMA200) → cash a ${currentPrice}`);
      dailyTrader.applySell(session, symbol, currentPrice, 'SIGNAL');
    }
  }

  await dailyTrader.commitSession(session);
  console.log('✅ [SMA200-1d] Ciclo diario terminado.');
}

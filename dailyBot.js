import binance from './binanceService.js';
import { dailyTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { evaluateStrategySMA200, computeVolTargetWeight } from './indicators.js';
import { isBlacklisted, SMA_HYSTERESIS_BAND, SMA_PERIOD, DAILY_BASKET, VOLTARGET, RISK } from './config.js';

/**
 * BOT DIARIO — Market-timing de régimen SMA (estilo Faber). CANAL PARALELO al 15m.
 *
 * Config tras auditoría 2026-06-19 (la familia validada, optimizada por riesgo-ajustado OOS):
 *  - SMA_PERIOD = 150 (única longitud con holdout PF>1; ver config.js).
 *  - Universo = cesta FIJA de large-caps (DAILY_BASKET), NO el top-10 por volumen volátil.
 *  - Vol-targeting POR-CANAL: el tamaño se escala por volatilidad realizada (mejora Calmar/MaxDD
 *    OOS). Se cablea aquí, NO con VOLTARGET.enabled global (eso afectaría a V4C/ROT).
 *
 * Lógica in-or-out por moneda: invertido si cierre DIARIO > SMA·(1+band), cash si < SMA·(1-band).
 * - Frecuencia bajísima → costes irrelevantes. Sin TP/SL fijo: la SMA ES el stop.
 * - Idempotente intra-día: solo opera cuando la señal diaria (velas CERRADAS) cambia.
 *
 * ⚠️ Honestidad: el objetivo es PRESERVACIÓN DE CAPITAL / mejor riesgo-ajustado, NO batir a BTC.
 *    No promover a capital real hasta ≥6-8 trades CERRADOS con PF>1 en live (hoy n=1).
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

  // Universo: cesta FIJA de large-caps (no el top-10 volátil) — paridad con el backtest.
  const symbols = DAILY_BASKET.filter(s => !isBlacklisted(s));

  // Además gestionamos cualquier posición abierta aunque ya no esté en la cesta (se vende normal).
  const openSymbols = Object.keys(session.state.openPositions);
  const monitored = [...new Set([...symbols, ...openSymbols])];
  console.log(`🔍 [SMA${SMA_PERIOD}-1d] Evaluando régimen diario (band ${(SMA_HYSTERESIS_BAND * 100).toFixed(1)}%): ${monitored.join(', ')}`);

  // Velas DIARIAS en PARALELO (auditoría 2026-07-09: antes secuencial → ~8× más lento; el cron
  // serverless tiene timeout). Ventana = SMA_PERIOD+61 (se descarta la vela en formación → +60
  // cierres) para PARIDAD EXACTA con el bufferSize del backtest (sp+60): el peso de vol-targeting
  // (EWMA) ve la misma longitud de serie en live y en backtest. cacheMs: el canal LS reutiliza
  // estas mismas velas en la misma invocación sin re-descargar.
  const rawBySymbol = {};
  await Promise.all(monitored.map(async (s) => {
    rawBySymbol[s] = await binance.getKlines(s, DAILY_INTERVAL, SMA_PERIOD + 61, {}, { cacheMs: 120000 });
  }));

  for (const symbol of monitored) {
    const raw = rawBySymbol[symbol] || [];
    const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
    // Guard de histórico: sin suficientes velas no se puede calcular la SMA → se ignora.
    if (klines.length < SMA_PERIOD + 1) continue;

    const closes = klines.map(k => k.close);
    const currentPrice = closes[closes.length - 1];
    const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND });

    const hasPos = !!session.state.openPositions[symbol];
    const canOpen = symbols.includes(symbol);

    if (signal === 'BUY' && !hasPos && canOpen && !isBlacklisted(symbol)) {
      // Vol-targeting por-canal (paridad con el engine: frac=positionSizePct·w, 0 si w<=minWeight).
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

import binance from './binanceService.js';
import { longShortTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { evaluateStrategySMA200, computeVolTargetWeight } from './indicators.js';
import { isBlacklisted, SMA_HYSTERESIS_BAND, SMA_PERIOD, DAILY_BASKET, VOLTARGET, RISK } from './config.js';

/**
 * CANAL LONG/SHORT — SMA150 "always-in-the-market" (reconvierte el hueco del parado V4C-15m).
 *
 * Misma señal de régimen que el canal SMA150-1d (cierre diario vs SMA150 ± banda), pero en vez de
 * ir a CASH en régimen bajista, abre un CORTO. Flip en el cruce:
 *   - close > SMA150 → LARGO  (cierra el corto si lo había)
 *   - close < SMA150 → CORTO  (cierra el largo si lo había)
 * Idempotente intra-día: solo opera cuando la señal cambia de lado.
 *
 * ⚠️ Honestidad: el lado CORTO no está validado a largo plazo (cripto tiene sesgo alcista). En el
 *    walk-forward de la muestra disponible el long/short batió al long-only (sobre todo en el bear
 *    reciente), pero es ~1 ciclo y perfil trend-following (WR baja, rachas de pérdidas pequeñas).
 *    Se corre en SHADOW para observar; el usuario ejecuta a mano (ya opera corto y largo).
 */
const DAILY_INTERVAL = '1d';

export async function runLongShortBot() {
  try {
    await _runCycle();
  } catch (error) {
    console.error('❌ [SMA150-LS] Error en runLongShortBot:', error.message);
    try {
      await telegramService.sendMessage(`⚠️ <b>FALLO BOT SMA150-LS</b>\n<code>${telegramService.escape(error.message)}</code>`);
    } catch (_) { /* noop */ }
  }
}

async function _runCycle() {
  console.log(`\n↕️ [SMA${SMA_PERIOD}-LS] Iniciando canal long/short (always-in)...`);
  const session = await longShortTrader.beginSession();
  console.log(`📊 [SMA${SMA_PERIOD}-LS] Saldo Virtual: ${session.state.balanceUSDC.toFixed(2)} USDC`);

  const symbols = DAILY_BASKET.filter(s => !isBlacklisted(s));
  const openSymbols = Object.keys(session.state.openPositions);
  const monitored = [...new Set([...symbols, ...openSymbols])];
  console.log(`🔍 [SMA${SMA_PERIOD}-LS] Evaluando régimen diario: ${monitored.join(', ')}`);

  // Fracción del cash a comprometer (vol-target por-canal, igual que SMA150-1d).
  const sizeFracFor = (closes) => {
    const w = computeVolTargetWeight(closes, { ...VOLTARGET, periodsPerYear: 365 });
    let frac = RISK.positionSizePct * w;
    if (w <= (VOLTARGET.minWeight ?? 0)) frac = 0;
    return frac;
  };

  for (const symbol of monitored) {
    const raw = await binance.getKlines(symbol, DAILY_INTERVAL, SMA_PERIOD + 11);
    const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
    if (klines.length < SMA_PERIOD + 1) continue;

    const closes = klines.map(k => k.close);
    const price = closes[closes.length - 1];
    const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND });

    const pos = session.state.openPositions[symbol];
    const canOpen = symbols.includes(symbol); // solo abrir nuevos lados dentro de la cesta
    const frac = sizeFracFor(closes);

    if (signal === 'BUY') {
      // Régimen alcista → LARGO. Cierra el corto si lo había, luego abre largo.
      if (pos && pos.side === 'short') {
        console.log(`🟢 [SMA${SMA_PERIOD}-LS] FLIP a LARGO: cubrir corto ${symbol} a ${price}`);
        longShortTrader.applySell(session, symbol, price, 'SIGNAL');
      }
      if (canOpen && !session.state.openPositions[symbol] && frac > 0) {
        console.log(`🟢 [SMA${SMA_PERIOD}-LS] LARGO ${symbol} a ${price} (size ${(frac * 100).toFixed(0)}%)`);
        longShortTrader.applyBuy(session, symbol, price, { regimeMode: true, smaPeriod: SMA_PERIOD, sizeFraction: frac });
      }
    } else if (signal === 'SELL') {
      // Régimen bajista → CORTO. Cierra el largo si lo había, luego abre corto.
      if (pos && pos.side === 'long') {
        console.log(`🔴 [SMA${SMA_PERIOD}-LS] FLIP a CORTO: cerrar largo ${symbol} a ${price}`);
        longShortTrader.applySell(session, symbol, price, 'SIGNAL');
      }
      if (canOpen && !session.state.openPositions[symbol] && frac > 0) {
        console.log(`🟠 [SMA${SMA_PERIOD}-LS] CORTO ${symbol} a ${price} (size ${(frac * 100).toFixed(0)}%)`);
        longShortTrader.applyShort(session, symbol, price, { regimeMode: true, smaPeriod: SMA_PERIOD, sizeFraction: frac });
      }
    }
  }

  await longShortTrader.commitSession(session);
  console.log(`✅ [SMA${SMA_PERIOD}-LS] Ciclo terminado.`);
}

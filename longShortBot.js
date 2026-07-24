import binance from './binanceService.js';
import { longShortTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import { evaluateStrategySMA200, computeVolTargetWeight, shortEntryAllowed, calculateATR, btcRegimeOn } from './indicators.js';
import { isBlacklisted, SMA_HYSTERESIS_BAND, SMA_PERIOD, DAILY_BASKET, VOLTARGET, RISK, LONGSHORT, REGIME } from './config.js';

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

  const cooldowns = session.state.cooldowns || (session.state.cooldowns = {});

  // Descarga en paralelo + caché compartida con el canal SMA150-1d (misma cesta/ventana en la
  // misma invocación del cron → 0 llamadas extra). Ventana SMA_PERIOD+61 = paridad vol-target
  // con el backtest (ver dailyBot.js).
  const rawBySymbol = {};
  const toFetch = [...new Set([...monitored, ...(REGIME.btcEnabled ? [REGIME.btcSymbol] : [])])];
  await Promise.all(toFetch.map(async (s) => {
    rawBySymbol[s] = await binance.getKlines(s, DAILY_INTERVAL, SMA_PERIOD + 61, {}, { cacheMs: 120000 });
  }));

  // Gate maestro BTC para entradas LARGAS (✅ adoptado 2026-07-10, paridad con el engine).
  // Solo bloquea ABRIR largos: los flips de cierre y todo el lado corto no se tocan.
  let btcRiskOn = true;
  if (REGIME.btcEnabled) {
    const btcRaw = rawBySymbol[REGIME.btcSymbol] || [];
    const btcCloses = (btcRaw.length > 0 ? btcRaw.slice(0, -1) : btcRaw).map(k => k.close);
    btcRiskOn = btcRegimeOn(btcCloses, REGIME.btcSmaPeriod);
    if (!btcRiskOn) console.log(`⛔ [SMA${SMA_PERIOD}-LS] Gate BTC: BTC < SMA${REGIME.btcSmaPeriod} → no se abren largos nuevos este ciclo.`);
  }

  for (const symbol of monitored) {
    const raw = rawBySymbol[symbol] || [];
    const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
    if (klines.length < SMA_PERIOD + 1) continue;

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const price = closes[closes.length - 1];
    const candleTime = klines[klines.length - 1].openTime;
    const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND });

    const pos = session.state.openPositions[symbol];

    // ── Gestión de SALIDA del corto (paridad con el motor) ──
    if (pos && pos.side === 'short') {
      const entry = pos.entryPrice ?? pos.buyPrice;
      const low = Math.min(pos.lowestLow ?? entry, price); // actualizar extremo favorable
      if (low !== pos.lowestLow) longShortTrader.applyUpdatePosition(session, symbol, { lowestLow: low });
      let shortExit = null;
      // 1) STOP DURO (catástrofe): cubrir si sube ≥shortStopPct sobre la entrada.
      if (LONGSHORT.shortStopPct > 0 && price >= entry * (1 + LONGSHORT.shortStopPct)) shortExit = 'STOP_LOSS';
      // 2) Chandelier del corto (research #9, ADOPTADO k=3.0): cubrir si close > minLow + k·ATR14.
      else if (LONGSHORT.shortTrailAtr > 0) {
        const atrArr = calculateATR(highs, lows, closes, 14);
        const atr = atrArr.length ? atrArr[atrArr.length - 1] : null;
        if (atr && price > low + LONGSHORT.shortTrailAtr * atr) shortExit = 'TRAILING_STOP';
      }
      if (shortExit) {
        console.log(`${shortExit === 'STOP_LOSS' ? '🛑' : '📉'} [SMA${SMA_PERIOD}-LS] ${shortExit === 'STOP_LOSS' ? 'STOP' : 'TRAIL'} CORTO ${symbol} a ${price}`);
        longShortTrader.applySell(session, symbol, price, shortExit);
        if (shortExit === 'STOP_LOSS') cooldowns[symbol] = new Date(candleTime + LONGSHORT.shortStopCooldownDays * 86400000).toISOString();
        continue;
      }
    }
    const onCooldown = cooldowns[symbol] && new Date(cooldowns[symbol]).getTime() > candleTime;
    const inBasket = symbols.includes(symbol);
    const frac = sizeFracFor(closes);

    // El cap de exposición se evalúa AL ABRIR, después del cierre del flip (auditoría 2026-07-03
    // #5: antes se evaluaba antes de liberar el margen del lado que se cierra → paridad con el
    // motor, que chequea canOpenPosition tras executeShortClose).
    if (signal === 'BUY') {
      if (pos && pos.side === 'short') {
        console.log(`🟢 [SMA${SMA_PERIOD}-LS] FLIP a LARGO: cubrir corto ${symbol} a ${price}`);
        longShortTrader.applySell(session, symbol, price, 'SIGNAL');
      }
      // Diagnóstico (auditoría 2026-07-24): antes, si una entrada elegible no se abría, no
      // quedaba rastro de POR QUÉ (silencio indistinguible de "todo va bien"). Cada gate ahora
      // deja una línea explícita en logs para poder auditar sin reconstruir el estado a mano.
      if (inBasket && !session.state.openPositions[symbol]) {
        if (!btcRiskOn) {
          // Ya logueado una vez por ciclo a nivel de gate global (evita repetirlo por símbolo).
        } else if (frac <= 0) {
          console.log(`⚪ [SMA${SMA_PERIOD}-LS] ${symbol} señal LARGO pero vol-target → peso 0 (no se abre)`);
        } else if (!canOpenLive(session.state)) {
          console.log(`🚫 [SMA${SMA_PERIOD}-LS] ${symbol} señal LARGO bloqueada por cap de exposición/posiciones (maxExposurePct/maxConcurrentPositions)`);
        } else {
          console.log(`🟢 [SMA${SMA_PERIOD}-LS] LARGO ${symbol} a ${price} (size ${(frac * 100).toFixed(0)}%)`);
          longShortTrader.applyBuy(session, symbol, price, { regimeMode: true, smaPeriod: SMA_PERIOD, sizeFraction: frac });
        }
      }
    } else if (signal === 'SELL') {
      if (pos && pos.side === 'long') {
        console.log(`🔴 [SMA${SMA_PERIOD}-LS] FLIP a CORTO: cerrar largo ${symbol} a ${price}`);
        longShortTrader.applySell(session, symbol, price, 'SIGNAL');
      }
      // κ (LONGSHORT.shortRiskFraction): presupuesto de riesgo asimétrico del corto (paridad motor).
      const shortFrac = frac * (LONGSHORT.shortRiskFraction ?? 1);
      // Filtro de entrada del corto (research #8, ADOPTADO confirm3d): paridad con el motor.
      const entryOk = shortEntryAllowed(closes, { ...LONGSHORT.shortEntry, smaPeriod: SMA_PERIOD });
      if (inBasket && !session.state.openPositions[symbol]) {
        if (onCooldown) {
          console.log(`⏳ [SMA${SMA_PERIOD}-LS] ${symbol} en cooldown post-stop (no re-shortear)`);
        } else if (!entryOk) {
          console.log(`🔒 [SMA${SMA_PERIOD}-LS] ${symbol} señal CORTO pero filtro de entrada (confirmDays) aún no confirma → no se abre`);
        } else if (shortFrac <= 0) {
          console.log(`⚪ [SMA${SMA_PERIOD}-LS] ${symbol} señal CORTO pero vol-target → peso 0 (no se abre)`);
        } else if (!canOpenLive(session.state)) {
          console.log(`🚫 [SMA${SMA_PERIOD}-LS] ${symbol} señal CORTO bloqueada por cap de exposición/posiciones (maxExposurePct/maxConcurrentPositions)`);
        } else {
          console.log(`🟠 [SMA${SMA_PERIOD}-LS] CORTO ${symbol} a ${price} (size ${(shortFrac * 100).toFixed(0)}%)`);
          longShortTrader.applyShort(session, symbol, price, { regimeMode: true, smaPeriod: SMA_PERIOD, sizeFraction: shortFrac });
        }
      }
    }
  }

  await longShortTrader.commitSession(session);
  console.log(`✅ [SMA${SMA_PERIOD}-LS] Ciclo terminado.`);
}

// Cap de exposición en LIVE (auditoría #4): porta la guarda que el motor ya aplica, para que el
// backtest y el live respeten los mismos límites. Valora a coste (sin llamadas extra a la API).
function canOpenLive(state) {
  const open = state.openPositions;
  const count = Object.keys(open).length;
  if (LONGSHORT.maxConcurrentPositions != null && count >= LONGSHORT.maxConcurrentPositions) return false;
  if (LONGSHORT.maxExposurePct != null) {
    let invested = 0;
    for (const s in open) invested += open[s].investedUSDC || 0;
    const equity = state.balanceUSDC + invested;
    if (equity > 0 && invested / equity >= LONGSHORT.maxExposurePct) return false;
  }
  return true;
}

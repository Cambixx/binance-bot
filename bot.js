import binance from './binanceService.js';
import shadowTrader from './shadowTrader.js';
import telegramService from './telegramService.js';
import {
  evaluateStrategyV4C as evaluateStrategy,
  computeVolTargetWeight, periodsPerYearFor, btcRegimeOn,
} from './indicators.js';
import { evaluateFixedExit } from './exits.js';
import {
  INTERVAL, TOP_COINS_LIMIT, STRATEGY_OPTS, RISK, LOOKBACK_15M,
  VOLTARGET, REGIME, isBlacklisted,
} from './config.js';

// Parámetros de riesgo (fuente única: config.js → paridad total con el backtest)
const RISK_TP = RISK.takeProfitPct;
const RISK_SL = RISK.stopLossPct;
const TRAIL_ACTIVATION = RISK.trailingActivation;
const TRAIL_DISTANCE = RISK.trailingDistance;
// Cooldown tras STOP_LOSS, expresado en ms (12 velas × 15m = 3h). Se ancla al tiempo de la
// vela de la señal (no a Date.now()) para contar VELAS y mantener paridad con el backtest.
const COOLDOWN_MS = RISK.cooldownCandles * 15 * 60 * 1000;

export async function runBot() {
  try {
    await _runBotCycle();
  } catch (error) {
    // Fallo a nivel de ciclo: alerta a Telegram (fix #4) — antes era invisible (console.error).
    // No se hace commit, así que el estado no queda a medias; el siguiente ciclo se recupera.
    console.error('❌ Error en runBot:', error.message);
    try {
      await telegramService.sendMessage(`⚠️ <b>FALLO BOT V4C-15m</b>\n<code>${telegramService.escape(error.message)}</code>`);
    } catch (_) { /* noop */ }
  }
}

async function _runBotCycle() {
  console.log('🤖 Iniciando Binance Shadow Bot V4C-COMBO (V3 + Regime Gate)...');

  // UNA sola lectura del estado por ciclo (fix #3/#12). Todas las mutaciones van a memoria.
  const session = await shadowTrader.beginSession();
  console.log(`📊 Saldo Virtual: ${session.state.balanceUSDC.toFixed(2)} USDC`);

  // 1. Símbolos con más volumen, post-blacklist
  let symbols = await binance.getTopVolumeSymbols(TOP_COINS_LIMIT + 5);
  symbols = symbols.filter(symbol => !isBlacklisted(symbol)).slice(0, TOP_COINS_LIMIT);

  const openSymbols = Object.keys(session.state.openPositions);
  const monitoredSymbols = [...new Set([...symbols, ...openSymbols])];
  const cooldowns = session.state.cooldowns || {};

  console.log(`🔍 Escaneando nuevas señales: ${symbols.join(', ')}`);
  console.log(`🛡️ Monitorizando riesgo: ${monitoredSymbols.join(', ')}`);

  // Filtro maestro de régimen BTC (investigación §2.2). Si BTC < SMA, no se abren entradas.
  let btcRiskOn = true;
  if (REGIME.btcEnabled) {
    try {
      const btcRaw = await binance.getKlines(REGIME.btcSymbol, '1d', REGIME.btcSmaPeriod + 5);
      const btcCloses = (btcRaw.length > 1 ? btcRaw.slice(0, -1) : btcRaw).map(k => k.close);
      btcRiskOn = btcRegimeOn(btcCloses, REGIME.btcSmaPeriod);
      console.log(`🧭 Régimen BTC: ${btcRiskOn ? 'RISK-ON ✅' : 'RISK-OFF ⛔ (no se abren entradas)'}`);
    } catch (e) {
      console.warn(`⚠️ No se pudo evaluar el régimen BTC: ${e.message} (se asume risk-on)`);
    }
  }

  for (const symbol of monitoredSymbols) {
    // 2. Velas (OHLCV). Pedimos LOOKBACK_15M+1 y DESCARTAMOS la última (vela en formación):
    //    el backtest solo ve velas cerradas → sin repaint. La ventana es EXACTAMENTE
    //    LOOKBACK_15M para que el último valor de EMA/ADX/MFI/CHOP coincida con el backtest (#10).
    const rawKlines = await binance.getKlines(symbol, INTERVAL, LOOKBACK_15M + 1);
    const klines = rawKlines.length > 0 ? rawKlines.slice(0, -1) : rawKlines;
    if (klines.length < LOOKBACK_15M) {
      // Si es una posición abierta y no pudimos leer velas, no la dejamos sin gestión:
      if (openSymbols.includes(symbol)) console.warn(`⚠️ Klines insuficientes para gestionar ${symbol} (${klines.length})`);
      continue;
    }

    const strategyData = {
      closes: klines.map(k => k.close),
      highs: klines.map(k => k.high),
      lows: klines.map(k => k.low),
      volumes: klines.map(k => k.volume),
    };

    const currentPrice = strategyData.closes[strategyData.closes.length - 1];
    const candleTime = klines[klines.length - 1].openTime; // ancla del cooldown
    const hasPos = !!session.state.openPositions[symbol];
    const canOpenNewPosition = symbols.includes(symbol);
    // Cooldown anclado a vela: bloqueado si el expiry supera el tiempo de la vela actual.
    const onCooldown = cooldowns[symbol] && new Date(cooldowns[symbol]).getTime() > candleTime;

    const signal = evaluateStrategy(strategyData, STRATEGY_OPTS);

    // 3. Entrada
    if (signal === 'BUY' && !hasPos && canOpenNewPosition && !isBlacklisted(symbol)) {
      if (onCooldown) {
        console.log(`⏳ [COOLDOWN] BUY ignorado para ${symbol} (cooldown post-SL hasta ${cooldowns[symbol]})`);
      } else if (!btcRiskOn) {
        console.log(`⛔ [BTC RISK-OFF] BUY ignorado para ${symbol}`);
      } else if (!canOpenPosition(session.state, currentPrice)) {
        console.log(`⛔ [CAP] BUY ignorado para ${symbol} (límite de posiciones/exposición)`);
      } else {
        const sizeFraction = computeSizeFraction(strategyData.closes);
        if (sizeFraction > 0) {
          console.log(`\n🚨 [V4C SIGNAL] COMPRA: ${symbol} a ${currentPrice} (size ${(sizeFraction * 100).toFixed(0)}%)`);
          shadowTrader.applyBuy(session, symbol, currentPrice, {
            trailActivationPct: TRAIL_ACTIVATION, stopLossPct: RISK_SL, sizeFraction,
          });
        }
      }
    } else if (signal === 'SELL' && hasPos) {
      console.log(`\n🚨 [V4C SIGNAL] VENTA (señal): ${symbol} a ${currentPrice}`);
      shadowTrader.applySell(session, symbol, currentPrice, 'SIGNAL');
      continue;
    }

    // 4. Gestión de riesgo (TP / SL / Trailing) vía la FUENTE ÚNICA compartida con el engine (#2)
    const pos = session.state.openPositions[symbol];
    if (!pos) continue;

    const wasArmed = pos.trailingActivated;
    const d = evaluateFixedExit(pos, currentPrice, {
      takeProfitPct: RISK_TP, stopLossPct: RISK_SL,
      trailingActivation: TRAIL_ACTIVATION, trailingDistance: TRAIL_DISTANCE,
    });
    // Persistir el bookkeeping del trailing en memoria (se guarda en el commit único)
    shadowTrader.applyUpdatePosition(session, symbol, {
      peakPrice: d.peakPrice, trailingActivated: d.trailingActivated, trailingSL: d.trailingSL,
    });
    if (!wasArmed && d.trailingActivated) {
      console.log(`🔄 [V4C] Trailing ACTIVADO para ${symbol} (Profit ${d.profitPct.toFixed(2)}%)`);
    }

    if (d.action === 'TAKE_PROFIT') {
      console.log(`\n🎯 [V4C] TAKE PROFIT ${symbol}`);
      shadowTrader.applySell(session, symbol, currentPrice, 'TAKE_PROFIT');
    } else if (d.action === 'TRAILING_STOP') {
      console.log(`\n📉 [V4C] TRAILING STOP ${symbol} (${d.profitPct.toFixed(2)}%)`);
      shadowTrader.applySell(session, symbol, currentPrice, 'TRAILING_STOP');
    } else if (d.action === 'STOP_LOSS') {
      console.log(`\n🛑 [V4C] STOP LOSS ${symbol}`);
      shadowTrader.applySell(session, symbol, currentPrice, 'STOP_LOSS', { cooldownMs: COOLDOWN_MS, candleTime });
    }
  }

  // UNA sola escritura + envío de notificaciones acumuladas (fix #3/#12)
  await shadowTrader.commitSession(session);
  console.log('✅ Ciclo de análisis terminado.');
}

// Fracción del cash a invertir. Vol-targeting opcional (investigación §2.1): escala el tamaño
// base por volatilidad realizada. VOLTARGET.enabled=false → tamaño fijo histórico.
function computeSizeFraction(closes) {
  let frac = RISK.positionSizePct;
  if (VOLTARGET.enabled && closes && closes.length > 20) {
    const w = computeVolTargetWeight(closes, { ...VOLTARGET, periodsPerYear: periodsPerYearFor(INTERVAL) });
    frac = RISK.positionSizePct * w;
    if (w <= (VOLTARGET.minWeight ?? 0)) frac = 0;
  }
  return frac;
}

// Caps de cartera (fix #26): nº máximo de posiciones simultáneas y exposición agregada.
function canOpenPosition(state, currentPrice) {
  const open = state.openPositions;
  const openCount = Object.keys(open).length;
  if (RISK.maxConcurrentPositions != null && openCount >= RISK.maxConcurrentPositions) return false;
  if (RISK.maxExposurePct != null) {
    let invested = 0;
    for (const s in open) invested += open[s].amount * (open[s].buyPrice || 0);
    const equity = state.balanceUSDC + invested;
    if (equity > 0 && invested / equity >= RISK.maxExposurePct) return false;
  }
  return true;
}

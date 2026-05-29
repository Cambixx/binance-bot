import binance from './binanceService.js';
import shadowTrader from './shadowTrader.js';
import { evaluateStrategyV4C as evaluateStrategy } from './indicators.js';
import { INTERVAL, TOP_COINS_LIMIT, STRATEGY_OPTS, RISK, isBlacklisted } from './config.js';

// Parámetros de riesgo (fuente única: config.js → paridad total con el backtest)
const RISK_TP = RISK.takeProfitPct;
const RISK_SL = RISK.stopLossPct;
const TRAIL_ACTIVATION = RISK.trailingActivation;
const TRAIL_DISTANCE = RISK.trailingDistance;
// Cooldown tras STOP_LOSS, expresado en ms (12 velas × 15m = 3h) — robusto a irregularidad del cron
const COOLDOWN_MS = RISK.cooldownCandles * 15 * 60 * 1000;

export async function runBot() {
  console.log('🤖 Iniciando Binance Shadow Bot V4C-COMBO (V3 + Regime Gate)...');
  
  try {
    const fullState = await shadowTrader.getFullState();
    console.log(`📊 Saldo Virtual: ${fullState.balanceUSDC.toFixed(2)} USDC`);
    
    // 1. Obtener símbolos con más volumen
    let symbols = await binance.getTopVolumeSymbols(TOP_COINS_LIMIT + 5);
    symbols = symbols.filter(symbol => !isBlacklisted(symbol)).slice(0, TOP_COINS_LIMIT);

    // Posiciones abiertas actuales
    const openSymbols = await shadowTrader.getOpenPositions();
    const monitoredSymbols = [...new Set([...symbols, ...openSymbols])];

    // Cooldowns persistentes tras STOP_LOSS (paridad con el backtest)
    const cooldowns = fullState.cooldowns || {};
    const now = Date.now();

    console.log(`🔍 Escaneando nuevas señales: ${symbols.join(', ')}`);
    console.log(`🛡️ Monitorizando riesgo: ${monitoredSymbols.join(', ')}`);

    for (const symbol of monitoredSymbols) {
      // 2. Obtener velas (OHLCV). Pedimos 131 y DESCARTAMOS la última (vela en formación):
      //    el backtest solo ve velas cerradas, así evitamos repaint y mantenemos paridad.
      const rawKlines = await binance.getKlines(symbol, INTERVAL, 131);
      const klines = rawKlines.length > 0 ? rawKlines.slice(0, -1) : rawKlines;

      if (klines.length < 125) continue;

      // Preparar datos para Strategy V4-C (ADX + CHOP + BBW necesitan OHLCV)
      const strategyData = {
        closes: klines.map(k => k.close),
        highs: klines.map(k => k.high),
        lows: klines.map(k => k.low),
        volumes: klines.map(k => k.volume)
      };

      const currentPrice = strategyData.closes[strategyData.closes.length - 1];
      const hasPos = openSymbols.includes(symbol);
      const canOpenNewPosition = symbols.includes(symbol);
      // Gate de cooldown: bloquea recompra durante 3h tras un SL (igual que el backtest)
      const onCooldown = cooldowns[symbol] && new Date(cooldowns[symbol]).getTime() > now;

      // 3. Evaluar Señal de Entrada/Salida (V4-C COMBO)
      const signal = evaluateStrategy(strategyData, STRATEGY_OPTS);

      if (signal === 'BUY' && !hasPos && canOpenNewPosition && !isBlacklisted(symbol) && !onCooldown) {
        console.log(`\n🚨 [V4C SIGNAL] COMPRA DETECTADA: ${symbol} a ${currentPrice}`);
        await shadowTrader.buy(symbol, currentPrice, { trailActivationPct: TRAIL_ACTIVATION, stopLossPct: RISK_SL });
      } else if (signal === 'BUY' && !hasPos && canOpenNewPosition && onCooldown) {
        console.log(`⏳ [COOLDOWN] Señal BUY ignorada para ${symbol} (cooldown post-SL activo hasta ${cooldowns[symbol]})`);
      } else if (signal === 'BUY' && !hasPos && isBlacklisted(symbol)) {
        console.warn(`⛔ [BLACKLIST GATE] Señal BUY bloqueada para ${symbol} (en blacklist)`);
      }
      else if (signal === 'SELL' && hasPos) {
        console.log(`\n🚨 [V4C SIGNAL] VENTA (RSI SOBRECOMPRA): ${symbol} a ${currentPrice}`);
        await shadowTrader.sell(symbol, currentPrice, 'SIGNAL');
        continue; // Pasamos a la siguiente moneda
      }

      // 4. Lógica de Riesgo (TP / SL / Trailing Stop)
      if (hasPos) {
        const state = await shadowTrader.getFullState();
        const pos = state.openPositions[symbol];
        
        if (!pos) continue;

        const profitPct = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

        // Actualizar precio máximo (Peak)
        if (currentPrice > (pos.peakPrice || pos.buyPrice)) {
          await shadowTrader.updatePosition(symbol, { peakPrice: currentPrice });
          pos.peakPrice = currentPrice;
        }

        // Activar trailing y calcular su nivel (idéntico a applyFixedExits del backtest)
        let trailingSLPrice = null;
        if (profitPct >= TRAIL_ACTIVATION) {
          if (!pos.trailingActivated) {
            console.log(`\n🔄 [V4C] Trailing Stop ACTIVADO para ${symbol} (Profit: ${profitPct.toFixed(2)}%)`);
            await shadowTrader.updatePosition(symbol, { trailingActivated: true });
            pos.trailingActivated = true;
          }
          const peakProfit = ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100;
          const trailLevel = peakProfit * TRAIL_DISTANCE;
          trailingSLPrice = pos.buyPrice * (1 + trailLevel / 100);
        }

        // Orden de salidas EXACTO al backtest: TP → Trailing → SL (mutuamente excluyentes)
        if (profitPct >= RISK_TP) {
          console.log(`\n🎯 [V4C] TAKE PROFIT ALCANZADO PARA ${symbol}`);
          await shadowTrader.sell(symbol, currentPrice, 'TAKE_PROFIT');
        } else if (pos.trailingActivated && trailingSLPrice !== null && currentPrice <= trailingSLPrice) {
          console.log(`\n📉 [V4C] TRAILING STOP ALCANZADO PARA ${symbol} (${profitPct.toFixed(2)}%)`);
          await shadowTrader.sell(symbol, currentPrice, 'TRAILING_STOP');
        } else if (profitPct <= -RISK_SL) {
          console.log(`\n🛑 [V4C] STOP LOSS ALCANZADO PARA ${symbol}`);
          await shadowTrader.sell(symbol, currentPrice, 'STOP_LOSS');
        }
      }
    }
    
    console.log('✅ Ciclo de análisis terminado.');

  } catch (error) {
    console.error('❌ Error en runBot:', error.message);
  }
}

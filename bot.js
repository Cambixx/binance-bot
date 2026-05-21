import binance from './binanceService.js';
import shadowTrader from './shadowTrader.js';
import { evaluateStrategyV4C as evaluateStrategy } from './indicators.js';

// Configuración principal (paridad con backtest V4C-COMBO)
const INTERVAL = '15m';
const TOP_COINS_LIMIT = 10;
// BCH añadido tras backtest: -95 USDC consistente en 3 y 6 meses (WR 33-40%)
const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ', 'DOGE', 'BCH'
];

// Defense-in-depth: gate explícito invocable en cualquier punto
function isBlacklisted(symbol) {
  return BLACKLIST.some(badCoin => symbol.includes(badCoin));
}

// Opciones de filtro de régimen para V4-C (chop<50 y BBW pct>20)
const STRATEGY_OPTS = { chopMax: 50, bbwPctMin: 20 };

// Configuración de Riesgo V4C-COMBO
const RISK_TP = 5.0;            // Take Profit
const RISK_SL = 3.0;            // Stop Loss ampliado a 3.0% para absorber slippage real (~0.5pp medido)
const TRAIL_ACTIVATION = 1.5;   // Activa trailing al +1.5%
const TRAIL_DISTANCE = 0.45;    // Protege 45% del pico (V4C-COMBO: mejor WR y holdout PF que 0.30)

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

    console.log(`🔍 Escaneando nuevas señales: ${symbols.join(', ')}`);
    console.log(`🛡️ Monitorizando riesgo: ${monitoredSymbols.join(', ')}`);

    for (const symbol of monitoredSymbols) {
      // 2. Obtener velas completas (OHLCV) — V4-C necesita ≥120 (BBW rolling 100)
      const klines = await binance.getKlines(symbol, INTERVAL, 130);

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

      // 3. Evaluar Señal de Entrada/Salida (V4-C COMBO)
      const signal = evaluateStrategy(strategyData, STRATEGY_OPTS);

      if (signal === 'BUY' && !hasPos && canOpenNewPosition && !isBlacklisted(symbol)) {
        console.log(`\n🚨 [V4C SIGNAL] COMPRA DETECTADA: ${symbol} a ${currentPrice}`);
        await shadowTrader.buy(symbol, currentPrice, { trailActivationPct: TRAIL_ACTIVATION });
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

        // Lógica de Trailing Stop Dinámico
        if (profitPct >= TRAIL_ACTIVATION && !pos.trailingActivated) {
          console.log(`\n🔄 [V4C] Trailing Stop ACTIVADO para ${symbol} (Profit: ${profitPct.toFixed(2)}%)`);
          await shadowTrader.updatePosition(symbol, { trailingActivated: true });
          pos.trailingActivated = true;
        }

        // Calcular el nivel actual del Trailing Stop (paridad con el backtest)
        if (pos.trailingActivated) {
          const peakProfit = ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100;
          const trailLevel = peakProfit * TRAIL_DISTANCE;
          const trailingSLPrice = pos.buyPrice * (1 + trailLevel / 100);

          if (currentPrice <= trailingSLPrice) {
            console.log(`\n📉 [V4C] TRAILING STOP ALCANZADO PARA ${symbol} (${profitPct.toFixed(2)}%)`);
            await shadowTrader.sell(symbol, currentPrice, 'TRAILING_STOP');
            continue;
          }
        }

        // Stop Loss y Take Profit fijos
        if (profitPct >= RISK_TP) {
          console.log(`\n🎯 [V4C] TAKE PROFIT ALCANZADO PARA ${symbol}`);
          await shadowTrader.sell(symbol, currentPrice, 'TAKE_PROFIT');
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

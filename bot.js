import binance from './binanceService.js';
import shadowTrader from './shadowTrader.js';
import { evaluateStrategyV3 as evaluateStrategy } from './indicators.js';

// Configuración principal (Mismos parámetros que el Backtest V3)
const INTERVAL = '15m'; 
const TOP_COINS_LIMIT = 10;
const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ'
];

// Configuración de Riesgo V3
const RISK_TP = 5.0;            // Take Profit
const RISK_SL = 2.5;            // Stop Loss (Aumentado a 2.5% para dar aire al trade)
const TRAIL_ACTIVATION = 1.5;   // Activa trailing al +1.5% (V3 optimizado)
const TRAIL_DISTANCE = 0.45;    // Protege el 45% del pico, deja 55% de respiración

export async function runBot() {
  console.log('🤖 Iniciando Binance Shadow Bot V3 (ADX + Trailing)...');
  
  try {
    const fullState = await shadowTrader.getFullState();
    console.log(`📊 Saldo Virtual: ${fullState.balanceUSDC.toFixed(2)} USDC`);
    
    // 1. Obtener símbolos con más volumen
    let symbols = await binance.getTopVolumeSymbols(TOP_COINS_LIMIT + 5);
    symbols = symbols.filter(symbol => {
      return !BLACKLIST.some(badCoin => symbol.includes(badCoin));
    }).slice(0, TOP_COINS_LIMIT);

    // Posiciones abiertas actuales
    const openSymbols = await shadowTrader.getOpenPositions();
    const monitoredSymbols = [...new Set([...symbols, ...openSymbols])];

    console.log(`🔍 Escaneando nuevas señales: ${symbols.join(', ')}`);
    console.log(`🛡️ Monitorizando riesgo: ${monitoredSymbols.join(', ')}`);

    for (const symbol of monitoredSymbols) {
      // 2. Obtener velas completas (OHLCV)
      const klines = await binance.getKlines(symbol, INTERVAL, 120);
      
      if (klines.length < 110) continue;

      // Preparar datos para Strategy V3 (ADX necesita todo)
      const strategyData = {
        closes: klines.map(k => k.close),
        highs: klines.map(k => k.high),
        lows: klines.map(k => k.low),
        volumes: klines.map(k => k.volume)
      };

      const currentPrice = strategyData.closes[strategyData.closes.length - 1];
      const hasPos = openSymbols.includes(symbol);
      const canOpenNewPosition = symbols.includes(symbol);

      // 3. Evaluar Señal de Entrada/Salida
      const signal = evaluateStrategy(strategyData);

      if (signal === 'BUY' && !hasPos && canOpenNewPosition) {
        console.log(`\n🚨 [V3 SIGNAL] COMPRA DETECTADA: ${symbol} a ${currentPrice}`);
        await shadowTrader.buy(symbol, currentPrice, { trailActivationPct: TRAIL_ACTIVATION });
      } 
      else if (signal === 'SELL' && hasPos) {
        console.log(`\n🚨 [V3 SIGNAL] VENTA (RSI SOBRECOMPRA): ${symbol} a ${currentPrice}`);
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
          console.log(`\n🔄 [V3] Trailing Stop ACTIVADO para ${symbol} (Profit: ${profitPct.toFixed(2)}%)`);
          await shadowTrader.updatePosition(symbol, { trailingActivated: true });
          pos.trailingActivated = true;
        }

        // Calcular el nivel actual del Trailing Stop (paridad con el backtest)
        if (pos.trailingActivated) {
          const peakProfit = ((pos.peakPrice - pos.buyPrice) / pos.buyPrice) * 100;
          const trailLevel = peakProfit * TRAIL_DISTANCE;
          const trailingSLPrice = pos.buyPrice * (1 + trailLevel / 100);

          if (currentPrice <= trailingSLPrice) {
            console.log(`\n📉 [V3] TRAILING STOP ALCANZADO PARA ${symbol} (${profitPct.toFixed(2)}%)`);
            await shadowTrader.sell(symbol, currentPrice, 'TRAILING_STOP');
            continue;
          }
        }

        // Stop Loss y Take Profit fijos
        if (profitPct >= RISK_TP) {
          console.log(`\n🎯 [V3] TAKE PROFIT ALCANZADO PARA ${symbol}`);
          await shadowTrader.sell(symbol, currentPrice, 'TAKE_PROFIT');
        } else if (profitPct <= -RISK_SL) {
          console.log(`\n🛑 [V3] STOP LOSS ALCANZADO PARA ${symbol}`);
          await shadowTrader.sell(symbol, currentPrice, 'STOP_LOSS');
        }
      }
    }
    
    console.log('✅ Ciclo de análisis terminado.');

  } catch (error) {
    console.error('❌ Error en runBot:', error.message);
  }
}

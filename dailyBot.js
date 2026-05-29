import binance from './binanceService.js';
import { dailyTrader } from './shadowTrader.js';
import { evaluateStrategySMA200 } from './indicators.js';
import { TOP_COINS_LIMIT, isBlacklisted } from './config.js';

/**
 * BOT DIARIO — Market-timing de régimen SMA200 (estilo Faber). CANAL PARALELO al 15m.
 *
 * Estrategia validada (backtest 36m, costes 0.30%, OOS): bate a buy&hold en
 * retorno-ajustado-a-riesgo y recorta el drawdown ~41% (ver BOT_DOCUMENTATION §1.2).
 *
 * Lógica in-or-out por moneda: invertido si cierre DIARIO > SMA200, cash si no.
 * - Frecuencia bajísima (~pocos cambios/año) → costes irrelevantes.
 * - Sin TP/SL fijo: la SMA200 ES el stop. La salida la dicta la señal.
 * - Idempotente: aunque el cron lo invoque cada 15m, solo opera cuando la señal
 *   diaria (sobre velas CERRADAS) cambia. Entre cierres diarios no hace nada.
 */
const SMA_PERIOD = 200;
const DAILY_INTERVAL = '1d';

export async function runDailyBot() {
  console.log('\n📅 [SMA200-1d] Iniciando canal diario (regime-timer)...');

  try {
    const fullState = await dailyTrader.getFullState();
    console.log(`📊 [SMA200-1d] Saldo Virtual: ${fullState.balanceUSDC.toFixed(2)} USDC`);

    // Universo: mismo top por volumen que el bot 15m, tras blacklist
    let symbols = await binance.getTopVolumeSymbols(TOP_COINS_LIMIT + 5);
    symbols = symbols.filter(s => !isBlacklisted(s)).slice(0, TOP_COINS_LIMIT);

    const openSymbols = await dailyTrader.getOpenPositions();
    const monitored = [...new Set([...symbols, ...openSymbols])];
    console.log(`🔍 [SMA200-1d] Evaluando régimen diario: ${monitored.join(', ')}`);

    for (const symbol of monitored) {
      // Velas DIARIAS. Pedimos SMA_PERIOD+11 y descartamos la última (vela en formación):
      // la señal solo cambia al cierre diario → sin repaint, idempotente intra-día.
      const raw = await binance.getKlines(symbol, DAILY_INTERVAL, SMA_PERIOD + 11);
      const klines = raw.length > 0 ? raw.slice(0, -1) : raw;
      if (klines.length < SMA_PERIOD + 1) continue;

      const closes = klines.map(k => k.close);
      const currentPrice = closes[closes.length - 1];
      const signal = evaluateStrategySMA200({ closes }, { smaPeriod: SMA_PERIOD });

      const hasPos = openSymbols.includes(symbol);
      const canOpen = symbols.includes(symbol);

      // In-or-out: comprar si régimen alcista y no tenemos; vender a cash si pierde la SMA200.
      if (signal === 'BUY' && !hasPos && canOpen && !isBlacklisted(symbol)) {
        console.log(`🟢 [SMA200-1d] RÉGIMEN ALCISTA: ${symbol} (close > SMA200) a ${currentPrice}`);
        await dailyTrader.buy(symbol, currentPrice, { regimeMode: true, smaPeriod: SMA_PERIOD });
      } else if (signal === 'SELL' && hasPos) {
        console.log(`🔴 [SMA200-1d] RÉGIMEN BAJISTA: ${symbol} (close < SMA200) → cash a ${currentPrice}`);
        await dailyTrader.sell(symbol, currentPrice, 'SIGNAL');
      }
    }

    console.log('✅ [SMA200-1d] Ciclo diario terminado.');
  } catch (error) {
    console.error('❌ [SMA200-1d] Error en runDailyBot:', error.message);
  }
}

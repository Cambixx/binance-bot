import { runBot } from '../../bot.js';
import { runDailyBot } from '../../dailyBot.js';

/**
 * Netlify Scheduled Function (Netlify Functions v2)
 * Se ejecuta automáticamente cada 15 minutos.
 *
 * Corre DOS canales shadow independientes en paralelo:
 *  - V4C-15m: generador de señales 15m (cartera bot_state_v2)
 *  - SMA200-1d: regime-timer diario (cartera bot_state_daily_v1), idempotente intra-día
 */
export default async (req) => {
  console.log("⏰ Invocando trader-cron (Ejecución programada)");

  await runBot();          // Canal 15m (V4C-COMBO)
  await runDailyBot();     // Canal diario (SMA200 regime-timer)
};

export const config = {
  schedule: "*/15 * * * *" // Expresión Cron: cada 15 minutos
};

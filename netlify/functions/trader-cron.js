import { runBot } from '../../bot.js';
import { runDailyBot } from '../../dailyBot.js';
import { runRotationBot } from '../../rotationBot.js';

/**
 * Netlify Scheduled Function (Netlify Functions v2). Se ejecuta cada 15 minutos.
 *
 * Corre canales shadow INDEPENDIENTES en paralelo (cada uno con su cartera virtual):
 *  - V4C-15m: generador de señales 15m (cartera bot_state_v2)
 *  - SMA200-1d: regime-timer diario (cartera bot_state_daily_v1), idempotente intra-día
 *  - ROT-dual-mom: rotación cross-sectional + dual-momentum (cartera bot_state_rotation_v1),
 *    EXPERIMENTAL — actívalo con env ROTATION_ENABLED=true.
 *
 * Cada runX tiene su propio try/catch con alerta a Telegram (fix #4), así un fallo en un canal
 * no tumba a los demás.
 */
export default async (req) => {
  console.log('⏰ Invocando trader-cron (Ejecución programada)');

  await runBot();        // Canal 15m (V4C-COMBO)
  await runDailyBot();   // Canal diario (SMA200 regime-timer)

  if (process.env.ROTATION_ENABLED === 'true') {
    await runRotationBot(); // Canal de rotación (experimental)
  }
};

export const config = {
  schedule: '*/15 * * * *' // cada 15 minutos
};

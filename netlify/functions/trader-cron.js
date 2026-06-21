import { runDailyBot } from '../../dailyBot.js';
import { runLongShortBot } from '../../longShortBot.js';
import { runRotationBot } from '../../rotationBot.js';

/**
 * Netlify Scheduled Function (Netlify Functions v2). Se ejecuta cada 15 minutos.
 *
 * Canales shadow (cada uno con su cartera virtual):
 *  - SMA150-1d: regime-timer diario LONG-ONLY (cartera bot_state_daily_v1). Validado.
 *  - SMA150-LS: long/short always-in (cartera bot_state_ls_v1). Misma señal SMA150 pero shortea
 *    en bajista. Kill-switch: LONGSHORT_ENABLED=false. Reemplaza al parado V4C-15m.
 *  - ROT-dual-mom: rotación experimental (cartera bot_state_rotation_v1), opt-in ROTATION_ENABLED=true.
 *
 * ⏹️ V4C-15m PARADO (2026-06-21): sin edge neto de costes. `bot.js` se conserva como referencia
 *    pero ya NO se ejecuta. Su blob `bot_state_v2` queda congelado.
 *
 * Cada runX tiene su propio try/catch con alerta a Telegram, así un fallo en un canal no tumba a otro.
 */
export default async (req) => {
  console.log('⏰ Invocando trader-cron (Ejecución programada)');

  await runDailyBot();   // SMA150-1d (long-only, validado)

  if (process.env.LONGSHORT_ENABLED !== 'false') {
    await runLongShortBot(); // SMA150-LS (long/short) — default ON
  }
  if (process.env.ROTATION_ENABLED === 'true') {
    await runRotationBot();   // Rotación (experimental) — opt-in
  }
};

export const config = {
  schedule: '*/15 * * * *' // cada 15 minutos
};

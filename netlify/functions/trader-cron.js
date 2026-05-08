import { runBot } from '../../bot.js';

/**
 * Netlify Scheduled Function (V2 Format)
 * Se ejecuta automáticamente cada 15 minutos.
 */
export default async (req) => {
  console.log("⏰ Invocando trader-cron (Ejecución programada)");
  
  await runBot();
};

export const config = {
  schedule: "*/15 * * * *" // Expresión Cron: cada 15 minutos
};

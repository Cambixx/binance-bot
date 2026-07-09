/**
 * setup-telegram.js — Registra el menú de comandos del bot en Telegram (setMyCommands).
 * Tras correrlo, al escribir "/" en el chat aparece el menú con /status y /help.
 *
 * Uso: pon TELEGRAM_BOT_TOKEN en tu .env y ejecuta:  npm run setup-telegram
 * (También se auto-registra solo cuando envías /start al bot.)
 */
import dotenv from 'dotenv';
dotenv.config();

// Import dinámico: asegura que telegramService lea el token DESPUÉS de cargar .env.
const { default: telegramService, BOT_COMMANDS } = await import('./telegramService.js');

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Falta TELEGRAM_BOT_TOKEN en el .env. Añádelo y reintenta.');
  process.exit(1);
}

const ok = await telegramService.setCommands(BOT_COMMANDS);
if (ok) {
  console.log('✅ Menú de comandos registrado en Telegram:');
  BOT_COMMANDS.forEach(c => console.log(`   /${c.command} — ${c.description}`));
  console.log('\nAbre el chat del bot y escribe "/" para verlo.');
} else {
  console.error('❌ No se pudo registrar (revisa el token).');
  process.exit(1);
}

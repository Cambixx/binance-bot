import shadowTrader from '../../shadowTrader.js';
import telegramService from '../../telegramService.js';

export default async (req) => {
  // Solo aceptamos peticiones POST de Telegram
  if (req.method !== 'POST') {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const update = await req.json();
    
    // Ignorar si no es un mensaje de texto
    if (!update.message || !update.message.text) {
      return new Response("OK", { status: 200 });
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text ? update.message.text.trim().toLowerCase() : '';

    console.log(`[Webhook] Mensaje recibido de ${chatId}: "${text}"`);

    // Seguridad: Solo responder si el mensaje viene de nuestro chat privado
    if (chatId !== process.env.TELEGRAM_CHAT_ID) {
      console.log(`[Webhook] BLOQUEADO: El Chat ID ${chatId} no coincide con el configurado (${process.env.TELEGRAM_CHAT_ID})`);
      return new Response("OK", { status: 200 });
    }

    // Comando /status o /status-bot
    if (text === '/status' || text === '/status-bot') {
      const stats = await shadowTrader.getStats();
      
      const icon = parseFloat(stats.totalProfitUSDC) >= 0 ? '🟢' : '🔴';
      
      const reply = `🤖 <b>ESTADO DEL BOT (Shadow Mode)</b>\n\n` +
        `<b>Capital Inicial:</b> ${stats.initialBalance} USDC\n` +
        `<b>Total Equity:</b> ${stats.currentTotalEquity} USDC\n` +
        `<b>Balance Disponible:</b> ${stats.availableBalance} USDC\n` +
        `<b>Inmovilizado (Posiciones):</b> ${stats.investedEquity} USDC\n\n` +
        `<b>Posiciones Abiertas:</b> ${stats.openPositionsCount}\n` +
        `<b>Trades Completados:</b> ${stats.totalTrades}\n` +
        `<b>Win Rate:</b> ${stats.winRate} (${stats.winningTrades}/${stats.totalTrades})\n\n` +
        `<b>Beneficio Neto:</b> ${icon} ${stats.totalProfitUSDC} USDC`;

      await telegramService.sendMessage(reply);
    }
    
    // Comando /help
    else if (text === '/help' || text === '/start') {
      const reply = `¡Hola! Soy tu Binance Shadow Bot.\nComandos disponibles:\n👉 /status - Ver métricas de rendimiento\n👉 /help - Ayuda`;
      await telegramService.sendMessage(reply);
    }

    return new Response("OK", { status: 200 });
    
  } catch (error) {
    console.error("[Webhook] Error procesando mensaje:", error);
    return new Response("Error", { status: 500 });
  }
};

export const config = {
  path: "/telegram-webhook"
};

import shadowTrader, { dailyTrader } from '../../shadowTrader.js';
import telegramService from '../../telegramService.js';
import binance from '../../binanceService.js';

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

    // Comando /status o /status-bot — muestra AMBOS canales (15m y diario)
    if (text === '/status' || text === '/status-bot') {
      const channelBlock = async (trader, title) => {
        const openSymbols = await trader.getOpenPositions();
        const prices = openSymbols.length > 0 ? await binance.getPrices(openSymbols) : {};
        const s = await trader.getStats(prices);
        const icon = parseFloat(s.totalProfitUSDC) >= 0 ? '🟢' : '🔴';
        const mktNote = s.pricedAtMarket ? '' : ' <i>(a coste)</i>';
        return `<b>━━ ${title} ━━</b>\n` +
          `Equity: ${s.currentTotalEquity} USDC${mktNote} (inicial ${s.initialBalance})\n` +
          `Disponible: ${s.availableBalance} | Invertido: ${s.investedEquity}\n` +
          `Posiciones: ${s.openPositionsCount} | Trades: ${s.totalTrades} | WR: ${s.winRate}\n` +
          `P&L: realizado ${s.realizedPnLUSDC} + latente ${s.unrealizedPnLUSDC} = ${icon} <b>${s.totalProfitUSDC} USDC</b>`;
      };

      const block15m = await channelBlock(shadowTrader, '📡 V4C-15m (señales)');
      const blockDaily = await channelBlock(dailyTrader, '📅 SMA200-1d (regime-timer)');
      const reply = `🤖 <b>ESTADO DEL BOT (Shadow Mode)</b>\n\n${block15m}\n\n${blockDaily}`;

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

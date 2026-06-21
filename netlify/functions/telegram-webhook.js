import { dailyTrader, rotationTrader, longShortTrader } from '../../shadowTrader.js';
import telegramService from '../../telegramService.js';
import binance from '../../binanceService.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Autenticación criptográfica del webhook (fix #15): Telegram envía el secret token
  // (configurado en setWebhook) en esta cabecera. Sin él, la URL es pública y el chat.id
  // del body es falsificable. Si TELEGRAM_WEBHOOK_SECRET no está definido, no se exige
  // (compat) — recomendado definirlo y registrar el webhook con secret_token.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers.get('x-telegram-bot-api-secret-token');
    if (got !== expectedSecret) {
      console.warn('[Webhook] BLOQUEADO: secret token inválido');
      return new Response('Forbidden', { status: 403 });
    }
  }

  try {
    const update = await req.json();

    if (!update.message || !update.message.text) {
      return new Response('OK', { status: 200 });
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text ? update.message.text.trim().toLowerCase() : '';

    console.log(`[Webhook] Mensaje recibido de ${chatId}: "${text}"`);

    // Defensa en profundidad: además del secret, sólo respondemos a nuestro chat privado.
    if (chatId !== process.env.TELEGRAM_CHAT_ID) {
      console.log(`[Webhook] BLOQUEADO: Chat ID ${chatId} no coincide con el configurado`);
      return new Response('OK', { status: 200 });
    }

    if (text === '/status' || text === '/status-bot') {
      const channelBlock = async (trader, title) => {
        const openSymbols = await trader.getOpenPositions();
        const prices = openSymbols.length > 0 ? await binance.getPrices(openSymbols) : {};
        const s = await trader.getStats(prices);
        const icon = parseFloat(s.totalProfitUSDC) >= 0 ? '🟢' : '🔴';
        const mktNote = s.pricedAtMarket ? '' : ' <i>(a coste)</i>';
        return `<b>━━ ${telegramService.escape(title)} ━━</b>\n` +
          `Equity: ${s.currentTotalEquity} USDC${mktNote} (inicial ${s.initialBalance})\n` +
          `Disponible: ${s.availableBalance} | Invertido: ${s.investedEquity}\n` +
          `Posiciones: ${s.openPositionsCount} | Trades: ${s.totalTrades} | WR: ${s.winRate}\n` +
          `P&L: realizado ${s.realizedPnLUSDC} + latente ${s.unrealizedPnLUSDC} = ${icon} <b>${s.totalProfitUSDC} USDC</b>`;
      };

      const blocks = [
        await channelBlock(dailyTrader, '📅 SMA150-1d (long-only)'),
      ];
      // Canal long/short (default ON; kill-switch LONGSHORT_ENABLED=false)
      if (process.env.LONGSHORT_ENABLED !== 'false') {
        blocks.push(await channelBlock(longShortTrader, '↕️ SMA150-LS (long/short)'));
      }
      // Solo mostrar la rotación si el canal está activo
      if (process.env.ROTATION_ENABLED === 'true') {
        blocks.push(await channelBlock(rotationTrader, '🔄 ROT-dual-mom (experimental)'));
      }
      const reply = `🤖 <b>ESTADO DEL BOT (Shadow Mode)</b>\n\n${blocks.join('\n\n')}`;
      await telegramService.sendMessage(reply);
    }
    else if (text === '/help' || text === '/start') {
      const reply = `¡Hola! Soy tu Binance Shadow Bot.\nComandos disponibles:\n👉 /status - Ver métricas de rendimiento\n👉 /help - Ayuda`;
      await telegramService.sendMessage(reply);
    }

    return new Response('OK', { status: 200 });

  } catch (error) {
    console.error('[Webhook] Error procesando mensaje:', error);
    return new Response('Error', { status: 500 });
  }
};

export const config = {
  path: '/telegram-webhook'
};

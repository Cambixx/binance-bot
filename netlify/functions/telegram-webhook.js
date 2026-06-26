import { dailyTrader, rotationTrader, longShortTrader } from '../../shadowTrader.js';
import telegramService, { BOT_COMMANDS } from '../../telegramService.js';
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

    // Canales ACTIVOS (según flags). Cada uno con su etiqueta.
    const channels = [{ trader: dailyTrader, title: '📅 SMA150-1d (long-only)' }];
    if (process.env.LONGSHORT_ENABLED !== 'false') channels.push({ trader: longShortTrader, title: '↕️ SMA150-LS (long/short)' });
    if (process.env.ROTATION_ENABLED === 'true') channels.push({ trader: rotationTrader, title: '🔄 ROT-dual-mom (experimental)' });
    const esc = (t) => telegramService.escape(t);
    const tag = (sym) => esc(sym.replace('USDC', ''));

    if (text === '/status' || text === '/status-bot') {
      const channelBlock = async ({ trader, title }) => {
        const openSymbols = await trader.getOpenPositions();
        const prices = openSymbols.length > 0 ? await binance.getPrices(openSymbols) : {};
        const s = await trader.getStats(prices);
        const icon = parseFloat(s.totalProfitUSDC) >= 0 ? '🟢' : '🔴';
        const mktNote = s.pricedAtMarket ? '' : ' <i>(a coste)</i>';
        return `<b>━━ ${esc(title)} ━━</b>\n` +
          `Equity: ${s.currentTotalEquity} USDC${mktNote} (inicial ${s.initialBalance})\n` +
          `Disponible: ${s.availableBalance} | Invertido: ${s.investedEquity}\n` +
          `Posiciones: ${s.openPositionsCount} | Trades: ${s.totalTrades} | WR: ${s.winRate}\n` +
          `P&L: realizado ${s.realizedPnLUSDC} + latente ${s.unrealizedPnLUSDC} = ${icon} <b>${s.totalProfitUSDC} USDC</b>`;
      };
      const blocks = [];
      for (const ch of channels) blocks.push(await channelBlock(ch));
      await telegramService.sendMessage(`🤖 <b>ESTADO DEL BOT (Shadow Mode)</b>\n\n${blocks.join('\n\n')}`);
    }

    else if (text === '/posiciones' || text === '/positions') {
      const blocks = [];
      for (const { trader, title } of channels) {
        const state = await trader.getFullState();
        const syms = Object.keys(state.openPositions);
        if (syms.length === 0) { blocks.push(`<b>${esc(title)}</b>\n<i>sin posiciones abiertas</i>`); continue; }
        const prices = await binance.getPrices(syms);
        const lines = syms.map(sym => {
          const p = state.openPositions[sym];
          const side = p.side || 'long';
          const entry = p.entryPrice ?? p.buyPrice;
          const mkt = prices[sym] || entry;
          const pnl = side === 'short' ? p.amount * (entry - mkt) : p.amount * mkt - p.investedUSDC;
          const pnlPct = p.investedUSDC ? (pnl / p.investedUSDC) * 100 : 0;
          const ic = pnl >= 0 ? '🟢' : '🔴';
          const sideTxt = side === 'short' ? '🔻SHORT' : '🔺LONG';
          return `${ic} <b>#${tag(sym)}</b> ${sideTxt}  ${entry} → ${mkt}\n` +
            `   ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) · inv ${Number(p.investedUSDC).toFixed(0)}`;
        });
        blocks.push(`<b>${esc(title)}</b>\n${lines.join('\n')}`);
      }
      await telegramService.sendMessage(`📌 <b>POSICIONES ABIERTAS</b> <i>(P&L latente a mercado)</i>\n\n${blocks.join('\n\n')}`);
    }

    else if (text === '/trades') {
      const all = [];
      for (const { trader, title } of channels) {
        const state = await trader.getFullState();
        for (const t of (state.tradeHistory || [])) all.push({ ...t, _ch: title });
      }
      all.sort((a, b) => new Date(b.sellTime).getTime() - new Date(a.sellTime).getTime());
      const last = all.slice(0, 10);
      if (last.length === 0) {
        await telegramService.sendMessage('🧾 <b>OPERACIONES CERRADAS</b>\n\n<i>Aún no hay trades cerrados.</i>');
      } else {
        const reasonTxt = { TAKE_PROFIT: 'TP', STOP_LOSS: 'SL', TRAILING_STOP: 'Trail', SIGNAL: 'Señal', END_OF_BACKTEST: 'Fin', MANUAL_CLEANUP: 'Limpieza' };
        const lines = last.map(t => {
          const p = Number(t.profitUSDC) || 0;
          const ic = p >= 0 ? '🟢' : '🔴';
          const side = (t.side || 'long') === 'short' ? '🔻' : '🔺';
          const d = new Date(t.sellTime).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
          return `${ic} ${d} ${side}<b>#${tag(t.symbol)}</b> ${p >= 0 ? '+' : ''}${p.toFixed(2)} USDC · ${esc(reasonTxt[t.reason] || t.reason)}`;
        });
        await telegramService.sendMessage(`🧾 <b>ÚLTIMAS ${last.length} OPERACIONES CERRADAS</b>\n\n${lines.join('\n')}`);
      }
    }

    else if (text === '/help' || text === '/start' || text === '/ayuda') {
      // Auto-configura el menú "/" de Telegram (idempotente): al escribir "/" saldrán los comandos.
      await telegramService.setCommands(BOT_COMMANDS);
      const lines = BOT_COMMANDS.map(c => `👉 /${c.command} — ${c.description}`).join('\n');
      await telegramService.sendMessage(`¡Hola! Soy tu Binance Shadow Bot.\n\nComandos disponibles:\n${lines}\n\n<i>Escribe «/» para ver el menú.</i>`);
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

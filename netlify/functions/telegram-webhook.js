import telegramService, { BOT_COMMANDS } from '../../telegramService.js';
import binance from '../../binanceService.js';
import { activeChannels, channelStatusBlock } from '../../botStatus.js';

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
  } else {
    console.warn('[Webhook] ⚠️ TELEGRAM_WEBHOOK_SECRET no configurado: el endpoint queda protegido solo por chat_id (falsificable). Define el secret y registra el webhook con secret_token.');
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

    // Canales ACTIVOS (según flags). Fuente única en botStatus.js (auditoría 2026-07-24).
    const channels = activeChannels();
    const esc = (t) => telegramService.escape(t);
    const tag = (sym) => esc(sym.replace('USDC', ''));

    if (text === '/status' || text === '/status-bot') {
      const blocks = [];
      for (const ch of channels) blocks.push(await channelStatusBlock(ch));
      await telegramService.sendMessage(`🤖 <b>ESTADO DEL BOT (Shadow Mode)</b>\n\n${blocks.join('\n\n')}`);
    }

    else if (text === '/portfolio' || text === '/rendimiento' || text === '/cartera') {
      let totalInit = 0;
      let totalAvail = 0;
      let totalInvested = 0;
      let totalRealized = 0;
      let totalUnrealized = 0;
      let totalEquity = 0;
      let totalOpen = 0;
      let totalTrades = 0;
      const chSummaries = [];

      for (const { trader, title } of channels) {
        const openSyms = await trader.getOpenPositions();
        const prices = openSyms.length > 0 ? await binance.getPrices(openSyms) : {};
        const s = await trader.getStats(prices);
        const init = parseFloat(s.initialBalance) || 5000;
        const eq = parseFloat(s.currentTotalEquity) || 0;
        const real = parseFloat(s.realizedPnLUSDC) || 0;
        const unreal = parseFloat(s.unrealizedPnLUSDC) || 0;
        const avail = parseFloat(s.availableBalance) || 0;
        const inv = parseFloat(s.investedEquity) || 0;
        const chProfit = parseFloat(s.totalProfitUSDC) || 0;
        const chRoi = init > 0 ? ((chProfit / init) * 100).toFixed(2) : '0.00';

        totalInit += init;
        totalAvail += avail;
        totalInvested += inv;
        totalRealized += real;
        totalUnrealized += unreal;
        totalEquity += eq;
        totalOpen += s.openPositionsCount || 0;
        totalTrades += s.totalTrades || 0;

        const icon = chProfit >= 0 ? '🟢' : '🔴';
        chSummaries.push(`• <b>${esc(title)}</b>\n  Equity: ${eq.toFixed(2)} USDC | ${icon} <b>${chProfit >= 0 ? '+' : ''}${chProfit.toFixed(2)} USDC</b> (${chRoi >= 0 ? '+' : ''}${chRoi}%)`);
      }

      const netProfit = totalEquity - totalInit;
      const netRoi = totalInit > 0 ? ((netProfit / totalInit) * 100).toFixed(2) : '0.00';
      const mainIcon = netProfit >= 0 ? '🟢' : '🔴';

      const msg = `🌐 <b>RESUMEN CONSOLIDADO DE CARTERA</b>\n\n` +
        `💼 <b>Equity Total:</b> ${totalEquity.toFixed(2)} USDC (Inicial: ${totalInit.toFixed(2)} USDC)\n` +
        `📈 <b>Beneficio Neto:</b> ${mainIcon} <b>${netProfit >= 0 ? '+' : ''}${netProfit.toFixed(2)} USDC (${netRoi >= 0 ? '+' : ''}${netRoi}%)</b>\n\n` +
        `💵 <b>Efectivo Disponible:</b> ${totalAvail.toFixed(2)} USDC\n` +
        `📊 <b>Capital Invertido:</b> ${totalInvested.toFixed(2)} USDC\n` +
        `📍 <b>P&L Latente:</b> ${totalUnrealized >= 0 ? '+' : ''}${totalUnrealized.toFixed(2)} USDC\n` +
        `🧾 <b>P&L Realizado:</b> ${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(2)} USDC\n` +
        `🔓 <b>Posiciones Abiertas:</b> ${totalOpen} | <b>Trades:</b> ${totalTrades}\n\n` +
        `<b>━━ Desglose por Canal ━━</b>\n` +
        chSummaries.join('\n\n');

      await telegramService.sendMessage(msg);
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
        const reasonTxt = { TAKE_PROFIT: 'TP', STOP_LOSS: 'SL', TRAILING_STOP: 'Trail', SIGNAL: 'Señal', END_OF_BACKTEST: 'Fin', MANUAL_CLEANUP: 'Limpieza', MANUAL_CLOSE: 'Manual' };
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

    // ── /cerrar — cierre DISCRECIONAL de posiciones (2026-09-05) ─────────────────────────
    // Primera orden del webhook que MUTA estado, así que:
    //  · exige confirmación explícita ("si") — un dedo torpe no puede liquidar la cartera;
    //  · usa el patrón de sesión, cuyo commit es CONDICIONAL (onlyIfMatch): si el cron escribe a
    //    la vez, el commit falla en vez de pisarlo, y aquí se traduce a un aviso para reintentar;
    //  · marca los cierres como MANUAL_CLOSE → excluidos de winRate/PF (ver shadowTrader).
    else if (text === '/cerrar' || text.startsWith('/cerrar ') || text === '/close' || text.startsWith('/close ')) {
      const parts = text.split(/\s+/).filter(Boolean);
      const target = (parts[1] || '').toUpperCase();      // símbolo, "TODO"/"ALL", o vacío
      const confirmed = ['SI', 'SÍ', 'YES', 'CONFIRMAR'].includes((parts[2] || '').toUpperCase());

      // Inventario: qué hay abierto y en qué canal.
      const found = [];
      for (const ch of channels) {
        const state = await ch.trader.getFullState();
        for (const sym of Object.keys(state.openPositions)) found.push({ ch, sym, pos: state.openPositions[sym] });
      }

      if (found.length === 0) {
        await telegramService.sendMessage('📌 <b>CERRAR</b>\n\n<i>No hay posiciones abiertas.</i>');
      } else if (!target) {
        // Sin argumento: NO se cierra nada. Solo se muestra el inventario y cómo usarlo.
        const lines = found.map(f => `• <b>#${tag(f.sym)}</b> · ${esc(f.ch.title)}`);
        await telegramService.sendMessage(
          `📌 <b>CERRAR POSICIONES</b>\n\n${lines.join('\n')}\n\n` +
          `<b>Uso:</b>\n· <code>/cerrar SOL</code> — vista previa de esa moneda\n` +
          `· <code>/cerrar SOL si</code> — cerrar de verdad\n· <code>/cerrar todo si</code> — cerrar todas\n\n` +
          `<i>Los cierres manuales se registran como señales truncadas: cuentan el trabajo del bot, pero no el win rate de la estrategia.</i>`
        );
      } else {
        const isAll = target === 'TODO' || target === 'ALL' || target === 'TODAS';
        // Match por base del par: el usuario escribe "SOL", el estado guarda "SOLUSDC".
        const sel = isAll ? found : found.filter(f => f.sym === target || f.sym.replace(/USDC$|USDT$/, '') === target);

        if (sel.length === 0) {
          await telegramService.sendMessage(`❓ <b>${esc(target)}</b> no está abierta en ningún canal.\n\nUsa <code>/cerrar</code> para ver la lista.`);
        } else {
          const prices = await binance.getPrices([...new Set(sel.map(f => f.sym))]);
          const fmt = (f) => {
            const entry = f.pos.entryPrice ?? f.pos.buyPrice;
            const mkt = prices[f.sym] || entry;
            const pnl = (f.pos.side === 'short') ? f.pos.amount * (entry - mkt) : f.pos.amount * mkt - f.pos.investedUSDC;
            const pct = f.pos.investedUSDC ? (pnl / f.pos.investedUSDC) * 100 : 0;
            return { pnl, txt: `${pnl >= 0 ? '🟢' : '🔴'} <b>#${tag(f.sym)}</b> · ${esc(f.ch.title)}\n   ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` };
          };

          if (!confirmed) {
            // VISTA PREVIA. No toca nada.
            const rows = sel.map(fmt);
            const tot = rows.reduce((a, r) => a + r.pnl, 0);
            await telegramService.sendMessage(
              `⚠️ <b>CONFIRMA EL CIERRE</b>\n\nVas a cerrar <b>${sel.length}</b> posición(es):\n\n` +
              `${rows.map(r => r.txt).join('\n')}\n\n` +
              `<b>P&L total:</b> ${tot >= 0 ? '+' : ''}${tot.toFixed(2)} USDC\n\n` +
              `Se registrarán como <b>señales truncadas</b>: la entrada la generó el bot y queda\n` +
              `acreditada, pero como la salida la eliges tú NO entran en el win rate de la estrategia.\n\n` +
              `👉 Confirma con <code>/cerrar ${esc(target.toLowerCase())} si</code>`
            );
          } else {
            // EJECUCIÓN: una sesión por canal (una lectura + una escritura condicional).
            const done = [], failed = [];
            for (const ch of channels) {
              const mine = sel.filter(f => f.ch === ch);
              if (mine.length === 0) continue;
              try {
                const session = await ch.trader.beginSession();
                let n = 0;
                for (const f of mine) {
                  const px = prices[f.sym];
                  if (!(px > 0)) { failed.push(`${tag(f.sym)} (${esc(ch.title)}): sin precio`); continue; }
                  if (ch.trader.applySell(session, f.sym, px, 'MANUAL_CLOSE')) { done.push(f.sym); n++; }
                }
                if (n > 0) await ch.trader.commitSession(session);
              } catch (e) {
                // commitSession lanza si otra invocación (el cron) escribió entremedias.
                failed.push(`${esc(ch.title)}: ${esc(e.message)}`);
              }
            }
            const parts2 = [];
            if (done.length) parts2.push(`✅ Cerradas <b>${done.length}</b> posición(es).\n<i>Registradas como señales truncadas — mira /status.</i>`);
            if (failed.length) parts2.push(`⚠️ No se pudo cerrar:\n${failed.map(x => `• ${x}`).join('\n')}\n<i>Si fue un conflicto de escritura, el cron estaba guardando: reintenta en unos segundos.</i>`);
            await telegramService.sendMessage(`🔚 <b>CIERRE MANUAL</b>\n\n${parts2.join('\n\n')}`);
          }
        }
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

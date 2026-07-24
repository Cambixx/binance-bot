import { dailyTrader, longShortTrader, rotationTrader } from './shadowTrader.js';
import telegramService from './telegramService.js';
import binance from './binanceService.js';

/**
 * Fuente ÚNICA de qué canales están activos (según flags de entorno) y cómo se resume cada uno.
 * Antes esta lista vivía duplicada en telegram-webhook.js; extraída (auditoría 2026-07-24) para
 * que el heartbeat proactivo y los comandos /status no puedan divergir sobre qué canal está vivo.
 */
export function activeChannels() {
  const channels = [{ trader: dailyTrader, title: '📅 SMA150-1d (long-only)' }];
  if (process.env.LONGSHORT_ENABLED !== 'false') channels.push({ trader: longShortTrader, title: '↕️ SMA150-LS (long/short)' });
  if (process.env.ROTATION_ENABLED === 'true') channels.push({ trader: rotationTrader, title: '🔄 ROT-dual-mom (experimental)' });
  return channels;
}

/** Bloque de texto (HTML Telegram) con el resumen de un canal. */
export async function channelStatusBlock({ trader, title }) {
  const esc = (t) => telegramService.escape(t);
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
}

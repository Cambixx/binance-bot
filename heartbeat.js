import { getStore } from '@netlify/blobs';
import telegramService from './telegramService.js';
import binance from './binanceService.js';
import { REGIME } from './config.js';
import { btcRegimeOn } from './indicators.js';
import { activeChannels, channelStatusBlock } from './botStatus.js';

/**
 * Heartbeat proactivo (auditoría 2026-07-24): el bot solo manda Telegram cuando ABRE/CIERRA
 * una posición (shadowTrader.commitSession). En un régimen bajista sostenido eso puede significar
 * semanas de silencio TOTAL en canales long-only/rotación, indistinguible desde Telegram de un
 * cron caído. Este módulo manda un resumen best-effort cada HEARTBEAT_HOURS aunque no haya trades,
 * con el estado del gate BTC para que el silencio se lea como "sin cambio de régimen", no como fallo.
 */
const STORE_NAME = 'shadow_trading_state';
const STORE_KEY = 'heartbeat_meta';
const HEARTBEAT_HOURS = 24;

export async function maybeSendHeartbeat() {
  try {
    const store = getStore(STORE_NAME);
    const meta = (await store.get(STORE_KEY, { type: 'json' })) || {};
    const lastSentAt = meta.lastSentAt ? new Date(meta.lastSentAt).getTime() : 0;
    if (Date.now() - lastSentAt < HEARTBEAT_HOURS * 3600000) return; // aún no toca

    const blocks = [];
    for (const ch of activeChannels()) blocks.push(await channelStatusBlock(ch));

    let regimeLine = '';
    try {
      const raw = await binance.getKlines(REGIME.btcSymbol, '1d', REGIME.btcSmaPeriod + 5, {}, { cacheMs: 300000 });
      const closes = (raw.length > 0 ? raw.slice(0, -1) : raw).map(k => k.close);
      const riskOn = btcRegimeOn(closes, REGIME.btcSmaPeriod);
      regimeLine = `\n\n📡 <b>Régimen BTC:</b> ${riskOn ? `🟢 risk-on (BTC &gt; SMA${REGIME.btcSmaPeriod})` : `🔴 risk-off (BTC &lt; SMA${REGIME.btcSmaPeriod}) → sin largos nuevos`}`;
    } catch (_) { /* best-effort: el heartbeat no debe fallar por esto */ }

    await telegramService.sendMessage(
      `💓 <b>HEARTBEAT</b> — el bot sigue vivo, evaluando cada 15 min.\n\n${blocks.join('\n\n')}${regimeLine}\n\n` +
      `<i>Silencio ≠ caído: sin trades nuevos porque el régimen no ha cambiado. Detalle con /status, /posiciones o /trades.</i>`
    );

    await store.setJSON(STORE_KEY, { lastSentAt: new Date().toISOString() });
  } catch (error) {
    // Best-effort: un fallo aquí (Blobs, Telegram, Binance) no debe tumbar el ciclo de trading.
    console.error('❌ [Heartbeat] Error:', error.message);
  }
}

import binance from '../../binanceService.js';
import { dailyTrader, longShortTrader, rotationTrader } from '../../shadowTrader.js';
import { aggregateByPosition, bookMetrics } from '../../backtestEngine.js';
import { btcRegimeOn } from '../../indicators.js';
import {
  SIGNAL_MODE, SMA_PERIOD, DAILY_BASKET, REGIME, COSTS,
  ENTRY_FRESHNESS_HOURS, isBlacklisted,
} from '../../config.js';

/**
 * dashboard-data — API de SOLO LECTURA con el estado VIVO de los canales.
 *
 * Es lo que diferencia el panel web del informe estático (`shadow-report.js`): aquí no hay que
 * regenerar nada a mano, la página lee el estado real de los blobs en cada carga.
 *
 * Ninguna operación de escritura: no toca `openPositions`, `tradeHistory` ni el balance. Si algo
 * falla (Binance caído, blob ausente), degrada a valoración a coste y lo DECLARA en la respuesta
 * (`pricedAtMarket: false`) en vez de devolver un número que parece bueno y no lo es.
 */

const CHANNELS = [
  { id: 'daily', title: 'SMA150-1d', subtitle: 'Long-only', trader: dailyTrader, experimental: false },
  { id: 'ls', title: 'SMA150-LS', subtitle: 'Long/Short', trader: longShortTrader, experimental: false },
  { id: 'rotation', title: 'ROT-dual-mom', subtitle: 'Rotación', trader: rotationTrader, experimental: true },
];

const ADMIN_REASONS = new Set(['MANUAL_CLEANUP', 'END_OF_BACKTEST']);
const r2 = (v) => (v == null || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;

/** Valora una posición a mercado. El corto devenga funding hasta hoy (igual que `getStats`). */
function valuePosition(pos, price, now) {
  const entry = pos.entryPrice ?? pos.buyPrice;
  const px = (price && price > 0) ? price : pos.buyPrice;
  if (pos.side === 'short') {
    const days = Math.max(0, (now - new Date(pos.timestamp).getTime()) / 86400000);
    const funding = (Number(pos.investedUSDC) || 0) * (COSTS.fundingDailyShort || 0) * days;
    const pnl = pos.amount * (entry - px) - funding;
    return { marketValue: (Number(pos.investedUSDC) || 0) + pnl, unrealized: pnl, fundingAccrued: funding };
  }
  const value = pos.amount * px;
  return { marketValue: value, unrealized: value - (Number(pos.investedUSDC) || 0), fundingAccrued: 0 };
}

export default async () => {
  const now = Date.now();
  const errors = [];

  // 1) Estado de los tres canales (lecturas independientes: un canal caído no tumba el panel).
  const states = {};
  await Promise.all(CHANNELS.map(async (c) => {
    try { states[c.id] = await c.trader.getFullState(); }
    catch (e) { states[c.id] = null; errors.push(`estado ${c.id}: ${e.message}`); }
  }));

  // 2) Precios de todo lo que haya abierto, más la cesta y BTC (para el gate de régimen).
  const symbols = new Set(DAILY_BASKET.filter((s) => !isBlacklisted(s)));
  symbols.add(REGIME.btcSymbol);
  for (const id in states) for (const s in (states[id]?.openPositions || {})) symbols.add(s);

  let prices = {};
  try { prices = await binance.getPrices([...symbols]); }
  catch (e) { errors.push(`precios: ${e.message}`); }

  // 3) Régimen BTC + frescura de la última vela cerrada (los dos gates que más callan al usuario).
  let regime = { btcRiskOn: null, btcClose: null, btcSma: null, lastCandleClose: null, freshHours: null, fresh: null };
  try {
    const raw = await binance.getKlines(REGIME.btcSymbol, '1d', REGIME.btcSmaPeriod + 5);
    const closed = raw.length > 1 ? raw.slice(0, -1) : raw;
    const closes = closed.map((k) => k.close);
    if (closes.length > REGIME.btcSmaPeriod) {
      const win = closes.slice(-REGIME.btcSmaPeriod);
      regime.btcSma = r2(win.reduce((a, b) => a + b, 0) / win.length);
      regime.btcClose = r2(closes[closes.length - 1]);
      regime.btcRiskOn = btcRegimeOn(closes, REGIME.btcSmaPeriod, REGIME);
    }
    const last = closed[closed.length - 1];
    if (last) {
      regime.lastCandleClose = new Date(last.closeTime).toISOString();
      regime.freshHours = r2((now - last.closeTime) / 3600000);
      regime.fresh = regime.freshHours <= ENTRY_FRESHNESS_HOURS;
    }
  } catch (e) { errors.push(`régimen BTC: ${e.message}`); }

  // 4) Por canal: posiciones vivas + estadística POR SEÑAL (la que importa en modo señal).
  const channels = CHANNELS.map((c) => {
    const st = states[c.id];
    if (!st) return { id: c.id, title: c.title, subtitle: c.subtitle, experimental: c.experimental, unavailable: true };

    let pricedAtMarket = true;
    const open = Object.entries(st.openPositions || {}).map(([symbol, pos]) => {
      const px = prices[symbol];
      if (!(px > 0)) pricedAtMarket = false;
      const v = valuePosition(pos, px, now);
      const invested = Number(pos.investedUSDC) || 0;
      return {
        symbol, side: pos.side || 'long',
        entryPrice: pos.entryPrice ?? pos.buyPrice,
        currentPrice: (px > 0) ? px : null,
        investedUSDC: r2(invested),
        marketValue: r2(v.marketValue),
        unrealized: r2(v.unrealized),
        unrealizedPct: invested > 0 ? r2((v.unrealized / invested) * 100) : null,
        fundingAccrued: r2(v.fundingAccrued),
        openedAt: pos.timestamp,
        daysHeld: r2((now - new Date(pos.timestamp).getTime()) / 86400000),
      };
    }).sort((a, b) => (b.unrealized ?? 0) - (a.unrealized ?? 0));

    // Historial normalizado al formato que entiende `bookMetrics` (contabilidad por POSICIÓN).
    const closed = (st.tradeHistory || []).map((t) => ({
      symbol: t.symbol,
      side: t.side || 'long',
      profit: Number(t.profitUSDC) || 0,
      profitPct: Number(t.profitPercentage ?? t.profitPct) || 0,
      invested: SIGNAL_MODE.notionalPerSignal,
      buyPrice: t.buyPrice, sellPrice: t.sellPrice,
      buyTime: t.buyTime, sellTime: t.sellTime,
      reason: t.reason || 'SIGNAL',
    })).sort((a, b) => new Date(b.sellTime) - new Date(a.sellTime));

    // Solo SEÑALES: los cierres administrativos no dicen nada de la calidad de la señal.
    const signals = aggregateByPosition(closed.filter((t) => !ADMIN_REASONS.has(t.reason)));

    const realized = closed.reduce((s, t) => s + t.profit, 0);
    const unrealized = open.reduce((s, p) => s + (p.unrealized || 0), 0);
    const deployed = open.reduce((s, p) => s + (p.investedUSDC || 0), 0)
      + signals.length * (SIGNAL_MODE.notionalPerSignal || 0);

    return {
      id: c.id, title: c.title, subtitle: c.subtitle, experimental: c.experimental,
      pricedAtMarket,
      balanceUSDC: r2(st.balanceUSDC),
      open, closed,
      realized: r2(realized),
      unrealized: r2(unrealized),
      // El denominador honesto en modo señal: nocional × operaciones, no el saldo inicial.
      deployedCapital: r2(deployed),
      returnOnDeployed: deployed > 0 ? r2(((realized + unrealized) / deployed) * 100) : null,
      books: {
        global: bookMetrics(signals),
        long: bookMetrics(signals.filter((t) => t.side !== 'short')),
        short: bookMetrics(signals.filter((t) => t.side === 'short')),
      },
    };
  });

  const live = channels.filter((c) => !c.unavailable);
  const totals = {
    signalsOpen: live.reduce((s, c) => s + c.open.length, 0),
    signalsClosed: live.reduce((s, c) => s + c.closed.length, 0),
    realized: r2(live.reduce((s, c) => s + (c.realized || 0), 0)),
    unrealized: r2(live.reduce((s, c) => s + (c.unrealized || 0), 0)),
    deployedCapital: r2(live.reduce((s, c) => s + (c.deployedCapital || 0), 0)),
  };
  totals.returnOnDeployed = totals.deployedCapital > 0
    ? r2(((totals.realized + totals.unrealized) / totals.deployedCapital) * 100) : null;

  return Response.json({
    generatedAt: new Date(now).toISOString(),
    signalMode: { ...SIGNAL_MODE },
    config: {
      smaPeriod: SMA_PERIOD,
      basket: DAILY_BASKET.filter((s) => !isBlacklisted(s)),
      basketDeclared: DAILY_BASKET.length,
      btcSmaPeriod: REGIME.btcSmaPeriod,
      entryFreshnessHours: ENTRY_FRESHNESS_HOURS,
      roundTripCostPct: r2((COSTS.feePct + COSTS.slippagePct) * 2 * 100),
    },
    regime,
    channels,
    totals,
    errors,
  }, {
    headers: {
      // Cache corta: el cron corre cada 15 min, no tiene sentido machacar Binance en cada F5.
      'cache-control': 'public, max-age=60, stale-while-revalidate=240',
    },
  });
};

export const config = { path: '/api/dashboard-data' };

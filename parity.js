/**
 * parity.js — Gate de promoción por PARIDAD live ↔ motor (auditoría 2026-09-29 §20.4).
 *
 * POR QUÉ. El gate anterior ("≥6-8 cierres con PF>1") no tiene potencia: con WR ~22 % y payoff ~5:1
 * (lo que mide el propio backtest), 8 trades dan PF>1 el 52 % de las veces con el edge real y el
 * 32 % con edge CERO; para separarlos harían falta ~60 trades (~3 años al ritmo del canal diario).
 * El shadow no puede validar el EDGE en un plazo razonable, pero SÍ la EJECUCIÓN: si el bot en vivo
 * hace lo mismo que el motor sobre el que se validó la estrategia, el walk-forward del motor es
 * evidencia aplicable al live; si no lo hace, no lo es (ver §20.3: el live re-entraba en la misma
 * vela y el motor no).
 *
 * QUÉ COMPARA. Para cada ENTRADA del live (cerradas + abiertas) busca su gemela en el motor
 * (mismo símbolo y lado, misma vela ±`dayTolerance`) y mide la desviación de precio; lo que no
 * casa es o bien una entrada del live que el motor no habría hecho (`liveOnly`), o bien una señal
 * del motor que el live se ha saltado (`engineOnly`, lo más grave). Para los pares cerrados por los
 * dos, compara también la razón de salida.
 *
 * Funciones puras: sin red ni estado. El CLI (`parity-check.js`) las alimenta.
 */

const DAY = 86400000;
const dayOf = (ms) => Math.floor(ms / DAY);

/**
 * Entradas del ledger live: cierres (tradeHistory) + abiertas (openPositions).
 * @returns {Array<{symbol, side, time, price, exitTime, exitReason, open}>}
 */
export function liveEntries(state) {
  const out = [];
  for (const t of state?.tradeHistory || []) {
    const time = new Date(t.buyTime).getTime();
    if (!Number.isFinite(time)) continue;
    out.push({
      symbol: t.symbol, side: t.side || 'long', time, price: Number(t.buyPrice),
      exitTime: new Date(t.sellTime).getTime(), exitReason: t.reason, open: false,
    });
  }
  for (const [symbol, p] of Object.entries(state?.openPositions || {})) {
    const time = new Date(p.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    out.push({ symbol, side: p.side || 'long', time, price: Number(p.entryPrice ?? p.buyPrice), exitTime: null, exitReason: null, open: true });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Entradas del motor a partir de `report.trades`. Las que el motor cierra con END_OF_BACKTEST
 * siguen ABIERTAS al final de los datos.
 */
export function engineEntries(trades) {
  return (trades || []).map((t) => ({
    symbol: t.symbol, side: t.side || 'long',
    time: new Date(t.buyTime).getTime(), price: Number(t.buyPrice),
    exitTime: t.reason === 'END_OF_BACKTEST' ? null : new Date(t.sellTime).getTime(),
    exitReason: t.reason === 'END_OF_BACKTEST' ? null : t.reason,
    open: t.reason === 'END_OF_BACKTEST',
  })).sort((a, b) => a.time - b.time);
}

/**
 * El live ejecuta a las 00:00 UTC del día D+1 la señal de la vela cerrada del día D; el motor
 * fecha esa entrada en la vela D. Se compara el DÍA DE LA VELA: día_live − 1 vs día_motor.
 */
const liveCandleDay = (ms) => dayOf(ms) - 1;

/**
 * @param {Array} live    salida de liveEntries()
 * @param {Array} engine  salida de engineEntries()
 * @param {object} o { since (ms; ignora entradas anteriores), dayTolerance=1, priceTolPct=0.5 }
 */
export function compareEntries(live, engine, o = {}) {
  const dayTol = o.dayTolerance ?? 1;
  const priceTol = o.priceTolPct ?? 0.5;
  const sinceDay = o.since != null ? dayOf(o.since) : -Infinity;
  const L = live.filter((e) => dayOf(e.time) >= sinceDay);
  const E = engine.filter((e) => e.time >= sinceDay * DAY - DAY);
  const used = new Set();
  const matched = [], liveOnly = [];
  for (const l of L) {
    let best = -1, bestGap = Infinity;
    E.forEach((e, i) => {
      if (used.has(i) || e.symbol !== l.symbol || e.side !== l.side) return;
      const gap = Math.abs(dayOf(e.time) - liveCandleDay(l.time));
      if (gap <= dayTol && gap < bestGap) { best = i; bestGap = gap; }
    });
    if (best < 0) { liveOnly.push(l); continue; }
    used.add(best);
    const e = E[best];
    const priceDevPct = e.price > 0 ? ((l.price - e.price) / e.price) * 100 : null;
    matched.push({ live: l, engine: e, dayGap: bestGap, priceDevPct });
  }
  const engineOnly = E.filter((e, i) => !used.has(i) && dayOf(e.time) >= sinceDay - 1
    && (o.until == null || e.time <= o.until));

  // Salidas: solo pares cerrados por AMBOS. MANUAL_CLOSE es del dueño (señal truncada): no cuenta.
  const exitMismatch = [];
  let exitsCompared = 0, manualSkipped = 0;
  for (const m of matched) {
    if (m.live.open || m.engine.open) continue;
    if (m.live.exitReason === 'MANUAL_CLOSE') { manualSkipped++; continue; }
    exitsCompared++;
    const sameReason = m.live.exitReason === m.engine.exitReason;
    const exitGap = Math.abs(dayOf(m.engine.exitTime) - liveCandleDay(m.live.exitTime));
    if (!sameReason || exitGap > dayTol) exitMismatch.push({ ...m, exitGap });
  }

  const devs = matched.map((m) => m.priceDevPct).filter((v) => v != null).map(Math.abs);
  const maxPriceDev = devs.length ? Math.max(...devs) : 0;
  const meanPriceDev = devs.length ? devs.reduce((a, b) => a + b, 0) / devs.length : 0;
  const priceBreaches = matched.filter((m) => m.priceDevPct != null && Math.abs(m.priceDevPct) > priceTol);

  const ok = liveOnly.length === 0 && engineOnly.length === 0 && exitMismatch.length === 0 && priceBreaches.length === 0;
  return {
    ok, liveCount: L.length, matched, liveOnly, engineOnly, exitMismatch, priceBreaches,
    exitsCompared, manualSkipped, maxPriceDev, meanPriceDev,
    matchRate: L.length ? matched.length / L.length : null,
  };
}

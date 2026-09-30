import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEntries, engineEntries, compareEntries } from '../parity.js';

const DAY = 86400000;
const D0 = Date.UTC(2026, 7, 1);                 // 2026-08-01 00:00 UTC
const iso = (ms) => new Date(ms).toISOString();
// El live ejecuta a las 00:00:27 del día D+1 la señal de la vela D; el motor la fecha en la vela D.
const liveTrade = (symbol, side, candleDay, price, reason = 'SIGNAL', exitCandleDay = candleDay + 5) => ({
  symbol, side, buyPrice: price, buyTime: iso(D0 + (candleDay + 1) * DAY + 27000),
  sellPrice: price, sellTime: iso(D0 + (exitCandleDay + 1) * DAY + 27000), reason,
});
const engTrade = (symbol, side, candleDay, price, reason = 'SIGNAL', exitCandleDay = candleDay + 5) => ({
  symbol, side, buyPrice: price, buyTime: iso(D0 + candleDay * DAY),
  sellPrice: price, sellTime: iso(D0 + exitCandleDay * DAY), reason,
});
const since = D0 + 2 * DAY;

test('paridad perfecta: mismas entradas, mismo precio y misma salida → ok', () => {
  const live = liveEntries({ tradeHistory: [liveTrade('ETHUSDC', 'short', 10, 2000), liveTrade('SOLUSDC', 'long', 12, 100, 'TRAILING_STOP')], openPositions: {} });
  const eng = engineEntries([engTrade('ETHUSDC', 'short', 10, 2000), engTrade('SOLUSDC', 'long', 12, 100, 'TRAILING_STOP')]);
  const r = compareEntries(live, eng, { since });
  assert.equal(r.ok, true);
  assert.equal(r.matched.length, 2);
  assert.equal(r.exitsCompared, 2);
});

test('el caso §20.3: el live REABRE en la misma vela tras un trail y el motor no → liveOnly', () => {
  const live = liveEntries({
    tradeHistory: [liveTrade('ETHUSDC', 'short', 10, 2000, 'TRAILING_STOP', 20)],
    openPositions: { ETHUSDC: { side: 'long', entryPrice: 2251.72, timestamp: iso(D0 + 21 * DAY + 907000) } },
  });
  const eng = engineEntries([engTrade('ETHUSDC', 'short', 10, 2000, 'TRAILING_STOP', 20)]);
  const r = compareEntries(live, eng, { since });
  assert.equal(r.ok, false);
  assert.equal(r.liveOnly.length, 1);
  assert.equal(r.liveOnly[0].side, 'long');
});

test('una señal del motor que el live se saltó → engineOnly (lo más grave)', () => {
  const live = liveEntries({ tradeHistory: [liveTrade('ETHUSDC', 'short', 10, 2000)], openPositions: {} });
  const eng = engineEntries([engTrade('ETHUSDC', 'short', 10, 2000), engTrade('BTCUSDC', 'short', 11, 60000)]);
  const r = compareEntries(live, eng, { since });
  assert.equal(r.engineOnly.length, 1);
  assert.equal(r.engineOnly[0].symbol, 'BTCUSDC');
  assert.equal(r.ok, false);
});

test('desviación de precio por encima de la tolerancia se marca; por debajo no', () => {
  const live = liveEntries({ tradeHistory: [liveTrade('ETHUSDC', 'short', 10, 2000)], openPositions: {} });
  const eng = engineEntries([engTrade('ETHUSDC', 'short', 10, 2020)]);   // ≈0,99 % de diferencia
  assert.equal(compareEntries(live, eng, { since, priceTolPct: 0.5 }).priceBreaches.length, 1);
  assert.equal(compareEntries(live, eng, { since, priceTolPct: 2 }).priceBreaches.length, 0);
});

test('salida distinta (razón) se reporta; MANUAL_CLOSE del dueño no cuenta como discrepancia', () => {
  const live = liveEntries({ tradeHistory: [liveTrade('ETHUSDC', 'short', 10, 2000, 'SIGNAL'), liveTrade('SOLUSDC', 'long', 12, 100, 'MANUAL_CLOSE')], openPositions: {} });
  const eng = engineEntries([engTrade('ETHUSDC', 'short', 10, 2000, 'TRAILING_STOP'), engTrade('SOLUSDC', 'long', 12, 100, 'SIGNAL')]);
  const r = compareEntries(live, eng, { since });
  assert.equal(r.exitMismatch.length, 1);
  assert.equal(r.exitMismatch[0].live.symbol, 'ETHUSDC');
  assert.equal(r.manualSkipped, 1);
});

test('las entradas de arranque (antes de `since`) no cuentan; END_OF_BACKTEST del motor = posición aún abierta', () => {
  const live = liveEntries({ tradeHistory: [], openPositions: { BTCUSDC: { side: 'short', entryPrice: 65000, timestamp: iso(D0 + 1 * DAY + 5000) } } });
  const eng = engineEntries([engTrade('BTCUSDC', 'short', 0, 65000, 'END_OF_BACKTEST'), engTrade('ETHUSDC', 'long', 30, 3000, 'END_OF_BACKTEST')]);
  assert.equal(eng.every((e) => e.open), true);
  const r = compareEntries(live, eng, { since, until: D0 + 20 * DAY });
  assert.equal(r.liveCount, 0, 'la entrada de arranque queda fuera');
  assert.equal(r.engineOnly.length, 0, 'lo del motor fuera de la ventana tampoco cuenta');
  assert.equal(r.ok, true);
});

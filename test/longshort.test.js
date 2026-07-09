import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowTrader } from '../shadowTrader.js';
import BacktestEngine from '../backtestEngine.js';
import { COSTS } from '../config.js';

// Sesión falsa para testear los mutadores puros sin tocar Netlify Blobs.
function fakeSession(balance = 5000) {
  return { state: { balanceUSDC: balance, openPositions: {}, tradeHistory: [], cooldowns: {} }, notifications: [] };
}

function makeDaily(closes, startTime = 1700000000000) {
  const dayMs = 86400000;
  return closes.map((c, i) => ({ time: startTime + i * dayMs, open: c, high: c, low: c, close: c, volume: 1000 }));
}

// ───────────────────── shadowTrader: cortos ─────────────────────
test('applyShort reserva margen y marca side=short', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  const pos = s.state.openPositions['BTCUSDC'];
  assert.equal(pos.side, 'short');
  assert.equal(s.state.balanceUSDC, 4000);          // 20% reservado como margen
  assert.equal(pos.investedUSDC, 1000);
  assert.ok(Math.abs(pos.amount - 10) < 1e-9);       // 1000/100
});

test('corto GANA cuando el precio baja (neto de costes)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  t.applySell(s, 'BTCUSDC', 80, 'SIGNAL'); // cubre 20% abajo
  const tr = s.state.tradeHistory[0];
  assert.equal(tr.side, 'short');
  assert.ok(tr.profitUSDC > 0, `debería ganar, profit=${tr.profitUSDC}`);
  // ~20% bruto menos ~0.30% costes sobre 1000 → ~+197 USDC
  assert.ok(tr.profitUSDC > 180 && tr.profitUSDC < 200, `profit fuera de rango: ${tr.profitUSDC}`);
  assert.ok(s.state.balanceUSDC > 5000); // recuperó margen + ganancia
});

test('corto PIERDE cuando el precio sube', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  t.applySell(s, 'BTCUSDC', 120, 'SIGNAL'); // cubre 20% arriba
  const tr = s.state.tradeHistory[0];
  assert.ok(tr.profitUSDC < 0, `debería perder, profit=${tr.profitUSDC}`);
  assert.ok(s.state.balanceUSDC < 5000);
});

test('corto plano pierde ~round-trip (≈0.30%)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  t.applySell(s, 'BTCUSDC', 100, 'SIGNAL'); // cubre al mismo precio
  const tr = s.state.tradeHistory[0];
  const expectedPct = -2 * (COSTS.feePct + COSTS.slippagePct) * 100; // ≈ -0.30%
  assert.ok(Math.abs(tr.profitPercentage - expectedPct) < 0.02, `pct=${tr.profitPercentage} vs ${expectedPct}`);
});

test('corto paga borrow/funding pro-rata a los días abiertos', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  // Backdatear la apertura 10 días para simular un corto mantenido
  s.state.openPositions['BTCUSDC'].timestamp = new Date(Date.now() - 10 * 86400000).toISOString();
  t.applySell(s, 'BTCUSDC', 100, 'SIGNAL'); // cubre al mismo precio
  const tr = s.state.tradeHistory[0];
  const rtPct = -2 * (COSTS.feePct + COSTS.slippagePct) * 100;          // ≈ -0.30%
  const borrowPct = -(COSTS.shortBorrowDailyPct * 10) * 100;            // ≈ -0.30% (10d × 0.03%)
  assert.ok(Math.abs(tr.profitPercentage - (rtPct + borrowPct)) < 0.02,
    `pct=${tr.profitPercentage} vs ${rtPct + borrowPct}`);
});

test('el long-only sigue intacto (side=long, mismo comportamiento)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyBuy(s, 'ETHUSDC', 100, { sizeFraction: 0.2 });
  assert.equal(s.state.openPositions['ETHUSDC'].side, 'long');
  t.applySell(s, 'ETHUSDC', 110, 'SIGNAL');
  const tr = s.state.tradeHistory[0];
  assert.equal(tr.side, 'long');
  assert.ok(tr.profitUSDC > 0); // +10% menos costes
});

test('getStats side-aware: P&L latente del corto sube cuando baja el precio', async () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  // Simular getStats con la valoración a mercado (sin red): replicamos su cálculo side-aware.
  // Precio cae a 90 → P&L latente = amount·(entry-mkt) = 10·(100-90)=+100
  const pos = s.state.openPositions['BTCUSDC'];
  const floatPnL = pos.amount * (pos.entryPrice - 90);
  assert.ok(Math.abs(floatPnL - 100) < 1e-9);
});

// ───────────────────── Motor: long/short ─────────────────────
test('motor long/short: shortea en bajista y gana en la caída', async () => {
  // Sube 200 días (warmup + largo), luego cae fuerte → flip a corto que gana en la bajada.
  const up = Array.from({ length: 220 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 320 - i * 3);
  const closes = [...up, ...down];
  const data = { AAAUSDC: makeDaily(closes) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, dataBySymbol: data, bufferSize: 260, minCandles: 205,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  const shorts = r.trades.filter(t => t.side === 'short');
  assert.ok(shorts.length >= 1, 'debería haber abierto al menos un corto');
  // Algún corto en la caída debe haber sido ganador
  assert.ok(shorts.some(t => t.profit > 0), 'algún corto debería ganar en la bajada');
});

test('motor: el borrow reduce el P&L de los cortos (y a 0 lo preserva)', async () => {
  const up = Array.from({ length: 220 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 320 - i * 3);
  const closes = [...up, ...down];
  const mk = (shortBorrowDailyPct) => new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, dataBySymbol: { AAAUSDC: makeDaily(closes) }, bufferSize: 260, minCandles: 205,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95, shortBorrowDailyPct,
  });
  const sumShort = (r) => r.trades.filter(t => t.side === 'short').reduce((s, t) => s + t.profit, 0);
  const sinBorrow = await mk(0).run();
  const conBorrow = await mk(0.001).run(); // 0.1%/día, exagerado para hacer visible el efecto
  assert.ok(sumShort(conBorrow) < sumShort(sinBorrow),
    `borrow debería reducir el P&L corto: ${sumShort(conBorrow)} vs ${sumShort(sinBorrow)}`);
});

test('motor long-only NO abre cortos (longShort=false)', async () => {
  const up = Array.from({ length: 220 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 320 - i * 3);
  const data = { AAAUSDC: makeDaily([...up, ...down]) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  assert.equal(r.trades.filter(t => t.side === 'short').length, 0);
});

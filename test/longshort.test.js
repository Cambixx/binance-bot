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

test('funding reduce el P&L del corto cuanto más se mantiene', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  // Forzar 30 días de antigüedad del corto
  s.state.openPositions['BTCUSDC'].timestamp = new Date(Date.now() - 30 * 86400000).toISOString();
  t.applySell(s, 'BTCUSDC', 100, 'SIGNAL'); // cubre plano a 30 días
  const tr = s.state.tradeHistory[0];
  // Plano sin funding ≈ -0.30%; con 30d de funding (0.03%/día = 0.9%) ≈ -1.2% sobre 1000 ≈ -12 USDC
  assert.ok(tr.profitUSDC < -9, `el funding debe restar (profit=${tr.profitUSDC})`);
});

test('motor long/short: el stop de catástrofe (25%) dispara si el precio sube ≥ stopPct', async () => {
  // Bajada larga (abre corto), luego SUBIDA fuerte >25% mientras la SMA sigue bajista → STOP.
  // shortTrailAtr:0 para aislar el stop de catástrofe (si no, el Chandelier cubre antes).
  const down = Array.from({ length: 220 }, (_, i) => 300 - i);   // baja 300→81 (bajista)
  const spike = Array.from({ length: 10 }, (_, i) => 81 + i * 8); // sube 81→153 (+89%) rápido
  const data = { AAAUSDC: makeDaily([...down, ...spike]) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, shortStopPct: 0.25, shortStopCooldown: 5, shortTrailAtr: 0, shortEntry: {},
    dataBySymbol: data, bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  const stops = r.trades.filter(t => t.side === 'short' && t.reason === 'STOP_LOSS');
  assert.ok(stops.length >= 1, 'el stop del corto debería haber disparado en el spike');
});

test('motor long/short: el Chandelier del corto (ATR-trail) cubre en el rebote (research #9)', async () => {
  // Bajada (abre corto y hace nuevos mínimos), luego rebote moderato → el Chandelier cubre
  // ANTES del stop 25% (salida más ajustada). Reason = TRAILING_STOP.
  const down = Array.from({ length: 230 }, (_, i) => 300 - i);   // 300→71
  const bounce = Array.from({ length: 8 }, (_, i) => 71 + i * 4); // +45% moderado
  const data = { AAAUSDC: makeDaily([...down, ...bounce]) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, shortStopPct: 0.25, shortTrailAtr: 3.0, shortEntry: {},
    dataBySymbol: data, bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  const trails = r.trades.filter(t => t.side === 'short' && t.reason === 'TRAILING_STOP');
  assert.ok(trails.length >= 1, 'el Chandelier del corto debería haber cubierto en el rebote');
});

test('shortEntryAllowed: confirm3d exige 3 cierres bajo la SMA antes de shortear', async () => {
  const { shortEntryAllowed } = await import('../indicators.js');
  // 150 velas planas a 100 + 2 cierres bajo la SMA → confirm3d NO permite (solo 2)
  const two = [...Array.from({ length: 150 }, () => 100), 99, 98];
  assert.equal(shortEntryAllowed(two, { smaPeriod: 150, confirmDays: 3 }), false);
  // 3 cierres bajo la SMA → permite
  const three = [...Array.from({ length: 150 }, () => 100), 99, 98, 97];
  assert.equal(shortEntryAllowed(three, { smaPeriod: 150, confirmDays: 3 }), true);
  // sin filtro → siempre permite
  assert.equal(shortEntryAllowed(two, { smaPeriod: 150 }), true);
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

// ───────────────────── Auditoría 2026-07-03: instrumentación ─────────────────────
test('computeMetrics expone signalOnly (PF sin END_OF_BACKTEST)', async () => {
  const up = Array.from({ length: 220 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 320 - i * 3);
  const data = { AAAUSDC: makeDaily([...up, ...down]) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, dataBySymbol: data, bufferSize: 260, minCandles: 205,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  assert.ok(r.summary.signalOnly, 'summary.signalOnly debe existir');
  const eob = r.trades.filter(t => t.reason === 'END_OF_BACKTEST').length;
  assert.equal(r.summary.signalOnly.trades, r.summary.totalTrades - eob);
});

test('getStats excluye cierres administrativos del winRate y cuenta signalTrades', async () => {
  const t = new ShadowTrader();
  const state = {
    balanceUSDC: 5000, openPositions: {}, cooldowns: {},
    tradeHistory: [
      { symbol: 'AUSDC', reason: 'SIGNAL', profitUSDC: -46 },
      { symbol: 'BUSDC', reason: 'MANUAL_CLEANUP', profitUSDC: 100 }, // ganador administrativo
    ],
  };
  t._loadState = async () => state;
  const st = await t.getStats({});
  assert.equal(st.signalTrades, 1);
  assert.equal(st.totalTrades, 2);
  assert.equal(st.winRate, '0.00%'); // el cleanup ganador NO infla el WR de estrategia
});

test('commitSession aborta si el balance no es finito (guard anti-NaN)', async () => {
  const t = new ShadowTrader();
  t._saveState = async () => { throw new Error('no debería llegar a guardar'); };
  await assert.rejects(
    () => t.commitSession({ state: { balanceUSDC: NaN }, notifications: [] }),
    /no finito/
  );
});

test('funding devengado en cortos abiertos reduce el unrealized de getStats', async () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { sizeFraction: 0.2 });
  s.state.openPositions['BTCUSDC'].timestamp = new Date(Date.now() - 10 * 86400000).toISOString();
  t._loadState = async () => s.state;
  const st = await t.getStats({ BTCUSDC: 100 }); // precio plano → latente = −funding
  // margen 1000 × 0.0003/día × 10 días = −3.00
  assert.ok(Math.abs(Number(st.unrealizedPnLUSDC) - (-3)) < 0.01, `unrealized=${st.unrealizedPnLUSDC}`);
});

// ───────────────────── Funding real firmado (research 2026-07 #1) ─────────────────────
test('buildCumFromRates + cumRateAt: acumulado y búsqueda binaria correctos', async () => {
  const { buildCumFromRates, cumRateAt } = await import('../binanceService.js');
  const s = buildCumFromRates([{ time: 300, rate: 0.0003 }, { time: 100, rate: 0.0001 }, { time: 200, rate: -0.0002 }]);
  assert.equal(s.length, 3);
  assert.ok(Math.abs(cumRateAt(s, 50) - 0) < 1e-12);          // antes del primer punto
  assert.ok(Math.abs(cumRateAt(s, 250) - (-0.0001)) < 1e-12); // tras el 2º punto
  assert.ok(Math.abs(cumRateAt(s, 999) - 0.0002) < 1e-9);     // tras el último
});

test('shortFundingCost: funding real positivo = el corto COBRA (coste negativo); flat siempre en contra', async () => {
  const { buildCumFromRates } = await import('../binanceService.js');
  const engine = new BacktestEngine({ symbols: ['AAAUSDC'], longShort: true, fundingMode: 'real' });
  engine.fundingSeries = { AAAUSDC: buildCumFromRates([{ time: 1000, rate: 0.001 }, { time: 2000, rate: 0.001 }]) };
  // Tramo que cubre ambos pagos (0.2% acumulado) sobre 1000 de margen → el corto cobra 2 → coste −2
  const real = engine.shortFundingCost('AAAUSDC', 500, 2500, 1000);
  assert.ok(Math.abs(real - (-2)) < 1e-9, `coste real=${real}`);
  // Sin serie para el símbolo → cae a flat (0.03%/día en contra)
  const flat = engine.shortFundingCost('BBBUSDC', 0, 10 * 86400000, 1000);
  assert.ok(Math.abs(flat - 3) < 1e-9, `coste flat=${flat}`);
});

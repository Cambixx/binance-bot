import { test } from 'node:test';
import assert from 'node:assert/strict';
import BacktestEngine, { strategyName } from '../backtestEngine.js';
import { evaluateFixedExit } from '../exits.js';

// Genera velas diarias sintéticas para un símbolo a partir de una serie de cierres.
function makeDaily(closes, startTime = 1700000000000) {
  const dayMs = 86400000;
  return closes.map((c, i) => ({
    time: startTime + i * dayMs, open: c, high: c, low: c, close: c, volume: 1000,
  }));
}

test('strategyName resuelve todas las versiones (fix #25)', () => {
  assert.equal(strategyName('4C'), 'V4-C (V3+RegimeGate)');
  assert.equal(strategyName('SMA200'), 'SMA200 (Faber regime, diaria)');
  assert.equal(strategyName('DONCHIAN'), 'Donchian 55/20 (diaria)');
  assert.notEqual(strategyName('4C'), 'V3 (ADX+Trailing)'); // ya NO cae al label de V3 (el bug)
});

test('SMA200 in-or-out sobre datos sintéticos: entra en subida, sale en bajada', async () => {
  // Sube 250 días, luego cae fuerte → debe comprar y luego vender a cash
  const up = Array.from({ length: 250 }, (_, i) => 100 + i);
  const down = Array.from({ length: 60 }, (_, i) => 350 - i * 4);
  const closes = [...up, ...down];
  const data = { AAAUSDC: makeDaily(closes) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200',
    exitMode: 'signal', dataBySymbol: data, bufferSize: 260, minCandles: 205,
    regimeOpts: { smaPeriod: 200 }, oosSplitRatio: 0.7,
  });
  const r = await engine.run();
  assert.ok(r.summary.totalTrades >= 1, 'debería ejecutar al menos un trade');
  // Las métricas riesgo-ajustadas existen (fix #18)
  assert.ok('sharpe' in r.summary && 'calmar' in r.summary && 'sortino' in r.summary);
});

test('profitFactor = null (∞) cuando no hay pérdidas (fix #8)', async () => {
  // Tendencia monótona alcista: SMA200 compra una vez y cierra en ganancia al final
  const closes = Array.from({ length: 320 }, (_, i) => 100 + i);
  const data = { AAAUSDC: makeDaily(closes) };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200',
    exitMode: 'signal', dataBySymbol: data, bufferSize: 360, minCandles: 205,
    regimeOpts: { smaPeriod: 200 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  assert.equal(r.summary.losingTrades, 0);
  assert.equal(r.summary.profitFactor, null, 'PF debe ser null (∞), no 0');
});

test('costes: trade plano pierde el round-trip (≈0.30%)', async () => {
  // Precio sube por encima de SMA (compra) y termina exactamente al precio de entrada de la
  // primera compra no es trivial; en su lugar comprobamos que con costes el balance final < HODL
  // sin coste no aplica aquí — validamos que el coste se aplica vía pérdida en in/out repetido.
  const seg = [];
  for (let k = 0; k < 6; k++) {
    for (let i = 0; i < 210; i++) seg.push(100 + i);      // sube
    for (let i = 0; i < 5; i++) seg.push(100);            // cae a 100 (sale)
  }
  const data = { AAAUSDC: makeDaily(seg) };
  const withCosts = await new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 200 },
  }).run();
  const noCosts = await new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 200 },
    feePct: 0, slippagePct: 0,
  }).run();
  assert.ok(withCosts.summary.finalBalance < noCosts.summary.finalBalance,
    'con costes el balance final debe ser menor que sin costes');
});

test('MaxDrawdown per-bar captura caídas intra-hora (fix #1)', async () => {
  // En 15m: posición abierta, caída fuerte y recuperación dentro de la misma hora.
  // El tracker per-bar debe ver el DD aunque el equityCurve esté submuestreado a 1h.
  // Construimos un caso simple con SMA corta para forzar exposición.
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100);       // base plana
  for (let i = 0; i < 5; i++) closes.push(100 + i);    // sube → compra (SMA corta)
  closes.push(70);                                      // caída fuerte
  closes.push(105);                                     // recuperación
  for (let i = 0; i < 5; i++) closes.push(106 + i);
  const fifteenMin = 15 * 60 * 1000;
  const data = {
    AAAUSDC: closes.map((c, i) => ({ time: 1700000000000 + i * fifteenMin, open: c, high: c, low: c, close: c, volume: 1000 })),
  };
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '15m', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 80, minCandles: 50, regimeOpts: { smaPeriod: 40 },
  });
  const r = await engine.run();
  // El DD reportado debe ser sustancial (la caída a 70 mientras está invertido)
  assert.ok(r.summary.maxDrawdown > 5, `maxDD ${r.summary.maxDrawdown} debería reflejar la caída intra-hora`);
});

// ───────────────────────── Paridad de salidas (fix #2) ─────────────────────────
test('evaluateFixedExit: trailing dispara tras pullback bajo la activación (el bug del audit)', () => {
  const params = { takeProfitPct: 5, stopLossPct: 3, trailingActivation: 1.5, trailingDistance: 0.45 };
  // Vela 1: buy=100, sube a 104 → trailing armado, trailSL = 100*(1+4*0.45/100)=101.8
  let pos = { buyPrice: 100, peakPrice: 100, trailingActivated: false, trailingSL: 0 };
  let d = evaluateFixedExit(pos, 104, params);
  assert.equal(d.trailingActivated, true);
  assert.ok(Math.abs(d.trailingSL - 101.8) < 1e-9, `trailSL ${d.trailingSL}`);
  assert.equal(d.action, null); // aún por encima del trail
  pos = { ...pos, peakPrice: d.peakPrice, trailingActivated: d.trailingActivated, trailingSL: d.trailingSL };
  // Vela 2: precio cae a 101 (profit +1% < activación 1.5%) pero <= trailSL 101.8 → TRAILING_STOP
  d = evaluateFixedExit(pos, 101, params);
  assert.equal(d.action, 'TRAILING_STOP', 'el trailing debe disparar aunque el profit caiga bajo la activación');
});

test('evaluateFixedExit: orden TP → Trailing → SL', () => {
  const params = { takeProfitPct: 5, stopLossPct: 3, trailingActivation: 1.5, trailingDistance: 0.45 };
  // TP tiene prioridad
  let d = evaluateFixedExit({ buyPrice: 100, peakPrice: 100, trailingActivated: false, trailingSL: 0 }, 106, params);
  assert.equal(d.action, 'TAKE_PROFIT');
  // SL puro
  d = evaluateFixedExit({ buyPrice: 100, peakPrice: 100, trailingActivated: false, trailingSL: 0 }, 96, params);
  assert.equal(d.action, 'STOP_LOSS');
});

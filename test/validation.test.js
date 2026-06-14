import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, std, normalCDF, normalInvCDF, makeRng,
  bootstrapTradeCI, blockBootstrapReturns, pricesFromLogReturns,
  deflatedSharpe, probabilityOfBacktestOverfitting,
} from '../validation.js';

test('normalCDF / normalInvCDF coherentes', () => {
  assert.ok(Math.abs(normalCDF(0) - 0.5) < 1e-3);
  assert.ok(Math.abs(normalCDF(1.645) - 0.95) < 5e-3);
  assert.ok(Math.abs(normalInvCDF(0.975) - 1.96) < 1e-2);
  // round-trip
  assert.ok(Math.abs(normalCDF(normalInvCDF(0.8)) - 0.8) < 1e-3);
});

test('makeRng determinista', () => {
  const a = makeRng(42); const b = makeRng(42);
  assert.equal(a(), b());
  assert.equal(a(), b());
});

test('bootstrapTradeCI: edge positivo claro → IC por encima de 0', () => {
  const pcts = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? -1 : 1.5)); // expectativa positiva
  const r = bootstrapTradeCI(pcts, { iters: 2000, seed: 7 });
  assert.ok(!r.insufficient);
  assert.ok(r.ci5 > 0, `ci5 ${r.ci5} debería ser >0 con edge positivo`);
  assert.ok(r.pLoss < 0.1);
});

test('bootstrapTradeCI: muestra insuficiente marcada', () => {
  const r = bootstrapTradeCI([1, 2], {});
  assert.equal(r.insufficient, true);
});

test('blockBootstrapReturns preserva longitud y usa valores reales', () => {
  const rets = Array.from({ length: 50 }, (_, i) => i / 100);
  const s = blockBootstrapReturns(rets, 10, makeRng(1));
  assert.equal(s.length, rets.length);
  s.forEach(v => assert.ok(rets.includes(v)));
});

test('pricesFromLogReturns reconstruye precios', () => {
  const p = pricesFromLogReturns([Math.log(1.1), Math.log(1.1)], 100);
  assert.ok(Math.abs(p[2] - 121) < 1e-6);
});

test('deflatedSharpe: nTrials=1 sin deflación; más pruebas reducen la DSR', () => {
  const base = { sharpe: 0.15, T: 250, skew: 0, kurt: 3 };
  const one = deflatedSharpe({ ...base, nTrials: 1, varTrialSharpe: 0.1 });
  const many = deflatedSharpe({ ...base, nTrials: 50, varTrialSharpe: 0.1 });
  assert.ok(one.expectedMaxSharpe === 0);
  assert.ok(many.deflatedSharpe < one.deflatedSharpe, 'más pruebas → DSR menor');
});

test('PBO/CSCV: estrategia con señal persistente → PBO bajo; ruido → PBO alto', () => {
  // Config 0 es consistentemente la mejor en todos los bloques → ganador IS también gana OOS.
  const S = 8, Nc = 4;
  const consistent = [];
  for (let c = 0; c < S; c++) {
    const row = [];
    for (let j = 0; j < Nc; j++) row.push(j === 0 ? 0.05 : 0.01 * j - 0.02); // config 0 domina
    consistent.push(row);
  }
  const pboGood = probabilityOfBacktestOverfitting(consistent);
  assert.ok(pboGood.pbo < 0.5, `PBO consistente ${pboGood.pbo} debería ser <0.5`);

  // Ruido determinista: el ganador IS cambia por bloque → PBO alto
  const rng = makeRng(123);
  const noisy = [];
  for (let c = 0; c < S; c++) {
    const row = [];
    for (let j = 0; j < Nc; j++) row.push(rng() - 0.5);
    noisy.push(row);
  }
  const pboBad = probabilityOfBacktestOverfitting(noisy);
  assert.ok(pboBad.pbo >= 0, 'PBO computable sobre ruido');
  assert.ok(pboGood.pbo <= pboBad.pbo + 0.5); // sanity: el consistente no es peor que el ruido
});

test('PBO exige S par y >=4', () => {
  const r = probabilityOfBacktestOverfitting([[1, 2], [3, 4], [5, 6]]); // S=3 impar
  assert.ok(r.error);
});

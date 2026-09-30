import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lsBaseEngineOpts } from '../wfcore.js';
import BacktestEngine from '../backtestEngine.js';
import {
  SMA_HYSTERESIS_BAND, SMA_PERIOD, STRATEGY_OPTS, LONGSHORT, REGIME, VOLTARGET,
} from '../config.js';

// Auditoría 2026-09-29 (§20.1): `lsBaseEngineOpts` fijaba band:0 mientras el live usaba 0,75 %, y
// todos los torneos midieron una estrategia que no era la de producción. Estos tests fallan si el
// perfil del arnés vuelve a divergir de lo que ejecutan los bots.

test('perfil del arnés = producción: régimen, banda, stops del corto y vol-target salen de config', () => {
  const o = lsBaseEngineOpts();
  assert.equal(o.regimeOpts.band, SMA_HYSTERESIS_BAND);
  assert.equal(o.regimeOpts.smaPeriod, SMA_PERIOD);
  assert.equal(o.regimeOpts.chopMax, STRATEGY_OPTS.chopMax);
  assert.equal(o.shortStopPct, LONGSHORT.shortStopPct);
  assert.equal(o.shortStopCooldown, LONGSHORT.shortStopCooldownDays);
  assert.equal(o.volTarget.targetVolAnnual, VOLTARGET.targetVolAnnual);
  assert.equal(o.volTarget.enabled, true);
});

test('un motor con el perfil del arnés hereda del config el gate BTC, el Chandelier y el filtro del corto', () => {
  const e = new BacktestEngine({ ...lsBaseEngineOpts(), dataBySymbol: {}, symbols: [] });
  assert.deepEqual(e.btcGateLong, { smaPeriod: REGIME.btcSmaPeriod });
  assert.equal(e.shortTrailAtr, LONGSHORT.shortTrailAtr);
  assert.deepEqual(e.shortEntry, LONGSHORT.shortEntry);
  assert.equal(e.shortBtcGate, true);
  assert.equal(e.shortTrailReentry, 'immediate');
});

test('los bots en vivo leen la banda de config, no un literal', () => {
  for (const f of ['dailyBot.js', 'longShortBot.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /band:\s*SMA_HYSTERESIS_BAND/, `${f} debe usar SMA_HYSTERESIS_BAND`);
    assert.doesNotMatch(src, /band:\s*0\.\d+/, `${f} no debe llevar una banda literal`);
  }
});

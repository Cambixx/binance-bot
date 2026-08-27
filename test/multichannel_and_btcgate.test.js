import { test } from 'node:test';
import assert from 'node:assert/strict';
import BacktestEngine from '../backtestEngine.js';

function makeDaily(closes, startTime = 1700000000000) {
  const dayMs = 86400000;
  return closes.map((c, i) => ({ time: startTime + i * dayMs, open: c, high: c, low: c, close: c, volume: 1000 }));
}

const flat = (n, v) => Array.from({ length: n }, () => v);
const ramp = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);

// Escenario: AAA bajista (cruza su SMA150 a la baja) mientras BTC está alcista (sube sobre su SMA200).
function bullBtcBearAltScenario() {
  return {
    AAAUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, -0.5)]),   // cae 100→45.5 (señal SELL)
    BTCUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, 1)]),      // sube 100→209 (BTC alcista)
  };
}

// Escenario: AAA bajista Y BTC bajista (ambos caen bajo sus medias).
function bearBtcBearAltScenario() {
  return {
    AAAUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, -0.5)]),   // cae 100→45.5
    BTCUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, -0.5)]),   // cae 100→45.5 (BTC bajista)
  };
}

function mkEngine(data, extra = {}) {
  return new BacktestEngine({
    symbols: Object.keys(data), interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 310, minCandles: 205, longShort: true,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95, volTarget: null, ...extra,
  });
}

test('shortAllowedByBtc bloquea cortos cuando BTC está alcista (Risk-On)', async () => {
  const r = await mkEngine(bullBtcBearAltScenario(), { btcGateLong: { smaPeriod: 200 } }).run();
  const aaaShorts = r.trades.filter(t => t.symbol === 'AAAUSDC' && t.side === 'short');
  assert.equal(aaaShorts.length, 0, `no debería abrir cortos en AAA cuando BTC está alcista (hubo ${aaaShorts.length})`);
});

test('shortAllowedByBtc permite cortos cuando BTC está bajista (Risk-Off)', async () => {
  const r = await mkEngine(bearBtcBearAltScenario(), { btcGateLong: { smaPeriod: 200 } }).run();
  const aaaShorts = r.trades.filter(t => t.symbol === 'AAAUSDC' && t.side === 'short');
  assert.ok(aaaShorts.length >= 1, `debería abrir cortos en AAA cuando BTC también está bajista (hubo ${aaaShorts.length})`);
});

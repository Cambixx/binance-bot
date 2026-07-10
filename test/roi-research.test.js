import { test } from 'node:test';
import assert from 'node:assert/strict';
import BacktestEngine from '../backtestEngine.js';

// Tests del research ROI 2026-07-10: gate maestro BTC (adoptado) + pyramid/tilt (candidatas
// disponibles como opción, rechazadas por el gate pareado — se testea que funcionen como opción).

function makeDaily(closes, startTime = 1700000000000) {
  const dayMs = 86400000;
  return closes.map((c, i) => ({ time: startTime + i * dayMs, open: c, high: c, low: c, close: c, volume: 1000 }));
}

const flat = (n, v) => Array.from({ length: n }, () => v);
const ramp = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);

// AAA alcista (cruza su SMA150 al alza) mientras BTC está bajista (bajo su SMA200).
function gateScenario() {
  return {
    AAAUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, 1)]),      // sube 100→209
    BTCUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, -0.5)]),   // cae 100→45.5
  };
}

function mkEngine(data, extra = {}) {
  return new BacktestEngine({
    symbols: Object.keys(data), interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    dataBySymbol: data, bufferSize: 310, minCandles: 205,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95, volTarget: null, ...extra,
  });
}

test('btcGateLong bloquea largos nuevos cuando BTC < SMA200', async () => {
  const conGate = await mkEngine(gateScenario(), { btcGateLong: { smaPeriod: 200 } }).run();
  const aaaLongs = conGate.trades.filter(t => t.symbol === 'AAAUSDC' && t.side !== 'short');
  assert.equal(aaaLongs.length, 0, `el gate debería bloquear los largos de AAA (hubo ${aaaLongs.length})`);
});

test('btcGateLong: null lo desactiva (los largos vuelven a abrirse)', async () => {
  const sinGate = await mkEngine(gateScenario(), { btcGateLong: null }).run();
  const aaaLongs = sinGate.trades.filter(t => t.symbol === 'AAAUSDC' && t.side !== 'short');
  assert.ok(aaaLongs.length >= 1, 'sin gate, AAA alcista debería abrir largo');
});

test('btcGateLong es fail-open sin BTC en el universo', async () => {
  const data = { AAAUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, 1)]) };
  const r = await mkEngine(data, { btcGateLong: { smaPeriod: 200 } }).run();
  assert.ok(r.trades.filter(t => t.symbol === 'AAAUSDC').length >= 1, 'sin BTC, el gate no debe bloquear');
});

test('pyramid añade tranches en tendencia y aumenta el P&L absoluto del rally', async () => {
  const data = () => ({ AAAUSDC: makeDaily([...flat(250, 100), ...ramp(110, 100, 1)]) });
  const base = await mkEngine(data(), { btcGateLong: null }).run();
  const pyr = await mkEngine(data(), { btcGateLong: null, pyramid: { stepPct: 0.10, maxAdds: 2 } }).run();
  const sum = (r) => r.trades.reduce((s, t) => s + t.profit, 0);
  assert.ok(sum(pyr) > sum(base), `pyramid debería ganar más en rally monótono: ${sum(pyr)} vs ${sum(base)}`);
});

test('entryTilt: entrada débil (cruce fresco) recibe el floor; fuerte recibe tamaño pleno', () => {
  const engine = mkEngine({ AAAUSDC: makeDaily(flat(200, 100)) }, { entryTilt: { horizonDays: 30, floor: 0.25 } });
  // Serie con vol ~1%/día alrededor de 100 (para que σ no sea 0)
  const noisy = Array.from({ length: 200 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.01 : -0.01)));
  const weak = { closes: [...noisy, 101] };   // ~1% sobre la SMA → z pequeño → floor
  // Subida GRADUAL (para no inflar la σ20d con un salto): 30 días al +1%/día → lejos de la SMA
  const strong = { closes: [...noisy, ...Array.from({ length: 30 }, (_, i) => 101 * 1.01 ** (i + 1))] };
  assert.equal(engine.entryTiltMult(weak), 0.25);
  assert.equal(engine.entryTiltMult(strong), 1);
});

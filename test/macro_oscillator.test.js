import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMacroOscillator,
  calculateBullMarketSupportBand,
  calculateCorrectionStreak,
  evaluateStrategyMacroOscillator,
} from '../indicators.js';
import BacktestEngine from '../backtestEngine.js';

test('calculateMacroOscillator calcula el diferencial porcentual SMA50 vs SMA200', () => {
  const closes = Array.from({ length: 250 }, (_, i) => 100 + i);
  const osc = calculateMacroOscillator(closes, 50, 200);

  assert.equal(osc.length, 250);
  assert.equal(osc[198], null); // antes de 200 velas es null
  assert.ok(typeof osc[199] === 'number');
  // Como los precios van en aumento constante, la SMA50 debe ser mayor que la SMA200 -> Osc > 0
  assert.ok(osc[249] > 0);
});

test('calculateBullMarketSupportBand calcula EMA 20w y SMA 21w', () => {
  const closes = Array.from({ length: 200 }, () => 50000);
  const bmsb = calculateBullMarketSupportBand(closes, 140, 147);

  assert.ok(bmsb.ema20w);
  assert.ok(bmsb.sma21w);
  assert.equal(Math.round(bmsb.ema20w[199]), 50000);
  assert.equal(Math.round(bmsb.sma21w[199]), 50000);
});

test('calculateCorrectionStreak mide racha y resetea ante caídas >= 15%', () => {
  // 100 velas subiendo
  const highs = Array.from({ length: 100 }, (_, i) => 100 + i);
  const lows = Array.from({ length: 100 }, (_, i) => 99 + i);
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i);

  const streak1 = calculateCorrectionStreak(highs, lows, closes, 0.15);
  assert.ok(streak1[99] > 90);

  // Añadir una caída del 20% (de 200 a 160)
  highs.push(200);
  lows.push(158);
  closes.push(160);

  const streak2 = calculateCorrectionStreak(highs, lows, closes, 0.15);
  assert.equal(streak2[100], 0, 'La racha debe resetearse a 0 tras caída >= 15%');
});

test('evaluateStrategyMacroOscillator genera señales BUY/SELL/HOLD según condiciones macro', () => {
  // Insuficientes velas
  assert.equal(evaluateStrategyMacroOscillator({ closes: [100, 105, 110] }), 'HOLD');

  // Simulación de serie con 220 velas
  const baseCloses = Array.from({ length: 220 }, () => 100);
  const res = evaluateStrategyMacroOscillator({ closes: baseCloses, highs: baseCloses, lows: baseCloses });
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(res));
});

test('BacktestEngine ejecuta exitosamente la estrategia MACRO_OSC', async () => {
  const dayMs = 86400000;
  const startTime = 1600000000000;
  const mockCandles = Array.from({ length: 300 }, (_, i) => {
    const p = 10000 + i * 50;
    return { time: startTime + i * dayMs, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 500 };
  });

  const engine = new BacktestEngine({
    symbols: ['BTCUSDC'],
    interval: '1d',
    strategyVersion: 'MACRO_OSC',
    exitMode: 'signal',
    dataBySymbol: { BTCUSDC: mockCandles },
    bufferSize: 250,
    minCandles: 210,
    oosSplitRatio: 0.8,
  });

  const report = await engine.run();
  assert.ok(report);
  assert.ok(Number.isFinite(report.summary.finalBalance));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEMA, calculateRSI, calculateATR, calculateChoppinessIndex, calculateBBW,
  calculateSupertrend, evaluateStrategySMA200, evaluateStrategyDonchian,
  computeVolTargetWeight, periodsPerYearFor, trailingReturn, btcRegimeOn, computeRotationTargets,
} from '../indicators.js';
import { COSTS } from '../config.js';

// ───────────────────────── Modelo de costes ─────────────────────────
test('round-trip de coste ≈ 2×(fee+slippage) en trade plano', () => {
  const { feePct, slippagePct } = COSTS;
  const price = 100, invest = 1000;
  const fillBuy = price * (1 + slippagePct);
  const amt = (invest - invest * feePct) / fillBuy;
  const fillSell = price * (1 - slippagePct);
  const gross = amt * fillSell;
  const ret = gross - gross * feePct;
  const lossPct = (ret - invest) / invest * 100;
  const expected = -2 * (feePct + slippagePct) * 100;
  assert.ok(Math.abs(lossPct - expected) < 0.01, `loss ${lossPct} vs esperado ${expected}`);
});

// ───────────────────────── Indicadores base ─────────────────────────
test('EMA: longitud y monotonía en serie creciente', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
  const ema = calculateEMA(closes, 10);
  assert.equal(ema.length, 41);
  assert.ok(ema[ema.length - 1] > ema[0]);
});

test('RSI tiende a ~100 en serie estrictamente creciente', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const rsi = calculateRSI(closes, 14);
  assert.ok(rsi[rsi.length - 1] > 99);
});

test('ATR longitud = n - period', () => {
  const n = 30;
  const highs = Array.from({ length: n }, (_, i) => 10 + i);
  const lows = highs.map(h => h - 1);
  const closes = highs.map(h => h - 0.5);
  const atr = calculateATR(highs, lows, closes, 14);
  assert.equal(atr.length, n - 14);
});

test('CHOP: tendencia limpia → valor bajo; lateral → valor alto', () => {
  const n = 40;
  // Serie en tendencia (rango total grande vs suma de TRs)
  const trH = Array.from({ length: n }, (_, i) => 100 + i);
  const trL = trH.map(h => h - 0.5);
  const trC = trH.map(h => h - 0.25);
  const chopTrend = calculateChoppinessIndex(trH, trL, trC, 14);
  // Serie lateral (oscila en banda estrecha)
  const laH = Array.from({ length: n }, (_, i) => 100 + (i % 2));
  const laL = laH.map(h => h - 1);
  const laC = laH.map(h => h - 0.5);
  const chopLat = calculateChoppinessIndex(laH, laL, laC, 14);
  assert.ok(chopTrend[chopTrend.length - 1] < chopLat[chopLat.length - 1],
    `trend ${chopTrend.at(-1)} debería ser < lateral ${chopLat.at(-1)}`);
});

test('Supertrend: seed +1 (sin downtrend espurio en arranque alcista)', () => {
  const n = 30;
  const highs = Array.from({ length: n }, (_, i) => 100 + i * 2);
  const lows = highs.map(h => h - 2);
  const closes = highs.map(h => h - 1);
  const st = calculateSupertrend(highs, lows, closes, 10, 3);
  assert.ok(st.length > 0);
  // En una tendencia alcista clara, el trend final debe ser +1
  assert.equal(st[st.length - 1].trend, 1);
});

// ───────────────────────── SMA con banda de histéresis ─────────────────────────
test('SMA200 con banda: zona muerta alrededor de la media', () => {
  const closes = Array.from({ length: 205 }, () => 100);
  closes[closes.length - 1] = 100.3; // +0.3% sobre la media plana
  assert.equal(evaluateStrategySMA200({ closes }, { smaPeriod: 200 }), 'BUY'); // sin banda
  assert.equal(evaluateStrategySMA200({ closes }, { smaPeriod: 200, band: 0.01 }), 'HOLD'); // banda 1%
});

// ───────────────────────── Donchian ─────────────────────────
test('Donchian: ruptura del máximo previo con régimen ON dispara BUY', () => {
  // 60 cierres planos a 100, luego ruptura a 130 con SMA por debajo
  const closes = Array.from({ length: 60 }, () => 100);
  closes.push(130);
  const highs = closes.map(c => c);
  const lows = closes.map(c => c);
  const sig = evaluateStrategyDonchian({ closes, highs, lows }, { entryLen: 20, exitLen: 10, smaPeriod: 50, useRegime: true });
  assert.equal(sig, 'BUY');
});

// ───────────────────────── Vol-targeting ─────────────────────────
test('vol-target: w alto en calma, w recortado en alta volatilidad', () => {
  const calm = []; let p = 100;
  for (let i = 0; i < 80; i++) { p *= (1 + (i % 2 ? 0.001 : -0.001)); calm.push(p); }
  const wild = []; p = 100;
  for (let i = 0; i < 80; i++) { p *= (1 + (i % 2 ? 0.08 : -0.07)); wild.push(p); }
  const wCalm = computeVolTargetWeight(calm, { targetVolAnnual: 0.5, periodsPerYear: 365, wMax: 1 });
  const wWild = computeVolTargetWeight(wild, { targetVolAnnual: 0.5, periodsPerYear: 365, wMax: 1 });
  assert.ok(wCalm > wWild, `calm ${wCalm} > wild ${wWild}`);
  assert.ok(wCalm <= 1 && wWild >= 0);
});

test('periodsPerYearFor coherente', () => {
  assert.equal(periodsPerYearFor('1d'), 365);
  assert.equal(periodsPerYearFor('15m'), 365 * 24 * 4);
});

// ───────────────────────── Régimen BTC + rotación ─────────────────────────
test('btcRegimeOn: true si último cierre > SMA', () => {
  const up = Array.from({ length: 205 }, (_, i) => 100 + i); // creciente
  const down = Array.from({ length: 205 }, (_, i) => 300 - i); // decreciente
  assert.equal(btcRegimeOn(up, 200), true);
  assert.equal(btcRegimeOn(down, 200), false);
});

test('trailingReturn correcto', () => {
  const closes = [10, 11, 12, 15]; // últimos: ret 2 atrás = 15/11-1
  assert.ok(Math.abs(trailingReturn(closes, 2) - (15 / 11 - 1)) < 1e-9);
});

test('rotación: top-N por retorno con gate de momentum absoluto y BTC', () => {
  const closesBySymbol = {
    A: [1, 1, 1.5],   // +50%
    B: [1, 1, 0.8],   // -20% (excluido por momentum absoluto <0)
    C: [1, 1, 1.2],   // +20%
    D: [1, 1, 1.1],   // +10%
  };
  const r = computeRotationTargets(closesBySymbol, { lookbackDays: 2, topN: 2, absMomLookback: 2, useBtcRegime: false });
  assert.deepEqual(r.targets, ['A', 'C']); // top-2 con momentum>0
  // BTC risk-off → todo a cash
  const off = computeRotationTargets(closesBySymbol, {
    lookbackDays: 2, topN: 2, absMomLookback: 2, useBtcRegime: true,
    btcCloses: Array.from({ length: 205 }, (_, i) => 300 - i), btcSmaPeriod: 200,
  });
  assert.equal(off.riskOff, true);
  assert.deepEqual(off.targets, []);
});

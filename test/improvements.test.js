import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  btcCrashGuard,
  btcRegimeOn,
  computeRotationTargets,
  evaluateStrategySMA200
} from '../indicators.js';
import { isCircuitBreakerActive } from '../shadowTrader.js';
import { SMA_HYSTERESIS_BAND, PORTFOLIO_CIRCUIT_BREAKER } from '../config.js';

describe('🚀 Mejoras de Auditoría 2026-07-24 (Quality & Risk Enhancements)', () => {

  it('btcCrashGuard: detecta caídas de pánico (>12% en 3 días)', () => {
    // 4 cierres diarios: 100, 100, 100, 85 (caída de -15% en 3 días)
    const btcCloses = [100, 100, 100, 85];
    const isCrash = btcCrashGuard(btcCloses, { crashGuardLookbackDays: 3, crashGuardMaxDropPct: 0.12 });
    assert.equal(isCrash, true, 'Debe detectar la caída del 15% como crash de pánico');

    // Cierres estables
    const btcStable = [100, 101, 100, 99];
    assert.equal(btcCrashGuard(btcStable), false, 'No debe activar crash guard en mercado estable');
  });

  it('btcRegimeOn: bloquea risk-on si salta btcCrashGuard aunque esté sobre la SMA', () => {
    // Generar 200 cierres altos y luego un crash rápido de 1000 a 850
    const btcCloses = new Array(200).fill(1000);
    btcCloses.push(850); // caída instantánea >12%
    const riskOn = btcRegimeOn(btcCloses, 150, { crashGuardEnabled: true, crashGuardLookbackDays: 3, crashGuardMaxDropPct: 0.10 });
    assert.equal(riskOn, false, 'Crash guard debe apagar el régimen risk-on independientemente de la SMA');
  });

  it('computeRotationTargets: favorece monedas con retorno ajustado a riesgo (Sharpe 30d)', () => {
    // Moneda A: +10% constante y limpia (baja vol)
    const closesA = [];
    let priceA = 100;
    for (let i = 0; i < 35; i++) {
      priceA *= 1.003;
      closesA.push(priceA);
    }

    // Moneda B: +12% ruidosa con altísima volatilidad (+10%, -8%, +15%, -10%...)
    const closesB = [];
    let priceB = 100;
    for (let i = 0; i < 35; i++) {
      const swing = (i % 2 === 0) ? 1.08 : 0.93;
      priceB *= swing;
      closesB.push(priceB);
    }

    const { ranked } = computeRotationTargets(
      { AAA: closesA, BBB: closesB },
      { lookbackDays: 30, topN: 2, absMomLookback: 30, useBtcRegime: false, useRiskAdjusted: true }
    );

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].symbol, 'AAA', 'Moneda A con tendencia limpia debe rankear por encima de B que es muy volátil');
  });

  it('SMA_HYSTERESIS_BAND: respeta la banda de histéresis configurada', () => {
    // SMA150 = 100
    const closes = new Array(150).fill(100);
    // Precio exactamente en 100.5 (0.5% arriba) -> con histéresis del 0.75% debe ser HOLD (no BUY)
    closes.push(100.5);
    const signalNoBuy = evaluateStrategySMA200({ closes }, { smaPeriod: 150, band: 0.0075 });
    assert.equal(signalNoBuy, 'HOLD', '0.5% sobre la SMA con histéresis 0.75% debe devolver HOLD');

    // Precio en 101.0 (1.0% arriba) -> debe ser BUY
    closes[closes.length - 1] = 101.0;
    const signalBuy = evaluateStrategySMA200({ closes }, { smaPeriod: 150, band: 0.0075 });
    assert.equal(signalBuy, 'BUY', '1.0% sobre la SMA con histéresis 0.75% debe devolver BUY');
  });

  it('isCircuitBreakerActive: activa la pausa por Max Drawdown rolling', () => {
    const mockState = {
      balanceUSDC: 4000,
      tradeHistory: [
        { profitUSDC: -200 },
        { profitUSDC: -300 },
        { profitUSDC: -250 },
        { profitUSDC: -150 }
      ]
    };
    // Pérdidas acumuladas = 900 USDC sobre equity de 4000 (~18.3% DD) -> activa circuit breaker (max 12%)
    const active = isCircuitBreakerActive(mockState);
    assert.equal(active, true, 'Circuit Breaker debe estar activo ante un DD > 12%');
    assert.ok(mockState.circuitBreakerPausedUntil, 'Debe fijar el timestamp de pausa');
  });

});

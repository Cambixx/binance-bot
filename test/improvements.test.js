import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  btcCrashGuard,
  btcRegimeOn,
  computeRotationTargets,
  evaluateStrategySMA200
} from '../indicators.js';
import { updateCircuitBreaker, isCircuitBreakerPaused, computePortfolioEquity, portfolioEquityAtCost } from '../shadowTrader.js';
import { aggregateByPosition, bookMetrics, wilsonInterval, truncationCounterfactual } from '../backtestEngine.js';
import { entriesAreFresh } from '../indicators.js';
import { isBlacklisted, DAILY_BASKET } from '../config.js';
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

  // ─────────── Circuit breaker de cartera (reescrito, auditoría 2026-08-29) ───────────
  // La versión anterior no medía drawdown: dividía Σ|pérdidas| de los ≤8 últimos cierres entre
  // la CAJA. Estos tests fijan la semántica correcta y cubren los 4 defectos que tenía.

  it('circuit breaker: dispara con un drawdown REAL sobre el pico de equity', () => {
    const state = { balanceUSDC: 4400, openPositions: {}, tradeHistory: [], equityPeak: 5000 };
    const r = updateCircuitBreaker(state, 4400);
    assert.equal(r.active, true, 'DD del 12% sobre el pico debe activar el breaker');
    assert.ok(Math.abs(r.drawdownPct - 12) < 1e-9, `DD esperado 12%, obtenido ${r.drawdownPct}`);
    assert.ok(state.circuitBreakerPausedUntil, 'Debe fijar el timestamp de pausa');
  });

  it('circuit breaker: NO pausa un canal netamente ganador (defecto: no neteaba ganancias)', () => {
    // P&L neto +1.200 USDC y drawdown CERO. La versión antigua devolvía true.
    const state = {
      balanceUSDC: 5000, openPositions: {}, equityPeak: 5000,
      tradeHistory: [500, 500, 500, 500, -200, -200, -200, -200].map(p => ({ profitUSDC: p })),
    };
    assert.equal(updateCircuitBreaker(state, 5000).active, false,
      'Un canal en beneficio y sin drawdown no puede pausarse');
  });

  it('circuit breaker: el denominador es el EQUITY, no la caja (posiciones abiertas cuentan)', () => {
    // Mismo canal, mismo equity, pero con el capital desplegado en una posición en vez de en caja.
    // Con el denominador antiguo (caja) desplegar capital ACERCABA al disparo; ahora es indiferente.
    const abierto = {
      balanceUSDC: 1000, equityPeak: 5000, tradeHistory: [],
      openPositions: { BTCUSDC: { side: 'long', amount: 1, buyPrice: 4000, investedUSDC: 4000, timestamp: new Date().toISOString() } },
    };
    assert.equal(portfolioEquityAtCost(abierto), 5000, 'equity a coste = caja + invertido');
    assert.equal(computePortfolioEquity(abierto, { BTCUSDC: 4000 }), 5000, 'equity a mercado = caja + valor');
    assert.equal(updateCircuitBreaker(abierto, computePortfolioEquity(abierto, { BTCUSDC: 4000 })).active, false,
      'Sin caída de equity no hay drawdown, esté el capital en caja o desplegado');
  });

  it('circuit breaker: NO queda inerte con caja 0 (defecto del guard equity > 0)', () => {
    // El canal ROT opera al 100% invertido con caja 0,00: la versión antigua nunca disparaba.
    const rot = {
      balanceUSDC: 0, equityPeak: 10000, tradeHistory: [],
      openPositions: { AAAUSDC: { side: 'long', amount: 10, buyPrice: 1000, investedUSDC: 10000, timestamp: new Date().toISOString() } },
    };
    const r = updateCircuitBreaker(rot, computePortfolioEquity(rot, { AAAUSDC: 600 }));
    assert.equal(r.active, true, 'Con caja 0 y equity hundido el breaker DEBE disparar');
  });

  it('circuit breaker: histéresis — una pausa expirada no se re-arma en bucle', () => {
    const pausado = {
      balanceUSDC: 4400, openPositions: {}, tradeHistory: [], equityPeak: 5000,
      circuitBreakerPausedUntil: new Date(Date.now() - 1000).toISOString(),
    };
    const r = updateCircuitBreaker(pausado, 4400);
    assert.equal(r.active, false, 'Tras cumplir la pausa debe poder volver a operar');
    assert.equal(r.reason, 'histeresis', 'y quedar en histéresis, no re-armado otras pauseHours');

    // Al recuperarse por debajo del 80% del umbral, la pausa se limpia y el breaker se re-arma.
    const recuperado = { ...pausado, balanceUSDC: 4750 };
    updateCircuitBreaker(recuperado, 4750);
    assert.equal(recuperado.circuitBreakerPausedUntil, null, 'Recuperado: pausa limpiada');
  });

  it('circuit breaker: isCircuitBreakerPaused es PURO (no muta el estado)', () => {
    const state = { balanceUSDC: 100, openPositions: {}, tradeHistory: [], equityPeak: 5000 };
    const antes = JSON.stringify(state);
    isCircuitBreakerPaused(state);
    assert.equal(JSON.stringify(state), antes, 'El predicado no puede escribir en el estado');
  });

  it('circuit breaker: siembra el pico con el capital inicial si el estado no lo trae', () => {
    // Canal preexistente al fix: sin equityPeak, el pico NO puede arrancar en el equity actual
    // (reportaría DD 0% ignorando la caída que ya lleva).
    const state = { balanceUSDC: 4300, openPositions: {}, tradeHistory: [] };
    const r = updateCircuitBreaker(state, 4300);
    assert.equal(r.peak, 5000, 'El pico debe sembrarse con INITIAL_BALANCE');
    assert.ok(r.drawdownPct > 13, 'y reportar el DD real desde el inicio');
  });


  // ─────────── Universo: blacklist anclada al activo base (H6) ───────────

  it('isBlacklisted: no excluye activos cuyo ticker contiene una stablecoin', () => {
    // 'DOTUSDC'.includes('TUSD') era true → DOT llevaba meses sin operarse en vivo.
    for (const s of ['DOTUSDC', 'BNBUSDC', 'APTUSDC', 'ARBUSDC', 'SHIBUSDC']) {
      assert.equal(isBlacklisted(s), false, `${s} no debe estar en la blacklist`);
    }
    assert.equal(DAILY_BASKET.filter((s) => !isBlacklisted(s)).length, DAILY_BASKET.length,
      'La cesta declarada y la operada deben tener el MISMO tamaño');
  });

  it('isBlacklisted: sigue excluyendo stablecoins y activos vetados de verdad', () => {
    for (const s of ['TUSDUSDC', 'BUSDUSDC', 'FDUSDUSDC', 'DAIUSDC', 'EURUSDC', 'USTCUSDC',
                     'ADAUSDC', 'DOGEUSDC', 'PEPEUSDC', 'TAOUSDC', 'ZECUSDC', 'BCHUSDC']) {
      assert.equal(isBlacklisted(s), true, `${s} SÍ debe estar en la blacklist`);
    }
  });

  // ─────────── Contabilidad por posición (A1): la trampa del win rate ───────────

  it('aggregateByPosition: una posición con parcial ganador + cierre perdedor es UN trade perdedor', () => {
    const ejecuciones = [
      { symbol: 'BTCUSDC', side: 'long', buyTime: '2026-01-01T00:00:00.000Z', sellTime: '2026-01-05T00:00:00.000Z', profit: 50, invested: 500, reason: 'PARTIAL_TP' },
      { symbol: 'BTCUSDC', side: 'long', buyTime: '2026-01-01T00:00:00.000Z', sellTime: '2026-01-09T00:00:00.000Z', profit: -120, invested: 500, reason: 'TRAILING_STOP' },
    ];
    const pos = aggregateByPosition(ejecuciones);
    assert.equal(pos.length, 1, 'Dos ejecuciones de la MISMA posición son un solo resultado');
    assert.equal(pos[0].profit, -70, 'El P&L es la suma de los tramos');
    assert.equal(pos[0].reason, 'TRAILING_STOP', 'Hereda el motivo del cierre final');
    const m = bookMetrics(pos);
    assert.equal(m.trades, 1);
    assert.equal(m.winRate, 0, 'La posición perdió: win rate 0%, no 50%');
  });

  it('bookMetrics: el win rate de breakeven y el margen son la cifra de decisión', () => {
    // payoff 3:1 → breakeven 25%. Con WR 50% el margen es +25 pp.
    const pos = [
      { symbol: 'A', buyTime: '2026-01-01', profit: 300, invested: 1000, reason: 'SIGNAL' },
      { symbol: 'B', buyTime: '2026-01-02', profit: -100, invested: 1000, reason: 'SIGNAL' },
    ];
    const m = bookMetrics(pos);
    assert.equal(m.payoff, 3);
    assert.equal(m.breakevenWR, 25);
    assert.equal(m.marginPP, 25);
  });

  it('bookMetrics: N efectivo cuenta FECHAS de entrada, no trades', () => {
    // El caso real: 7 cortos abiertos el MISMO día no son 7 apuestas.
    const mismoDia = Array.from({ length: 7 }, (_, i) => ({
      symbol: `S${i}`, buyTime: '2026-07-24T12:33:42.171Z', profit: -50, invested: 500, reason: 'SIGNAL',
    }));
    assert.equal(bookMetrics(mismoDia).nEffective, 1, '7 trades del mismo día = 1 apuesta efectiva');
  });

  it('wilsonInterval: 0 de 7 NO excluye una win rate del 35%', () => {
    const w = wilsonInterval(0, 7);
    assert.equal(w.low, 0);
    assert.ok(w.high > 35.35, `Wilson(0/7) alto = ${w.high}% debe contener el 35,35% del backtest`);
  });

  it('truncationCounterfactual: un take-profit temprano destruye la esperanza', () => {
    // Trend-following: la cola derecha sostiene el resultado.
    const pos = [
      { symbol: 'A', buyTime: 'T', profit: 900, invested: 1000, reason: 'SIGNAL' },  // +90%
      { symbol: 'B', buyTime: 'T', profit: -150, invested: 1000, reason: 'SIGNAL' },
      { symbol: 'C', buyTime: 'T', profit: -150, invested: 1000, reason: 'SIGNAL' },
      { symbol: 'D', buyTime: 'T', profit: -150, invested: 1000, reason: 'SIGNAL' },
    ];
    const base = pos.reduce((s, t) => s + t.profit, 0);
    const tp20 = truncationCounterfactual(pos, 20);
    assert.equal(base, 450, 'base positiva');
    assert.ok(tp20.netProfit < 0, `Truncar al 20% convierte +${base} en ${tp20.netProfit}`);
    assert.equal(tp20.truncatedTrades, 1);
  });

  // ─────────── Guarda de frescura (H8) ───────────

  it('entriesAreFresh: veta entradas al cierre de una vela rancia, y hace fail-open sin datos', () => {
    const now = Date.parse('2026-08-29T04:00:00Z');
    const velas = (closeTime) => [{ closeTime: closeTime - 86400000 }, { closeTime }, { closeTime: closeTime + 86400000 }];
    assert.equal(entriesAreFresh(velas(now - 4 * 3600000), 6, now), true, '4h: fresco');
    assert.equal(entriesAreFresh(velas(now - 12 * 3600000), 6, now), false, '12h: rancio');
    assert.equal(entriesAreFresh([], 6, now), true, 'sin datos: fail-open');
    assert.equal(entriesAreFresh(null, 6, now), true, 'null: fail-open');
  });

});
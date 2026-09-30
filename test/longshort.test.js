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
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  const pos = s.state.openPositions['BTCUSDC'];
  assert.equal(pos.side, 'short');
  assert.equal(s.state.balanceUSDC, 4000);          // 20% reservado como margen
  assert.equal(pos.investedUSDC, 1000);
  assert.ok(Math.abs(pos.amount - 10) < 1e-9);       // 1000/100
});

test('corto GANA cuando el precio baja (neto de costes)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
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
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  t.applySell(s, 'BTCUSDC', 120, 'SIGNAL'); // cubre 20% arriba
  const tr = s.state.tradeHistory[0];
  assert.ok(tr.profitUSDC < 0, `debería perder, profit=${tr.profitUSDC}`);
  assert.ok(s.state.balanceUSDC < 5000);
});

test('corto plano pierde ~round-trip (≈0.30%)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  t.applySell(s, 'BTCUSDC', 100, 'SIGNAL'); // cubre al mismo precio
  const tr = s.state.tradeHistory[0];
  const expectedPct = -2 * (COSTS.feePct + COSTS.slippagePct) * 100; // ≈ -0.30%
  assert.ok(Math.abs(tr.profitPercentage - expectedPct) < 0.02, `pct=${tr.profitPercentage} vs ${expectedPct}`);
});

test('corto paga borrow/funding pro-rata a los días abiertos', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  // Backdatear la apertura 10 días para simular un corto mantenido
  s.state.openPositions['BTCUSDC'].timestamp = new Date(Date.now() - 10 * 86400000).toISOString();
  t.applySell(s, 'BTCUSDC', 100, 'SIGNAL'); // cubre al mismo precio
  const tr = s.state.tradeHistory[0];
  const rtPct = -2 * (COSTS.feePct + COSTS.slippagePct) * 100;          // ≈ -0.30%
  const fundingPct = -(COSTS.fundingDailyShort * 10) * 100;             // ≈ -0.30% (10d × 0.03%)
  assert.ok(Math.abs(tr.profitPercentage - (rtPct + fundingPct)) < 0.02,
    `pct=${tr.profitPercentage} vs ${rtPct + fundingPct}`);
});

test('el long-only sigue intacto (side=long, mismo comportamiento)', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyBuy(s, 'ETHUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  assert.equal(s.state.openPositions['ETHUSDC'].side, 'long');
  t.applySell(s, 'ETHUSDC', 110, 'SIGNAL');
  const tr = s.state.tradeHistory[0];
  assert.equal(tr.side, 'long');
  assert.ok(tr.profitUSDC > 0); // +10% menos costes
});

test('getStats side-aware: P&L latente del corto sube cuando baja el precio', async () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
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

test('motor: el funding reduce el P&L de los cortos (y a 0 lo preserva)', async () => {
  const up = Array.from({ length: 220 }, (_, i) => 100 + i);
  const down = Array.from({ length: 80 }, (_, i) => 320 - i * 3);
  const closes = [...up, ...down];
  const mk = (fundingDailyShort) => new BacktestEngine({
    symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, dataBySymbol: { AAAUSDC: makeDaily(closes) }, bufferSize: 260, minCandles: 205,
    regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95, fundingDailyShort,
  });
  const sumShort = (r) => r.trades.filter(t => t.side === 'short').reduce((s, t) => s + t.profit, 0);
  const sinFunding = await mk(0).run();
  const conFunding = await mk(0.001).run(); // 0.1%/día, exagerado para hacer visible el efecto
  assert.ok(sumShort(conFunding) < sumShort(sinFunding),
    `el funding debería reducir el P&L corto: ${sumShort(conFunding)} vs ${sumShort(sinFunding)}`);
});

test('funding reduce el P&L del corto cuanto más se mantiene', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
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
  t.applyShort(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
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

// ───────────────── Cierre manual /cerrar (MANUAL_CLOSE) — 2026-09-05 ─────────────────
// El invariante que protege la medición del MODO SEÑAL: un cierre discrecional mueve la CAJA
// pero NO el marcador de la estrategia. Si contase para winRate/PF, cerrar ganadores a mano
// inflaría justo la métrica que este bot existe para medir.

test('applySell con MANUAL_CLOSE cierra la posición y acredita la caja', () => {
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyBuy(s, 'BTCUSDC', 100, { signalMode: false, sizeFraction: 0.2 });
  const balTrasCompra = s.state.balanceUSDC;
  const ok = t.applySell(s, 'BTCUSDC', 120, 'MANUAL_CLOSE');
  assert.equal(ok, true);
  assert.equal(s.state.openPositions['BTCUSDC'], undefined, 'la posición debe desaparecer');
  assert.equal(s.state.tradeHistory.at(-1).reason, 'MANUAL_CLOSE');
  assert.ok(s.state.balanceUSDC > balTrasCompra, 'la venta acredita la caja');
});

test('MANUAL_CLOSE: fuera del winRate de estrategia, pero REGISTRADO como truncada', async () => {
  const t = new ShadowTrader();
  // Historial: una señal completa perdedora y un cierre manual ganador. Si el manual contase
  // como estrategia, el WR saldría 50%; el correcto es 0% sobre 1 sola señal completa.
  t._loadState = async () => ({
    balanceUSDC: 5100, openPositions: {}, cooldowns: {},
    tradeHistory: [
      { symbol: 'AAAUSDC', reason: 'SIGNAL', profitUSDC: -100 },
      { symbol: 'BBBUSDC', reason: 'MANUAL_CLOSE', profitUSDC: +200 },
    ],
  });
  const s = await t.getStats({});
  // 1) El win rate de la ESTRATEGIA no se contamina.
  assert.equal(s.signalTrades, 1, 'solo la señal completa cuenta como estrategia');
  assert.equal(s.signalWins, 0);
  assert.equal(s.winRate, '0.00%', 'el cierre manual NO puede inflar el win rate');
  // 2) Pero el trabajo del bot SÍ queda registrado, en su propio cajón.
  assert.equal(s.truncatedTrades, 1, 'la entrada la generó el bot: se registra como truncada');
  assert.equal(s.truncatedWins, 1);
  assert.equal(s.truncatedWinRate, '100.00%');
  assert.equal(s.truncatedPnLUSDC, '200.00');
  assert.equal(s.botEntriesClosed, 2, 'ambas entradas las generó el bot');
  // 3) La caja es la caja.
  assert.equal(s.totalTrades, 2);
  assert.equal(s.realizedPnLUSDC, '100.00', '+200 −100 = +100');
});

test('MANUAL_CLEANUP (mantenimiento) NO se registra como trabajo del bot; MANUAL_CLOSE sí', async () => {
  // Es la distinción que motivó el refinamiento: antes ambos caían en el mismo saco.
  const t = new ShadowTrader();
  t._loadState = async () => ({
    balanceUSDC: 5000, openPositions: {}, cooldowns: {},
    tradeHistory: [
      { symbol: 'AAAUSDC', reason: 'MANUAL_CLOSE', profitUSDC: +50 },
      { symbol: 'BBBUSDC', reason: 'MANUAL_CLEANUP', profitUSDC: +50 },
    ],
  });
  const s = await t.getStats({});
  assert.equal(s.truncatedTrades, 1, 'solo el cierre manual del dueño es una señal truncada');
  assert.equal(s.signalTrades, 0, 'ninguna de las dos es una señal completa');
  assert.equal(s.botEntriesClosed, 1, 'la limpieza no acredita trabajo del bot');
  assert.equal(s.realizedPnLUSDC, '100.00', 'las dos mueven la caja igualmente');
});

// ───────────────────── Auditoría 2026-09-29: reentrada tras Chandelier y gate BTC de cortos ─────────────────────
// Bajada → rebote que dispara el Chandelier → nueva bajada, todo MUY por debajo de la SMA150 (la
// señal sigue en SELL de principio a fin). Aísla qué pasa después del TRAILING_STOP.
function trailThenFallAgain() {
  const down = Array.from({ length: 230 }, (_, i) => 300 - i);     // 300→71
  const bounce = Array.from({ length: 8 }, (_, i) => 71 + i * 4);   // rebote → TRAILING_STOP
  const fall = Array.from({ length: 30 }, (_, i) => 99 - i);        // vuelve a caer, aún bajo la SMA
  return { AAAUSDC: makeDaily([...down, ...bounce, ...fall]) };
}
const trailOpts = (extra) => ({
  symbols: ['AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
  longShort: true, shortStopPct: 0.25, shortTrailAtr: 3.0, shortEntry: {},
  dataBySymbol: trailThenFallAgain(), bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150 },
  oosSplitRatio: 0.95, ...extra,
});

test('shortTrailReentry default (immediate): tras el Chandelier re-shortea con la señal aún en SELL', async () => {
  const r = await new BacktestEngine(trailOpts({})).run();
  const shorts = r.trades.filter(t => t.side === 'short');
  assert.ok(shorts.some(t => t.reason === 'TRAILING_STOP'), 'el Chandelier debe disparar');
  assert.ok(shorts.length >= 2, 'comportamiento histórico: vuelve a abrir corto tras el trail');
});

test('shortTrailReentry flat: tras el Chandelier NO re-shortea hasta que la señal salga de SELL', async () => {
  const r = await new BacktestEngine(trailOpts({ shortTrailReentry: 'flat' })).run();
  const shorts = r.trades.filter(t => t.side === 'short');
  assert.equal(shorts.length, 1, 'un solo corto: el trail deja el símbolo en FLAT');
  assert.equal(shorts[0].reason, 'TRAILING_STOP');
});

test('shortBtcGate: el gate BTC sobre cortos se puede aislar del gate de largos', async () => {
  // BTC en tendencia alcista (risk-on) y una alt en bajista. Con el gate de cortos activo (default)
  // la alt NO se shortea; con shortBtcGate:false sí, manteniendo el gate de largos intacto.
  const btc = Array.from({ length: 260 }, (_, i) => 100 + i);
  const alt = Array.from({ length: 260 }, (_, i) => 400 - i);
  const base = {
    symbols: ['BTCUSDC', 'AAAUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    longShort: true, shortTrailAtr: 0, shortEntry: {}, btcGateLong: { smaPeriod: 200 },
    dataBySymbol: { BTCUSDC: makeDaily(btc), AAAUSDC: makeDaily(alt) },
    bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150 }, oosSplitRatio: 0.95,
  };
  const on = await new BacktestEngine(base).run();
  const off = await new BacktestEngine({ ...base, shortBtcGate: false }).run();
  const altShorts = (r) => r.trades.filter(t => t.symbol === 'AAAUSDC' && t.side === 'short').length;
  assert.equal(altShorts(on), 0, 'BTC risk-on bloquea el corto de la alt (comportamiento actual)');
  assert.ok(altShorts(off) >= 1, 'sin el gate de cortos, la alt se shortea');
});

// ───────────────────── Auditoría 2026-09-29: guarda de misma vela, funding real, niveles ─────────────────────
test('exitedOnSameCandle: bloquea la reentrada en la vela de la salida y la libera en la siguiente', async () => {
  const { exitedOnSameCandle } = await import('../indicators.js');
  const DAY = 86400000, T = 1790553600000;
  const last = { ETHUSDC: T };
  assert.equal(exitedOnSameCandle(last, 'ETHUSDC', T), true, 'mismo cron, misma vela → bloqueado');
  assert.equal(exitedOnSameCandle(last, 'ETHUSDC', T - DAY), true, 'una vela anterior también');
  assert.equal(exitedOnSameCandle(last, 'ETHUSDC', T + DAY), false, 'vela siguiente → libre (como el motor)');
  assert.equal(exitedOnSameCandle(last, 'SOLUSDC', T), false, 'otro símbolo no se ve afectado');
  assert.equal(exitedOnSameCandle({}, 'ETHUSDC', T), false);
  assert.equal(exitedOnSameCandle(undefined, 'ETHUSDC', T), false);
});

test('applySell corto: fundingCostUSDC inyectado sustituye al modelo plano; negativo = el corto cobra', () => {
  const t = new ShadowTrader();
  const mk = () => { const s = fakeSession(5000); t.applyShort(s, 'ETHUSDC', 2000, { signalMode: false, sizeFraction: 0.2 }); return s; };
  const flat = mk(), paid = mk(), earned = mk();
  t.applySell(flat, 'ETHUSDC', 2000, 'SIGNAL');
  t.applySell(paid, 'ETHUSDC', 2000, 'SIGNAL', { fundingCostUSDC: 10 });
  t.applySell(earned, 'ETHUSDC', 2000, 'SIGNAL', { fundingCostUSDC: -10 });
  const pnl = (s) => s.state.tradeHistory[0].profitUSDC;
  assert.ok(Math.abs((pnl(earned) - pnl(paid)) - 20) < 1e-6, 'la diferencia entre cobrar 10 y pagar 10 son 20 USDC');
  assert.ok(pnl(paid) < pnl(flat) || Math.abs(pnl(paid) - pnl(flat)) < 10.5, 'el override manda sobre el plano');
});

test('applyShort: el mensaje da el stop duro y el Chandelier reales, no "sin TP/SL fijo"', async () => {
  const { LONGSHORT } = await import('../config.js');
  const t = new ShadowTrader();
  const s = fakeSession(5000);
  t.applyShort(s, 'ETHUSDC', 2000, { signalMode: false, sizeFraction: 0.2, smaPeriod: 150, atr: 60 });
  const msg = s.notifications[0];
  assert.doesNotMatch(msg, /sin TP\/SL fijo/);
  assert.match(msg, /Stop duro/);
  assert.ok(msg.includes((2000 * (1 + LONGSHORT.shortStopPct)).toFixed(4)), 'nivel del stop duro');
  assert.match(msg, /Chandelier/);
  assert.ok(msg.includes((2000 + LONGSHORT.shortTrailAtr * 60).toFixed(4)), 'nivel inicial del Chandelier');
});

test('motor: con el mismo timestamp, un símbolo listado ANTES que BTC ya ve el cierre de HOY en el gate BTC', async () => {
  // La alt da BUY justo el último día; BTC pierde su SMA200 (y dispara el crash guard) ese mismo día.
  // Antes, la alt (primera en el array) leía el buffer de BTC de AYER (risk-on) y abría largo.
  const alt = [...Array.from({ length: 259 }, () => 100), 105];
  const btc = [...Array.from({ length: 259 }, (_, i) => 100 + i), 50];
  const engine = new BacktestEngine({
    symbols: ['AAAUSDC', 'BTCUSDC'], interval: '1d', strategyVersion: 'SMA200', exitMode: 'signal',
    btcGateLong: { smaPeriod: 200 }, dataBySymbol: { AAAUSDC: makeDaily(alt), BTCUSDC: makeDaily(btc) },
    bufferSize: 260, minCandles: 205, regimeOpts: { smaPeriod: 150, band: 0 }, oosSplitRatio: 0.95,
  });
  const r = await engine.run();
  assert.equal(r.trades.filter(t => t.symbol === 'AAAUSDC').length, 0, 'BTC risk-off hoy debe bloquear el largo de la alt');
});

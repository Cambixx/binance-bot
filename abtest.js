/**
 * abtest.js — Torneo de VARIANTES vs baseline con walk-forward pareado (research 2026-07 #2).
 *
 * Descarga los datos UNA sola vez y corre cada variante por los MISMOS folds → comparación pareada
 * justa. Aplica el gate de adopción: una variante se ADOPTA solo si Calmar mediano ≥ baseline,
 * IQR de Calmar ≤ baseline (menos dependencia de régimen) y el peor fold no empeora.
 *
 * Uso:  node abtest.js [--months=42] [--folds=8] [--symbols=A,B,...]
 * Edita VARIANTS para definir el torneo (patrón sweep.js). Cada `opts` se mergea sobre el baseline.
 */
import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import binance from './binanceService.js';
import { runWalkForward, lsBaseEngineOpts } from './wfcore.js';
import { isBlacklisted, BLACKLIST, VOLTARGET } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };
const MONTHS = getNum('--months=', 42);
const FOLDS = getNum('--folds=', 8);
let SYMBOLS = getStr('--symbols=', '') ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
SYMBOLS = SYMBOLS.filter(s => !isBlacklisted(s));

// ─────────── TORNEO: baseline + variantes (opts = overrides del engine sobre lsBaseEngineOpts) ───────────
// El baseline SIEMPRE va primero. Edita esta lista para cada experimento.
// TORNEO research 2026-07-10 (búsqueda de ROI, parámetros fijados a priori — no barrer fino):
//  - PYR:  piramidación Turtle en largos (tranche extra al confirmar +10%, máx 2 añadidos).
//  - TILT: sizing continuo tipo Carver al abrir (fuerza de tendencia en unidades de σ).
//  - GATE: gate maestro BTC>SMA200 para largos nuevos (investigación §2.2, aún sin cablear).
// --longonly corre el mismo torneo sobre el canal long-only (SMA150-1d, canal del usuario).
const LONG_ONLY = args.includes('--longonly');
// Meseta del gate BTC con buffer amplio (310) para que TODAS las SMAs sean computables;
// el baseline usa el MISMO buffer para que la comparación pareada sea justa.
const BUF = { bufferSize: 310 };

// ⚠️ El baseline declara btcGateLong EXPLÍCITAMENTE. Sin esto, `backtestEngine` lo rellena desde
// `config.REGIME` y un torneo sobre el gate se compararía CONSIGO MISMO (auditoría 2026-08-29).
const BASE_GATE = { btcGateLong: { smaPeriod: 200 } };

// Torneos disponibles (--tournament=). Parámetros fijados A PRIORI: se declara la rejilla ENTERA
// antes de correr y se archiva el resultado de TODOS los valores, pasen o no (evita el sesgo de
// reportar solo el ganador). Regla de la casa: meseta, no pico.
const TOURNAMENTS = {
  // κ — presupuesto de riesgo del corto. Es la palanca principal: no añade grados de libertad,
  // el parámetro ya existe (config.LONGSHORT.shortRiskFraction).
  kappa: [
    { name: 'baseline k=1.00', opts: { ...BUF, ...BASE_GATE } },
    { name: 'KAPPA 0.60', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.60 } },
    { name: 'KAPPA 0.40', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.40 } },
    { name: 'KAPPA 0.25', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.25 } },
    { name: 'KAPPA 0.15', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.15 } },
    { name: 'KAPPA 0.00 (long-only)', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.0 } },
  ],
  // Base de dimensionamiento (H1): 'equity' quita la escalera geométrica y hace alcanzable el cap.
  sizing: [
    { name: 'baseline cash', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'cash' } },
    { name: 'EQUITY basis', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equity' } },
    { name: 'EQUITY + cap 0.60', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equity', maxExposurePct: 0.60 } },
    { name: 'EQUITY + cap 0.50', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equity', maxExposurePct: 0.50 } },
  ],
  // Gate Donchian de horizonte lento SOLO en largos (única vía honesta al win rate).
  donchian: [
    { name: 'baseline', opts: { ...BUF, ...BASE_GATE } },
    { name: 'DONCHIAN 60d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 60 } } },
    { name: 'DONCHIAN 90d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 90 } } },
    { name: 'DONCHIAN 150d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 150 } } },
  ],
  // El circuit breaker se añadió al live SIN pasar por aquí: se mide su efecto real.
  circuitbreaker: [
    { name: 'baseline SIN cb', opts: { ...BUF, ...BASE_GATE, portfolioCircuitBreaker: null } },
    { name: 'CB 12% / 48h', opts: { ...BUF, ...BASE_GATE } },
  ],
  // Archivo del rechazo con datos propios: el parcial que "sube el win rate".
  partial: [
    { name: 'baseline sin parcial', opts: { ...BUF, ...BASE_GATE, exitMode: 'atr' } },
    { name: 'PARTIAL 2R', opts: { ...BUF, ...BASE_GATE, exitMode: 'atr', partialExitAtR: 2.0 } },
  ],
};
const TOURNAMENT = getStr('--tournament=', 'kappa');
const VARIANTS = TOURNAMENTS[TOURNAMENT];
if (!VARIANTS) { console.error(`Torneo desconocido: ${TOURNAMENT}. Opciones: ${Object.keys(TOURNAMENTS).join(', ')}`); process.exit(1); }

function pad(v, n) { return String(v ?? '—').padEnd(n); }

async function main() {
  console.error(`\n🔬 ABTEST [${TOURNAMENT}] — ${MONTHS}m · ${FOLDS} folds · ${LONG_ONLY ? 'LONG-ONLY' : 'LONG/SHORT'} · ${VARIANTS.length} variantes`);
  console.error(`   ${SYMBOLS.join(', ')}`);
  console.error('📥 Descargando datos (una vez)...');
  const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval: '1d' });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const dataBySymbol = {};
  for (const s of fetcher.symbols) dataBySymbol[s] = await fetcher.fetchHistoricalData(s);

  // Prefetch del funding real UNA vez (todas las variantes LS lo comparten).
  let tMin = Infinity, tMax = -Infinity;
  for (const s in dataBySymbol) for (const k of dataBySymbol[s]) { if (k.time < tMin) tMin = k.time; if (k.time > tMax) tMax = k.time; }
  console.error('💱 Descargando funding real...');
  const fundingSeries = await binance.getFundingCumSeries([...fetcher.symbols], tMin, tMax + 86400000);

  const results = [];
  for (const v of VARIANTS) {
    // --longonly: mismo stack pero sin la pata corta (canal SMA150-1d del usuario).
    const modeExtra = LONG_ONLY ? { longShort: false } : {};
    const engineOpts = lsBaseEngineOpts({ months: MONTHS, fundingSeries, ...modeExtra, ...v.opts });
    const { rows, summary } = await runWalkForward(dataBySymbol, { folds: FOLDS, engineOpts });
    results.push({ ...v, rows, summary });
    console.error(`   ✓ ${v.name}`);
  }

  const base = results[0].summary;
  console.error('\n══════════════════ RESULTADOS (holdout por fold) ══════════════════');
  console.error(pad('VARIANTE', 26) + pad('nFolds', 7) + pad('CalmarMed', 11) + pad('IQR', 7) + pad('Peor', 7) + pad('SharpeMed', 10) + pad('ROIMed', 8) + 'GATE');
  console.error('─'.repeat(92));
  for (const r of results) {
    const s = r.summary;
    let gate = '— (baseline)';
    if (r !== results[0]) {
      // Comparación a 2 decimales enteros (H9): `3.49 <= 3.48 + 0.01` es FALSE en coma flotante,
      // lo que hacía suspender variantes por un empate exacto (ya pasó con el gate BTC).
      const c2 = (v) => v == null ? null : Math.round(v * 100);
      // H7: dos variantes solo son comparables si evaluaron los MISMOS folds. Si una se fue a
      // cash y su fold desapareció del resumen, el "pareado" no lo es.
      const passPaired = s.valid === base.valid;
      const passCalmar = s.medianCalmar != null && base.medianCalmar != null && c2(s.medianCalmar) >= c2(base.medianCalmar);
      const passIqr = s.iqrCalmar != null && base.iqrCalmar != null && c2(s.iqrCalmar) <= c2(base.iqrCalmar);
      const passWorst = s.worstCalmar != null && base.worstCalmar != null && c2(s.worstCalmar) >= c2(base.worstCalmar);
      gate = (passPaired && passCalmar && passIqr && passWorst) ? '✅ ADOPTAR' :
             `🔻 (${[!passPaired && 'folds≠', !passCalmar && 'Calmar<', !passIqr && 'IQR↑', !passWorst && 'peor↓'].filter(Boolean).join(' ')})`;
    }
    console.error(
      pad(r.name, 26) + pad(s.valid, 7) + pad(s.medianCalmar, 11) + pad(s.iqrCalmar, 7) +
      pad(s.worstCalmar, 7) + pad(s.medianSharpe, 10) + pad(s.medianROI, 8) + gate
    );
  }
  console.error('\nGate: Calmar mediano ≥ baseline, IQR ≤ baseline, y peor fold no peor. Comparación pareada (mismos folds/datos).');

  const quote = SYMBOLS[0] && SYMBOLS[0].endsWith('USDT') ? 'usdt' : 'usdc';
  const out = `abtest-${TOURNAMENT}-${quote}${LONG_ONLY ? '-longonly' : ''}.json`;
  fs.writeFileSync(out, JSON.stringify({ tournament: TOURNAMENT, months: MONTHS, folds: FOLDS, longOnly: LONG_ONLY, symbols: SYMBOLS, results }, null, 2));
  console.error(`📄 Detalle en ${out}`);
}

main();

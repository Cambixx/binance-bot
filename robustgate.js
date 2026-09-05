/**
 * robustgate.js — Gate de adopción ROBUSTO (auditoría 2026-08-29).
 *
 * ⚠️ POR QUÉ EXISTE. El gate de `abtest.js` compara TRES estadísticos puntuales (Calmar mediano,
 * IQR, peor fold) de UNA sola ejecución por variante. Medido en esta auditoría, ese procedimiento
 * no puede sostener sus propias decisiones:
 *
 *   · Reordenar el array de símbolos —sin tocar NADA más— mueve el Calmar mediano del baseline
 *     entre 2,07 y 2,84: **0,77 de ruido puro**. El gate maestro BTC, hoy en producción, se
 *     adoptó con un margen de +0,82. Las decisiones históricas están en la banda de ruido.
 *   · Con 7 folds, el IQR es un estadístico de cola calculado sobre ~7 puntos: la métrica más
 *     inestable de las tres, y la que más veces ha suspendido variantes.
 *
 * QUÉ HACE DISTINTO:
 *   1. **Permutaciones**: corre cada variante bajo K órdenes de símbolos distintos, así que el
 *      ruido de ordenación entra en la medición en vez de contaminarla en silencio.
 *   2. **Pareado de verdad**: compara variante y baseline en el MISMO (permutación, fold).
 *   3. **Bootstrap por CLÚSTER de fold**: remuestrea folds enteros (con todas sus permutaciones
 *      juntas), porque las permutaciones de un mismo fold NO son observaciones independientes.
 *      Devuelve P(mejora media > 0) en vez de un sí/no sobre un estadístico puntual.
 *   4. **Criterio de adopción**: P ≥ 0,80 Y el peor fold (peor caso sobre TODAS las permutaciones)
 *      no empeora. El IQR se REPORTA pero ya no veta: con esta muestra no es estimable de forma
 *      fiable, y usarlo como criterio duro es lo que suspendía variantes por ruido.
 *
 * Uso:  node robustgate.js [--tournament=kappa] [--perms=5] [--months=42] [--folds=8]
 *                          [--symbols=A,B,...] [--longonly] [--seed=42]
 */
import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import binance from './binanceService.js';
import { runWalkForward, lsBaseEngineOpts } from './wfcore.js';
import { isBlacklisted } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };

const MONTHS = getNum('--months=', 42);
const FOLDS = getNum('--folds=', 8);
const PERMS = getNum('--perms=', 5);
const BOOT = getNum('--boot=', 5000);
const SEED = getNum('--seed=', 42);
const LONG_ONLY = args.includes('--longonly');
const TOURNAMENT = getStr('--tournament=', 'kappa');

let SYMBOLS = (getStr('--symbols=', '') ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'])
  .filter(s => !isBlacklisted(s));

const BUF = { bufferSize: 310 };
const BASE_GATE = { btcGateLong: { smaPeriod: 200 } };

const TOURNAMENTS = {
  kappa: [
    { name: 'baseline k=1.00', opts: { ...BUF, ...BASE_GATE } },
    { name: 'KAPPA 0.60', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.60 } },
    { name: 'KAPPA 0.40', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.40 } },
    { name: 'KAPPA 0.25', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.25 } },
    { name: 'KAPPA 0.15', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.15 } },
    { name: 'KAPPA 0.00', opts: { ...BUF, ...BASE_GATE, shortRiskFraction: 0.0 } },
  ],
  donchian: [
    { name: 'baseline', opts: { ...BUF, ...BASE_GATE } },
    { name: 'DONCHIAN 60d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 60 } } },
    { name: 'DONCHIAN 90d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 90 } } },
    { name: 'DONCHIAN 150d', opts: { ...BUF, ...BASE_GATE, donchianLongGate: { lookbackDays: 150 } } },
  ],
  btcgate: [
    { name: 'baseline SIN gate', opts: { ...BUF, btcGateLong: null } },
    { name: 'GATE btc>sma200', opts: { ...BUF, btcGateLong: { smaPeriod: 200 } } },
    { name: 'GATE btc>sma250', opts: { ...BUF, btcGateLong: { smaPeriod: 250 } } },
  ],
  // Dirección INVERSA del test anterior: el baseline es la PRODUCCIÓN ACTUAL (gate ON) y la
  // variante es quitarlo. Importa porque P(Δ>0) no es simétrico y la pregunta operativa real es
  // "¿quitar el gate que ya está vivo mejora?", no "¿añadirlo mejoraría?".
  btcgate_off: [
    { name: 'baseline PRODUCCIÓN (gate on)', opts: { ...BUF, btcGateLong: { smaPeriod: 200 } } },
    { name: 'QUITAR el gate BTC', opts: { ...BUF, btcGateLong: null } },
  ],
  // Base de dimensionamiento. 'equalN' reparte equity/plazas: es el único de los tres modos
  // genuinamente independiente del orden del array (ver backtestEngine.sizingBase).
  sizing: [
    { name: 'baseline cash', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'cash' } },
    { name: 'EQUAL-N (equity/8)', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equalN' } },
    { name: 'EQUAL-N 6 plazas', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equalN', positionSlots: 6 } },
    { name: 'EQUAL-N 5 plazas', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equalN', positionSlots: 5 } },
    { name: 'EQUITY basis (20%)', opts: { ...BUF, ...BASE_GATE, sizeBasis: 'equity' } },
  ],
  // Stop de CATÁSTROFE del largo en modo régimen. REJILLA PRE-REGISTRADA (2026-09-05) antes de
  // correr nada. Hipótesis: en `exitMode:'signal'` la única salida del largo es el cruce (laggy)
  // de la SMA150, así que el recorrido pico→SMA no está acotado; un backstop lejano debería
  // recortar el peor fold sin tocar la mediana (si toca la mediana, está cortando tendencias
  // sanas y no es un backstop). Predicción declarada: mejora `worstFold`, Δ media ≈ 0 y por
  // tanto P(Δ>0) < 0,80 → NO adoptable bajo el criterio vigente. Se mide para cuantificarlo,
  // no para adoptarlo por sorpresa. Cooldown 5d, igual que el del corto.
  longstop: [
    { name: 'baseline SIN stop largo', opts: { ...BUF, ...BASE_GATE } },
    { name: 'LONGSTOP 30%', opts: { ...BUF, ...BASE_GATE, longStopPct: 0.30, longStopCooldown: 5 } },
    { name: 'LONGSTOP 25%', opts: { ...BUF, ...BASE_GATE, longStopPct: 0.25, longStopCooldown: 5 } },
    { name: 'LONGSTOP 20%', opts: { ...BUF, ...BASE_GATE, longStopPct: 0.20, longStopCooldown: 5 } },
    { name: 'LONGSTOP 15%', opts: { ...BUF, ...BASE_GATE, longStopPct: 0.15, longStopCooldown: 5 } },
  ],
  circuitbreaker: [
    { name: 'baseline SIN cb', opts: { ...BUF, ...BASE_GATE, portfolioCircuitBreaker: null } },
    { name: 'CB 12% / 48h', opts: { ...BUF, ...BASE_GATE } },
  ],
};
const VARIANTS = TOURNAMENTS[TOURNAMENT];
if (!VARIANTS) { console.error(`Torneo desconocido: ${TOURNAMENT}. Opciones: ${Object.keys(TOURNAMENTS).join(', ')}`); process.exit(1); }

// PRNG determinista (sin Math.random: el resultado debe ser reproducible y auditable).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** K permutaciones deterministas del orden de símbolos (la 1ª siempre es la identidad). */
function buildPermutations(symbols, k, rnd) {
  const out = [symbols.slice()];
  const seen = new Set([symbols.join(',')]);
  let guard = 0;
  while (out.length < k && guard++ < 200) {
    const p = symbols.slice();
    for (let i = p.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    const key = p.join(',');
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quant = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

/**
 * Bootstrap por CLÚSTER DE FOLD sobre los deltas pareados.
 * Se remuestrean FOLDS enteros (arrastrando todas sus permutaciones), porque las permutaciones de
 * un mismo fold comparten datos y no son independientes. Tratarlas como independientes inflaría
 * artificialmente la confianza — exactamente el error que este arnés viene a evitar.
 */
function clusterBootstrap(deltasByFold, iters, rnd) {
  const folds = Object.keys(deltasByFold);
  if (folds.length === 0) return { p: null, meanDelta: null, ci: [null, null] };
  const all = folds.flatMap(f => deltasByFold[f]);
  const meanDelta = all.reduce((s, v) => s + v, 0) / all.length;
  let wins = 0; const means = [];
  for (let b = 0; b < iters; b++) {
    let sum = 0, n = 0;
    for (let i = 0; i < folds.length; i++) {
      const f = folds[Math.floor(rnd() * folds.length)];
      for (const d of deltasByFold[f]) { sum += d; n++; }
    }
    const m = n > 0 ? sum / n : 0;
    means.push(m);
    if (m > 0) wins++;
  }
  means.sort((a, b) => a - b);
  return {
    p: wins / iters,
    meanDelta,
    ci: [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]],
  };
}

const pad = (v, n) => String(v ?? '—').padEnd(n);
const f2 = (v) => v == null ? '—' : v.toFixed(2);

async function main() {
  const rnd = mulberry32(SEED);
  console.error(`\n🔒 GATE ROBUSTO [${TOURNAMENT}] — ${MONTHS}m · ${FOLDS} folds · ${PERMS} permutaciones · ${LONG_ONLY ? 'LONG-ONLY' : 'LONG/SHORT'}`);
  console.error(`   ${SYMBOLS.join(', ')}`);
  console.error('📥 Descargando datos (una vez)...');

  const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval: '1d' });
  fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
  const data = {};
  for (const s of fetcher.symbols) data[s] = await fetcher.fetchHistoricalData(s);

  let tMin = Infinity, tMax = -Infinity;
  for (const s in data) for (const k of data[s]) { if (k.time < tMin) tMin = k.time; if (k.time > tMax) tMax = k.time; }
  console.error('💱 Descargando funding real...');
  const fundingSeries = await binance.getFundingCumSeries([...fetcher.symbols], tMin, tMax + 86400000);

  const perms = buildPermutations(fetcher.symbols, PERMS, rnd);
  console.error(`🔀 ${perms.length} órdenes de símbolos\n`);

  // calmar[variante][permIdx][fold]
  const results = [];
  for (const v of VARIANTS) {
    const byPerm = [];
    for (let pi = 0; pi < perms.length; pi++) {
      const ordered = {};
      for (const s of perms[pi]) if (data[s]) ordered[s] = data[s];
      const engineOpts = lsBaseEngineOpts({
        months: MONTHS, fundingSeries,
        ...(LONG_ONLY ? { longShort: false } : {}),
        ...v.opts,
      });
      const { rows } = await runWalkForward(ordered, { folds: FOLDS, engineOpts });
      const byFold = {};
      for (const r of rows) if (!r.skipped) byFold[r.fold] = r.calmar ?? 0;
      byPerm.push(byFold);
    }
    results.push({ ...v, byPerm });
    console.error(`   ✓ ${v.name}`);
  }

  const base = results[0];
  const rows = [];
  for (const r of results) {
    const flat = r.byPerm.flatMap(bf => Object.values(bf));
    const row = {
      name: r.name,
      medianCalmar: median(flat),
      iqrCalmar: flat.length >= 4 ? quant(flat, 0.75) - quant(flat, 0.25) : null,
      worstCalmar: flat.length ? Math.min(...flat) : null,
      spreadByOrder: null, p: null, meanDelta: null, ci: [null, null], verdict: '— (baseline)',
    };
    // Dispersión atribuible SOLO al orden: rango del Calmar mediano entre permutaciones.
    const medPerPerm = r.byPerm.map(bf => median(Object.values(bf))).filter(v => v != null);
    row.spreadByOrder = medPerPerm.length ? Math.max(...medPerPerm) - Math.min(...medPerPerm) : null;

    if (r !== base) {
      const deltasByFold = {};
      for (let pi = 0; pi < r.byPerm.length; pi++) {
        for (const f of Object.keys(r.byPerm[pi])) {
          const b = base.byPerm[pi]?.[f];
          if (b == null) continue;
          (deltasByFold[f] ||= []).push(r.byPerm[pi][f] - b);
        }
      }
      const bs = clusterBootstrap(deltasByFold, BOOT, rnd);
      row.p = bs.p; row.meanDelta = bs.meanDelta; row.ci = bs.ci;
      const baseWorst = Math.min(...base.byPerm.flatMap(bf => Object.values(bf)));
      const passP = bs.p != null && bs.p >= 0.80;
      const passWorst = row.worstCalmar >= baseWorst - 0.01;
      row.verdict = (passP && passWorst) ? '✅ ADOPTAR'
        : `🔻 (${[!passP && `P=${bs.p?.toFixed(2)}<0.80`, !passWorst && 'peor↓'].filter(Boolean).join(' ')})`;
    }
    rows.push(row);
  }

  console.error('\n═══════════════ GATE ROBUSTO — Calmar sobre TODAS las permutaciones ═══════════════');
  console.error(pad('VARIANTE', 20) + pad('CalmarMed', 11) + pad('IQR', 7) + pad('Peor', 7) + pad('ΔMedia', 9) + pad('IC95%', 18) + pad('P(Δ>0)', 9) + 'VEREDICTO');
  console.error('─'.repeat(104));
  for (const r of rows) {
    console.error(
      pad(r.name, 20) + pad(f2(r.medianCalmar), 11) + pad(f2(r.iqrCalmar), 7) + pad(f2(r.worstCalmar), 7) +
      pad(r.meanDelta == null ? '—' : (r.meanDelta >= 0 ? '+' : '') + f2(r.meanDelta), 9) +
      pad(r.ci[0] == null ? '—' : `[${f2(r.ci[0])}, ${f2(r.ci[1])}]`, 18) +
      pad(r.p == null ? '—' : r.p.toFixed(3), 9) + r.verdict
    );
  }
  console.error(`\nRuido por ORDEN del array en el baseline: ${f2(rows[0].spreadByOrder)} de Calmar mediano.`);
  console.error('Criterio: P(mejora media > 0) ≥ 0,80 por bootstrap de clúster de fold, Y peor fold no peor.');
  console.error('El IQR se reporta pero NO veta: con ~7 folds no es estimable de forma fiable.');

  const out = `robustgate-${TOURNAMENT}-${SYMBOLS[0].endsWith('USDT') ? 'usdt' : 'usdc'}${LONG_ONLY ? '-longonly' : ''}.json`;
  fs.writeFileSync(out, JSON.stringify({
    tournament: TOURNAMENT, months: MONTHS, folds: FOLDS, perms: perms.length, seed: SEED,
    bootstrapIters: BOOT, longOnly: LONG_ONLY, symbols: SYMBOLS, permutations: perms, rows,
    raw: results.map(r => ({ name: r.name, byPerm: r.byPerm })),
  }, null, 2));
  console.error(`📄 ${out}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

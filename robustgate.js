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
import { runWalkForward, lsBaseEngineOpts, CALMAR_CLIP } from './wfcore.js';
import { isBlacklisted, MACRO_OSCILLATOR, SMA_PERIOD, STRATEGY_OPTS, SMA_HYSTERESIS_BAND } from './config.js';

const args = process.argv.slice(2);
const getNum = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? parseFloat(a.split('=')[1]) : d; };
const getStr = (p, d) => { const a = args.find(x => x.startsWith(p)); return a ? a.split('=')[1] : d; };

const MONTHS = getNum('--months=', 42);
const FOLDS = getNum('--folds=', 8);
const PERMS = getNum('--perms=', 5);
const BOOT = getNum('--boot=', 5000);
const SEED = getNum('--seed=', 42);
const LONG_ONLY = args.includes('--longonly');
// Auditoría 2026-09-29 (§20.5): el fold 2 (arranque de la muestra, casi sin drawdown) satura el
// Calmar en el recorte en TODAS las variantes → delta 0 exacto que solo diluye el bootstrap hacia
// cero (sesgo conservador). Se excluye del bootstrap y se informa cuántos pares se descartaron.
// `--keep-saturated` restaura el comportamiento anterior.
const KEEP_SATURATED = args.includes('--keep-saturated');
const TOURNAMENT = getStr('--tournament=', 'kappa');

let SYMBOLS = (getStr('--symbols=', '') ? getStr('--symbols=', '').split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'])
  .filter(s => !isBlacklisted(s));

const BUF = { bufferSize: 310 };
const BASE_GATE = { btcGateLong: { smaPeriod: 200 } };
// Régimen tal y como corre EN VIVO (dailyBot/longShortBot usan SMA_HYSTERESIS_BAND).
const PROD_REGIME = { ...STRATEGY_OPTS, smaPeriod: SMA_PERIOD, band: SMA_HYSTERESIS_BAND };

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
  // ══ ESTRATEGIA MACRO_OSC (V7) — REJILLA PRE-REGISTRADA 2026-09-05, antes de correr nada ══
  // POR QUÉ ESTA CANDIDATA Y NO OTRA: está implementada, testeada y cableada al motor desde el
  // commit `abfa3691`, pero NUNCA medida — no aparece en AUDIT_REPORT.md y no tiene resultados
  // archivados. Además ataca la debilidad que la propia auditoría dejó identificada (§17: el
  // riesgo del diseño actual no es la falta de stop, es el LAG de la SMA150): su salida
  // `isPurpleTakeProfit` corta por sobreextensión del oscilador, muy por delante del cruce.
  //
  // HIPÓTESIS DECLARADA: la salida temprana debería subir el Calmar reduciendo el recorrido
  // pico→SMA. RIESGO CONOCIDO Y DECLARADO: salir antes en un trend-follower suele cortar las
  // colas derechas que SON el edge (medido ya en este repo con Donchian §14.4: WR 19→47 % pero
  // ROI −60 %). PREDICCIÓN: ROI mediano BAJA; el veredicto depende de si el Calmar compensa.
  //
  // CONTROL DE MESETA: se barre purpleZoneThreshold (22/28/34). Si solo el default gana, es un
  // pico y no se adopta aunque pase el gate ("meseta, no pico", regla de la casa).
  //
  // ⚠️ PARIDAD DE ARRANQUE: MACRO_OSC necesita slowPeriod+10=210 velas (y BMSB 147). Se fija el
  // MISMO bufferSize/minCandles a TODAS las variantes, baseline incluida: si el baseline
  // arrancara antes, la comparación mediría fechas de inicio distintas, no estrategias.
  strategy: [
    { name: 'baseline SMA150', opts: { bufferSize: 310, minCandles: 220, ...BASE_GATE } },
    { name: 'MACRO_OSC p28 (def)', opts: { bufferSize: 310, minCandles: 220, ...BASE_GATE,
      strategyVersion: 'MACRO_OSC', regimeOpts: { ...MACRO_OSCILLATOR } } },
    { name: 'MACRO_OSC p22', opts: { bufferSize: 310, minCandles: 220, ...BASE_GATE,
      strategyVersion: 'MACRO_OSC', regimeOpts: { ...MACRO_OSCILLATOR, purpleZoneThreshold: 22.0 } } },
    { name: 'MACRO_OSC p34', opts: { bufferSize: 310, minCandles: 220, ...BASE_GATE,
      strategyVersion: 'MACRO_OSC', regimeOpts: { ...MACRO_OSCILLATOR, purpleZoneThreshold: 34.0 } } },
  ],
  // ══ SALIDA ASIMÉTRICA (SMA rápida) — REJILLA PRE-REGISTRADA 2026-09-05 ══
  // Ataca DIRECTAMENTE la debilidad de §17: el lag de la SMA150 en la SALIDA. La entrada (filtro
  // de régimen) no se toca; solo se acelera el momento de cerrar. Es el experimento que DESCOMPONE
  // la pregunta que MACRO_OSC dejó confundida (allí cambiaban entrada y salida a la vez).
  //
  // PREDICCIÓN DECLARADA: salir antes reduce el giveback pico→salida (mejor peor-fold) pero corta
  // la cola derecha y multiplica el turnover (cada round-trip paga 0,30 %). Dado el precedente
  // Donchian (§14.4) y MACRO_OSC, se espera ROI↓ y Δ Calmar ≈ 0 o negativa → NO adoptable.
  // CONTROL DE MESETA: 50/75/100. Un ganador aislado entre dos perdedoras es un pico → no se adopta.
  fastexit: [
    { name: 'baseline (salida 150)', opts: { ...BUF, ...BASE_GATE } },
    { name: 'SALIDA SMA100', opts: { ...BUF, ...BASE_GATE, regimeOpts: { ...STRATEGY_OPTS, smaPeriod: SMA_PERIOD, band: 0, exitSmaPeriod: 100 } } },
    { name: 'SALIDA SMA75', opts: { ...BUF, ...BASE_GATE, regimeOpts: { ...STRATEGY_OPTS, smaPeriod: SMA_PERIOD, band: 0, exitSmaPeriod: 75 } } },
    { name: 'SALIDA SMA50', opts: { ...BUF, ...BASE_GATE, regimeOpts: { ...STRATEGY_OPTS, smaPeriod: SMA_PERIOD, band: 0, exitSmaPeriod: 50 } } },
  ],
  // ══ REGLAS EN PRODUCCIÓN SIN TORNEO — REJILLA PRE-REGISTRADA 2026-09-29, antes de correr nada ══
  // Tres reglas vivas entraron en commits de otra temática y nunca pasaron por el gate:
  //   · banda de histéresis 0,75 % (815364c6) — §10 la había RECHAZADO y dejado en 0;
  //   · crash guard BTC −12 %/3 d (815364c6);
  //   · gate BTC sobre CORTOS (7a22be78, §13).
  // Y `lsBaseEngineOpts` fija band: 0, así que todos los torneos desde el 24-jul miden una
  // estrategia que NO es la que opera. Aquí el baseline es la PRODUCCIÓN REAL y cada variante
  // quita UNA sola regla. Más la candidata FLAT tras el Chandelier del corto (ver motor).
  // PREDICCIÓN: ninguna de las tres reglas muestra mejora detectable (P de quitarlas ≈ 0,5);
  // FLAT recorta trades/costes con Δ Calmar incierta. Con --longonly las variantes del corto
  // deben dar Δ = 0 exacto (control de que el cambio está aislado).
  unvalidated: [
    { name: 'baseline PRODUCCIÓN', opts: { ...BUF, ...BASE_GATE, regimeOpts: PROD_REGIME } },
    // La banda ya está en 0 en producción (2026-09-29); esta variante mide la ANTERIOR (0,75 %).
    { name: 'CON banda 0,75% (antigua)', opts: { ...BUF, ...BASE_GATE, regimeOpts: { ...PROD_REGIME, band: 0.0075 } } },
    { name: 'SIN crash guard', opts: { ...BUF, btcGateLong: { smaPeriod: 200, crashGuardEnabled: false }, regimeOpts: PROD_REGIME } },
    { name: 'SIN gate BTC cortos', opts: { ...BUF, ...BASE_GATE, regimeOpts: PROD_REGIME, shortBtcGate: false } },
    { name: 'CHANDELIER FLAT', opts: { ...BUF, ...BASE_GATE, regimeOpts: PROD_REGIME, shortTrailReentry: 'flat' } },
    { name: 'SIN chandelier', opts: { ...BUF, ...BASE_GATE, regimeOpts: PROD_REGIME, shortTrailAtr: 0 } },
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

/** Huella corta y determinista de un universo, para no pisar archivos entre muestras. */
function fingerprint(syms) {
  const key = [...syms].sort().join(',');
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).slice(0, 6);
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
      let saturated = 0;
      for (let pi = 0; pi < r.byPerm.length; pi++) {
        for (const f of Object.keys(r.byPerm[pi])) {
          const b = base.byPerm[pi]?.[f];
          if (b == null) continue;
          const v = r.byPerm[pi][f];
          if (!KEEP_SATURATED && Math.abs(b) >= CALMAR_CLIP && Math.abs(v) >= CALMAR_CLIP) { saturated++; continue; }
          (deltasByFold[f] ||= []).push(v - b);
        }
      }
      row.saturatedPairs = saturated;
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
  const sat = rows.find(r => r.saturatedPairs > 0);
  if (sat) console.error(`\nℹ️ ${sat.saturatedPairs} pares (permutación, fold) con Calmar saturado en ±${CALMAR_CLIP} en baseline Y variante se excluyeron del bootstrap (--keep-saturated para incluirlos).`);
  console.error(`\nRuido por ORDEN del array en el baseline: ${f2(rows[0].spreadByOrder)} de Calmar mediano.`);
  console.error('Criterio: P(mejora media > 0) ≥ 0,80 por bootstrap de clúster de fold, Y peor fold no peor.');
  console.error('El IQR se reporta pero NO veta: con ~7 folds no es estimable de forma fiable.');

  // ⚠️ Defecto corregido 2026-09-05: el nombre solo miraba la MONEDA de cotización del primer
  // símbolo, así que dos universos distintos en la misma divisa escribían el MISMO fichero y el
  // segundo borraba al primero sin avisar. Se detectó al correr `fastexit` sobre un universo
  // disjunto: sobrescribió el resultado de large-caps. Ahora, si el universo no es la cesta por
  // defecto, se añade una huella determinista para que cada muestra conserve su archivo.
  const quote = SYMBOLS[0].endsWith('USDT') ? 'usdt' : 'usdc';
  const isDefaultBasket = !getStr('--symbols=', '');
  const tag = getStr('--tag=', '') || (isDefaultBasket ? '' : '-u' + fingerprint(SYMBOLS));
  const out = `robustgate-${TOURNAMENT}-${quote}${tag}${LONG_ONLY ? '-longonly' : ''}.json`;
  fs.writeFileSync(out, JSON.stringify({
    tournament: TOURNAMENT, months: MONTHS, folds: FOLDS, perms: perms.length, seed: SEED,
    bootstrapIters: BOOT, longOnly: LONG_ONLY, symbols: SYMBOLS, permutations: perms, rows,
    raw: results.map(r => ({ name: r.name, byPerm: r.byPerm })),
  }, null, 2));
  console.error(`📄 ${out}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

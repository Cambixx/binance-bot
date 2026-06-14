/**
 * sweep.js — Barrido de hipótesis de estrategia con COSTES REALES y validación OOS.
 *
 * Objetivo (auditoría 2026-05-29): encontrar una configuración cuyo edge sobreviva
 * el round-trip de costes (0.30%) TAMBIÉN fuera de muestra (holdout), no solo in-sample.
 *
 * Descarga los datos UNA sola vez por timeframe y reutiliza entre combos (eficiente,
 * sin saturar la API). Las hipótesis están motivadas por teoría, no es fuerza bruta:
 *   - Timeframe más alto (1h) reduce el lastre de costes por trade.
 *   - TP/trailing más amplios capturan movimientos grandes que superan el coste fijo.
 *   - Filtros de régimen más estrictos → menos trades pero de mayor calidad.
 *
 * Uso: node sweep.js [--months=12] [--symbols=A,B,C]
 */
import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import { deflatedSharpe, probabilityOfBacktestOverfitting, variance } from './validation.js';
import { BLACKLIST, STRATEGY_OPTS, RISK, COSTS } from './config.js';

// Performance por bloque temporal (suma de retornos log de la equity) para PBO/CSCV.
function chunkPerformance(equityCurve, S) {
  const pts = (equityCurve || []).filter(p => p.equity > 0);
  if (pts.length < S + 1) return null;
  const per = Math.floor(pts.length / S);
  const out = [];
  for (let c = 0; c < S; c++) {
    const a = pts[c * per];
    const b = c === S - 1 ? pts[pts.length - 1] : pts[(c + 1) * per];
    out.push(Math.log((b.equity || 1) / (a.equity || 1)));
  }
  return out; // longitud S
}

const args = process.argv.slice(2);
const monthsArg = args.find(a => a.startsWith('--months='));
const symbolsArg = args.find(a => a.startsWith('--symbols='));
const MONTHS = monthsArg ? parseInt(monthsArg.split('=')[1]) : 12;

// Set estable de large-caps con histórico largo (minimiza survivorship bias)
let SYMBOLS = symbolsArg
  ? symbolsArg.split('=')[1].split(',')
  : ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
SYMBOLS = SYMBOLS.filter(s => !BLACKLIST.some(b => s.includes(b)));

const TIMEFRAMES = ['15m', '1h'];

// Hipótesis (config-overrides sobre los defaults de config.js). Pocas y con tesis.
// V6 = Adaptive SuperTrend (port SATS): exits por flip → TP "apagado" + SL disaster amplio.
// `ro` = opciones de régimen/estrategia que se mergean en regimeOpts.
const HYPOTHESES = [
  // — Referencia (ya sabemos que no sobrevive costes) —
  { name: 'V4C-base',         v: '4C' },
  { name: 'V3-base',          v: '3' },
  // — Familia V6: Adaptive SuperTrend, salida por flip —
  { name: 'V6-base',          v: '6', tp: 100, sl: 12, trailAct: 999, big6: true },
  { name: 'V6-tightQ',        v: '6', tp: 100, sl: 12, trailAct: 999, big6: true, ro: { qStrength: 0.6 } },
  { name: 'V6-noAsym',        v: '6', tp: 100, sl: 12, trailAct: 999, big6: true, ro: { useAsym: false } },
  { name: 'V6-wideBand',      v: '6', tp: 100, sl: 12, trailAct: 999, big6: true, ro: { baseMult: 3.0 } },
  { name: 'V6-fastATR',       v: '6', tp: 100, sl: 12, trailAct: 999, big6: true, ro: { atrLen: 10 } },
  // — V6 con NUESTRA gestión de riesgo encima (TP/SL/trailing en vez de solo flip) —
  { name: 'V6+riskmgmt',      v: '6', big6: true },
  { name: 'V6+bigTP-trail',   v: '6', tp: 8, trailDist: 0.60, big6: true },
];

// Silenciar logs verbosos del engine durante el barrido
function mute(fn) {
  const orig = console.log;
  console.log = () => {};
  return fn().finally(() => { console.log = orig; });
}

// Cooldown equivalente a ~3h reales según timeframe
function cooldownFor(tf) {
  return tf === '1h' ? 3 : 12;
}

function robustnessVerdict(r) {
  const f = r.summary, t = r.trainSummary, h = r.holdoutSummary;
  const reasons = [];
  if (!h || !t) return { robust: false, reasons: ['sin split OOS'], score: -999 };
  if (h.totalTrades < 8) reasons.push(`holdout n=${h.totalTrades}<8`);
  if (f.profitFactor < 1.25) reasons.push(`PF full ${f.profitFactor}<1.25`);
  if (h.profitFactor < 1.2) reasons.push(`PF holdout ${h.profitFactor}<1.2`);
  if (t.profitFactor < 1.1) reasons.push(`PF train ${t.profitFactor}<1.1`);
  if (h.roi <= 0) reasons.push(`ROI holdout ${h.roi}≤0`);
  const robust = reasons.length === 0;
  // Score: prioriza rentabilidad holdout robusta y muestra suficiente
  const score = (h.roi || 0) + (h.profitFactor - 1) * 5 + Math.min(h.totalTrades, 40) * 0.1;
  return { robust, reasons, score: parseFloat(score.toFixed(2)) };
}

async function main() {
  const rtPct = ((COSTS.feePct + COSTS.slippagePct) * 2 * 100).toFixed(2);
  console.error(`\n🔬 SWEEP — ${MONTHS} meses | símbolos: ${SYMBOLS.join(',')} | costes ON (${rtPct}% round-trip)`);
  console.error(`Hipótesis: ${HYPOTHESES.length} × ${TIMEFRAMES.length} timeframes = ${HYPOTHESES.length * TIMEFRAMES.length} backtests\n`);

  const rows = [];
  const PBO_CHUNKS = 10;        // bloques temporales para CSCV (par, >=4)
  const perTf = {};             // por timeframe: [{name, sharpe, chunks}] para DSR/PBO
  TIMEFRAMES.forEach(tf => { perTf[tf] = []; });

  for (const tf of TIMEFRAMES) {
    console.error(`📥 Descargando datos ${tf} (una vez)...`);
    // Fetcher: una instancia descarga todos los símbolos para este timeframe
    const fetcher = new BacktestEngine({ symbols: [...SYMBOLS], months: MONTHS, interval: tf });
    fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
    const dataBySymbol = {};
    for (const s of fetcher.symbols) {
      dataBySymbol[s] = await fetcher.fetchHistoricalData(s);
    }
    const totalCandles = Object.values(dataBySymbol).reduce((a, d) => a + d.length, 0);
    console.error(`   ✅ ${totalCandles} velas ${tf} en memoria\n`);

    for (const h of HYPOTHESES) {
      // regimeOpts: filtros V4C (chop/bbw) y params V5 (emaFast/emaSlow/exitEma/adxMin)
      const regimeOpts = { ...STRATEGY_OPTS };
      if (h.chopMax !== undefined) regimeOpts.chopMax = h.chopMax;
      if (h.bbwPct !== undefined) regimeOpts.bbwPctMin = h.bbwPct;
      if (h.emaFast !== undefined) regimeOpts.emaFast = h.emaFast;
      if (h.emaSlow !== undefined) regimeOpts.emaSlow = h.emaSlow;
      if (h.exitEma !== undefined) regimeOpts.exitEma = h.exitEma;
      if (h.adxMin !== undefined) regimeOpts.adxMin = h.adxMin;
      if (h.ro) Object.assign(regimeOpts, h.ro);  // opciones V6 (qStrength, atrLen, baseMult, useAsym...)

      const opts = {
        symbols: [...SYMBOLS],
        months: MONTHS,
        interval: tf,
        strategyVersion: h.v,
        regimeOpts,
        cooldownCandles: cooldownFor(tf),
        dataBySymbol,            // ← reutiliza la descarga, costes ON por defecto (config.js)
      };
      // V5 necesita ventana mayor (EMA200); V6 necesita ~160 (ATR baseline 100 + warmup)
      if (h.big) { opts.bufferSize = 260; opts.minCandles = 205; }
      if (h.big6) { opts.bufferSize = 170; opts.minCandles = 140; }
      if (h.exitMode !== undefined) opts.exitMode = h.exitMode;
      if (h.atrTrail !== undefined) opts.atrTrailMult = h.atrTrail;
      if (h.atrSL !== undefined) opts.atrSLMult = h.atrSL;
      if (h.tp !== undefined) opts.takeProfitPct = h.tp;
      if (h.sl !== undefined) opts.stopLossPct = h.sl;
      if (h.trailAct !== undefined) opts.trailingActivation = h.trailAct;
      if (h.trailDist !== undefined) opts.trailingDistance = h.trailDist;

      const engine = new BacktestEngine(opts);
      let result;
      try {
        result = await mute(() => engine.run());
      } catch (e) {
        console.error(`   ⚠️ ${h.name} @${tf} falló: ${e.message}`);
        continue;
      }
      const v = robustnessVerdict(result);
      const s = result.summary, t = result.trainSummary || {}, ho = result.holdoutSummary || {};
      rows.push({
        config: h.name, tf, robust: v.robust, score: v.score, reasons: v.reasons,
        fullROI: s.roi, fullPF: s.profitFactor, fullWR: s.winRate, fullTrades: s.totalTrades, maxDD: s.maxDrawdown,
        sharpe: s.sharpe, calmar: s.calmar,
        trainPF: t.profitFactor, trainROI: t.roi,
        holdoutPF: ho.profitFactor, holdoutROI: ho.roi, holdoutWR: ho.winRate, holdoutTrades: ho.totalTrades,
      });
      // Para DSR/PBO: guardar Sharpe y la performance por bloque de cada config (por timeframe)
      perTf[tf].push({ name: h.name, sharpe: s.sharpe, chunks: chunkPerformance(result.equityCurve, PBO_CHUNKS) });
      console.error(`   ${v.robust ? '✅' : '  '} ${h.name.padEnd(20)}@${tf.padEnd(3)} fullPF=${String(s.profitFactor).padEnd(5)} holdoutPF=${String(ho.profitFactor).padEnd(5)} holdoutROI=${String(ho.roi).padEnd(7)} Sharpe=${String(s.sharpe).padEnd(6)} n=${ho.totalTrades}`);
    }
  }

  rows.sort((a, b) => b.score - a.score);

  console.error('\n══════════════════════ RANKING (por robustez OOS) ══════════════════════');
  const pad = (v, n) => String(v).padEnd(n);
  console.error(pad('CONFIG', 20) + pad('TF', 4) + pad('ROB', 5) + pad('SCORE', 7) + pad('fPF', 6) + pad('fROI', 7) + pad('hPF', 6) + pad('hROI', 7) + pad('hN', 5) + 'MaxDD');
  console.error('─'.repeat(80));
  rows.forEach(r => {
    console.error(
      pad(r.config, 20) + pad(r.tf, 4) + pad(r.robust ? 'SÍ' : 'no', 5) +
      pad(r.score, 7) + pad(r.fullPF, 6) + pad(r.fullROI, 7) +
      pad(r.holdoutPF, 6) + pad(r.holdoutROI, 7) + pad(r.holdoutTrades, 5) + r.maxDD
    );
  });

  const robustOnes = rows.filter(r => r.robust);
  console.error(`\n🏆 Configuraciones ROBUSTAS (sobreviven costes OOS): ${robustOnes.length}`);
  if (robustOnes.length === 0) {
    console.error('   ❌ NINGUNA hipótesis sobrevive a los costes fuera de muestra con esta muestra.');
    console.error('   → El edge no es robusto; hay que explorar familias de estrategia nuevas (no solo afinar params).');
  } else {
    robustOnes.slice(0, 3).forEach((r, i) => console.error(`   ${i + 1}. ${r.config} @${r.tf} — holdout PF ${r.holdoutPF}, ROI ${r.holdoutROI}%, n=${r.holdoutTrades}`));
  }

  // ───────── Corrección de multiple-testing: Deflated Sharpe + PBO (fix #34) ─────────
  // Elegir el mejor de N configs sobre el MISMO holdout es in-sample al proceso de selección.
  // DSR descuenta el Sharpe por el nº de pruebas; PBO/CSCV estima P(el ganador IS sea perdedor OOS).
  console.error('\n══════════ 🛡️ MULTIPLE-TESTING (DSR + PBO por timeframe) ══════════');
  const overfitting = {};
  for (const tf of TIMEFRAMES) {
    const configs = perTf[tf].filter(c => c.sharpe != null && isFinite(c.sharpe));
    if (configs.length < 2) { console.error(`  ${tf}: configs insuficientes`); continue; }
    const sharpes = configs.map(c => c.sharpe);
    const best = Math.max(...sharpes);
    const varTrial = variance(sharpes);
    // T aproximado: nº de bloques (proxy del nº de observaciones independientes disponibles)
    const dsr = deflatedSharpe({ sharpe: best, nTrials: configs.length, varTrialSharpe: varTrial, T: PBO_CHUNKS + 1 });
    // Matriz de performance por bloque [chunk][config]
    const withChunks = configs.filter(c => Array.isArray(c.chunks) && c.chunks.length === PBO_CHUNKS);
    let pbo = null;
    if (withChunks.length >= 2) {
      const matrix = [];
      for (let chunk = 0; chunk < PBO_CHUNKS; chunk++) matrix.push(withChunks.map(c => c.chunks[chunk]));
      pbo = probabilityOfBacktestOverfitting(matrix);
    }
    overfitting[tf] = { bestSharpe: best, nTrials: configs.length, dsr, pbo };
    console.error(`  ${tf}: mejor Sharpe ${best} sobre ${configs.length} configs`);
    if (dsr) console.error(`       DSR ${dsr.deflatedSharpe} ${dsr.passes ? '✅' : '🔻 (no supera el descuento de multiple-testing)'}`);
    if (pbo && !pbo.error) console.error(`       PBO ${pbo.pbo} ${pbo.passes ? '✅ (<0.5)' : '🔻 (>=0.5, el ganador IS tiende a perder OOS)'}`);
  }

  fs.writeFileSync('sweep-results.json', JSON.stringify({ months: MONTHS, symbols: SYMBOLS, timeframes: TIMEFRAMES, rows, overfitting }, null, 2));
  console.error('\n📄 Resultados completos en sweep-results.json');
}

main();

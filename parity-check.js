/**
 * parity-check.js — CLI del gate de promoción por PARIDAD (ver parity.js y AUDIT_REPORT §20.4).
 *
 * Re-ejecuta el motor sobre el periodo del estado live (mismo perfil que los bots: lsBaseEngineOpts,
 * modo señal) y compara entradas/salidas contra el ledger.
 *
 * Uso:  npm run sync
 *       node parity-check.js --state=sync_ls.json [--channel=ls|daily] [--months=14]
 *                            [--since=YYYY-MM-DD] [--tol-price=0.5] [--band=0.75]
 *
 * `--band=` (en %) permite reproducir un estado generado con otra banda (p.ej. el archivo del
 * 2026-08-29 se generó con 0,75 %). Por defecto usa `config.SMA_HYSTERESIS_BAND`.
 * Código de salida: 0 = paridad, 1 = divergencia, 2 = sin datos para juzgar.
 */
import fs from 'fs';
import BacktestEngine from './backtestEngine.js';
import { lsBaseEngineOpts } from './wfcore.js';
import { liveEntries, engineEntries, compareEntries } from './parity.js';
import { DAILY_BASKET, SIGNAL_MODE, isBlacklisted } from './config.js';

const args = process.argv.slice(2);
const getStr = (p, d) => { const a = args.find((x) => x.startsWith(p)); return a ? a.split('=')[1] : d; };
const statePath = getStr('--state=', '');
if (!statePath) { console.error('Falta --state=<fichero de estado live> (p.ej. sync_ls.json tras npm run sync)'); process.exit(2); }
const channel = getStr('--channel=', 'ls');
const months = parseFloat(getStr('--months=', '14'));
const tolPrice = parseFloat(getStr('--tol-price=', '0.5'));
const bandArg = getStr('--band=', '');

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const live = liveEntries(state);
if (live.length === 0) { console.error(`⚪ ${statePath}: sin entradas live que comparar (¿estado recién reseteado?).`); process.exit(2); }

// Las entradas del PRIMER ciclo son de arranque: el bot abre todo lo que ya está en régimen, y el
// motor las abrió semanas antes. Se compara desde el día siguiente al primer ciclo.
const firstDay = Math.floor(live[0].time / 86400000);
const sinceStr = getStr('--since=', '');
const since = sinceStr ? Date.parse(sinceStr) : (firstDay + 1) * 86400000;

const symbols = DAILY_BASKET.filter((s) => !isBlacklisted(s));
console.error(`\n🔁 PARIDAD [${channel}] — ${live.length} entradas live · desde ${new Date(since).toISOString().slice(0, 10)} · ${symbols.length} símbolos`);

const fetcher = new BacktestEngine({ symbols: [...symbols], months, interval: '1d' });
fetcher.symbols = fetcher.filterSymbols(fetcher.symbols);
const data = {};
for (const s of fetcher.symbols) data[s] = await fetcher.fetchHistoricalData(s);

const opts = lsBaseEngineOpts({
  months, dataBySymbol: data, symbols: fetcher.symbols,
  longShort: channel === 'ls',
  signalMode: { notional: SIGNAL_MODE.notionalPerSignal },
  oosSplitRatio: 0.5,
  // fundingMode 'flat' evita descargar la serie; la paridad se mide en ENTRADAS y SALIDAS, no en P&L.
  fundingMode: 'flat',
});
if (bandArg) opts.regimeOpts = { ...opts.regimeOpts, band: parseFloat(bandArg) / 100 };
const log = console.log; console.log = () => {};
let report;
try { report = await new BacktestEngine(opts).run(); } finally { console.log = log; }

const eng = engineEntries(report.trades);
const untilMs = Math.max(...live.map((e) => e.exitTime || e.time)) + 86400000;
const res = compareEntries(live, eng, { since, priceTolPct: tolPrice, dayTolerance: 1, until: untilMs });

const d = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log(`\nEntradas live comparadas: ${res.liveCount} · con gemela en el motor: ${res.matched.length} (${res.matchRate == null ? '—' : (res.matchRate * 100).toFixed(0)} %)`);
console.log(`Desviación de precio de entrada: media ${res.meanPriceDev.toFixed(3)} % · máx ${res.maxPriceDev.toFixed(3)} % (umbral ${tolPrice} %)`);
console.log(`Salidas comparadas: ${res.exitsCompared} · discrepantes: ${res.exitMismatch.length}${res.manualSkipped ? ` · ${res.manualSkipped} manuales omitidas` : ''}`);
if (res.liveOnly.length) { console.log(`\n🔸 Entradas del LIVE que el motor NO habría hecho (${res.liveOnly.length}):`); for (const e of res.liveOnly) console.log(`   ${d(e.time)} ${e.side.padEnd(5)} ${e.symbol} @ ${e.price}`); }
if (res.engineOnly.length) { console.log(`\n🔴 Señales del MOTOR que el live se saltó (${res.engineOnly.length}):`); for (const e of res.engineOnly) console.log(`   vela ${d(e.time)} ${e.side.padEnd(5)} ${e.symbol} @ ${e.price}`); }
if (res.exitMismatch.length) { console.log(`\n🔸 Salidas discrepantes:`); for (const m of res.exitMismatch) console.log(`   ${m.live.symbol} ${m.live.side}: live ${m.live.exitReason} ${d(m.live.exitTime)} vs motor ${m.engine.exitReason} ${d(m.engine.exitTime)}`); }
console.log(`\n${res.ok ? '✅ PARIDAD: el live hace lo que el motor. El walk-forward del motor es evidencia aplicable.' : '❌ DIVERGENCIA: el live NO reproduce al motor; el walk-forward no es evidencia de esta ejecución hasta corregirlo.'}`);
process.exit(res.ok ? 0 : 1);

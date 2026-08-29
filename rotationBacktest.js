/**
 * rotationBacktest.js — Motor de backtest del canal 🔄 ROT-dual-mom.
 *
 * ⚠️ POR QUÉ EXISTE (auditoría 2026-08-29, H3): el canal de rotación aportaba el 88 % del
 * beneficio reportado del bot y NO TENÍA NINGUNA SIMULACIÓN. `grep -rl rotation` sobre
 * backtestEngine/backtest/walkforward/wfcore/abtest/sweep/validate devolvía CERO ficheros: sus
 * parámetros (`ROTATION` en config.js) nunca habían pasado el gate pareado ni la regla de
 * sobrevivir al 0,30 % round-trip OOS, porque no había forma técnica de correrlos.
 *
 * Extiende `BacktestEngine` para heredar EXACTAMENTE el mismo modelo de costes, la contabilidad
 * por posición, el panel por libro, el tracker de drawdown per-bar, las métricas ajustadas a
 * riesgo y el split train/holdout. Solo se reemplaza el bucle de decisión.
 *
 * ── LIMITACIÓN DECLARADA, no disimulada ──────────────────────────────────────────────────────
 * El canal LIVE elige su universo con `getTopVolumeSymbols` (top-N por volumen de 24 h). Ese
 * criterio NO es reconstruible point-in-time con la API pública: no hay histórico de rankings de
 * volumen. Este backtest corre por tanto sobre un universo FIJO pasado por el caller. Eso:
 *   · elimina el sesgo de supervivencia de "el top de HOY aplicado al pasado",
 *   · pero NO reproduce la selección real del live, que por construcción persigue lo que acaba
 *     de bombear (PUMP, ENA) — un sesgo que este arnés no puede medir.
 * Conclusión honesta: valida las REGLAS de rotación (ranking, gates, cadencia, costes), no la
 * selección de universo. Se reporta así en el summary (`universeNote`).
 */
import BacktestEngine from './backtestEngine.js';
import { computeRotationTargets } from './indicators.js';
import { ROTATION, REGIME, isBlacklisted } from './config.js';

export default class RotationBacktestEngine extends BacktestEngine {
  constructor(options = {}) {
    // PARIDAD: `rotationBot.js` (live) NO tiene circuit breaker de cartera — el antiguo era además
    // inerte en este canal, porque su guard `equity > 0` sobre la CAJA lo desactivaba y ROT opera
    // con caja 0. Si el motor lo heredase de `BacktestEngine`, el backtest simularía una guarda que
    // el live no aplica. Se desactiva por defecto y se puede forzar para medir su efecto.
    // (El breaker suspendió su propio torneo: Calmar mediano 2,74 → 2,68, sin mejorar IQR ni peor
    // fold. Añadirlo a ROT en vivo sería un cambio de estrategia sin validar.)
    super({ interval: '1d', strategyVersion: 'ROTATION', exitMode: 'signal', portfolioCircuitBreaker: null, ...options });
    this.rotation = { ...ROTATION, ...(options.rotation || {}) };
    // Comprobación DIARIA del gate BTC entre rebalanceos (mejora auditada). El live solo mira el
    // gate el día del rebalanceo: hasta 14 días 100 % largo en 5 alts sin poder reaccionar aunque
    // BTC pierda la SMA200 al día siguiente. `false` reproduce el live actual.
    this.rotationDailyRiskOff = options.rotationDailyRiskOff ?? false;
    // Colchón de caja: fracción del equity que NO se despliega (el live usa 0 → 100 % invertido).
    this.rotationCashBuffer = options.rotationCashBuffer ?? 0;
  }

  async run() {
    const rtCost = ((this.feePct + this.slippagePct) * 2 * 100).toFixed(2);
    console.log('🚀 Iniciando simulación de ROTACIÓN cross-sectional + dual-momentum...');
    console.log(`   top${this.rotation.topN} · lookback ${this.rotation.lookbackDays}d · rebalanceo ${this.rotation.rebalanceDays}d · gate BTC ${this.rotation.useBtcRegime ? 'ON' : 'off'}`);
    console.log(`💸 Costes: ${rtCost}% round-trip`);

    this.symbols = this.filterSymbols(this.symbols);

    let dataBySymbol;
    if (this.dataBySymbol) {
      dataBySymbol = {};
      for (const s of this.symbols) dataBySymbol[s] = this.dataBySymbol[s] || [];
    } else {
      dataBySymbol = {};
      for (const s of this.symbols) dataBySymbol[s] = await this.fetchHistoricalData(s);
    }
    this.symbols = this.symbols.filter(s => (dataBySymbol[s] || []).length > 0);
    if (this.symbols.length === 0) throw new Error('Rotación: sin datos utilizables.');

    // Eje temporal unificado (unión de todas las fechas disponibles).
    const times = [...new Set(this.symbols.flatMap(s => dataBySymbol[s].map(k => k.time)))].sort((a, b) => a - b);
    const startTime = times[0];
    const endTime = times[times.length - 1];
    if (this.oosSplitRatio > 0 && this.oosSplitRatio < 1) {
      this.splitTime = startTime + (endTime - startTime) * this.oosSplitRatio;
    }

    this.buyHold = this.computeBuyHold(dataBySymbol);
    this.buyHoldTrain = this.computeBuyHold(dataBySymbol, null, this.splitTime);
    this.buyHoldHoldout = this.computeBuyHold(dataBySymbol, this.splitTime, null);
    const btcSym = Object.keys(dataBySymbol).find(s => s.includes('BTC'));
    this.btcHold = btcSym ? this.computeBuyHold({ [btcSym]: dataBySymbol[btcSym] }) : null;
    this.benchmarkSeries = this.computeBuyHoldSeries(dataBySymbol);

    // Índice por fecha para lectura O(1) y series de cierres acumuladas.
    const byTime = {};
    for (const s of this.symbols) {
      byTime[s] = new Map();
      for (const k of dataBySymbol[s]) byTime[s].set(k.time, k);
    }
    const closesBySymbol = {};
    for (const s of this.symbols) closesBySymbol[s] = [];

    const warmup = Math.max(this.rotation.lookbackDays, this.rotation.absMomLookback) + 2;
    const currentPrices = {};
    let lastRebalance = 0;

    console.log(`📈 Procesando ${times.length} días...`);

    for (const time of times) {
      // 1) Actualizar precios y series con la vela de HOY (que es una vela CERRADA).
      for (const s of this.symbols) {
        const k = byTime[s].get(time);
        if (!k) continue;
        currentPrices[s] = k.close;
        closesBySymbol[s].push(k.close);
      }
      if (time > this.lastEventTime) this.lastEventTime = time;

      const ready = this.symbols.filter(s => closesBySymbol[s].length >= warmup);
      if (ready.length >= this.rotation.topN) {
        const btcCloses = (this.rotation.useBtcRegime && btcSym) ? closesBySymbol[btcSym] : null;
        const rotOpts = {
          lookbackDays: this.rotation.lookbackDays,
          topN: this.rotation.topN,
          absMomLookback: this.rotation.absMomLookback,
          useBtcRegime: this.rotation.useBtcRegime,
          useRiskAdjusted: this.rotation.useRiskAdjusted,
          btcCloses,
          btcSmaPeriod: REGIME.btcSmaPeriod,
          ...REGIME,
        };

        const due = (time - lastRebalance) >= this.rotation.rebalanceDays * 86400000;

        // 2) Salida de emergencia DIARIA por gate BTC (opcional; el live no la tiene).
        //    Es el riesgo de cola concreto que la auditoría señaló: sin esto, entre rebalanceos
        //    el canal no evalúa NINGUNA salida durante hasta `rebalanceDays` días.
        if (!due && this.rotationDailyRiskOff && Object.keys(this.state.openPositions).length > 0) {
          const probe = computeRotationTargets(
            Object.fromEntries(ready.map(s => [s, closesBySymbol[s]])), rotOpts
          );
          if (probe.riskOff) {
            for (const sym of Object.keys(this.state.openPositions)) {
              if (currentPrices[sym] > 0) this.executeSell(sym, currentPrices[sym], time, 'REGIME_RISKOFF');
            }
          }
        }

        // 3) Rebalanceo periódico.
        if (due) {
          const { targets } = computeRotationTargets(
            Object.fromEntries(ready.map(s => [s, closesBySymbol[s]])), rotOpts
          );
          const wanted = targets.filter(t => !isBlacklisted(t) && currentPrices[t] > 0);

          // 3a) Vender lo que sale del target.
          for (const sym of Object.keys(this.state.openPositions)) {
            if (!wanted.includes(sym) && currentPrices[sym] > 0) {
              this.executeSell(sym, currentPrices[sym], time, 'SIGNAL');
            }
          }

          // 3b) Comprar los nuevos, equiponderados sobre el equity CONGELADO tras las ventas.
          //     Es el patrón order-independent que rotationBot.js ya usaba y que los otros dos
          //     canales no tenían (H1): el reparto no depende del orden del array.
          const toBuy = wanted.filter(s => !this.state.openPositions[s]);
          if (toBuy.length > 0) {
            const equity = this.currentEquity(currentPrices, time);
            const deployable = equity * (1 - this.rotationCashBuffer);
            const perPos = deployable / this.rotation.topN;
            for (const sym of toBuy) {
              const px = currentPrices[sym];
              if (!(px > 0) || !(this.state.balance > 0)) continue;
              if (!this.canOpenPosition(currentPrices)) break; // circuit breaker / caps
              const invest = Math.min(perPos, this.state.balance);
              if (!(invest > 0)) continue;
              const fillPrice = px * (1 + this.slippagePct);
              const buyFee = invest * this.feePct;
              this.state.balance -= invest;
              this.state.openPositions[sym] = {
                side: 'long',
                amount: (invest - buyFee) / fillPrice,
                buyPrice: px,
                entryPrice: px,
                peakPrice: px,
                invested: invest,
                time: new Date(time).toISOString(),
              };
            }
          }
          lastRebalance = time;
        }
      }

      this.trackDrawdown(time, currentPrices);
      this.recordEquity(time, currentPrices);
    }

    // Cierre final al último timestamp de vela (fix #9: nunca Date.now()).
    const closeTime = this.lastEventTime || endTime;
    for (const symbol in this.state.openPositions) {
      if (currentPrices[symbol]) this.executeSell(symbol, currentPrices[symbol], closeTime, 'END_OF_BACKTEST');
    }
    this.trackDrawdown(closeTime, currentPrices);
    this.recordEquity(closeTime, currentPrices, true);

    const report = this.generateReport();
    report.summary.universeNote = 'universo FIJO — no reconstruye el top-N por volumen point-in-time del live';
    report.summary.rotation = { ...this.rotation, dailyRiskOff: this.rotationDailyRiskOff, cashBuffer: this.rotationCashBuffer };
    return report;
  }
}

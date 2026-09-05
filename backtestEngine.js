import axios from 'axios';
import {
  evaluateStrategy, evaluateStrategyV2, evaluateStrategyV3,
  evaluateStrategyV4A, evaluateStrategyV4B, evaluateStrategyV4C,
  evaluateStrategyV5, evaluateStrategyV6,
  evaluateStrategySMA200, evaluateStrategySupertrendDaily, evaluateStrategyDonchian,
  evaluateStrategyMacroOscillator,
  calculateATR, computeVolTargetWeight, computeVolTargetWeightConditional, periodsPerYearFor,
  shortEntryAllowed, dailyVol, btcRegimeOn
} from './indicators.js';
import { evaluateFixedExit } from './exits.js';
import binance, { cumRateAt } from './binanceService.js';
import { BLACKLIST, isBlacklisted, RISK, COSTS, LOOKBACK_15M, LONGSHORT, REGIME, SIZING_BASIS, PORTFOLIO_CIRCUIT_BREAKER, SIGNAL_MODE } from './config.js';

const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

// Mapa único de nombres de estrategia (fix auditoría #25: antes había dos mapas locales
// desincronizados y generateReport etiquetaba TODO como "V3").
export const STRATEGY_NAMES = {
  ROTATION: 'Rotación cross-sectional + dual-momentum (ROT)',
  1: 'V1 (Original)', 2: 'V2 (Optimizada)', 3: 'V3 (ADX+Trailing)',
  '4A': 'V4-A (Supertrend+Chandelier)', '4B': 'V4-B (V3+ATR-exits)', '4C': 'V4-C (V3+RegimeGate)',
  '5': 'V5 (Trend-rider)', '6': 'V6 (Adaptive SuperTrend)',
  'SMA200': 'SMA regime (Faber, diaria)', 'STDAY': 'SuperTrend diario', 'DONCHIAN': 'Donchian 55/20 (diaria)',
  'MACRO_OSC': 'Oscilador Anticipado + Anti-FOMO (Videos 1 & 2)', '7': 'V7 (Macro Oscillator)', 'V7': 'V7 (Macro Oscillator)',
};

export function strategyName(v) {
  return STRATEGY_NAMES[v] || STRATEGY_NAMES[String(v)] || `Estrategia ${v}`;
}

class BacktestEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 5000;
    this.symbols = options.symbols || ['BTCUSDC', 'ETHUSDC', 'SOLUSDC'];
    this.interval = options.interval || '15m';
    this.months = options.months || 3;
    this.strategyVersion = options.strategyVersion || '4C'; // default paridad bot.js (V4C-COMBO)

    // Risk management (defaults centralizados en config.js → paridad live)
    this.takeProfitPct = options.takeProfitPct ?? RISK.takeProfitPct;
    this.stopLossPct = options.stopLossPct ?? RISK.stopLossPct;
    this.trailingActivation = options.trailingActivation ?? RISK.trailingActivation;
    this.trailingDistance = options.trailingDistance ?? RISK.trailingDistance;
    this.cooldownCandles = options.cooldownCandles ?? RISK.cooldownCandles;
    this.positionSizePct = options.positionSizePct ?? RISK.positionSizePct;
    // Caps de cartera (fix #26). null = sin límite (preserva comportamiento histórico).
    this.maxConcurrentPositions = options.maxConcurrentPositions ?? RISK.maxConcurrentPositions ?? null;
    this.maxExposurePct = options.maxExposurePct ?? RISK.maxExposurePct ?? null;

    // Costes de transacción (fees + slippage) — netados en cada trade. Ver config.js / auditoría.
    this.feePct = options.feePct ?? COSTS.feePct;
    this.slippagePct = options.slippagePct ?? COSTS.slippagePct;
    // Funding/borrow del lado corto (auditoría 2026-06-26). 0 = sin coste de carry.
    this.fundingDailyShort = options.fundingDailyShort ?? COSTS.fundingDailyShort ?? 0;
    // Gestión de riesgo del corto: stop duro + cooldown anti-whipsaw. Defaults desde config
    // LONGSHORT (auditoría 2026-07-03 #4: antes 0 → los backtests corrían SIN el catastrophe-stop
    // que el live siempre aplica → divergencia). Override explícito (incl. 0) sigue funcionando.
    // ⚠️ shortStopCooldownDays↔velas solo es 1:1 en interval '1d' (el único donde hay cortos hoy).
    this.shortStopPct = options.shortStopPct ?? LONGSHORT.shortStopPct ?? 0;
    this.shortStopCooldown = options.shortStopCooldown ?? LONGSHORT.shortStopCooldownDays ?? 0;
    // κ: presupuesto de riesgo del corto (research 2026-07 #3). 1.0 = simétrico (actual).
    this.shortRiskFraction = options.shortRiskFraction ?? LONGSHORT.shortRiskFraction ?? 1.0;
    // Filtro de ENTRADA del corto (research 2026-07 #8/#7b): banda/pendiente/confirmación/veto.
    // {} = sin filtro (comportamiento actual). Se pasa a shortEntryAllowed.
    this.shortEntry = options.shortEntry ?? LONGSHORT.shortEntry ?? {};
    // Gestión de SALIDA del corto (research 2026-07 #9), CAPA sobre el stop 25% (no lo sustituye):
    //  - shortTrailAtr (k): Chandelier del corto — cubrir si close > minLow + k·ATR14. 0 = off.
    //  - shortTimeStopDays: cubrir si a los N días el corto no acumula beneficio. 0 = off.
    this.shortTrailAtr = options.shortTrailAtr ?? LONGSHORT.shortTrailAtr ?? 0;
    // Stop de CATÁSTROFE del LARGO en modo régimen (exitMode 'signal'). Candidata 2026-09-05.
    // Motivación simétrica a la del corto: en `signal` la ÚNICA salida es el cruce de la SMA150,
    // que es laggy por construcción — un largo puede recorrer todo el camino desde su pico hasta
    // la SMA sin que nada lo corte. A diferencia del corto la pérdida SÍ está acotada (−100 %),
    // por eso esto es protección de DRAWDOWN, no de ruina, y por eso nace APAGADA (0 = off,
    // baseline = producción actual) hasta que pase el gate robusto de la casa.
    // El cooldown es imprescindible: sin él la señal (que sigue en BUY bajo la SMA) recompraría
    // a la vela siguiente y el stop solo quemaría costes de round-trip.
    // ⚠️ longStopCooldownDays↔velas solo es 1:1 en interval '1d' (la familia diaria).
    this.longStopPct = options.longStopPct ?? 0;
    this.longStopCooldown = options.longStopCooldown ?? 0;
    this.shortTimeStopDays = options.shortTimeStopDays ?? LONGSHORT.shortTimeStopDays ?? 0;
    // Multiplicadores de exposición del corto (seguros de cola, research #7a/#6): reducen el
    // tamaño del corto en pánico BTC o funding persistentemente negativo. null = off.
    this.panicDerisk = options.panicDerisk ?? LONGSHORT.panicDerisk ?? null;
    this.fundingKill = options.fundingKill ?? LONGSHORT.fundingKill ?? null;
    // Modo de funding del corto: 'flat' (0.03%/día en contra, conservador) o 'real' (serie
    // FIRMADA del perp — research 2026-07 #1). Con 'real', pasar fundingSeries pre-descargada
    // ({SPOT: [{t,cum}]}) o el run() la descarga para los símbolos del universo.
    this.fundingMode = options.fundingMode ?? 'flat';
    this.fundingSeries = options.fundingSeries || null;
    // ── Candidatas research 2026-07-10 (torneo abtest; off por defecto) ──
    // pyramid: piramidación estilo Turtle en LARGOS (solo exitMode 'signal'): añade una tranche
    // cuando el precio confirma la tendencia subiendo stepPct sobre la última entrada/añadido.
    // { stepPct: 0.10, maxAdds: 2 } — parámetros fijados a priori, no barrer fino.
    this.pyramid = options.pyramid ?? null;
    // entryTilt: sizing continuo tipo Carver al ABRIR — multiplica el tamaño por la fuerza de
    // tendencia z = |ln(close/SMA)| / (σ20d·√horizonDays), clamp [floor, 1]. Señal débil (cruce
    // fresco) → entra pequeño; señal fuerte → tamaño pleno. { horizonDays: 30, floor: 0.25 }.
    this.entryTilt = options.entryTilt ?? null;
    // btcGateLong: gate maestro BTC para entradas LARGAS (investigación §2.2 / REGIME): si el
    // cierre de BTC < SMA(period), no abrir largos nuevos. { smaPeriod: 200 }.
    // ✅ ADOPTADO 2026-07-10: default desde config.REGIME (paridad live↔backtest). Pasar
    // btcGateLong: null para desactivarlo explícitamente. Fail-open si el buffer no alcanza
    // para la SMA (p.ej. 15m con LOOKBACK_15M=130) o si BTC no está en el universo.
    this.btcGateLong = options.btcGateLong !== undefined
      ? options.btcGateLong
      : (REGIME.btcEnabled ? { smaPeriod: REGIME.btcSmaPeriod } : null);

    // Exit mode: 'fixed' = TP/SL/trailing% clásicos | 'atr' = Chandelier (ATR-based) + ATR SL
    // donchianLongGate (research 2026-08-29): exigir que el cierre marque MÁXIMO de n días para
    // abrir LARGO, ADEMÁS de la señal SMA. Es la ÚNICA candidata del research que sube el win
    // rate de verdad (réplica: 26,3 % → 45,5 %, esperanza/trade 7,36 % → 15,32 %, meseta en
    // 60/90/150) — a costa de ~37 % del P&L total. { lookbackDays: 90 }.
    // ⚠️ SOLO LARGOS: en la réplica la pata corta empeora monótonamente (42,9/38,8/35,9 %) con
    // el P&L hundiéndose un 70 %. No aplicar al corto bajo ningún concepto.
    this.donchianLongGate = options.donchianLongGate ?? null;

    // Base de dimensionamiento (H1). Tres modos:
    //   'cash'   → `balance · positionSizePct` (histórico). La exposición acumulada es 1−0,8^n, así
    //              que el reparto cae en escalera geométrica y el ÍNDICE del símbolo en el array
    //              decide su peso (3,76:1 entre el primero y el último con 7 posiciones).
    //   'equity' → `(balance+invertido) · positionSizePct`. Medido: NO arregla la dependencia del
    //              orden, la EMPEORA (dispersión del Calmar mediano 0,77 → 1,23), porque con el
    //              20 % fijo las 5 primeras agotan el equity y el resto simplemente no entra: el
    //              orden pasa de repartir capital a decidir QUIÉN opera.
    //   'equalN' → `(balance+invertido) / positionSlots`. Reparto EQUIPONDERADO sobre un nº de
    //              plazas declarado. Es el patrón que `rotationBot.js` ya usaba (`equity/topN`) y
    //              el único de los tres que es genuinamente independiente del orden: todas las
    //              plazas reciben lo mismo y la suma nunca agota la caja.
    this.sizeBasis = options.sizeBasis ?? SIZING_BASIS;
    // Nº de plazas de cartera para 'equalN'. Default = tamaño del universo (equiponderado puro).
    this.positionSlots = options.positionSlots ?? null;

    // MODO SEÑAL en el motor — OPT-IN, nunca por defecto (`node backtest.js --signal`).
    // Mide lo MISMO que mide el bot live desde 2026-08-29: nocional fijo por señal y capital
    // ilimitado, para que win rate, % medio por operación y profit factor describan la SEÑAL y no
    // la cartera. ⚠️ Con capital ilimitado, MaxDrawdown / Calmar / ROI pierden sentido económico,
    // así que el gate de adopción (`abtest.js`, `robustgate.js`) debe seguir corriendo en modo
    // CARTERA. Son dos preguntas distintas: "¿acierta la señal?" vs "¿qué hace la cartera?".
    this.signalMode = options.signalMode
      ? { notional: options.signalMode.notional ?? SIGNAL_MODE.notionalPerSignal }
      : null;

    // Circuit breaker de cartera (auditoría 2026-08-29 H2): existía SOLO en el live, así que
    // ningún backtest publicado describía la estrategia que realmente corre. Se porta aquí para
    // paridad; `portfolioCircuitBreaker: null` lo desactiva (y así se puede medir su efecto).
    this.circuitBreaker = options.portfolioCircuitBreaker !== undefined
      ? options.portfolioCircuitBreaker
      : (PORTFOLIO_CIRCUIT_BREAKER && PORTFOLIO_CIRCUIT_BREAKER.enabled ? { ...PORTFOLIO_CIRCUIT_BREAKER } : null);
    this.cbPeak = 0;
    this.cbPausedUntil = 0;
    this.cbCooling = false;
    this.cbTriggers = 0;

    this.exitMode = options.exitMode || 'fixed';
    this.atrPeriod = options.atrPeriod || 14;
    this.atrSLMult = options.atrSLMult || 2.0;        // SL = entry - 2×ATR
    this.atrTrailMult = options.atrTrailMult || 3.0;  // Chandelier trail = peak - 3×ATR
    this.partialExitAtR = options.partialExitAtR || 0; // 0 = off, >0 = vende 50% al alcanzar X·R

    // Regime-gate params (V4-C)
    this.regimeOpts = options.regimeOpts || {};

    // Vol-targeting (sizing dinámico). null/disabled = sizing fijo histórico (investigación §2.1).
    this.volTarget = options.volTarget || null;

    // Modo LONG/SHORT (solo con exitMode 'signal'): always-in-the-market. BUY = largo (cierra
    // corto si lo hay), SELL = corto (cierra largo si lo hay). Para el canal SMA150 long/short.
    this.longShort = options.longShort || false;

    // Datos pre-descargados (sweep.js reutiliza una sola descarga entre combos)
    this.dataBySymbol = options.dataBySymbol || null;

    // Buffer/warmup configurables (V5 usa EMA200 → necesita ventana mayor).
    // Default alineado con LOOKBACK_15M para PARIDAD EXACTA del último valor de los indicadores
    // recursivos (EMA/ADX/MFI/CHOP) entre live y backtest (fix auditoría #10).
    this.bufferSize = options.bufferSize ?? LOOKBACK_15M;
    this.minCandles = options.minCandles ?? 120;

    // Validación out-of-sample: split temporal train/holdout
    this.oosSplitRatio = options.oosSplitRatio ?? 0.7; // 70% train, 30% holdout
    this.splitTime = null;  // se calcula en run() una vez conocidos los datos

    this.state = {
      balance: this.initialBalance,
      openPositions: {},
      tradeHistory: [],
      equityCurve: [],
      cooldowns: {},
      // Cooldown DEDICADO del stop de catástrofe del largo. Mapa aparte a propósito: reutilizar
      // `cooldowns` acoplaría el stop del largo con el del corto (un stop de corto pasaría a
      // bloquear también la entrada larga) y la variante dejaría de ser UN solo cambio. Con
      // longStopPct=0 este mapa queda siempre vacío → el baseline es provablemente idéntico.
      longCooldowns: {}
    };

    // Trackers de drawdown a RESOLUCIÓN COMPLETA (fix #1): el equityCurve almacenado se
    // submuestrea a ~1h para el plot, pero el MaxDD se mide en CADA vela aquí, por fase.
    this.ddTrack = {
      full:    { peak: -Infinity, maxDD: 0 },
      train:   { peak: -Infinity, maxDD: 0 },
      holdout: { peak: -Infinity, maxDD: 0 },
    };
    this.lastEventTime = 0; // máximo timestamp de vela visto (para cierres END_OF_BACKTEST)
  }

  // Fuente ÚNICA del filtro de universo: `config.isBlacklisted` (auditoría 2026-08-29 H6).
  // Antes el motor tenía su PROPIA copia con la misma comparación por substring sin anclar,
  // así que el fix en config.js no habría llegado hasta aquí y backtest y live seguirían
  // corriendo universos distintos por otra vía.
  filterSymbols(symbols) {
    return symbols.filter(symbol => {
      const bad = isBlacklisted(symbol);
      if (bad) console.log(`🚫 ${symbol} eliminado por Blacklist`);
      return !bad;
    });
  }

  async fetchHistoricalData(symbol) {
    const limit = 1000;
    const msInMonth = 30 * 24 * 60 * 60 * 1000;
    const endTime = Date.now();
    const startTime = endTime - (this.months * msInMonth);

    let allKlines = [];
    let currentStartTime = startTime;

    console.log(`📥 Descargando datos para ${symbol}...`);

    while (currentStartTime < endTime) {
      // Retry con backoff (auditoría 2026-07-09): antes un fallo transitorio hacía `break`
      // SILENCIOSO a mitad de paginación → dataset truncado → métricas de backtest erróneas
      // sin aviso. Ahora se reintenta y, si aun así falla, se lanza (fallo ruidoso > dato falso).
      let klines = null, lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/klines`, {
            params: { symbol, interval: this.interval, limit, startTime: currentStartTime },
            timeout: 15000,
          });
          klines = response.data;
          break;
        } catch (error) {
          lastErr = error;
          const status = error.response?.status;
          const retryable = !status || status === 429 || status === 418 || status >= 500;
          if (!retryable || attempt === 3) break;
          const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 200);
          console.warn(`⚠️ ${symbol}: intento ${attempt + 1} falló (${status || error.code}); reintento en ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (klines === null) {
        throw new Error(`Descarga incompleta para ${symbol} (${lastErr?.message}); backtest abortado para no computar sobre datos truncados.`);
      }
      if (klines.length === 0) break;

      allKlines = allKlines.concat(klines.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      })));

      currentStartTime = klines[klines.length - 1][0] + 1;
      if (klines.length < limit) break;
    }

    console.log(`   ✅ ${allKlines.length} velas descargadas para ${symbol}`);
    return allKlines;
  }

  async run() {
    console.log('🚀 Iniciando simulación...');
    console.log(`📋 Estrategia: ${strategyName(this.strategyVersion)}`);
    if (this.exitMode === 'atr') {
      console.log(`🎯 EXIT=ATR | SL=${this.atrSLMult}×ATR | Chandelier=${this.atrTrailMult}×ATR | partial@${this.partialExitAtR}R`);
    } else {
      console.log(`🎯 TP: +${this.takeProfitPct}% | SL: -${this.stopLossPct}% | Trail: +${this.trailingActivation}%→${(this.trailingDistance * 100).toFixed(0)}%peak`);
    }
    const rtCost = ((this.feePct + this.slippagePct) * 2 * 100).toFixed(2);
    console.log(`💸 Costes: fee ${(this.feePct*100).toFixed(2)}%/lado + slippage ${(this.slippagePct*100).toFixed(2)}%/lado = ${rtCost}% round-trip`);

    this.symbols = this.filterSymbols(this.symbols);
    console.log(`🪙 Símbolos válidos: ${this.symbols.join(', ')}`);

    // 1. Datos: usar los inyectados (sweep reutiliza la descarga) o descargar
    let dataBySymbol;
    if (this.dataBySymbol) {
      dataBySymbol = {};
      for (const symbol of this.symbols) dataBySymbol[symbol] = this.dataBySymbol[symbol] || [];
    } else {
      dataBySymbol = {};
      for (const symbol of this.symbols) {
        dataBySymbol[symbol] = await this.fetchHistoricalData(symbol);
      }
    }

    // 2. Crear eventos cronológicos unificados
    const allEvents = [];
    for (const symbol in dataBySymbol) {
      dataBySymbol[symbol].forEach(k => allEvents.push({ ...k, symbol }));
    }
    allEvents.sort((a, b) => a.time - b.time);

    // Calcular timestamp de split train/holdout
    if (allEvents.length > 0) {
      const startTime = allEvents[0].time;
      const endTime = allEvents[allEvents.length - 1].time;
      this.splitTime = startTime + (endTime - startTime) * this.oosSplitRatio;
      const splitDate = new Date(this.splitTime).toISOString().slice(0, 10);
      console.log(`🔀 OOS split (${(this.oosSplitRatio*100).toFixed(0)}/${((1-this.oosSplitRatio)*100).toFixed(0)}): train hasta ${splitDate}, holdout después`);
    }

    // Benchmark buy&hold equiponderado por fase (referencia honesta: el objetivo es mejor
    // Sharpe/drawdown que HODL del MISMO periodo, no batir a cash)
    this.buyHold = this.computeBuyHold(dataBySymbol);
    this.buyHoldTrain = this.computeBuyHold(dataBySymbol, null, this.splitTime);
    this.buyHoldHoldout = this.computeBuyHold(dataBySymbol, this.splitTime, null);
    // Benchmark BTC-only HODL (fix #19): aísla el alfa de la estrategia del azar de selección
    // de la cesta. Solo se computa si BTC está en el universo.
    const btcSym = Object.keys(dataBySymbol).find(s => s.includes('BTC'));
    this.btcHold = btcSym ? this.computeBuyHold({ [btcSym]: dataBySymbol[btcSym] }) : null;
    // Serie del benchmark equiponderado para superponer en la curva de equity del reporte
    this.benchmarkSeries = this.computeBuyHoldSeries(dataBySymbol);

    // Funding real firmado (research 2026-07 #1): descargar la serie del perp si no la inyectaron.
    if (this.longShort && this.fundingMode === 'real' && !this.fundingSeries && allEvents.length > 0) {
      console.log('💱 Descargando funding real de perps (modo funding=real)...');
      this.fundingSeries = await binance.getFundingCumSeries(this.symbols, allEvents[0].time, allEvents[allEvents.length - 1].time + 86400000);
      const got = Object.keys(this.fundingSeries);
      console.log(`   ✅ funding real para ${got.length}/${this.symbols.length} símbolos${got.length < this.symbols.length ? ' (resto → flat)' : ''}`);
    }

    // Buffers OHLCV por símbolo (V3 necesita high, low, volume además de close)
    const candleBuffers = {};
    const currentPrices = {};
    this.symbols.forEach(s => {
      candleBuffers[s] = { closes: [], highs: [], lows: [], volumes: [] };
      currentPrices[s] = 0;
    });
    this._candleBuffers = candleBuffers; // ref para multiplicadores de riesgo (pánico BTC, #7a)
    this._btcKey = this.symbols.find(s => s.includes('BTC')) || null;

    console.log(`📈 Procesando ${allEvents.length} eventos históricos...`);

    for (const event of allEvents) {
      const { symbol, close, high, low, volume, time } = event;
      const buf = candleBuffers[symbol];
      
      buf.closes.push(close);
      buf.highs.push(high);
      buf.lows.push(low);
      buf.volumes.push(volume);
      currentPrices[symbol] = close;
      if (time > this.lastEventTime) this.lastEventTime = time;

      // Mantener buffer (configurable; V5 necesita >200 para EMA200)
      const maxBuf = this.bufferSize;
      if (buf.closes.length > maxBuf) {
        buf.closes.shift();
        buf.highs.shift();
        buf.lows.shift();
        buf.volumes.shift();
      }

      // Decrementar cooldowns
      if (this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0) {
        this.state.cooldowns[symbol]--;
      }
      if (this.state.longCooldowns && this.state.longCooldowns[symbol] > 0) {
        this.state.longCooldowns[symbol]--;
      }

      if (buf.closes.length < this.minCandles) continue;

      // Evaluar Estrategia según versión
      let signal;
      switch (String(this.strategyVersion)) {
        case '1':  signal = evaluateStrategy(buf.closes); break;
        case '2':  signal = evaluateStrategyV2(buf.closes); break;
        case '3':  signal = evaluateStrategyV3(buf); break;
        case '4A': signal = evaluateStrategyV4A(buf); break;
        case '4B': signal = evaluateStrategyV4B(buf); break;
        case '4C': signal = evaluateStrategyV4C(buf, this.regimeOpts); break;
        case '5':  signal = evaluateStrategyV5(buf, this.regimeOpts); break;
        case '6':  signal = evaluateStrategyV6(buf, this.regimeOpts); break;
        case 'SMA200':   signal = evaluateStrategySMA200(buf, this.regimeOpts); break;
        case 'STDAY':    signal = evaluateStrategySupertrendDaily(buf, this.regimeOpts); break;
        case 'DONCHIAN': signal = evaluateStrategyDonchian(buf, this.regimeOpts); break;
        case 'MACRO_OSC':
        case '7':
        case 'V7':       signal = evaluateStrategyMacroOscillator(buf, this.regimeOpts); break;
        default:   signal = evaluateStrategyV3(buf);
      }

      const hasPosition = !!this.state.openPositions[symbol];
      const isOnCooldown = this.state.cooldowns[symbol] && this.state.cooldowns[symbol] > 0;

      // ── Stop de CATÁSTROFE del LARGO (candidata 2026-09-05; off por defecto) ──
      // Se evalúa ANTES de la señal, igual que el del corto, para que una posición cortada no
      // pase además por la lógica de flip/piramidación en la misma vela. Cubre los DOS canales
      // (long-only y long/short) desde un único punto → sin divergencia entre ellos.
      if (this.longStopPct > 0 && this.exitMode === 'signal' && hasPosition) {
        const lp = this.state.openPositions[symbol];
        if (lp && lp.side !== 'short' && close <= (lp.entryPrice ?? lp.buyPrice) * (1 - this.longStopPct)) {
          this.executeSell(symbol, close, time, 'STOP_LOSS');
          // Después de executeSell: su rama STOP_LOSS ya escribe `cooldowns`, y aquí se fija el
          // cooldown propio del largo, que es el que gobierna la reentrada.
          this.state.longCooldowns[symbol] = this.longStopCooldown;
          this.trackDrawdown(time, currentPrices);
          this.recordEquity(time, currentPrices);
          continue;
        }
      }
      const longOnCooldown = !!(this.state.longCooldowns && this.state.longCooldowns[symbol] > 0);

      if (this.longShort && this.exitMode === 'signal') {
        // ALWAYS-IN long/short: la señal dicta el lado. BUY → largo (cierra corto previo);
        // SELL → corto (cierra largo previo). Flip en el cruce de la SMA.
        const pos = this.state.openPositions[symbol];
        // ── Gestión de SALIDA del corto (antes de la señal) ──
        if (pos && pos.side === 'short') {
          if (close < pos.lowestLow) pos.lowestLow = close; // actualizar extremo favorable
          let shortExit = null;
          // 1) STOP DURO / catastrophe (auditoría): cubrir si sube ≥shortStopPct sobre la entrada.
          if (this.shortStopPct > 0 && close >= pos.entryPrice * (1 + this.shortStopPct)) shortExit = 'STOP_LOSS';
          // 2) Chandelier del corto (#9): cubrir si close > minLow + k·ATR14.
          else if (this.shortTrailAtr > 0) {
            const atr = this.getCurrentATR(buf);
            if (atr && close > pos.lowestLow + this.shortTrailAtr * atr) shortExit = 'TRAILING_STOP';
          }
          // 3) Time-stop (#9): a los N días sin beneficio (precio ≥ entrada), cubrir.
          if (!shortExit && this.shortTimeStopDays > 0) {
            const daysHeld = (time - new Date(pos.time).getTime()) / 86400000;
            if (daysHeld >= this.shortTimeStopDays && close >= pos.entryPrice) shortExit = 'TIME_STOP';
          }
          if (shortExit) {
            this.executeShortClose(symbol, close, time, shortExit);
            if (shortExit === 'STOP_LOSS') this.state.cooldowns[symbol] = this.shortStopCooldown;
            this.trackDrawdown(time, currentPrices);
            this.recordEquity(time, currentPrices);
            continue;
          }
        }
        if (signal === 'BUY') {
          if (pos && pos.side === 'short') this.executeShortClose(symbol, close, time, 'SIGNAL');
          const cur = this.state.openPositions[symbol];
          if (!cur && !longOnCooldown && this.canOpenPosition(currentPrices) && this.longEntryAllowed() && this.donchianLongAllowed(buf)) {
            this.executeBuy(symbol, close, time, null, buf);
          } else if (cur && cur.side === 'long') {
            this.tryPyramidAdd(symbol, close, buf, currentPrices); // candidata pyramid (no-op si off)
          }
        } else if (signal === 'SELL') {
          if (pos && pos.side === 'long') this.executeSell(symbol, close, time, 'SIGNAL');
          // No re-shortear durante el cooldown post-stop, y solo si el filtro de entrada lo permite.
          const entryOk = shortEntryAllowed(buf.closes, { ...this.shortEntry, smaPeriod: this.regimeOpts.smaPeriod ?? 150 });
          if (!this.state.openPositions[symbol] && !isOnCooldown && entryOk && this.canOpenPosition(currentPrices) && this.shortAllowedByBtc()) this.executeShortOpen(symbol, close, time, buf);
        }
        this.trackDrawdown(time, currentPrices);
        this.recordEquity(time, currentPrices);
        continue;
      }

      // Lógica de Compra (con caps de cartera, fix #26)
      if (signal === 'BUY' && !hasPosition && !isOnCooldown && !longOnCooldown && this.canOpenPosition(currentPrices) && this.longEntryAllowed() && this.donchianLongAllowed(buf)) {
        // Si modo ATR, anclar SL/peak iniciales con ATR del momento
        const entryATR = this.exitMode === 'atr'
          ? this.getCurrentATR(buf)
          : null;
        this.executeBuy(symbol, close, time, entryATR, buf);
      }
      // Piramidación (candidata research 2026-07-10): tranche extra en tendencia confirmada.
      // Solo exitMode 'signal' (familia diaria): los exits TP/SL % asumen una sola entrada.
      else if (signal === 'BUY' && hasPosition && this.exitMode === 'signal') {
        this.tryPyramidAdd(symbol, close, buf, currentPrices);
      }
      // Lógica de Venta por señal
      else if (signal === 'SELL' && hasPosition) {
        this.executeSell(symbol, close, time, 'SIGNAL');
      }

      // Lógica de salida. 'signal' = la propia estrategia (SELL) gestiona la salida;
      // sin TP/SL/trailing (la regla del indicador ES el trailing stop). Para la familia diaria.
      if (this.exitMode !== 'signal' && hasPosition && this.state.openPositions[symbol]) {
        const pos = this.state.openPositions[symbol];

        // Actualizar precio máximo alcanzado (común a ambos modos)
        if (close > (pos.peakPrice || pos.buyPrice)) {
          pos.peakPrice = close;
        }

        if (this.exitMode === 'atr') {
          this.applyATRExits(symbol, close, time, pos);
        } else {
          this.applyFixedExits(symbol, close, time, pos);
        }
      }

      this.trackDrawdown(time, currentPrices); // MaxDD a resolución completa (fix #1)
      this.recordEquity(time, currentPrices);  // curva submuestreada para el plot
    }

    // Cerrar posiciones al final usando el ÚLTIMO timestamp de vela (no Date.now(), fix #9):
    // evita duraciones infladas cuando los datos terminan en el pasado.
    const closeTime = this.lastEventTime || Date.now();
    for (const symbol in this.state.openPositions) {
      if (currentPrices[symbol]) {
        if (this.state.openPositions[symbol].side === 'short') {
          this.executeShortClose(symbol, currentPrices[symbol], closeTime, 'END_OF_BACKTEST');
        } else {
          this.executeSell(symbol, currentPrices[symbol], closeTime, 'END_OF_BACKTEST');
        }
      }
    }
    // Punto final de equity (sin throttle) para que la curva acabe en finalBalance
    this.trackDrawdown(closeTime, currentPrices);
    this.recordEquity(closeTime, currentPrices, true);

    return this.generateReport();
  }

  // Fracción del balance a invertir en una nueva posición. Por defecto positionSizePct;
  // con vol-targeting activado (config VOLTARGET) escala el tamaño base por volatilidad
  // realizada: menos tamaño cuando la moneda está volátil (investigación §2.1).
  computeSizeFraction(buf) {
    let frac = this.positionSizePct;
    if (this.volTarget && this.volTarget.enabled && buf && buf.closes.length > 20) {
      const vtOpts = { ...this.volTarget, periodsPerYear: periodsPerYearFor(this.interval) };
      // mode 'conditional' (research #4): solo recorta en el quintil alto de vol; si no, exposición plena.
      const w = this.volTarget.mode === 'conditional'
        ? computeVolTargetWeightConditional(buf.closes, vtOpts)
        : computeVolTargetWeight(buf.closes, vtOpts);
      frac = this.positionSizePct * w;
      if (w <= (this.volTarget.minWeight ?? 0)) frac = 0;
    }
    return frac;
  }

  // SMA simple del último valor sobre los últimos n cierres (helper local).
  _smaLast(closes, n) {
    if (!closes || closes.length < n) return null;
    let s = 0;
    for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
    return s / n;
  }

  // Gate maestro BTC para entradas LARGAS (candidata btcGateLong): si BTC < SMA(period), no se
  // abren largos nuevos. Sin datos suficientes de BTC → no bloquear (fail-open, igual que btcRegimeOn).
  // Gate maestro BTC para entradas CORTAS: si BTC está alcista (Risk-On), NO shortear altcoins.
  shortAllowedByBtc() {
    if (!this.btcGateLong || !this._btcKey || !this._candleBuffers?.[this._btcKey]) return true;
    const c = this._candleBuffers[this._btcKey].closes;
    const smaPeriod = this.btcGateLong.smaPeriod ?? 200;
    const btcRiskOn = btcRegimeOn(c, smaPeriod, { ...REGIME, ...this.btcGateLong });
    return !btcRiskOn;
  }

  longEntryAllowed() {
    if (!this.btcGateLong || !this._btcKey || !this._candleBuffers?.[this._btcKey]) return true;
    const c = this._candleBuffers[this._btcKey].closes;
    const smaPeriod = this.btcGateLong.smaPeriod ?? 200;
    return btcRegimeOn(c, smaPeriod, { ...REGIME, ...this.btcGateLong });
  }

  /**
   * Gate Donchian de horizonte lento para LARGOS: el cierre debe ser el MÁXIMO de los últimos n
   * días (evaluación CONTINUA, no solo el día del cruce de la SMA — la versión "solo en el cruce"
   * deja pasar 13 de 251 entradas con n=90 y es inaplicable).
   * Fail-open si el buffer no alcanza (mismo criterio que el resto de gates).
   */
  donchianLongAllowed(buf) {
    if (!this.donchianLongGate || !buf) return true;
    const n = this.donchianLongGate.lookbackDays ?? 90;
    const closes = buf.closes;
    if (!closes || closes.length < n + 1) return true; // fail-open
    const window = closes.slice(closes.length - n - 1, closes.length - 1); // n cierres ANTERIORES
    const last = closes[closes.length - 1];
    let max = -Infinity;
    for (const v of window) if (v > max) max = v;
    return last >= max;
  }

  // Multiplicador de fuerza de tendencia al abrir (candidata entryTilt, Carver-lite):
  // z = |ln(close/SMA)| en unidades de σ del horizonte; clamp [floor, 1]. Side-agnóstico.
  entryTiltMult(buf) {
    if (!this.entryTilt || !buf) return 1;
    const closes = buf.closes;
    const sma = this._smaLast(closes, this.regimeOpts.smaPeriod ?? 150);
    if (!(sma > 0)) return 1;
    const vol = dailyVol(closes, 20);
    if (!Number.isFinite(vol) || vol <= 0) return 1;
    const H = this.entryTilt.horizonDays ?? 30;
    const z = Math.abs(Math.log(closes[closes.length - 1] / sma)) / (vol * Math.sqrt(H));
    return Math.max(this.entryTilt.floor ?? 0.25, Math.min(1, z));
  }

  // Piramidación estilo Turtle en LARGOS (candidata pyramid): tranche extra cuando el precio
  // confirma subiendo stepPct sobre la última entrada/añadido, hasta maxAdds. Respeta el cap de
  // exposición (no el de nº de posiciones: es la MISMA posición). El P&L agrega amount/invested.
  tryPyramidAdd(symbol, price, buf, currentPrices) {
    if (!this.pyramid) return;
    const pos = this.state.openPositions[symbol];
    if (!pos || pos.side === 'short') return;
    const step = this.pyramid.stepPct ?? 0.10;
    const maxAdds = this.pyramid.maxAdds ?? 2;
    if ((pos.adds ?? 0) >= maxAdds) return;
    const anchor = pos.lastAddPrice ?? pos.buyPrice;
    if (!(price >= anchor * (1 + step))) return;
    if (!this.canOpenPosition(currentPrices, true)) return;
    const sizeFrac = this.computeSizeFraction(buf) * this.entryTiltMult(buf);
    const investAmount = Math.min(this.sizingBase() * sizeFrac, this.state.balance);
    if (!(investAmount > 0)) return;
    const fillPrice = price * (1 + this.slippagePct);
    const buyFee = investAmount * this.feePct;
    pos.amount += (investAmount - buyFee) / fillPrice;
    pos.invested += investAmount;
    pos.adds = (pos.adds ?? 0) + 1;
    pos.lastAddPrice = price;
    this.state.balance -= investAmount;
  }

  // Caps de cartera (fix #26): nº máximo de posiciones simultáneas y exposición agregada.
  // En modo long/short, si no hay override, aplican los caps de LONGSHORT (paridad con el live,
  // auditoría 2026-07-03 #5). Exposición SIDE-AWARE: un corto compromete su MARGEN (invested),
  // no el nocional a mercado (antes un rally agregado bloqueaba aperturas de más).
  canOpenPosition(currentPrices, isAdd = false) {
    if (this.signalMode) return true;           // en modo señal no hay guardas de cartera
    if (this.cbPausedUntil > 0) return false;   // pausa vigente del circuit breaker
    const maxPos = this.maxConcurrentPositions ?? (this.longShort ? LONGSHORT.maxConcurrentPositions : null);
    const maxExp = this.maxExposurePct ?? (this.longShort ? LONGSHORT.maxExposurePct : null);
    const openCount = Object.keys(this.state.openPositions).length;
    if (!isAdd && maxPos != null && openCount >= maxPos) return false;
    if (maxExp != null) {
      const eq = this.currentEquity(currentPrices);
      let invested = 0;
      for (const s in this.state.openPositions) {
        const p = this.state.openPositions[s];
        invested += p.side === 'short' ? p.invested : p.amount * (currentPrices[s] || p.buyPrice);
      }
      if (eq > 0 && invested / eq >= maxExp) return false;
    }
    return true;
  }

  // Base sobre la que se aplica la fracción de tamaño. 'equity' = caja + coste de las abiertas:
  // invariante dentro de la misma barra, así que el reparto NO depende del orden de los símbolos.
  sizingBase() {
    if (this.sizeBasis === 'cash') return this.state.balance;
    let invested = 0;
    for (const s in this.state.openPositions) invested += this.state.openPositions[s].invested || 0;
    return this.state.balance + invested;
  }

  /** Fracción del BASE que recibe una posición nueva. En 'equalN' es 1/plazas, no positionSizePct. */
  slotFraction() {
    if (this.sizeBasis !== 'equalN') return null;
    const slots = this.positionSlots ?? (this.symbols.length || 1);
    return slots > 0 ? 1 / slots : null;
  }

  executeBuy(symbol, price, time, entryATR = null, buf = null) {
    let investAmount;
    if (this.signalMode) {
      investAmount = this.signalMode.notional;   // fijo, sin tope de caja: no se pierde una señal
    } else {
      let sizeFrac = this.computeSizeFraction(buf) * this.entryTiltMult(buf);
      // 'equalN': la plaza manda sobre positionSizePct; el vol-target sigue aplicando como recorte.
      const slot = this.slotFraction();
      if (slot != null) sizeFrac = slot * (this.positionSizePct > 0 ? sizeFrac / this.positionSizePct : 1);
      if (sizeFrac <= 0) return; // vol-targeting devolvió peso 0 (régimen demasiado volátil)
      investAmount = Math.min(this.sizingBase() * sizeFrac, this.state.balance);
    }
    if (!(investAmount > 0)) return;

    // Costes de entrada: slippage (peor precio de compra) + comisión sobre el notional.
    // amountCrypto se reduce por ambos → el coste queda baked-in en el P&L y la equity.
    const fillPrice = price * (1 + this.slippagePct);
    const buyFee = investAmount * this.feePct;
    const amountCrypto = (investAmount - buyFee) / fillPrice;

    this.state.balance -= investAmount;
    this.state.openPositions[symbol] = {
      side: 'long',
      amount: amountCrypto,
      buyPrice: price,        // precio de mercado RAW (base de los umbrales TP/SL/trailing)
      invested: investAmount, // capital comprometido (incluye fee de entrada)
      time: new Date(time).toISOString(),
      trailingActivated: false,
      trailingSL: 0,
      peakPrice: price,
      // ATR-mode bookkeeping
      entryATR: entryATR,
      atrSL: entryATR ? price - this.atrSLMult * entryATR : null,
      partialTaken: false
    };
  }

  // Coste de carry del corto para un tramo [fromMs, toMs] (research 2026-07 #1).
  // Modo 'real': funding FIRMADO del perp — positivo = el corto COBRA (coste negativo),
  // negativo = el corto paga. Modo 'flat' (default): 0.03%/día siempre en contra (conservador).
  shortFundingCost(symbol, fromMs, toMs, invested) {
    const series = this.fundingSeries && this.fundingSeries[symbol];
    if (this.fundingMode === 'real' && series) {
      const received = invested * (cumRateAt(series, toMs) - cumRateAt(series, fromMs));
      return -received; // lo cobrado reduce el coste
    }
    const daysHeld = Math.max(0, (toMs - fromMs) / 86400000);
    return invested * this.fundingDailyShort * daysHeld;
  }

  // Abre un CORTO (solo modo long/short, exitMode 'signal'). Modelo de margen: se reserva
  // `invested` del balance; el P&L se realiza al cubrir. amount = unidades nocionales (precio raw).
  // κ (shortRiskFraction, research #3): presupuesto de riesgo asimétrico del corto — el corto
  // toma κ× el tamaño que tomaría un largo. Default 1.0 (simétrico, comportamiento actual).
  // Multiplicador de exposición del corto por seguros de cola (research #7a pánico / #6 funding).
  shortRiskMultiplier(symbol, time) {
    let m = 1;
    if (this.panicDerisk && this._btcKey && this._candleBuffers[this._btcKey]) {
      const c = this._candleBuffers[this._btcKey].closes;
      const L = this.panicDerisk.btcLookback ?? 60;
      if (c.length > L) {
        const ret = c[c.length - 1] / c[c.length - 1 - L] - 1;
        // vol percentil sobre la ventana del buffer
        const vols = [];
        for (let i = 21; i < c.length; i++) { const v = dailyVol(c.slice(0, i + 1), 20); if (Number.isFinite(v)) vols.push(v); }
        const curVol = vols[vols.length - 1];
        let below = 0; for (const v of vols) if (v <= curVol) below++;
        const volPct = vols.length ? below / vols.length : 0;
        if (ret < (this.panicDerisk.btcThreshold ?? -0.30) && volPct > (this.panicDerisk.volPct ?? 0.80)) {
          m *= (this.panicDerisk.multiplier ?? 0.5);
        }
      }
    }
    if (this.fundingKill && this.fundingSeries) {
      const series = this.fundingSeries[symbol] || (this._btcKey && this.fundingSeries[this._btcKey]);
      if (series && series.length > 2) {
        const days = this.fundingKill.avgDays ?? 30;
        const cumNow = cumRateAt(series, time);
        const cumPrev = cumRateAt(series, time - days * 86400000);
        const avg = (cumNow - cumPrev); // acumulado en la ventana (negativo = el corto paga)
        if (avg < (this.fundingKill.threshold ?? 0)) m *= (this.fundingKill.multiplier ?? 0.5);
      }
    }
    return m;
  }

  executeShortOpen(symbol, price, time, buf = null) {
    let invested;
    if (this.signalMode) {
      invested = this.signalMode.notional;
    } else {
      let sizeFrac = this.computeSizeFraction(buf) * this.entryTiltMult(buf) * (this.shortRiskFraction ?? 1) * this.shortRiskMultiplier(symbol, time);
      const slotS = this.slotFraction();
      if (slotS != null) sizeFrac = slotS * (this.positionSizePct > 0 ? sizeFrac / this.positionSizePct : 1);
      if (sizeFrac <= 0) return;
      invested = Math.min(this.sizingBase() * sizeFrac, this.state.balance); // margen reservado
    }
    if (!(invested > 0)) return;
    const amount = invested / price;
    this.state.balance -= invested;
    this.state.openPositions[symbol] = {
      side: 'short',
      amount,
      buyPrice: price,        // = entryPrice (nombre compartido para reporting/peak)
      entryPrice: price,
      invested,
      time: new Date(time).toISOString(),
      peakPrice: price,
      lowestLow: price,       // extremo favorable del corto (para el Chandelier trail, #9)
    };
  }

  // Cierra un CORTO (buy-to-cover). P&L = amount·[entry·(1−slip−fee) − price·(1+slip+fee)] − borrow.
  executeShortClose(symbol, price, time, reason) {
    const pos = this.state.openPositions[symbol];
    if (!pos || pos.side !== 'short') return;
    const entry = pos.entryPrice;
    const slip = this.slippagePct, fee = this.feePct;
    const proceedsEntry = pos.amount * entry * (1 - slip) - pos.amount * entry * fee; // vender al abrir
    const costCover = pos.amount * price * (1 + slip) + pos.amount * price * fee;     // comprar al cerrar
    // Coste de carry (funding/borrow) del tramo mantenido — flat o serie real firmada.
    const fundingCost = this.shortFundingCost(symbol, new Date(pos.time).getTime(), time, pos.invested);
    const profit = proceedsEntry - costCover - fundingCost;
    const profitPct = (profit / pos.invested) * 100;
    this.state.balance += pos.invested + profit;

    const phase = (this.splitTime && time >= this.splitTime) ? 'holdout' : 'train';
    this.state.tradeHistory.push({
      symbol, side: 'short', buyPrice: entry, sellPrice: price,
      profit: parseFloat(profit.toFixed(2)), profitPct: parseFloat(profitPct.toFixed(2)),
      invested: parseFloat(pos.invested.toFixed(2)),
      buyTime: pos.time, sellTime: new Date(time).toISOString(), reason, phase,
    });
    delete this.state.openPositions[symbol];
  }

  getCurrentATR(buf) {
    const atrArr = calculateATR(buf.highs, buf.lows, buf.closes, this.atrPeriod);
    return atrArr.length > 0 ? atrArr[atrArr.length - 1] : null;
  }

  applyFixedExits(symbol, close, time, pos) {
    // Decisión vía la FUENTE ÚNICA compartida con el bot live (fix #2 → paridad garantizada).
    const d = evaluateFixedExit(pos, close, {
      takeProfitPct: this.takeProfitPct,
      stopLossPct: this.stopLossPct,
      trailingActivation: this.trailingActivation,
      trailingDistance: this.trailingDistance,
    });
    pos.peakPrice = d.peakPrice;
    pos.trailingActivated = d.trailingActivated;
    pos.trailingSL = d.trailingSL;

    if (d.action === 'TAKE_PROFIT') {
      this.executeSell(symbol, close, time, 'TAKE_PROFIT');
    } else if (d.action === 'TRAILING_STOP') {
      this.executeSell(symbol, close, time, 'TRAILING_STOP');
    } else if (d.action === 'STOP_LOSS') {
      this.executeSell(symbol, close, time, 'STOP_LOSS');
      this.state.cooldowns[symbol] = this.cooldownCandles;
    }
  }

  applyATRExits(symbol, close, time, pos) {
    if (!pos.entryATR) {
      // fallback a fixed si no hay ATR válido
      this.applyFixedExits(symbol, close, time, pos);
      return;
    }
    const R = this.atrSLMult * pos.entryATR; // unidad de riesgo (precio)

    // Partial profit-taking opcional a Nx ese R inicial
    if (this.partialExitAtR > 0 && !pos.partialTaken) {
      const targetPrice = pos.buyPrice + this.partialExitAtR * R;
      if (close >= targetPrice) {
        const halfAmount = pos.amount * 0.5;
        // Costes de salida también en la toma parcial
        const fillPrice = close * (1 - this.slippagePct);
        const grossReturn = halfAmount * fillPrice;
        const returnAmount = grossReturn - grossReturn * this.feePct;
        const halfInvested = pos.invested * 0.5;
        const partialProfit = returnAmount - halfInvested;
        const partialPct = (partialProfit / halfInvested) * 100;
        this.state.balance += returnAmount;
        this.state.tradeHistory.push({
          symbol, side: pos.side || 'long', buyPrice: pos.buyPrice, sellPrice: close,
          profit: parseFloat(partialProfit.toFixed(2)),
          profitPct: parseFloat(partialPct.toFixed(2)),
          invested: parseFloat(halfInvested.toFixed(2)),
          buyTime: pos.time, sellTime: new Date(time).toISOString(),
          reason: 'PARTIAL_TP',
          // Fase por sellTime (fix #7/#20): el P&L se realiza al CIERRE, así la métrica por
          // trade coincide con el tramo de equity donde realmente impacta.
          phase: (this.splitTime && time >= this.splitTime) ? 'holdout' : 'train'
        });
        pos.amount -= halfAmount;
        pos.invested -= halfInvested;
        pos.partialTaken = true;
        // ⚠️ Auditoría 2026-08-29: AQUÍ se movía el SL a breakeven (`pos.atrSL = pos.buyPrice`).
        // Combinado con el truncamiento del parcial es la variante MÁS dañina posible: corta la
        // cola derecha y además convierte en breakeven cualquier retroceso normal del trend.
        // El trailing/Chandelier sigue gestionando la salida del resto de la posición.
      }
    }

    // Chandelier trail: SL dinámico = peak - atrTrailMult × ATR(entry)
    const chandelierSL = pos.peakPrice - this.atrTrailMult * pos.entryATR;
    if (chandelierSL > pos.atrSL) pos.atrSL = chandelierSL;

    if (close <= pos.atrSL) {
      const reason = pos.peakPrice > pos.buyPrice * 1.01 ? 'TRAILING_STOP' : 'STOP_LOSS';
      this.executeSell(symbol, close, time, reason);
      if (reason === 'STOP_LOSS') this.state.cooldowns[symbol] = this.cooldownCandles;
    }
  }

  executeSell(symbol, price, time, reason) {
    const pos = this.state.openPositions[symbol];
    if (!pos) return;

    // Costes de salida: slippage (peor precio de venta) + comisión sobre el retorno bruto.
    const fillPrice = price * (1 - this.slippagePct);
    const grossReturn = pos.amount * fillPrice;
    const sellFee = grossReturn * this.feePct;
    const returnAmount = grossReturn - sellFee;
    const profit = returnAmount - pos.invested;
    const profitPct = (profit / pos.invested) * 100;

    this.state.balance += returnAmount;
    // Fase por sellTime (fix #7/#20): el P&L se realiza al cerrar, así la métrica por trade
    // queda atribuida a la misma fase (train/holdout) donde mueve la equity.
    const phase = (this.splitTime && time >= this.splitTime) ? 'holdout' : 'train';
    this.state.tradeHistory.push({
      symbol,
      side: pos.side || 'long',
      buyPrice: pos.buyPrice,
      sellPrice: price,
      profit: parseFloat(profit.toFixed(2)),
      profitPct: parseFloat(profitPct.toFixed(2)),
      invested: parseFloat(pos.invested.toFixed(2)),
      buyTime: pos.time,
      sellTime: new Date(time).toISOString(),
      reason,
      phase
    });

    delete this.state.openPositions[symbol];
  }

  // Buy&hold equiponderado opcionalmente acotado a [fromTime, toTime). Normaliza CADA
  // símbolo a su primer close DENTRO de la ventana → ROI y MaxDD del índice equiponderado.
  computeBuyHold(dataBySymbol, fromTime = null, toTime = null) {
    const syms = Object.keys(dataBySymbol).filter(s => (dataBySymbol[s] || []).length > 0);
    if (syms.length === 0) return { roi: 0, maxDrawdown: 0 };
    const inWin = t => (fromTime === null || t >= fromTime) && (toTime === null || t < toTime);
    const norm = {};
    syms.forEach(s => {
      const d = dataBySymbol[s].filter(k => inWin(k.time));
      if (d.length === 0) { norm[s] = new Map(); return; }
      const first = d[0].close;
      const m = new Map();
      d.forEach(k => m.set(k.time, k.close / first));
      norm[s] = m;
    });
    const times = [...new Set(syms.flatMap(s => [...norm[s].keys()]))].sort((a, b) => a - b);
    let peak = -Infinity, maxDD = 0, firstVal = null, lastVal = null;
    for (const t of times) {
      let sum = 0, cnt = 0;
      for (const s of syms) { const v = norm[s].get(t); if (v !== undefined) { sum += v; cnt++; } }
      if (cnt === 0) continue;
      const val = sum / cnt;
      if (firstVal === null) firstVal = val;
      lastVal = val;
      if (val > peak) peak = val;
      const dd = (peak - val) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
    const roi = firstVal ? (lastVal / firstVal - 1) * 100 : 0;
    return { roi: parseFloat(roi.toFixed(2)), maxDrawdown: parseFloat(maxDD.toFixed(2)) };
  }

  // Serie temporal del índice buy&hold equiponderado (normalizado al primer close = 1) sobre TODO
  // el periodo. Para superponer el benchmark en la curva de equity del reporte HTML.
  computeBuyHoldSeries(dataBySymbol) {
    const syms = Object.keys(dataBySymbol).filter(s => (dataBySymbol[s] || []).length > 0);
    if (syms.length === 0) return [];
    const norm = {};
    syms.forEach(s => {
      const d = dataBySymbol[s];
      const first = d[0].close;
      const m = new Map();
      d.forEach(k => m.set(k.time, k.close / first));
      norm[s] = m;
    });
    const times = [...new Set(syms.flatMap(s => [...norm[s].keys()]))].sort((a, b) => a - b);
    const series = [];
    for (const t of times) {
      let sum = 0, cnt = 0;
      for (const s of syms) { const v = norm[s].get(t); if (v !== undefined) { sum += v; cnt++; } }
      if (cnt > 0) series.push({ time: t, val: sum / cnt });
    }
    return series;
  }

  // Muestrea el índice benchmark en los timestamps de la curva de equity (último val ≤ time),
  // escalado a initialBalance → curva comparable para el plot.
  sampleBenchmarkCurve(equityCurve) {
    const series = this.benchmarkSeries || [];
    if (series.length === 0) return [];
    const base = series[0].val || 1;
    const out = [];
    let j = 0;
    for (const p of equityCurve) {
      while (j + 1 < series.length && series[j + 1].time <= p.time) j++;
      const val = series[j] ? series[j].val : base;
      out.push({ time: p.time, equity: parseFloat((this.initialBalance * (val / base)).toFixed(2)) });
    }
    return out;
  }

  // Equity total (cash + posiciones valoradas a mercado) en este instante. Side-aware:
  // largo = amount·mkt; corto = margen + amount·(entry − mkt) − funding devengado (auditoría
  // 2026-07-03 #3: sin el devengo, la curva del corto era optimista y el funding aparecía como
  // un escalón artificial al cierre → MaxDD infra-medido). `time` (ms) opcional: sin él, no
  // se devenga (comportamiento previo, usado solo por canOpenPosition para el cap).
  currentEquity(currentPrices, time = null) {
    let investedValue = 0;
    for (const s in this.state.openPositions) {
      const pos = this.state.openPositions[s];
      const mkt = currentPrices[s] || pos.buyPrice;
      if (pos.side === 'short') {
        let fundingAccrued = 0;
        if (time != null) {
          const entryMs = new Date(pos.time).getTime();
          if (Number.isFinite(entryMs)) fundingAccrued = this.shortFundingCost(s, entryMs, time, pos.invested);
        }
        investedValue += pos.invested + pos.amount * (pos.entryPrice - mkt) - fundingAccrued;
      } else {
        investedValue += pos.amount * mkt;
      }
    }
    return this.state.balance + investedValue;
  }

  // MaxDrawdown a RESOLUCIÓN COMPLETA: se llama en CADA vela (fix #1). Mantiene un peak/maxDD
  // por fase, independiente del equityCurve submuestreado (que es solo para el plot). Así el
  // DD reportado y el de computeBuyHold se miden con la misma granularidad por-vela.
  /**
   * Circuit breaker de cartera SIMULADO (paridad con `shadowTrader.updateCircuitBreaker`).
   * Mismo contrato: DD real sobre el pico de equity, pausa temporizada e histéresis al 80 %
   * del umbral para que una pausa expirada no se re-arme en bucle. Solo veta APERTURAS.
   */
  updateCircuitBreakerSim(time, equity) {
    const cb = this.circuitBreaker;
    if (!cb || !(equity > 0)) return;
    if (this.cbPeak <= 0) this.cbPeak = Math.max(this.initialBalance, equity);
    if (equity > this.cbPeak) this.cbPeak = equity;
    const dd = ((this.cbPeak - equity) / this.cbPeak) * 100;

    if (this.cbPausedUntil > 0) {
      if (time < this.cbPausedUntil) return;      // pausa vigente
      // Pausa cumplida → histéresis: no re-armar hasta recuperar por debajo del 80 % del umbral.
      if (dd < cb.maxDrawdownPct * 0.8) { this.cbPausedUntil = 0; this.cbCooling = false; }
      else { this.cbPausedUntil = 0; this.cbCooling = true; return; }
    }
    if (this.cbCooling) {
      if (dd < cb.maxDrawdownPct * 0.8) this.cbCooling = false;
      return;
    }
    if (dd >= cb.maxDrawdownPct) {
      this.cbPausedUntil = time + cb.pauseHours * 3600000;
      this.cbTriggers++;
    }
  }

  trackDrawdown(time, currentPrices) {
    const eq = this.currentEquity(currentPrices, time);
    this.updateCircuitBreakerSim(time, eq);
    const update = (acc) => {
      if (eq > acc.peak) acc.peak = eq;
      if (acc.peak > 0) {
        const dd = (acc.peak - eq) / acc.peak * 100;
        if (dd > acc.maxDD) acc.maxDD = dd;
      }
    };
    update(this.ddTrack.full);
    if (this.splitTime == null || time < this.splitTime) update(this.ddTrack.train);
    else update(this.ddTrack.holdout);
  }

  recordEquity(time, currentPrices, force = false) {
    const lastRecord = this.state.equityCurve[this.state.equityCurve.length - 1];
    if (!force && lastRecord && (time - lastRecord.time) < 3600000) return;

    const totalEquity = this.currentEquity(currentPrices, time);
    this.state.equityCurve.push({ time, equity: parseFloat(totalEquity.toFixed(2)) });
  }

  // Métricas riesgo-ajustadas (fix #18) sobre la serie de retornos de la curva de equity.
  // Sharpe/Sortino anualizados con periodsPerYear inferido del espaciado mediano de la curva.
  // Calmar = retorno anualizado / |MaxDD|. rf=0 (típico en cripto).
  computeRiskAdjusted(equityCurve, maxDDpct) {
    const pts = (equityCurve || []).filter(p => isFinite(p.equity) && p.equity > 0);
    if (pts.length < 3) return { sharpe: 0, sortino: 0, calmar: 0, annReturn: 0, annVol: 0 };
    const rets = [];
    const dts = [];
    for (let i = 1; i < pts.length; i++) {
      rets.push(Math.log(pts[i].equity / pts[i - 1].equity));
      dts.push(pts[i].time - pts[i - 1].time);
    }
    dts.sort((a, b) => a - b);
    const medianDt = dts[Math.floor(dts.length / 2)] || 3600000;
    const periodsPerYear = medianDt > 0 ? (365 * 24 * 3600000) / medianDt : 365;
    const n = rets.length;
    const mean = rets.reduce((s, r) => s + r, 0) / n;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const downside = rets.filter(r => r < 0);
    const downVar = downside.length > 0 ? downside.reduce((s, r) => s + r * r, 0) / n : 0;
    const downStd = Math.sqrt(downVar);
    const annReturn = (Math.exp(mean * periodsPerYear) - 1) * 100;
    const annVol = std * Math.sqrt(periodsPerYear) * 100;
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
    const sortino = downStd > 0 ? (mean / downStd) * Math.sqrt(periodsPerYear) : 0;
    const calmar = maxDDpct > 0 ? annReturn / maxDDpct : 0;
    return {
      sharpe: parseFloat(sharpe.toFixed(2)),
      sortino: parseFloat(sortino.toFixed(2)),
      calmar: parseFloat(calmar.toFixed(2)),
      annReturn: parseFloat(annReturn.toFixed(2)),
      annVol: parseFloat(annVol.toFixed(2)),
    };
  }

  computeMetrics(executions, balanceStart, balanceEnd, equityCurveSubset, precomputedMaxDD = null, opts = {}) {
    // ⚠️ Auditoría 2026-08-29 (A1): las métricas se calculan sobre POSICIONES, no sobre
    // ejecuciones. Una posición cerrada en tramos (`PARTIAL_TP` + cierre final) es UN resultado.
    // Contar los parciales por separado inflaba el win rate ~20 pp sin mejorar la esperanza,
    // porque el parcial solo dispara en ganancia (ganador por construcción).
    const trades = aggregateByPosition(executions);
    const totalTrades = trades.length;
    // Convención de clasificación (fix #27): ganadoras profit>0, perdedoras profit<0,
    // breakeven profit==0 en su propio bucket (no infla las pérdidas).
    const winners = trades.filter(t => t.profit > 0);
    const losers = trades.filter(t => t.profit < 0);
    const breakeven = trades.filter(t => t.profit === 0);
    const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

    const totalProfit = parseFloat((balanceEnd - balanceStart).toFixed(2));
    const roi = balanceStart > 0 ? (totalProfit / balanceStart) * 100 : 0;

    const grossProfit = winners.reduce((s, t) => s + t.profit, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.profit, 0));
    // profitFactor (fix #8): sin pérdidas y con ganancias = Infinity (no 0, que es el peor valor).
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

    // Métricas SOLO de cierres reales de estrategia (auditoría 2026-07-03 #2): los cierres
    // forzados END_OF_BACKTEST marcan a mercado posiciones aún abiertas — en trend-following
    // concentran los ganadores y pueden inflar el PF total (p.ej. PF 10 total vs 0.95 realizado).
    // El PF "honesto" de lo que la estrategia CERRÓ por sí misma es signalOnly.profitFactor.
    const realTrades = trades.filter(t => t.reason !== 'END_OF_BACKTEST');
    const sWin = realTrades.filter(t => t.profit > 0);
    const sLoss = realTrades.filter(t => t.profit < 0);
    const sGP = sWin.reduce((s, t) => s + t.profit, 0);
    const sGL = Math.abs(sLoss.reduce((s, t) => s + t.profit, 0));
    const signalOnly = {
      trades: realTrades.length,
      winRate: realTrades.length > 0 ? parseFloat(((sWin.length / realTrades.length) * 100).toFixed(2)) : 0,
      profitFactor: sGL > 0 ? parseFloat((sGP / sGL).toFixed(2)) : (sGP > 0 ? null : 0), // null = ∞
      netProfit: parseFloat((sGP - sGL).toFixed(2)),
    };

    // MaxDD: usa el tracker per-bar si está disponible (fix #1); si no, cae a la curva.
    let maxDD;
    if (precomputedMaxDD != null) {
      maxDD = precomputedMaxDD;
    } else {
      let maxEquity = balanceStart;
      maxDD = 0;
      (equityCurveSubset || []).forEach(p => {
        if (p.equity > maxEquity) maxEquity = p.equity;
        const dd = (maxEquity - p.equity) / maxEquity * 100;
        if (dd > maxDD) maxDD = dd;
      });
    }

    const avgWin = winners.length > 0 ? grossProfit / winners.length : 0;
    const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0;
    const expectancy = totalTrades > 0
      ? ((winRate / 100) * avgWin) - (((100 - winRate) / 100) * avgLoss)
      : 0;

    let totalDuration = 0;
    trades.forEach(t => {
      totalDuration += new Date(t.sellTime).getTime() - new Date(t.buyTime).getTime();
    });
    const avgDurationHours = totalTrades > 0 ? (totalDuration / totalTrades / 3600000) : 0;

    const byReason = {};
    trades.forEach(t => { byReason[t.reason] = (byReason[t.reason] || 0) + 1; });

    const bySymbol = {};
    trades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, profit: 0, wins: 0 };
      bySymbol[t.symbol].trades++;
      bySymbol[t.symbol].profit += t.profit;
      if (t.profit > 0) bySymbol[t.symbol].wins++;
    });

    const risk = this.computeRiskAdjusted(equityCurveSubset, maxDD);

    // ── Panel por LIBRO (A2): la win rate sola engaña; al lado va SIEMPRE la de breakeven ──
    const mkBooks = (list) => ({
      global: bookMetrics(list),
      long: bookMetrics(list.filter(t => (t.side || 'long') !== 'short')),
      short: bookMetrics(list.filter(t => t.side === 'short')),
    });
    const books = mkBooks(trades);
    // Y la versión HONESTA: sin los cierres administrativos de fin de ventana, que en
    // trend-following concentran los ganadores (marcan a mercado lo que seguía abierto).
    const booksSignalOnly = mkBooks(trades.filter(t => t.reason !== 'END_OF_BACKTEST'));

    // ── Purga del holdout (H4): métricas contando SOLO posiciones ENTRADAS en la ventana ──
    // El etiquetado de fase es por sellTime (fix #7/#20, correcto para atribuir P&L al tramo de
    // equity). Pero eso hace que el holdout herede posiciones abiertas en train: sobre
    // backtest-results.json el PF del holdout pasa de 3,66 a 2,46 al purgarlas, y el 80 % de esa
    // diferencia es UN solo trade de XRPUSDC. Se reporta AL LADO, no en sustitución.
    let entryInWindow = null;
    if (opts.windowStart != null) {
      const own = trades.filter(t => new Date(t.buyTime).getTime() >= opts.windowStart);
      entryInWindow = bookMetrics(own);
      entryInWindow.inheritedFromPreviousWindow = trades.length - own.length;
    }

    // ── Contrafactual de truncamiento (A4): guardarraíl contra "subir el win rate" ──
    const truncation = [20, 30, 50, 100].map(c => truncationCounterfactual(trades, c));

    return {
      books,
      booksSignalOnly,
      entryInWindow,
      truncation,
      totalTrades,
      winningTrades: winners.length,
      losingTrades: losers.length,
      breakevenTrades: breakeven.length,
      winRate: parseFloat(winRate.toFixed(2)),
      totalProfit,
      roi: parseFloat(roi.toFixed(2)),
      profitFactor: isFinite(profitFactor) ? parseFloat(profitFactor.toFixed(2)) : null, // null = sin pérdidas (PF=∞)
      maxDrawdown: parseFloat(maxDD.toFixed(2)),
      sharpe: risk.sharpe,
      sortino: risk.sortino,
      calmar: risk.calmar,
      annReturn: risk.annReturn,
      annVol: risk.annVol,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      avgDurationHours: parseFloat(avgDurationHours.toFixed(1)),
      signalOnly, // métricas SOLO de cierres reales (sin END_OF_BACKTEST) — el PF honesto
      byReason,
      bySymbol
    };
  }

  generateReport() {
    // Full curve & drawdown (plot). El DD reportado de las métricas usa el tracker per-bar.
    let maxEquity = this.initialBalance;
    const drawdownCurve = [];
    this.state.equityCurve.forEach(p => {
      if (p.equity > maxEquity) maxEquity = p.equity;
      const dd = (maxEquity - p.equity) / maxEquity * 100;
      drawdownCurve.push({ time: p.time, drawdown: parseFloat(dd.toFixed(2)) });
    });

    // Full metrics (MaxDD per-bar de ddTrack.full)
    const fullMetrics = this.computeMetrics(
      this.state.tradeHistory,
      this.initialBalance,
      this.state.balance,
      this.state.equityCurve,
      this.ddTrack.full.maxDD
    );

    // Train/holdout split
    let trainMetrics = null, holdoutMetrics = null;
    if (this.splitTime) {
      const splitIso = new Date(this.splitTime).toISOString();
      const trainTrades = this.state.tradeHistory.filter(t => t.phase === 'train');
      const holdoutTrades = this.state.tradeHistory.filter(t => t.phase === 'holdout');
      const trainCurve = this.state.equityCurve.filter(p => p.time < this.splitTime);
      const holdoutCurve = this.state.equityCurve.filter(p => p.time >= this.splitTime);

      const balanceAtSplit = trainCurve.length > 0
        ? trainCurve[trainCurve.length - 1].equity
        : this.initialBalance;

      trainMetrics = this.computeMetrics(
        trainTrades, this.initialBalance, balanceAtSplit, trainCurve, this.ddTrack.train.maxDD
      );
      holdoutMetrics = this.computeMetrics(
        holdoutTrades, balanceAtSplit, this.state.balance, holdoutCurve, this.ddTrack.holdout.maxDD,
        { windowStart: this.splitTime }
      );
      trainMetrics.splitTime = splitIso;
      holdoutMetrics.splitTime = splitIso;
      trainMetrics.buyHold = this.buyHoldTrain || null;
      holdoutMetrics.buyHold = this.buyHoldHoldout || null;
    }

    return {
      summary: {
        initialBalance: this.initialBalance,
        finalBalance: parseFloat(this.state.balance.toFixed(2)),
        periodMonths: this.months,
        interval: this.interval,
        symbols: this.symbols,
        strategy: strategyName(this.strategyVersion),
        strategyVersion: this.strategyVersion,
        circuitBreakerTriggers: this.circuitBreaker ? this.cbTriggers : null,
        sizeBasis: this.sizeBasis,
        oosSplitRatio: this.oosSplitRatio,
        costs: {
          feePct: this.feePct,
          slippagePct: this.slippagePct,
          roundTripPct: parseFloat(((this.feePct + this.slippagePct) * 2 * 100).toFixed(3))
        },
        buyHold: this.buyHold || null,
        btcHold: this.btcHold || null,
        longShort: this.longShort || false,
        splitTime: this.splitTime ? new Date(this.splitTime).toISOString() : null,
        dataEndTime: this.lastEventTime ? new Date(this.lastEventTime).toISOString() : null,
        ...fullMetrics
      },
      trainSummary: trainMetrics,
      holdoutSummary: holdoutMetrics,
      trades: this.state.tradeHistory,
      equityCurve: this.state.equityCurve,
      benchmarkCurve: this.sampleBenchmarkCurve(this.state.equityCurve),
      drawdownCurve
    };
  }
}

export default BacktestEngine;

// ═══════════════════════════════════════════════════════════════════════════════════════
// Contabilidad honesta de resultados (auditoría 2026-08-29)
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Agrega EJECUCIONES en POSICIONES. Una posición puede cerrarse en varios tramos (`PARTIAL_TP`
 * + cierre final); contarlos como trades independientes falsea el win rate.
 *
 * ⚠️ Por qué importa: `partialExitAtR` solo dispara EN GANANCIA (`close >= buyPrice + N·R`), así
 * que cada parcial es un ganador POR CONSTRUCCIÓN que entraba en el numerador y el denominador.
 * Medido: con 50 parciales el win rate salta de 35,35 % a 47,55 % sin que la esperanza mejore un
 * euro — de hecho empeora, porque el parcial trunca la cola derecha, que es donde vive el
 * beneficio (avgWin 114,33 vs avgLoss 39,50). Era un interruptor para falsificar la métrica.
 *
 * La posición se identifica por `symbol + buyTime`. El resultado hereda el motivo del ÚLTIMO
 * cierre (el que de verdad liquidó la posición) y el P&L es la suma de los tramos.
 */
export function aggregateByPosition(trades) {
  const byKey = new Map();
  for (const t of trades || []) {
    const key = `${t.symbol}|${t.buyTime}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...t, executions: 1, partials: t.reason === 'PARTIAL_TP' ? 1 : 0 });
      continue;
    }
    prev.profit = parseFloat((prev.profit + t.profit).toFixed(2));
    prev.invested = parseFloat(((prev.invested || 0) + (t.invested || 0)).toFixed(2));
    prev.executions += 1;
    if (t.reason === 'PARTIAL_TP') prev.partials += 1;
    // El cierre más tardío define motivo, precio y fase de la posición. Si algún sellTime no es
    // una fecha parseable, se cae al ORDEN de llegada (el último gana) en vez de comparar NaN,
    // que siempre da false y dejaría el motivo del PRIMER tramo (típicamente el PARTIAL_TP).
    const tNew = new Date(t.sellTime).getTime();
    const tPrev = new Date(prev.sellTime).getTime();
    const isLater = (Number.isFinite(tNew) && Number.isFinite(tPrev)) ? (tNew >= tPrev) : true;
    if (isLater) {
      prev.sellTime = t.sellTime;
      prev.sellPrice = t.sellPrice;
      prev.reason = t.reason;
      prev.phase = t.phase;
    }
  }
  const out = [];
  for (const pos of byKey.values()) {
    pos.profitPct = pos.invested > 0 ? parseFloat(((pos.profit / pos.invested) * 100).toFixed(2)) : pos.profitPct;
    out.push(pos);
  }
  return out.sort((a, b) => new Date(a.sellTime) - new Date(b.sellTime));
}

/**
 * Intervalo de confianza de Wilson para una proporción. Con n pequeño es MUY superior al
 * intervalo normal (que puede salirse de [0,1] y no cubre el caso 0 aciertos).
 * Wilson(0/7) = [0 % ; 35,4 %] — contiene el 35,35 % del backtest, y por eso una racha de
 * 0/7 no contradice al modelo.
 */
export function wilsonInterval(wins, n, z = 1.96) {
  if (!(n > 0)) return { low: null, high: null };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    low: parseFloat((Math.max(0, (centre - half) / d) * 100).toFixed(2)),
    high: parseFloat((Math.min(1, (centre + half) / d) * 100).toFixed(2)),
  };
}

/**
 * Métricas de decisión de un LIBRO (global / largo / corto), sobre POSICIONES ya agregadas.
 *
 * La cifra clave no es el win rate: es el win rate de BREAKEVEN — el mínimo necesario para no
 * perder dinero dado el payoff — y el MARGEN entre ambos. En este bot el libro corto tiene win
 * rate ALTA (40,74 %) y margen ridículo (+1,6 pp), y el largo win rate BAJA (23,29 %) y margen
 * cómodo (+14,0 pp): la win rate por sí sola apunta al revés que el dinero.
 *
 * `nEffective` cuenta FECHAS DE ENTRADA distintas, no trades: 7 cortos abiertos el mismo día
 * sobre activos con ρ̄=0,73 son ~1 apuesta, no 7.
 */
export function bookMetrics(positions) {
  const n = positions.length;
  if (n === 0) return { trades: 0 };
  const winners = positions.filter(t => t.profit > 0);
  const losers = positions.filter(t => t.profit < 0);
  const gp = winners.reduce((s, t) => s + t.profit, 0);
  const gl = Math.abs(losers.reduce((s, t) => s + t.profit, 0));
  const avgWin = winners.length ? gp / winners.length : 0;
  const avgLoss = losers.length ? gl / losers.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : null;
  // WR de breakeven = 1/(1+payoff): por debajo de esto el libro pierde dinero por construcción.
  const breakevenWR = payoff != null ? (1 / (1 + payoff)) * 100 : null;
  const winRate = (winners.length / n) * 100;
  const entryDays = new Set(positions.map(t => String(t.buyTime).slice(0, 10)));
  const sorted = positions.slice().sort((a, b) => b.profit - a.profit);
  const net = positions.reduce((s, t) => s + t.profit, 0);
  const topSum = (k) => sorted.slice(0, k).reduce((s, t) => s + t.profit, 0);
  const r2 = (v) => v == null ? null : parseFloat(v.toFixed(2));
  return {
    trades: n,
    winners: winners.length,
    losers: losers.length,
    winRate: r2(winRate),
    avgWin: r2(avgWin),
    avgLoss: r2(avgLoss),
    payoff: r2(payoff),
    breakevenWR: r2(breakevenWR),
    marginPP: breakevenWR != null ? r2(winRate - breakevenWR) : null,
    profitFactor: gl > 0 ? r2(gp / gl) : (gp > 0 ? null : 0), // null = ∞
    netProfit: r2(net),
    expectancy: r2(net / n),
    nEffective: entryDays.size,
    wilson95: wilsonInterval(winners.length, n),
    // Concentración: si el top-5 supera el 100 % del neto, el resultado depende de un puñado
    // de trades y la media no describe nada.
    top5PctOfNet: net !== 0 ? r2((topSum(5) / net) * 100) : null,
    top10PctOfNet: net !== 0 ? r2((topSum(10) / net) * 100) : null,
  };
}

/**
 * Contrafactual de TRUNCAMIENTO: ¿qué habría pasado con un take-profit al `capPct` %?
 *
 * Cota SUPERIOR optimista: solo trunca los trades que YA superaban el umbral, y asume que se
 * habrían cerrado exactamente ahí (ignora que muchos perdedores habrían tocado el objetivo
 * antes de girarse). Aun así, sobre los 208 cierres reales: base +2.702 → TP20 % **−1.102**.
 *
 * Es el guardarraíl contra la tentación de "subir el win rate": toda propuesta que toque
 * salidas pasa por aquí ANTES de gastar un walk-forward.
 */
export function truncationCounterfactual(positions, capPct) {
  let net = 0, truncated = 0;
  for (const t of positions) {
    const invested = t.invested || 0;
    const pct = invested > 0 ? (t.profit / invested) * 100 : (t.profitPct || 0);
    if (pct > capPct) {
      net += invested > 0 ? invested * (capPct / 100) : t.profit * (capPct / pct);
      truncated++;
    } else {
      net += t.profit;
    }
  }
  return { capPct, netProfit: parseFloat(net.toFixed(2)), truncatedTrades: truncated };
}

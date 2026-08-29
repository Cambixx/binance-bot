/**
 * Configuración CENTRALIZADA del bot — fuente única de verdad.
 *
 * Importado por bot.js, backtest.js, backtestEngine.js y shadowTrader.js
 * para garantizar PARIDAD TOTAL entre la operativa live y el backtest.
 * No edites parámetros en otros archivos: cámbialos aquí y se propagan.
 */

// ─────────────────────────── Universo ───────────────────────────
// Stablecoins/fiat + activos con bajo rendimiento confirmado en backtest.
export const BLACKLIST = [
  'LUNC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'BUSD', 'USDP', 'USTC', 'TST',
  'TAO', 'ZEC', 'PEPE', 'ADA', 'INJ', 'DOGE', 'BCH'
];

// Quotes que Binance usa en los pares que este bot mira. Se recortan del símbolo para quedarnos
// con el ACTIVO BASE antes de comparar contra la blacklist.
const QUOTE_SUFFIXES = /(USDC|USDT|FDUSD|BUSD|TUSD|USD1|EUR|GBP|BTC|ETH|BNB)$/;

/**
 * ¿Está el ACTIVO BASE del par en la blacklist?
 *
 * ⚠️ Auditoría 2026-08-29: antes esto era `BLACKLIST.some(bad => symbol.includes(bad))`, una
 * comparación por SUBSTRING sin anclar. Como la blacklist contiene stablecoins ('TUSD', 'BUSD'),
 * colisionaba con activos legítimos cuyo TICKER las contiene al pegarles el quote:
 *   'DOTUSDC'.includes('TUSD')  → true   ← DOT llevaba MESES sin operarse en vivo
 *   'BNBUSDC'.includes('BUSD')  → true
 *   'APTUSDC'.includes('TUSD')  → true
 *   'ARBUSDC'/'SHIBUSDC' .includes('BUSD') → true
 * Efecto: DAILY_BASKET declaraba 8 símbolos y el live operaba 7, divergiendo del backtest. Esto
 * explica además la anomalía "DOTUSDC nunca se ha shorteado" que la auditoría §12 dejó abierta:
 * DOT nunca entraba en el bucle `monitored`, así que su logging de diagnóstico no podía disparar.
 */
export function isBlacklisted(symbol) {
  const base = String(symbol).replace(QUOTE_SUFFIXES, '');
  return BLACKLIST.includes(base);
}

// ─────────────────────────── Estrategia ───────────────────────────
export const INTERVAL = '15m';
export const TOP_COINS_LIMIT = 10;

// Canal diario (regime-timer). Periodo SMA: 150 tras la auditoría 2026-06-19 — es la ÚNICA
// longitud con holdout PF>1 (degradación monótona hacia 250 → plateau, no overfit; SMA150
// "Robusto" en walk-forward vs SMA200 "Inconsistente"). Fuente única (live + backtest).
export const SMA_PERIOD = 150;
// Cesta FIJA de large-caps para el canal diario (auditoría 2026-06-19): el top-10 por volumen
// de HOY mete mid-caps volátiles sin histórico (ASTER/XPL: 2-158 velas → imposibles para una
// SMA larga) y sesgo de supervivencia. Esto es de-risking/paridad con el backtest, no mejora
// de rendimiento. Mismo universo que DEFAULT_BASKET de backtest.js.
export const DAILY_BASKET = ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'XRPUSDC', 'LINKUSDC', 'AVAXUSDC', 'DOTUSDC', 'LTCUSDC'];
// Ventana de velas CERRADAS que ve la estrategia 15m. Fuente única para garantizar
// paridad EXACTA del último valor de EMA/ADX/MFI/CHOP entre live y backtest (auditoría #10:
// los indicadores recursivos dependen de cuántas velas se les pasan).
export const LOOKBACK_15M = 130;
// Filtros de régimen V4-C: CHOP < chopMax (tendencia clara), BBW percentil > bbwPctMin (vol viva)
export const STRATEGY_OPTS = { chopMax: 50, bbwPctMin: 20 };

// ─────────────────────────── Gestión de riesgo (V4C-COMBO) ───────────────────────────
export const RISK = {
  takeProfitPct: 5.0,        // Take Profit fijo (%)
  stopLossPct: 3.0,          // Stop Loss fijo (%)
  trailingActivation: 1.5,   // Beneficio (%) que activa el trailing stop
  trailingDistance: 0.45,    // Fracción del peak protegida (0.45 = trail al 45% del beneficio máximo)
  cooldownCandles: 12,       // Velas (12 × 15m = 3h) de bloqueo tras un STOP_LOSS
  positionSizePct: 0.20,     // % del cash invertido por operación
  // Caps de cartera (auditoría #26). null = sin límite (preserva el comportamiento histórico).
  // Se aplican en el motor de backtest Y en el bot live para paridad.
  maxConcurrentPositions: null, // nº máximo de posiciones abiertas simultáneas
  maxExposurePct: null,         // fracción máxima del equity invertida a la vez (0..1)
};

// ─────────────────────────── Base de dimensionamiento ───────────────────────────
// Sobre QUÉ se aplica `positionSizePct` al abrir:
//   'cash'   → sobre la CAJA REMANENTE (comportamiento histórico).
//   'equity' → sobre caja + coste de las abiertas (invariante dentro del ciclo).
//
// ⚠️ Auditoría 2026-08-29 (H1): con base 'cash' la exposición acumulada es exactamente
// 1 − 0,8^n, así que las asignaciones caen en ESCALERA GEOMÉTRICA y el ORDEN del array de
// símbolos se convierte en un parámetro no declarado: el 24-jul-2026 el primer símbolo recibió
// 3,76× el capital del último (1.000 vs 266 USDC) por su índice en DAILY_BASKET, no por
// convicción ni por riesgo. Y el cap `maxExposurePct = 0.85` resulta INALCANZABLE: hace falta
// n ≥ 9 posiciones para cruzarlo y la cesta tiene 8. Con base 'equity' la exposición es n·20 %
// (lineal), todas las posiciones pesan igual y el cap vuelve a morder.
// `rotationBot.js` YA usa esta base ('equity / topN'); es el patrón correcto que faltaba en los
// otros dos canales. Se cambia solo si pasa el gate pareado.
export const SIZING_BASIS = 'cash';

// ─────────────────────────── Banda de histéresis (familia diaria) ───────────────────────────
// Evita whipsaw en torno a la SMA (auditoría #11 / mejora 2026-07-24): solo entra si close > sma*(1+band)
// y solo sale a cash si close < sma*(1-band). 0.0075 = 0.75% de histéresis.
export const SMA_HYSTERESIS_BAND = 0.0075;


// ─────────────────────────── Costes de transacción ───────────────────────────
// Modelo realista: comisión taker de Binance + slippage estimado, aplicados por LADO.
// Round-trip ≈ 2×(feePct + slippagePct) = 0.30% por defecto.
// IMPRESCINDIBLE para que el backtest no sobreestime el edge (ver auditoría 2026-05-29).
export const COSTS = {
  feePct: 0.001,        // 0.10% por lado (comisión taker Binance spot)
  slippagePct: 0.0005,  // 0.05% por lado (slippage estimado en 15m altcoins)
  // Coste de CARRY del lado CORTO (auditoría 2026-06-26): un corto real paga funding/borrow
  // mientras se mantiene. Prior conservador 0.03%/día ≈ 11%/año. IMPRESCINDIBLE para no
  // sobreestimar el edge del canal long/short (sus cortos se mantienen semanas esperando el flip).
  fundingDailyShort: 0.0003,
};

// ─────────────────────────── Canal LONG/SHORT (SMA150-LS) ───────────────────────────
// Gestión de riesgo del lado corto (auditoría + investigación 2026-06-26). Un corto sin stop
// tiene pérdida no acotada hasta que la SMA150 cruza (lag de semanas en un rebote en V).
// CATASTROPHE-STOP, no optimización de retorno: el barrido mostró que un stop ajustado (8/10/12%)
// es NO-MONOTÓNICO → sobreajuste a 1 muestra (la investigación exige "meseta, no pico"). Por eso
// el stop se fija ANCHO (25%): solo dispara en squeezes/rebotes genuinos → acota el riesgo de cola
// (un corto perdiendo >100% del margen, balance negativo) SIN sobreajustar. Stops más ajustados
// (Chandelier+estado FLAT) quedan como experimento a validar OOS antes de tocarlos.
export const LONGSHORT = {
  shortStopPct: 0.25,        // cubrir el corto si sube ≥25% sobre la entrada (protección de cola)
  shortStopCooldownDays: 5,  // tras un stop, no re-shortear ese símbolo durante N días (anti-whipsaw)
  maxConcurrentPositions: null, // sin límite de nº (el sizing por margen ya auto-limita)
  maxExposurePct: 0.85,      // guardrail: no comprometer >85% del equity a la vez
  // κ (research 2026-07 #3): presupuesto de riesgo del corto = κ × el del largo. 1.0 = simétrico
  // (comportamiento actual). κ=0.5 fue RECHAZADO por el gate (empeora el fold bajista). Flag A/B.
  shortRiskFraction: 1.0,
  // Filtro de ENTRADA del corto (research 2026-07 #8). ADOPTADO tras torneo pareado 2026-07-03:
  // confirmDays=3 (exigir 3 cierres consecutivos bajo la SMA antes de shortear) fue la ÚNICA
  // variante que pasó el gate limpio (Calmar mediano ≥ baseline, IQR ≤, peor fold no peor).
  // Evita shortear en el primer cruce (el whipsaw que sufrieron SOL/AVAX en vivo). Rechazadas:
  // banda-vol (#8A), confirm2d (IQR↑), veto anti-rebote #7b (Calmar↑ pero IQR↑ → dispersión).
  shortEntry: { confirmDays: 3 },
  // Gestión de SALIDA del corto (research 2026-07 #9) — CAPA sobre el stop 25% (nunca lo sustituye).
  // ADOPTADO tras torneo pareado 2026-07-03: Chandelier del corto k=3.0 (cubrir si close > minLow
  // + 3·ATR14) fue la MEJOR mejora encontrada: Calmar mediano 2.75→3.65 y — clave — IQR 4.16→3.5
  // (gran reducción de dispersión entre folds), con meseta 2.5/3.0/3.5 (no es un pico → robusto).
  // Time-stop: RECHAZADO (no aporta). El stop 25% se mantiene como backstop de catástrofe.
  shortTrailAtr: 3.0,
  shortTimeStopDays: 0,
};

// ─────────────────────────── Vol-targeting (sizing dinámico) ───────────────────────────
// Escala el tamaño de posición por volatilidad realizada (investigación §2.1, evidencia alta):
// w = clamp(targetVol / realizedVol, 0, wMax). EWMA RiskMetrics (λ=0.94), anualizado √365 (24/7).
// Banda de no-trade (τ) para no re-balancear por ruido y gastar costes. enabled=false preserva
// el sizing fijo histórico (positionSizePct); se activa por canal.
export const VOLTARGET = {
  // ⚠️ Auditoría 2026-08-29 (A5): esto decía `false` mientras el vol-targeting SÍ se aplicaba en
  // dailyBot y longShortBot (computeVolTargetWeight ignoraba el flag). Se pone en `true`, que es
  // el comportamiento REAL y el que el backtest ya forzaba — no cambia nada, deja de mentir.
  enabled: true,
  targetVolAnnual: 0.50,  // ~50% anualizado por sleeve de una sola moneda
  lambda: 0.94,           // decaimiento EWMA (estándar RiskMetrics diario)
  wMax: 1.0,              // spot long-only: sin apalancamiento
  band: 0.15,             // τ: solo re-balancea si |w - wActual| > band
  minWeight: 0.0,         // por debajo de esto, queda en cash
};

// ─────────────────────────── Filtro maestro de régimen BTC ───────────────────────────
// Interruptor global risk-on/off (investigación §2.2): si BTC < SMA(period), no se abren
// LARGOS nuevos (los cortos del canal LS no se tocan). Barato y de alto impacto.
// ✅ ADOPTADO 2026-07-10 tras torneo pareado (abtest, 42m, 8 folds, funding real): meseta en
// SMA 200-250 (180 inerte, no es pico). LS: Calmar mediano 2.37→3.19, Sharpe 1.04→1.38, ROI
// mediano 10.0→12.2. Long-only: Calmar 4.22→4.32, ROI mediano 16.6→18.3. La ganancia se
// concentra en rallies de bear market (el fold 2026 pasa de −2.4% a cash/0% en long-only y
// de +8.4% a +12.2% en LS); coste ~1.6pp en el fold choppy 2024. Detalle en AUDIT_REPORT §11.
export const REGIME = {
  btcEnabled: true,        // gate maestro BTC para entradas LARGAS (live + backtest)
  btcSymbol: 'BTCUSDC',
  btcSmaPeriod: 200,       // SMA diaria de BTC para el switch (meseta 200-250; no optimizar fino)
  crashGuardEnabled: true, // corte rápido si BTC sufre caída de pánico (< -12% en 3 días)
  crashGuardLookbackDays: 3,
  crashGuardMaxDropPct: 0.12,
};

// ─────────────────────────── Rotación cross-sectional + dual-momentum ───────────────────────────
// Canal nuevo (investigación P3+P4): rankea majors por retorno trailing y mantiene top-N,
// con gate de momentum absoluto + gate BTC; si no, cash. Lookback en banda 15-35d (el momentum
// cripto se invierte pasado ~1 mes). Rebalanceo poco frecuente para sobrevivir a costes.
export const ROTATION = {
  lookbackDays: 30,        // retorno trailing para el ranking (banda 15-35)
  topN: 5,                 // nº de monedas mantenidas, equiponderadas
  absMomLookback: 30,      // gate de momentum absoluto propio (>0)
  rebalanceDays: 14,       // cadencia bi-semanal (no semanal agresivo)
  useBtcRegime: true,      // exigir BTC risk-on para mantener cualquier posición
  useRiskAdjusted: true,   // ranking por retorno/volatilidad 30d (Sharpe-ratio) en vez de retorno bruto
};

// ─────────────────────────── Frescura de la vela para ENTRAR ───────────────────────────
// El canal diario ejecuta al CIERRE de la última vela cerrada, igual que el backtest. Si el cron
// dispara muchas horas después de ese cierre (jitter, recuperación de un fallo, cold start), el
// precio de referencia está rancio y el fill real diverge del simulado — medido en la auditoría
// 2026-08-29: +0,45 % de sesgo ponderado, sobre un presupuesto TOTAL de costes del 0,30 %.
// Solo veta APERTURAS: las salidas se gestionan siempre (nunca se atrapa una posición).
export const ENTRY_FRESHNESS_HOURS = 6;

// ─────────────────────────── Circuit Breaker de Cartera ───────────────────────────
// Pausa la apertura de nuevas posiciones si el Max Drawdown de la cartera supera el 12%.
export const PORTFOLIO_CIRCUIT_BREAKER = {
  enabled: true,
  maxDrawdownPct: 12.0,    // 12% MaxDD rolling
  pauseHours: 48,          // 48 horas de pausa tras el corte
};

// ─────────────────────────── MODO SEÑAL ───────────────────────────
// Convierte los bots de SIMULADOR DE CARTERA en GENERADOR DE SEÑALES (2026-08-29, a petición).
//
// Problema que resuelve: con capital acotado a 5.000 USDC y `positionSizePct` sobre la caja
// remanente, el bot DEJABA DE REGISTRAR señales válidas al quedarse sin efectivo — y las que sí
// registraba recibían tamaños en escalera geométrica según el ORDEN del array (1.000 vs 266 USDC
// entre la primera y la séptima). Eso contamina justo lo que se quiere medir: cuántas señales
// aciertan y cuánto rinde cada una.
//
// En modo señal:
//   · Cada señal abre SIEMPRE una posición de nocional FIJO → todas pesan igual en las métricas.
//   · Ninguna guarda de CARTERA bloquea una señal (circuit breaker, caps de exposición y de
//     nº de posiciones quedan inertes). Las guardas de ESTRATEGIA siguen activas —régimen BTC,
//     confirmDays, cooldowns, crash guard— porque forman parte de la señal, no de la cartera.
//   · El vol-targeting no dimensiona: es una decisión de cartera, no una señal.
//   · `balanceUSDC` deja de ser una restricción y pasa a ser un acumulador (puede ser negativo:
//     significa capital comprometido por encima del nominal). Las métricas que importan pasan a
//     ser POR OPERACIÓN: win rate, % medio por trade, profit factor y esperanza.
//
// ⚠️ Con capital ilimitado, MaxDrawdown / Calmar / ROI sobre el saldo inicial dejan de tener
// sentido económico. Usar el panel por libro (`books`) y el retorno sobre capital desplegado.
export const SIGNAL_MODE = {
  enabled: true,
  notionalPerSignal: 1000,  // USDC por señal. Unidad de medida, no una decisión de riesgo.
};

// ─────────────────────────── Capital ───────────────────────────
export const INITIAL_BALANCE = 5000; // Saldo virtual inicial (shadow mode)

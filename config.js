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

export function isBlacklisted(symbol) {
  return BLACKLIST.some(bad => symbol.includes(bad));
}

// ─────────────────────────── Estrategia ───────────────────────────
export const INTERVAL = '15m';
export const TOP_COINS_LIMIT = 10;
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
};

// ─────────────────────────── Costes de transacción ───────────────────────────
// Modelo realista: comisión taker de Binance + slippage estimado, aplicados por LADO.
// Round-trip ≈ 2×(feePct + slippagePct) = 0.30% por defecto.
// IMPRESCINDIBLE para que el backtest no sobreestime el edge (ver auditoría 2026-05-29).
export const COSTS = {
  feePct: 0.001,        // 0.10% por lado (comisión taker Binance spot)
  slippagePct: 0.0005,  // 0.05% por lado (slippage estimado en 15m altcoins)
};

// ─────────────────────────── Capital ───────────────────────────
export const INITIAL_BALANCE = 5000; // Saldo virtual inicial (shadow mode)

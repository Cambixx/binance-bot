/**
 * Lógica de salida FIJA (TP / SL / Trailing) — FUENTE ÚNICA compartida por el motor de backtest
 * y el bot live (fix auditoría #2). Antes el trailing se computaba distinto en cada sitio: el
 * backtest persistía trailingSL y lo chequeaba siempre, mientras el live lo recomputaba-o-null
 * cada cron y NO disparaba si el profit caía por debajo de la activación → divergencia que
 * costaba dinero. Centralizando la decisión, la paridad queda garantizada por construcción.
 *
 * @param {object} pos    { buyPrice, peakPrice, trailingActivated, trailingSL }
 * @param {number} price  precio actual (cierre de la vela)
 * @param {object} params { takeProfitPct, stopLossPct, trailingActivation, trailingDistance }
 * @returns {{action: ('TAKE_PROFIT'|'TRAILING_STOP'|'STOP_LOSS'|null),
 *            peakPrice, trailingActivated, trailingSL, profitPct}}
 *   El caller DEBE persistir peakPrice/trailingActivated/trailingSL en la posición.
 */
export function evaluateFixedExit(pos, price, params) {
  const buyPrice = pos.buyPrice;
  const peakPrice = Math.max(pos.peakPrice ?? buyPrice, price);
  const profitPct = ((price - buyPrice) / buyPrice) * 100;

  let trailingActivated = pos.trailingActivated || false;
  let trailingSL = pos.trailingSL || 0;

  // Al alcanzar la activación se arma/recomputa el nivel desde el peak (monótono → ratchet).
  if (profitPct >= params.trailingActivation) {
    trailingActivated = true;
    const peakProfit = ((peakPrice - buyPrice) / buyPrice) * 100;
    trailingSL = buyPrice * (1 + (peakProfit * params.trailingDistance) / 100);
  }

  // Orden de salidas: TP → Trailing → SL (mutuamente excluyentes). El trailing se evalúa
  // INCONDICIONALMENTE una vez armado (aunque el profit haya caído bajo la activación).
  let action = null;
  if (profitPct >= params.takeProfitPct) action = 'TAKE_PROFIT';
  else if (trailingActivated && trailingSL > 0 && price <= trailingSL) action = 'TRAILING_STOP';
  else if (profitPct <= -params.stopLossPct) action = 'STOP_LOSS';

  return { action, peakPrice, trailingActivated, trailingSL, profitPct };
}

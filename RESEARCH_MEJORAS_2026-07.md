# Plan de Mejoras — Research multiagente 2026-07-03

> Research online con fact-checking adversarial (32 agentes). Solo ideas que pasaron
> verificación de credibilidad y valor añadido. Regla de la casa: neto de 0.30% RT,
> meseta no pico, OOS manda.
>
> **ESTADO DE IMPLEMENTACIÓN (2026-07-03) → ledger completo en `AUDIT_REPORT.md` §9:**
> ✅ Adoptado: #1 funding real, #2 gate de dispersión, **#8 confirm3d**, **#9 ATR-trail 3.0** (la mejor).
> 🔻 Rechazado por el gate (media↑ pero IQR↑, o sin efecto): #3 κ=0.5, #4 vt-condicional, #6 funding-kill, #7b veto, #8A banda, #9 time-stop.
> 💤 Dormante (off): #7a panic-derisk (no gatilló). ⏸️ Aplazado: #5 (desajuste arquitectónico), Tier 3 #10/#11/#12.
> Neto: walk-forward LS de **Calmar 2.67 / IQR 4.27** → **Calmar 3.63 / IQR 3.5**.
>
> **RONDA 2026-07-10 (research de ROI) → ledger en `AUDIT_REPORT.md` §11:**
> ✅ Adoptado: **gate maestro BTC>SMA200 para largos nuevos** (`REGIME.btcEnabled=true`, era la
> mejora §2.2 pendiente de cablear): LS Calmar med 2.37→3.19 / ROI med 10.0→12.2; long-only
> Calmar 4.22→4.32 / ROI med 16.6→18.3; meseta en SMA 200-250. 🔻 Rechazado por el gate:
> piramidación Turtle 10%×2 (Calmar< y ROI med↓) y sizing continuo Carver-lite al abrir (IQR↑,
> peor fold↓, ROI med↓↓) — ambos quedan disponibles como opciones del motor (`pyramid`,
> `entryTilt`) para re-tests. Evidencia externa revisada: TSMOM fuerte / cross-sectional débil
> en cripto neto de costes (Han-Kang-Ryu) → no construir tilt cross-sectional.

# PLAN DE MEJORAS PRIORIZADO (solo ideas con verdict credible && addsValue)

Regla de la casa aplicable a todo: neto de 0.30% RT, meseta no pico, OOS manda. Referencias de código verificadas: `config.js` (SMA_HYSTERESIS_BAND=0.0 en L57, LONGSHORT en L80-82, EWMA λ=0.94), `longShortBot.js` (sizeFracFor L45, hoy simétrico largo/corto), `backtestEngine.js` (fundingDailyShort flat, L50/433-436/630-646), `walkforward.js` (flags --sma200 --longshort --sma= --band= --months= --folds= --symbols= --no-voltarget), `validate.js` (--permute=200).

---

## TIER 0 — Infraestructura de validación (hacer primero: endurece el backtest y habilita todo lo demás)

### 1. Funding firmado por régimen en el modelo de costes (confianza: ALTA)
- **Regla exacta**: sustituir el flat `fundingDailyShort = 0.03%/día` por la serie histórica real de funding de Binance (endpoint público `GET /fapi/v1/fundingRate`, sin auth, BTCUSDT desde sept-2019). El corto devenga el funding FIRMADO: cobra cuando es positivo, paga cuando es negativo. Cache local en JSON. Fallback donde no haya histórico (alts viejas): flat actual.
- **Dónde**: `backtestEngine.js` (L433-436 y L640-646, donde ya se devenga), nuevo fetcher en `binanceService.js`. Aclarar antes el instrumento real del corto: si es margin spot, el coste es borrow (siempre positivo) y esto solo aplica al backtest de perps.
- **Validación**: re-correr el baseline LS: `node walkforward.js --sma200 --longshort --months=36 --folds=8` con funding real vs flat. No hay umbral que superar: es una CORRECCIÓN del modelo (hoy el signo/timing está mal: sobrecarga al corto en régimen normal e infracarga en bears profundos, justo donde el LS concentró su edge). Si el edge del LS sobrevive con funding real, es más creíble; si muere, mejor saberlo ya.
- **Esfuerzo**: M.

### 2. Gate de aceptación por dispersión de Calmar entre folds (confianza: ALTA)
- **Regla exacta**: añadir a `walkforward.js` el reporte por fold de Calmar (winsorizado: cap cuando MaxDD≈0, o reportar Sharpe+MaxDD por separado), IQR entre folds, peor fold y turnover. Criterio pre-registrado para adoptar cualquier variante: (a) Calmar OOS ≥ baseline SMA150 actual, (b) IQR entre folds −25% o mejor, (c) turnover no sube, (d) domina en el peor fold. Subir folds de 6 a 8-10 (`--folds=10`) o bootstrap por bloques, porque con 5-6 folds el criterio de IQR no tiene poder.
- **Dónde**: `walkforward.js` (ya reporta por fold; falta Calmar/IQR/comparación pareada multi-variante).
- **Validación**: es la métrica de validación misma; comparación SIEMPRE pareada contra el incumbente SMA150, no contra la mediana de variantes.
- **Esfuerzo**: S/M.

---

## TIER 1 — Cambios baratos de mayor convicción

### 3. Cap asimétrico del presupuesto de riesgo del corto, κ=0.5 (confianza: media)
- **Regla exacta**: en el canal LS, `w_short = 0.5 × w_vol_target` (equivalente: vol-target del libro corto 25% vs 50% del largo). El largo no se toca. κ fijado a priori en 0.5 (dentro del plateau [0.4-0.5] del paper); NO barrer κ fino.
- **Dónde**: `longShortBot.js` (sizeFracFor, L45) y su espejo en `backtestEngine.js`. Cambio de una línea; cero trades extra.
- **Validación**: A/B `node walkforward.js --sma200 --longshort --months=36 --folds=8` con κ=1.0 vs κ=0.5 (y κ=0.4 como check de meseta, no de optimización). Umbral: Calmar OOS ≥ baseline Y MDD del fold 2022 no empeora materialmente (κ<1 reduce el hedge en bears — vigilarlo explícitamente). Correr DESPUÉS de la mejora #1 (funding real), que cambia la economía del corto.
- **Esfuerzo**: S.

### 4. Vol-targeting condicional por quintiles (confianza: ALTA)
- **Regla exacta**: con la σ_EWMA λ=0.94 ya calculada, contra su distribución trailing expanding propia: si σ > P80 → escalar s=min(1, 0.50/σ); si σ < P20 → exposición 100%; tramo medio P20-P80 → exposición 100% sin escalar (regla del paper, Eq. 3 — NO congelar el escalar anterior; el freeze solo como variante secundaria). Anti-whipsaw: 3 días consecutivos en el estado antes de cambiar. Percentiles 20/80 fijos.
- **Dónde**: módulo de vol-targeting usado por `dailyBot.js`/`backtestEngine.js` (flag `--voltarget` ya existe).
- **Validación**: A/B contra el VT continuo actual: `node walkforward.js --sma200 --months=36 --folds=8` vs variante condicional. Umbrales: Calmar OOS ≥ actual, turnover ≤ actual (esta es su promesa central: −33% turnover en el paper), MDD medio por fold no peor. Ojo: el paper es equities con rebalanceo mensual y costes 3-10x menores; la adaptación diaria es hipótesis propia. Requiere historia larga por símbolo para los quintiles expanding.
- **Esfuerzo**: M.

### 5. Vol-targeting de CARTERA con covarianza EWMA (confianza: media)
- **Regla exacta**: σ_p = sqrt(w'Σw) con Σ = covarianzas EWMA λ=0.94 (misma λ); escalar todas las posiciones por s = min(1, 0.50/σ_p_anualizada). Cero parámetros nuevos, cero trades nuevos (reutiliza los rebalanceos existentes). Cuando ρ̄ de la cesta sube, la exposición cae mecánicamente — es el "filtro de correlación" sin señal binaria.
- **Dónde**: mismo módulo de vol-targeting; hoy el sizing es por-activo, este es el upgrade a nivel cesta.
- **Validación**: A/B por-activo vs cartera con todo lo demás igual, mismo comando que #4. Umbral: Calmar OOS ≥ actual con IQR menor (gate #2); si empata en media pero reduce dispersión y colas, adoptar.
- **Esfuerzo**: M.

---

## TIER 2 — Gestión de riesgo del corto (canal SMA150-LS)

### 6. Kill-switch del corto por funding negativo persistente (confianza: alta como riesgo, no como alfa)
- **Regla exacta**: si el funding medio 30d de BTC lleva ≥30 días consecutivos negativo (o instantáneo < −0.02%/8h), reducir cortos del canal LS al 50% (preferir 50% sobre cierre total). Requiere el fetcher de la mejora #1.
- **Dónde**: `longShortBot.js` como multiplicador de exposición; un fetch diario extra.
- **Validación**: honestidad obligatoria: N=4 eventos en toda la historia — esto NO es validable OOS como alfa; es un seguro de cola. Backtestear en los 4 episodios (2020, 2021, FTX-2022, 2026) y contabilizar el PnL renunciado (en 2026 el trigger llegó semanas antes del squeeze). Adoptar solo si el coste medio del seguro es pequeño frente al squeeze evitado en FTX/COVID.
- **Esfuerzo**: S (una vez hecha #1).

### 7. De-risking del corto en estados de pánico + veto anti-rebote (confianza: media)
- **Regla exacta**: (a) pánico: si retorno BTC 60d < −30% Y σ_EWMA > percentil 80 histórico → libro corto al 50% (no 0%). (b) Veto de entrada: no abrir cortos nuevos si el precio ya está > 2×σ_20d (fijar UNA especificación: 2σ diaria escalada ≈ 7%, no el rango 15-20%; decidir a priori y documentar) por debajo de la SMA150.
- **Dónde**: `longShortBot.js`; reutiliza la EWMA del vol-targeting y el BTC del gate dual-momentum de `rotationBot.js`.
- **Validación**: solo ~3-6 activaciones en muestra → exigir meseta, no pico. Test crítico: PnL del corto con/sin veto en el fold 2022 (meses a >15% bajo SMA150 y siguió cayendo; el edge del LS vino de ahí según el propio repo). Umbral: el veto no puede costar >20% del PnL del corto en 2022 a cambio de las colas evitadas. Si lo cuesta, adoptar solo la parte (a).
- **Esfuerzo**: M.

### 8. Entrada del corto más exigente: banda vol-escalada + pendiente O confirmación N días — UNA de las dos, no ambas (confianza: media)
- **Regla exacta**: son sustitutos (el propio fact-check lo marca: barrer {banda × N} juntos infla el PBO). Candidata A: abrir corto solo si cierre < SMA150×(1−b) con b = 0.5×σ_20d_diaria (≈1-2% en majors, vol-escalada) Y SMA150_t < SMA150_{t−10}; salida del corto sin cambios (cruce simple: no añadir lag a la salida por riesgo de squeeze). Candidata B: N=2 cierres consecutivos bajo la SMA150 para abrir corto (N∈{2,3} máximo, fijado a priori); flip a largo con 1 cierre como hoy.
- **Dónde**: señal short en `longShortBot.js`; el flag `--band=` de `walkforward.js` ya existe para la variante banda. La señal larga NO se toca (preserva el canal long-only validado).
- **Validación**: torneo de 3: baseline vs A vs B con `node walkforward.js --sma200 --longshort --band=X ...` + `node validate.js --permute=200`. Umbral: menor turnover Y Calmar OOS ≥ baseline Y peor fold no peor. Prior en contra a respetar: la banda 1% simétrica ya fue RECHAZADA por la auditoría (AUDIT_REPORT.md L132) — la carga de la prueba es de la variante asimétrica.
- **Esfuerzo**: M.

---

## TIER 3 — Hipótesis de valor incierto (solo si Tiers 0-2 quedan cerrados)

### 9. ATR-trailing (α=2.5) + time-stop 21d para el corto (confianza: media, priors mixtos)
- **Regla exacta**: S_t = min(S_{t−1}, P_t + 2.5×ATR_14d), cubrir si cierre > S_t; time-stop: cerrar el corto si no acumula beneficio a los 21 días. MANTENER el stop 25% como backstop de catástrofe (no sustituirlo — la cola del corto tiene varianza indefinida). Cooldown existente se mantiene. Ablacionar trailing y time-stop POR SEPARADO.
- **Dónde**: `exits.js`/`backtestEngine.js` (misma interfaz que el stop actual); ATR de las velas diarias ya descargadas. Ya figuraba en el backlog como "Chandelier-stop" (AUDIT_REPORT.md L179) — no es descubrimiento nuevo.
- **Validación**: walk-forward + DSR + PBO completos. Advertencia del propio repo: el sweep de shortStopPct fue NO-monotónico en 8-12% y α=2.5×ATR14 (~2.5-4.5% del precio) cae en esa zona — exigir meseta en α∈{2.0, 2.5, 3.0, 3.5} y coste real por stop-out ≈ 1 RT (re-short post-cooldown), no 0.15%.
- **Esfuerzo**: M/L.

### 10. Absorption Ratio shift (ΔAR z-score) como overlay de fragilidad (confianza: media; el más especulativo)
- **Regla exacta**: PCA sobre retornos diarios de la cesta de 8; n=2 autovectores; ventana 250d/half-life 125d (adaptación cripto); ΔAR = (MA_15d − MA_252d)/σ_252d; ΔAR > +1σ → exposición 50%; < −1σ → 100%; entre medias mantener. Lag de 1 día. ~2 trades/año.
- **Dónde**: overlay del canal long-only en `dailyBot.js` y gate adicional en `rotationBot.js`.
- **Validación**: evidencia 100% equities e in-sample; en cripto vol y correlación se tensan casi a la vez, así que puede ser redundante con #5 (y #5 es gratis). Testear como incremental SOBRE el stack con #5 ya activo; si no mejora Calmar OOS neto sobre eso, descartar sin pena. Riesgo conocido: recorta rallies liderados por BTC (correlaciones también suben en subidas). Umbral: gate #2 completo.
- **Esfuerzo**: L.

### 11. Escalera fraccional de SMAs — versión recortada (confianza: media, con contraevidencia interna)
- **Regla exacta**: NO la versión 100/150/200 del research: la auditoría propia halló que SMA150 es la única longitud con holdout PF>1 (SMA200 inconsistente) y el speed-limit de costes desaconseja el peldaño rápido. Si se prueba, versión mínima: score = 0.5×[1(P>SMA150) + 1(P>SMA200)], exposición = w_voltarget × score, buffer de Carver: no rebalancear si |Δpeso| < 20% de la posición.
- **Dónde**: `dailyBot.js`/`backtestEngine.js` sobre el canal long-only.
- **Validación**: exactamente el gate #2 (para esto se diseñó): 4 variantes (SMA150 sola, SMA200 sola, escalera, escalera+buffer), aceptar solo con Calmar OOS ≥ SMA150 sola, IQR −25%, turnover no sube. El valor esperado es reducir dispersión, NO subir la media (Zakamulin: ninguna regla MA mejora la media OOS). Si no reduce IQR, no aporta.
- **Esfuerzo**: M.

### 12. Donchian asimétrico como segundo modelo de bajo peso (confianza: media; aporte marginal — dicho honestamente)
- **Regla exacta**: solo si #11 se adopta: señal = 0.5×escalera_SMA + 0.5×Donchian (entrada máximo N días, salida mínimo N/2, N∈{55,110,220}), redondeada a sextos, mismo buffer. `evaluateStrategyDonchian` (55/20) ya existe en `indicators.js` L810.
- **Validación**: gate #2. La propia evidencia citada estima el beneficio marginal de mezclar modelos en solo 0.05-0.1 bets independientes: esperar poco.
- **Esfuerzo**: M (depende de #11).

---

## NO HACER

1. **Histéresis/deadband simétrica en el canal SMA (b=1-3%)**: único item del research con addsValue=false. El mecanismo YA existe (`SMA_HYSTERESIS_BAND`, config.js L57, desactivado en 0.0) y b=1% ya fue probado y RECHAZADO por empeorar OOS a 0.30% RT (AUDIT_REPORT.md L132). Necesitar b mayor cuando b=1% empeora viola "meseta, no pico". (La banda ASIMÉTRICA solo-entrada-corto de la mejora #8 es distinta y sí compite.)
2. **SuperTrend en cualquier votación**: dominado por Donchian en el test citado, redundante con las SMAs, y el propio repo ya lo descartó (V4-A, V6, ST-daily). Además una cifra de su evidencia ("23 señales falsas seguidas") resultó fabricada en el fact-check.
3. **Filtro naive de correlación media (umbral sobre ρ̄)**: evidencia en contra (Pollet-Wilson: ρ̄ alta predice retornos FUTUROS más altos); en cripto la correlación salta contemporánea al crash — dispara tarde y te saca antes del rebote. Su sustituto correcto es #5 (mecánico) y, si acaso, #10.
4. **Adoptar parámetros del paper AdaptiveTrend a ciegas** (κ, γ, α, sus Sharpes 2.4): preprint sin peer review, 6h/perps/4bps — su sistema NO sobrevive 0.30% RT. Solo la dirección de sus ablations es utilizable; toda cifra debe re-validarse in-house.
5. **Barrer banda × confirmación-N × escalera juntos**: son anti-whipsaw sustitutos; el barrido conjunto infla el PBO. Torneo de candidatas, una gana o ninguna.
6. **Quitar el stop duro 25% del corto**: la cola del corto tiene varianza indefinida (corroboración FMPM 2025); el trailing de #9 se añade como capa, nunca como sustituto.
7. **Esperar que el ensemble suba la media**: el criterio correcto (y el único defendible por la evidencia) es reducción de dispersión entre folds con media no peor. Adoptar o rechazar por media puntual es el error simétrico que el gate #2 previene.

**Secuencia recomendada**: #1 → #2 (una semana de infra) → #3, #4, #5 en paralelo (A/B baratos) → re-evaluar el canal LS con funding real antes de invertir en #6-#9 → Tier 3 solo si sobra presupuesto de complejidad. Si el LS no sobrevive el funding firmado de #1, todo el Tier 2 pierde prioridad frente a mejorar el canal long-only.
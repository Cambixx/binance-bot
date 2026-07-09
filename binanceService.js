import axios from 'axios';
import crypto from 'crypto';

// Datos públicos de mercado: endpoint que evita bloqueos geográficos (451).
const BINANCE_DATA_BASE = 'https://data-api.binance.vision/api/v3';
// Endpoint AUTENTICADO para peticiones firmadas (/account, órdenes). NO usar el host de datos
// para firmar (fix #31: filtraría la API key a un host que no la necesita y no sirve /account).
const BINANCE_API_BASE = 'https://api.binance.com/api/v3';

// Instancia con timeout para no colgar el cron (fix #13)
const http = axios.create({ timeout: 10000 });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * GET con reintentos y backoff exponencial. Honra 429/418 (Retry-After), reintenta 5xx y
 * errores de red. Registra el peso de IP usado (x-mbx-used-weight-1m) para vigilar límites.
 */
async function getWithRetry(url, config = {}, { retries = 3, baseDelay = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await http.get(url, config);
      const weight = res.headers?.['x-mbx-used-weight-1m'];
      if (weight && Number(weight) > 1000) console.warn(`⚠️ [Binance] peso IP usado alto: ${weight}/min`);
      return res;
    } catch (error) {
      lastErr = error;
      const status = error.response?.status;
      const retryable = !status || status === 429 || status === 418 || status >= 500;
      if (attempt === retries || !retryable) break;
      // Respeta Retry-After si Binance lo envía; si no, backoff exponencial con jitter.
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      const delay = retryAfter > 0 ? retryAfter * 1000 : baseDelay * 2 ** attempt + Math.floor(Math.random() * 200);
      console.warn(`⚠️ [Binance] intento ${attempt + 1} falló (${status || error.code}); reintento en ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

class BinanceService {
  constructor() {}

  async _signedRequest(method, endpoint, data = {}) {
    const apiKey = process.env.BINANCE_API_KEY;
    const apiSecret = process.env.BINANCE_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error('Faltan BINANCE_API_KEY o BINANCE_API_SECRET en las variables de entorno (.env)');
    }

    const timestamp = Date.now();
    const queryData = { ...data, timestamp };
    const queryString = new URLSearchParams(queryData).toString();

    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    // Host AUTENTICADO (no el mirror de datos)
    const url = `${BINANCE_API_BASE}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await http.request({
        method,
        url,
        headers: {
          'X-MBX-APIKEY': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      return response.data;
    } catch (error) {
      const errorMsg = error.response?.data?.msg || error.message;
      throw new Error(`Binance API Error: ${errorMsg}`);
    }
  }

  async getAccountBalance(asset = null) {
    const data = await this._signedRequest('GET', '/account');
    const balances = data.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);

    if (asset) {
      const found = balances.find(b => b.asset === asset.toUpperCase());
      return found || { asset: asset.toUpperCase(), free: '0.00000000', locked: '0.00000000' };
    }
    return balances;
  }

  // --- MÉTODOS PÚBLICOS DE MERCADO ---

  /**
   * Obtiene los N pares con mayor volumen en las últimas 24h.
   * Filtra por pares que terminen en USDC y excluye stablecoins o tokens apalancados comunes.
   */
  async getTopVolumeSymbols(limit = 10) {
    try {
      const response = await getWithRetry(`${BINANCE_DATA_BASE}/ticker/24hr`);

      const validPairs = response.data.filter(ticker => {
        const symbol = ticker.symbol;
        return symbol.endsWith('USDC') &&
               !symbol.includes('UPUSDC') &&
               !symbol.includes('DOWNUSDC') &&
               !['USDTUSDC', 'FDUSDUSDC', 'TUSDUSDC', 'BUSDUSDC', 'EURUSDC'].includes(symbol);
      });

      validPairs.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
      return validPairs.slice(0, limit).map(t => t.symbol);
    } catch (error) {
      console.error('Error al obtener los símbolos con más volumen:', error.message);
      return ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'BNBUSDC']; // Fallback
    }
  }

  /**
   * Precio spot actual de uno o varios símbolos. Devuelve { SYMBOL: precio }.
   */
  async getPrices(symbols = []) {
    if (!symbols || symbols.length === 0) return {};
    try {
      const response = await getWithRetry(`${BINANCE_DATA_BASE}/ticker/price`, {
        params: { symbols: JSON.stringify(symbols) }
      });
      const out = {};
      const arr = Array.isArray(response.data) ? response.data : [response.data];
      arr.forEach(t => { out[t.symbol] = parseFloat(t.price); });
      return out;
    } catch (error) {
      console.error('Error al obtener precios spot:', error.message);
      return {};
    }
  }

  /**
   * Velas japonesas (K-lines) para un par y temporalidad. Devuelve [] sólo si la petición
   * falla tras reintentos (el caller debe tratar [] como "sin datos / fallo" y no operar).
   *
   * opts.cacheMs > 0 activa una caché en memoria de corta vida (auditoría 2026-07-09): dentro
   * de una misma invocación del cron, dailyBot y longShortBot piden las MISMAS velas diarias
   * de la misma cesta → la caché elimina la mitad de las llamadas y acelera la función.
   * Solo se cachean respuestas exitosas.
   */
  async getKlines(symbol, interval = '15m', limit = 100, extraParams = {}, opts = {}) {
    const cacheMs = opts.cacheMs || 0;
    const cacheKey = `${symbol}:${interval}:${limit}:${JSON.stringify(extraParams)}`;
    if (cacheMs > 0) {
      const hit = KLINES_CACHE.get(cacheKey);
      if (hit && Date.now() - hit.at < cacheMs) return hit.data;
    }
    try {
      const response = await getWithRetry(`${BINANCE_DATA_BASE}/klines`, {
        params: { symbol, interval, limit, ...extraParams }
      });

      const data = response.data.map(candle => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6]
      }));
      if (cacheMs > 0) {
        if (KLINES_CACHE.size > 200) KLINES_CACHE.clear(); // bound de memoria
        KLINES_CACHE.set(cacheKey, { at: Date.now(), data });
      }
      return data;
    } catch (error) {
      console.error(`Error al obtener Klines para ${symbol}:`, error.message);
      return [];
    }
  }
}

// Caché module-level de klines (viva mientras dure la invocación/instancia warm)
const KLINES_CACHE = new Map();

export default new BinanceService();

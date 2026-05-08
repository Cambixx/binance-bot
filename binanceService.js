import axios from 'axios';
import crypto from 'crypto';

// Usamos el endpoint público de datos de Binance para evitar bloqueos geográficos (451)
const BINANCE_API_BASE = 'https://data-api.binance.vision/api/v3';

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

    const url = `${BINANCE_API_BASE}${endpoint}?${queryString}&signature=${signature}`;

    try {
      const response = await axios({
        method: method,
        url: url,
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
   * Obtiene los N pares con mayor volumen en las últimas 24h
   * Filtra por pares que terminen en USDC y excluye stablecoins o tokens apalancados comunes
   */
  async getTopVolumeSymbols(limit = 10) {
    try {
      const response = await axios.get(`${BINANCE_API_BASE}/ticker/24hr`);
      
      // Filtrar pares USDC normales
      const validPairs = response.data.filter(ticker => {
        const symbol = ticker.symbol;
        return symbol.endsWith('USDC') && 
               !symbol.includes('UPUSDC') && 
               !symbol.includes('DOWNUSDC') &&
               !['USDTUSDC', 'FDUSDUSDC', 'TUSDUSDC', 'BUSDUSDC', 'EURUSDC'].includes(symbol);
      });

      // Ordenar por volumen en USDC descendente
      validPairs.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

      // Extraer los nombres de los símbolos top N
      return validPairs.slice(0, limit).map(t => t.symbol);
    } catch (error) {
      console.error('Error al obtener los símbolos con más volumen:', error.message);
      return ['BTCUSDC', 'ETHUSDC', 'SOLUSDC', 'BNBUSDC']; // Fallback
    }
  }

  /**
   * Obtiene las velas japonesas (K-lines) para un par y temporalidad específicos
   */
  async getKlines(symbol, interval = '15m', limit = 100) {
    try {
      const response = await axios.get(`${BINANCE_API_BASE}/klines`, {
        params: { symbol, interval, limit }
      });

      // Binance devuelve un array de arrays. Mapeamos a un formato más limpio
      return response.data.map(candle => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6]
      }));
    } catch (error) {
      console.error(`Error al obtener Klines para ${symbol}:`, error.message);
      return [];
    }
  }
}

export default new BinanceService();

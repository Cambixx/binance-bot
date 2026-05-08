import dotenv from 'dotenv';
dotenv.config();

import binance from './binanceService.js';

async function testConnection() {
    console.log('Probando conexión a Binance...');
    if (!process.env.BINANCE_API_KEY) {
        console.error('❌ ERROR: Falta BINANCE_API_KEY');
        return;
    }
    
    try {
        const balances = await binance.getAccountBalance();
        console.log('✅ Conexión exitosa! Tu balance Spot:');
        if (balances.length === 0) console.log(' (Cuenta vacía)');
        balances.forEach(b => console.log(` - ${b.asset}: ${b.free}`));
    } catch (error) {
        console.error('❌ ERROR:', error.message);
    }
}

testConnection();

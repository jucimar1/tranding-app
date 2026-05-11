const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Estado
const clients = new Set();
let currentPriceData = null;
let currentKlines = [];
let binanceWS = null;
let currentSymbol = 'btcusdt';

// API Telegram
app.post('/api/telegram', async (req, res) => {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return res.status(500).json({ error: 'Telegram não configurado' });
    try {
        const resTg = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: req.body.message, parse_mode: 'HTML' })
        });
        res.json(await resTg.json());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', clients: clients.size, symbol: currentSymbol.toUpperCase() });
});

// DADOS IMEDIATOS VIA REST (Fallback garantido)
app.get('/api/data', async (req, res) => {
    try {
        const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
        const [tickerRes, klinesRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
        ]);
        const ticker = await tickerRes.json();
        const klines = await klinesRes.json();
        res.json({ price: parseFloat(ticker.c), change: parseFloat(ticker.P), symbol: ticker.s, klines });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// WebSocket Binance
function connectBinanceWS(symbol) {
    if (binanceWS) binanceWS.close();
    const url = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
    console.log(`🔌 Tentando Binance WS: ${url}`);
    
    binanceWS = new WebSocket(url);
    let reconnectTimer;

    binanceWS.on('open', () => console.log(`✅ Binance WS conectado - ${symbol}`));
    
    binanceWS.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            if (msg.e === '24hrTicker') {
                currentPriceData = { symbol: msg.s, price: parseFloat(msg.c), change: parseFloat(msg.P) };
                broadcast({ type: 'price',  currentPriceData });
            }
            if (msg.e === 'kline') {
                const k = msg.k;
                const candle = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q];
                if (currentKlines.length && currentKlines[currentKlines.length-1][0] === k.t) currentKlines[currentKlines.length-1] = candle;
                else { currentKlines.push(candle); if (currentKlines.length > 100) currentKlines.shift(); }
                broadcast({ type: 'kline',  candle });
            }
        } catch (e) { console.error('WS Parse Error:', e); }
    });

    binanceWS.on('close', (code, reason) => {
        console.log(`❌ Binance WS fechado (${code}): ${reason}`);
        reconnectTimer = setTimeout(() => connectBinanceWS(currentSymbol), 5000);
    });

    binanceWS.on('error', (err) => {
        console.error('❌ Binance WS Erro:', err.message);
        clearTimeout(reconnectTimer);
        setTimeout(() => connectBinanceWS(currentSymbol), 5000);
    });
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`👤 Cliente conectado. Total: ${clients.size}`);
    if (currentPriceData) ws.send(JSON.stringify({ type: 'price',  currentPriceData }));
    if (currentKlines.length) ws.send(JSON.stringify({ type: 'klines',  currentKlines }));
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            if (data.type === 'subscribe') {
                const sym = data.symbol.toLowerCase();
                if (sym !== currentSymbol) {
                    currentSymbol = sym; currentKlines = [];
                    connectBinanceWS(currentSymbol);
                }
            }
        } catch(e) {}
    });

    ws.on('close', () => { clients.delete(ws); console.log(`🔌 Cliente saiu. Total: ${clients.size}`); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor ativo na porta ${PORT}`);
    connectBinanceWS(currentSymbol);
});

process.on('uncaughtException', e => console.error('Fatal:', e));

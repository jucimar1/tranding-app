const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
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
    try {
        const { message } = req.body;
        if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
            return res.status(500).json({ error: 'Telegram não configurado' });
        }
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML'
            })
        });
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        clients: clients.size,
        symbol: currentSymbol.toUpperCase(),
        wsConnected: binanceWS && binanceWS.readyState === 1
    });
});

// Dados Iniciais
app.get('/api/init', async (req, res) => {
    try {
        const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
        const [tickerRes, klinesRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
        ]);
        const ticker = await tickerRes.json();
        const klines = await klinesRes.json();
        res.json({
            price: parseFloat(ticker.c),
            change: parseFloat(ticker.P),
            symbol: ticker.s,
            klines: klines
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket Binance
function connectBinanceWebSocket(symbol) {
    if (binanceWS) binanceWS.close();
    const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
    console.log(`🔌 Conectando: ${wsUrl}`);
    
    binanceWS = new WebSocket(wsUrl);

    binanceWS.on('open', () => {
        console.log(`✅ Binance WS conectado - ${symbol.toUpperCase()}`);
    });

    binanceWS.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            // Preço em tempo real
            if (message.e === '24hrTicker') {
                currentPriceData = {
                    symbol: message.s,
                    price: parseFloat(message.c),
                    change: parseFloat(message.P),
                    time: message.E
                };
                broadcast({ type: 'price', data: currentPriceData });
            }
            
            // Candle em tempo real
            if (message.e === 'kline') {
                const k = message.k;
                const candle = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q];
                
                if (currentKlines.length > 0 && currentKlines[currentKlines.length - 1][0] === k.t) {
                    currentKlines[currentKlines.length - 1] = candle;
                } else {
                    currentKlines.push(candle);
                    if (currentKlines.length > 100) currentKlines.shift();
                }
                broadcast({ type: 'kline', data: candle });
            }
        } catch (e) {
            console.error('Erro WS:', e);
        }
    });

    binanceWS.on('close', () => {
        console.log('❌ WS desconectado. Reconectando em 5s...');
        setTimeout(() => connectBinanceWebSocket(currentSymbol), 5000);
    });

    binanceWS.on('error', (err) => {
        console.error('Erro Binance WS:', err);
    });
}

// Broadcast para clientes
function broadcast(message) {
    const data = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Conexão de clientes
wss.on('connection', (ws) => {
    console.log('👤 Cliente conectado. Total:', clients.size + 1);
    clients.add(ws);
    
    // Envia dados atuais
    if (currentPriceData) ws.send(JSON.stringify({ type: 'price', data: currentPriceData }));
    if (currentKlines.length > 0) ws.send(JSON.stringify({ type: 'klines', data: currentKlines }));
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'subscribe') {
                const newSymbol = data.symbol.toLowerCase();
                if (newSymbol !== currentSymbol) {
                    console.log(`🔄 Trocando para: ${newSymbol}`);
                    currentSymbol = newSymbol;
                    currentKlines = [];
                    connectBinanceWebSocket(currentSymbol);
                }
            }
        } catch (e) {
            console.error('Erro mensagem cliente:', e);
        }
    });

    ws.on('close', () => {
        console.log('🔌 Cliente desconectado. Total:', clients.size - 1);
        clients.delete(ws);
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`💚 Health: http://localhost:${PORT}/api/health`);
    
    // Conecta WebSocket
    connectBinanceWebSocket(currentSymbol);
});

process.on('uncaughtException', err => console.error('Erro:', err));

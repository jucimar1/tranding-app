const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configurações
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

app.use(express.static(path.join(__dirname, 'public')));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
    if (data.ok) res.json({ success: true });
    else res.status(500).json({ error: data.description });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/test-telegram', async (req, res) => {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({ error: 'Variáveis não configuradas' });
    }
    const testMessage = `🧪 <b>TESTE - TIMING PRO</b>\n✅ Telegram funcionando!\n${new Date().toLocaleString('pt-BR')}`;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: testMessage, parse_mode: 'HTML' })
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    clients: clients.size,
    symbol: currentSymbol.toUpperCase(),
    wsConnected: binanceWS && binanceWS.readyState === 1
  });
});

// API Init - Dados iniciais
app.get('/api/init', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    console.log(`📥 Fetching init data for ${symbol}`);
    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
    ]);
    if (!tickerRes.ok || !klinesRes.ok) throw new Error('Binance API error');
    const ticker = await tickerRes.json();
    const klines = await klinesRes.json();
    console.log(`✅ Init  price=${ticker.c}, klines=${klines.length}`);
    res.json({
      price: parseFloat(ticker.c),
      change: parseFloat(ticker.P),
      symbol: ticker.s,
      klines: klines
    });
  } catch (error) {
    console.error('❌ Init error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve PWA files
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'), {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket Binance
function connectBinanceWebSocket(symbol) {
  if (binanceWS) binanceWS.close();
  const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
  console.log(`🔌 Connecting to Binance WS: ${wsUrl}`);
  
  binanceWS = new WebSocket(wsUrl);

  binanceWS.on('open', () => {
    console.log(`✅ Binance WS connected for ${symbol.toUpperCase()}`);
  });

  binanceWS.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.e === '24hrTicker') {
        currentPriceData = {
          symbol: message.s,
          price: parseFloat(message.c),
          change: parseFloat(message.P),
          time: message.E
        };
        broadcast({ type: 'price', data: currentPriceData });
      }
      if (message.e === 'kline') {
        const k = message.k;
        const candle = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q];
        if (currentKlines.length > 0 && currentKlines[currentKlines.length - 1][0] === k.t) {
          currentKlines[currentKlines.length - 1] = candle;
        } else {
          currentKlines.push(candle);
          if (currentKlines.length > 100) currentKlines.shift();
        }
        broadcast({ type: 'kline',  candle });
      }
    } catch (e) { console.error('WS message error:', e); }
  });

  binanceWS.on('close', () => {
    console.log('❌ Binance WS disconnected. Reconnecting in 5s...');
    setTimeout(() => connectBinanceWebSocket(currentSymbol), 5000);
  });

  binanceWS.on('error', (error) => {
    console.error('Binance WS error:', error);
  });
}

function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('👤 Client connected. Total:', clients.size + 1);
  clients.add(ws);
  
  if (currentPriceData) ws.send(JSON.stringify({ type: 'price',  currentPriceData }));
  if (currentKlines.length > 0) ws.send(JSON.stringify({ type: 'klines', data: currentKlines }));
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe') {
        const newSymbol = data.symbol.toLowerCase();
        if (newSymbol !== currentSymbol) {
          console.log(`🔄 Switching to ${newSymbol}`);
          currentSymbol = newSymbol;
          currentKlines = [];
          connectBinanceWebSocket(currentSymbol);
        }
      }
    } catch (e) { console.error('Client message error:', e); }
  });

  ws.on('close', () => {
    console.log('🔌 Client disconnected. Total:', clients.size - 1);
    clients.delete(ws);
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`💚 Health: http://localhost:${PORT}/api/health`);
  connectBinanceWebSocket(currentSymbol);
});

process.on('uncaughtException', error => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

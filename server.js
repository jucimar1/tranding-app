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

// Segurança e performance
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Serve arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Estado global
const clients = new Set();
let currentPriceData = null;
let currentKlines = [];
let binanceWS = null;
let currentSymbol = 'btcusdt';
let lastRestFetch = 0;

// WebSocket para Binance
function connectBinanceWebSocket(symbol) {
  if (binanceWS) binanceWS.close();
  
  const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
  console.log(` Conectando ao Binance WS: ${wsUrl}`);
  
  binanceWS = new WebSocket(wsUrl);

  binanceWS.on('open', () => {
    console.log(`✅ Binance WS conectado para ${symbol.toUpperCase()}`);
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
          high: parseFloat(message.h),
          low: parseFloat(message.l),
          volume: parseFloat(message.v),
          quoteVolume: parseFloat(message.q),
          time: message.E
        };
        broadcast({ type: 'price', data: currentPriceData });
      }

      // Kline/Candlestick
      if (message.e === 'kline') {
        const kline = message.k;
        const candle = [
          kline.t, kline.o, kline.h, kline.l, kline.c,
          kline.v, kline.T, kline.q, kline.n, kline.V, kline.Q
        ];

        if (currentKlines.length > 0 && currentKlines[currentKlines.length - 1][0] === kline.t) {
          currentKlines[currentKlines.length - 1] = candle;
        } else {
          currentKlines.push(candle);
          if (currentKlines.length > 100) currentKlines.shift();
        }
        broadcast({ type: 'kline', data: candle });
      }
    } catch (error) {
      console.error('Erro processando mensagem WS:', error);
    }
  });

  binanceWS.on('close', () => {
    console.log('❌ Binance WS desconectado. Reconectando em 5s...');
    setTimeout(() => connectBinanceWebSocket(currentSymbol), 5000);
  });

  binanceWS.on('error', (error) => {
    console.error('Erro Binance WS:', error);
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

// WebSocket para clientes frontend
wss.on('connection', (ws) => {
  console.log('👤 Cliente conectado');
  clients.add(ws);

  // Envia dados atuais imediatamente
  if (currentPriceData) ws.send(JSON.stringify({ type: 'price', data: currentPriceData }));
  if (currentKlines.length > 0) ws.send(JSON.stringify({ type: 'klines', data: currentKlines }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe') {
        const newSymbol = data.symbol.toLowerCase();
        if (newSymbol !== currentSymbol) {
          currentSymbol = newSymbol;
          currentKlines = [];
          connectBinanceWebSocket(currentSymbol);
          fetchHistoricalKlines(currentSymbol);
        }
      }
    } catch (error) {
      console.error('Erro processando mensagem do cliente:', error);
    }
  });

  ws.on('close', () => {
    console.log(' Cliente desconectado');
    clients.delete(ws);
  });
});

// API Routes
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

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m', limit = 100 } = req.query;
    const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`);
    if (!response.ok) throw new Error(`Binance API error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Erro fetching klines:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ticker', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT' } = req.query;
    const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`);
    if (!response.ok) throw new Error(`Binance API error: ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Erro fetching ticker:', error);
    res.status(500).json({ error: error.message });
  }
});

// Fallback REST para dados iniciais
app.get('/api/init', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
    ]);
    
    if (!tickerRes.ok || !klinesRes.ok) throw new Error('Erro na API Binance');
    
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

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fetch histórico inicial
async function fetchHistoricalKlines(symbol) {
  try {
    const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=15m&limit=100`);
    currentKlines = await response.json();
    console.log(`📊 Carregados ${currentKlines.length} candles históricos para ${symbol}`);
  } catch (error) {
    console.error('Erro fetching histórico:', error);
  }
}

// Error handling
process.on('uncaughtException', error => console.error('Uncaught Exception:', error));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`💚 Health: http://localhost:${PORT}/api/health`);
  
  connectBinanceWebSocket(currentSymbol);
  fetchHistoricalKlines(currentSymbol);
});

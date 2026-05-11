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

// Configurações de segurança e performance
app.use(helmet({
  contentSecurityPolicy: false, // Desativado para desenvolvimento
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(compression());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Serve arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Store para conexões WebSocket dos clientes
const clients = new Set();
let currentPriceData = null;
let currentKlines = [];

// WebSocket para Binance (dados em tempo real)
let binanceWS = null;
let reconnectInterval = 5000;
let currentSymbol = 'btcusdt';

function connectBinanceWebSocket(symbol) {
  if (binanceWS) {
    binanceWS.close();
  }

  const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
  binanceWS = new WebSocket(wsUrl);

  binanceWS.on('open', () => {
    console.log(`✅ Connected to Binance WS for ${symbol.toUpperCase()}`);
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

        // Broadcast para todos os clientes
        broadcast({
          type: 'price',
          data: currentPriceData
        });
      }

      // Kline/Candlestick data
      if (message.e === 'kline') {
        const kline = message.k;
        const candle = [
          kline.t, // Open time
          kline.o, // Open
          kline.h, // High
          kline.l, // Low
          kline.c, // Close
          kline.v, // Volume
          kline.T, // Close time
          kline.q, // Quote asset volume
          kline.n, // Number of trades
          kline.V, // Taker buy base
          kline.Q  // Taker buy quote
        ];

        // Atualiza último candle ou adiciona novo
        if (currentKlines.length > 0 && 
            currentKlines[currentKlines.length - 1][0] === kline.t) {
          currentKlines[currentKlines.length - 1] = candle;
        } else {
          currentKlines.push(candle);
          // Mantém apenas últimos 100 candles
          if (currentKlines.length > 100) {
            currentKlines.shift();
          }
        }

        broadcast({
          type: 'kline',
          data: candle
        });
      }
    } catch (error) {
      console.error('Error processing WS message:', error);
    }
  });

  binanceWS.on('close', () => {
    console.log('❌ Binance WS disconnected');
    setTimeout(() => connectBinanceWebSocket(currentSymbol), reconnectInterval);
  });

  binanceWS.on('error', (error) => {
    console.error('Binance WS error:', error);
  });
}

// Broadcast para todos os clientes conectados
function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// WebSocket server para clientes frontend
wss.on('connection', (ws) => {
  console.log(' Client connected');
  clients.add(ws);

  // Envia dados atuais imediatamente
  if (currentPriceData) {
    ws.send(JSON.stringify({
      type: 'price',
      data: currentPriceData
    }));
  }

  if (currentKlines.length > 0) {
    ws.send(JSON.stringify({
      type: 'klines',
      data: currentKlines
    }));
  }

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
      console.error('Error processing client message:', error);
    }
  });

  ws.on('close', () => {
    console.log('🔌 Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('Client WS error:', error);
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
    symbol: currentSymbol.toUpperCase()
  });
});

app.get('/api/klines', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', interval = '15m', limit = 100 } = req.query;
    
    const response = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${limit}`
    );
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching klines:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ticker', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT' } = req.query;
    
    const response = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`
    );
    
    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status}`);
    }
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching ticker:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/symbols', async (req, res) => {
  try {
    const response = await fetch('https://api.binance.com/api/v3/exchangeInfo');
    const data = await response.json();
    
    // Filtra apenas pares USDT com volume
    const symbols = data.symbols
      .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol)
      .sort();
    
    res.json(symbols);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/telegram', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    return res.status(500).json({ error: 'Telegram not configured' });
  }

  const { message } = req.body;
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
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

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Fetch histórico inicial
async function fetchHistoricalKlines(symbol) {
  try {
    const response = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=15m&limit=100`
    );
    currentKlines = await response.json();
    console.log(`📊 Loaded ${currentKlines.length} historical candles for ${symbol}`);
  } catch (error) {
    console.error('Error fetching historical klines:', error);
  }
}

// Error handling global
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`💚 Health: http://localhost:${PORT}/api/health`);
  
  // Inicializa WebSocket
  connectBinanceWebSocket(currentSymbol);
  fetchHistoricalKlines(currentSymbol);
});
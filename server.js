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

// Configurações de Segurança e Performance
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json()); // Importante para o Telegram funcionar

// Rate Limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Serve arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Variáveis de Ambiente
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Estado Global
const clients = new Set();
let currentPriceData = null;
let currentKlines = [];
let binanceWS = null;
let currentSymbol = 'btcusdt';

// --- TELEGRAM ROUTES ---

// Rota para enviar alertas
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

// Rota de teste
app.get('/api/test-telegram', async (req, res) => {
  try {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({ error: 'Variáveis de ambiente não configuradas' });
    }
    
    const testMessage = `
🧪 <b>TESTE - TIMING PRO</b>
✅ Conexão com Telegram funcionando!
 ${new Date().toLocaleString('pt-BR')}
    `;
    
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

// --- API ROUTES ---

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

app.get('/api/init', async (req, res) => {
  try {
    const symbol = (req.query.symbol || 'BTCUSDT').toUpperCase();
    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
    ]);
    if (!tickerRes.ok || !klinesRes.ok) throw new Error('Erro Binance');
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

// Serve PWA files
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'), {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }
  });
});

// Fallback para Frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WEBSOCKET LOGIC ---

function connectBinanceWebSocket(symbol) {
  if (binanceWS) binanceWS.close();
  const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@ticker/${symbol}@kline_15m`;
  console.log(`🔌 Conectando ao Binance WS: ${wsUrl}`);
  
  binanceWS = new WebSocket(wsUrl);

  binanceWS.on('open', () => {
    console.log(`✅ Binance WS conectado para ${symbol.toUpperCase()}`);
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
        broadcast({ type: 'kline', data: candle });
      }
    } catch (e) { console.error('WS Error', e); }
  });

  binanceWS.on('close', () => {
    console.log('❌ Binance WS desconectado. Reconectando...');
    setTimeout(() => connectBinanceWebSocket(currentSymbol), 5000);
  });
}

function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
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
        }
      }
    } catch (e) {}
  });

  ws.on('close', () => clients.delete(ws));
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(` Server rodando na porta ${PORT}`);
  connectBinanceWebSocket(currentSymbol);
});

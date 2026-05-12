require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

// 🔢 Motor de Indicadores
const Indicators = {
  ema: (data, period) => {
    if (data.length < period) return null;
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const k = 2 / (period + 1);
    for (let i = period; i < data.length; i++) ema = (data[i] - ema) * k + ema;
    return ema;
  },
  rsi: (data, period = 14) => {
    if (data.length < period + 1) return 50;
    let g = 0, l = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const d = data[i] - data[i - 1]; d >= 0 ? g += d : l -= d;
    }
    const ag = g / period, al = l / period;
    return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
  },
  atr: (klines, period = 14) => {
    if (klines.length < period + 1) return 0;
    let sum = 0;
    for (let i = klines.length - period; i < klines.length; i++) {
      const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), pc = parseFloat(klines[i-1][4]);
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    return sum / period;
  },
  macd: (data, f = 12, s = 26, sp = 9) => {
    if (data.length < s + sp) return { trend: 'neutral', hist: 0 };
    const macdLine = [];
    for (let i = s; i < data.length; i++) {
      const ef = Indicators.ema(data.slice(0, i + 1), f);
      const es = Indicators.ema(data.slice(0, i + 1), s);
      macdLine.push(ef - es);
    }
    const sig = Indicators.ema(macdLine, sp);
    const hist = macdLine[macdLine.length - 1] - sig;
    const prevHist = macdLine.length > 1 ? macdLine[macdLine.length - 2] - Indicators.ema(macdLine.slice(0, -1), sp) : 0;
    
    let trend = 'neutral';
    if (hist > 0 && prevHist <= 0) trend = 'bull_cross';
    else if (hist < 0 && prevHist >= 0) trend = 'bear_cross';
    else if (hist > 0) trend = 'bull';
    else trend = 'bear';
    return { trend, hist, macd: macdLine[macdLine.length - 1], signal: sig };
  }
};

// 📊 API: Análise Completa
app.get('/api/analysis', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'BTCUSDT';
    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
      fetch(`https://binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`)
    ]);
    const ticker = await tickerRes.json();
    const klines = await klinesRes.json();

    const closes = klines.map(k => parseFloat(k[4]));
    const price = parseFloat(ticker.c);
    const change = parseFloat(ticker.P);

    const ema21 = Indicators.ema(closes, 21);
    const rsi = Indicators.rsi(closes, 14);
    const atr = Indicators.atr(klines, 14);
    const macd = Indicators.macd(closes);
    const volPct = atr / price;

    // 🧠 Lógica de Sinal (Confluência)
    let signal = 'WAIT', sigColor = '#f0b90b', reasons = [];
    const trend = price > ema21 * 1.005 ? 'UP' : price < ema21 * 0.995 ? 'DOWN' : 'SIDE';
    const volOk = volPct >= 0.005 && volPct <= 0.03;

    if (macd.trend === 'bull_cross' && volOk && trend === 'UP' && rsi > 30 && rsi < 70) {
      signal = 'BUY'; sigColor = '#0ecb81';
      reasons = ['MACD↑', 'Tendência Alta', 'Vol Ideal', `RSI ${rsi.toFixed(1)}`];
    } else if (macd.trend === 'bear_cross' && volOk && trend === 'DOWN' && rsi > 30 && rsi < 70) {
      signal = 'SELL'; sigColor = '#f6465d';
      reasons = ['MACD↓', 'Tendência Baixa', 'Vol Ideal', `RSI ${rsi.toFixed(1)}`];
    } else {
      reasons = ['Aguardando confluência'];
      if (!volOk) reasons.push(`Vol ${volPct.toFixed(2)}%`);
    }

    // 🛡️ Gestão de Risco
    const sl = price - (atr * 1.5);
    const tp = price + (atr * 2.5);
    const trail = price + atr;

    res.json({
      symbol, price, change,
      indicators: { rsi: rsi.toFixed(1), ema21: ema21.toFixed(0), atr: atr.toFixed(2), vol: (volPct*100).toFixed(2), macd: macd.trend },
      signal: { type: signal, color: sigColor, reasons },
      risk: { sl: sl.toFixed(2), tp: tp.toFixed(2), trail: trail.toFixed(2), atr: atr.toFixed(2) },
      updated: new Date().toLocaleTimeString('pt-BR')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 📢 API: Telegram
app.post('/api/alert', async (req, res) => {
  if (!TG_TOKEN || !TG_CHAT) return res.status(500).json({ error: 'Vars Telegram ausentes' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: req.body.message, parse_mode: 'HTML' })
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Dashboard ativo na porta ${PORT}`));

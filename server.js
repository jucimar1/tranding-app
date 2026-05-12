require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;

// ==========================================
// 🧮 BIBLIOTECA DE CÁLCULO (O "Cérebro")
// ==========================================
const Calc = {
    // Média Móvel Exponencial (EMA)
    ema: (data, period) => {
        if (data.length < period) return null;
        let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const k = 2 / (period + 1);
        for (let i = period; i < data.length; i++) ema = (data[i] - ema) * k + ema;
        return ema;
    },
    
    // RSI (Força Relativa)
    rsi: (data, period = 14) => {
        if (data.length < period + 1) return 50;
        let g = 0, l = 0;
        for (let i = data.length - period; i < data.length; i++) {
            const d = data[i] - data[i - 1]; d >= 0 ? g += d : l -= d;
        }
        const ag = g / period, al = l / period;
        return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
    },
    
    // ATR (Volatilidade Real)
    atr: (klines, period = 14) => {
        if (klines.length < period + 1) return 0;
        let sum = 0;
        for (let i = klines.length - period; i < klines.length; i++) {
            const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), pc = parseFloat(klines[i-1][4]);
            sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        return sum / period;
    },
    
    // MACD (Momentum)
    macd: (data, f = 12, s = 26, sp = 9) => {
        if (data.length < s + sp) return { trend: 'neutral', hist: 0 };
        const macdLine = [];
        // Cálculo simplificado do MACD para arrays grandes
        for (let i = s; i < data.length; i++) {
            const ef = Calc.ema(data.slice(0, i + 1), f);
            const es = Calc.ema(data.slice(0, i + 1), s);
            macdLine.push(ef - es);
        }
        const sig = Calc.ema(macdLine, sp);
        const hist = macdLine[macdLine.length - 1] - sig;
        
        // Detecção de Cruzamento
        const prevHist = macdLine.length > 1 ? macdLine[macdLine.length - 2] - Calc.ema(macdLine.slice(0, -1), sp) : 0;
        let trend = 'neutral';
        if (hist > 0 && prevHist <= 0) trend = 'bull_cross';
        else if (hist < 0 && prevHist >= 0) trend = 'bear_cross';
        else if (hist > 0) trend = 'bull';
        else trend = 'bear';
        
        return { trend, hist };
    }
};

// ==========================================
// 📡 API PROFISSIONAL
// ==========================================
app.get('/api/analysis', async (req, res) => {
    try {
        const symbol = req.query.symbol || 'BTCUSDT';
        // Buscamos 200 velas para ter EMA 200 confiável
        const [tickerRes, klinesRes] = await Promise.all([
            fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`),
            fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=250`)
        ]);

        const ticker = await tickerRes.json();
        const klines = await klinesRes.json();

        const closes = klines.map(k => parseFloat(k[4]));
        const volumes = klines.map(k => parseFloat(k[5]));
        const price = parseFloat(ticker.c);
        
        // 1. CÁLCULO DOS INDICADORES
        const ema21 = Calc.ema(closes, 21);
        const ema200 = Calc.ema(closes, 200); // O FILTRO DE TENDÊNCIA MESTRE
        const rsi = Calc.rsi(closes, 14);
        const atr = Calc.atr(klines, 14);
        const macd = Calc.macd(closes);

        // 2. FILTRO DE VOLUME (O DETECTOR DE MENTIRAS)
        const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
        const currentVol = volumes[volumes.length - 1];
        const isVolumeValid = currentVol > (avgVol * 1.1); // Volume 10% maior que média

        // 3. LÓGICA DE DECISÃO (ESTILO INSTITUCIONAL)
        let signal = 'WAIT', color = '#848e9c', reasons = [];
        
        // Definição de Tendência Macro
        const isUpTrend = price > ema200;
        const isDownTrend = price < ema200;

        // REGRA DE COMPRA: Só se MACD cruzar + Tendência Alta + Volume bom
        if (isUpTrend && macd.trend === 'bull_cross') {
            if (isVolumeValid) {
                signal = 'BUY'; color = '#0ecb81';
                reasons = ['Tendência Alta (EMA200)', 'MACD Cruzou ↑', 'Volume Confirmado'];
            } else {
                signal = 'WAIT'; reasons = ['MACD ok, mas Volume Baixo (Risco Fakeout)'];
            }
        }
        // REGRA DE VENDA: Só se MACD cruzar + Tendência Baixa + Volume bom
        else if (isDownTrend && macd.trend === 'bear_cross') {
            if (isVolumeValid) {
                signal = 'SELL'; color = '#f6465d';
                reasons = ['Tendência Baixa (EMA200)', 'MACD Cruzou ↓', 'Volume Confirmado'];
            } else {
                signal = 'WAIT'; reasons = ['MACD ok, mas Volume Baixo'];
            }
        } 
        // Feedback de Estado
        else if (isUpTrend) { signal = 'WAIT'; reasons = ['Tendência Alta, aguardando pullback...']; }
        else { signal = 'WAIT'; reasons = ['Tendência Baixa, aguardando recuperação...']; }

        // 4. GESTÃO DE RISCO (ATR)
        const stopLoss = isUpTrend ? price - (atr * 1.5) : price + (atr * 1.5);
        const takeProfit = isUpTrend ? price + (atr * 3.0) : price - (atr * 3.0);

        res.json({
            price,
            change: parseFloat(ticker.P),
            indicators: { rsi, ema200, ema21, atr, macd: macd.trend, volValid: isVolumeValid },
            signal, color, reasons,
            risk: { sl: stopLoss.toFixed(2), tp: takeProfit.toFixed(2) },
            updated: new Date().toLocaleTimeString()
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Alerta Telegram
app.post('/api/alert', async (req, res) => {
    if (!TG_TOKEN || !TG_CHAT) return res.status(500).json({ error: 'Config Telegram ausente' });
    try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT, text: req.body.message, parse_mode: 'HTML' })
        });
        res.json(await r.json());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 🖥️ FRONTEND (TUDO EM UM HTML)
// ==========================================
const HTML = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎯 Trading Pro — Unificado</title>
    <style>
        :root { --bg:#0b0e11; --card:#151a21; --brd:#2b3139; --txt:#eaecef; --mut:#848e9c; --pri:#f0b90b; --suc:#0ecb81; --dan:#f6465d; }
        * { box-sizing:border-box; margin:0; padding:0; font-family: system-ui, sans-serif; }
        body { background:var(--bg); color:var(--txt); padding:20px; }
        .wrap { max-width:700px; margin:0 auto; }
        .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
        .badge { background:var(--pri); color:#000; padding:4px 12px; border-radius:6px; font-weight:800; }
        .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:12px; margin-bottom:12px; }
        .card { background:var(--card); border:1px solid var(--brd); border-radius:10px; padding:14px; }
        .lbl { color:var(--mut); font-size:10px; text-transform:uppercase; margin-bottom:4px; }
        .val { font-size:18px; font-weight:700; font-family: monospace; }
        .box-signal { text-align:center; padding:20px; border-radius:10px; margin:16px 0; font-weight:800; font-size:20px; border:2px dashed var(--brd); transition:0.3s; }
        .reasons { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:10px; }
        .tag { background:rgba(255,255,255,0.05); padding:4px 10px; border-radius:4px; font-size:11px; color:var(--mut); }
        .risk-row { display:flex; justify-content:space-between; gap:10px; margin-top:12px; }
        .risk-it { flex:1; background:rgba(255,255,255,0.03); padding:10px; border-radius:8px; text-align:center; }
        .log { background:#000; padding:12px; border-radius:8px; font-family:monospace; font-size:11px; color:var(--mut); margin-top:16px; max-height:100px; overflow-y:auto; }
        .up { color:var(--suc); } .down { color:var(--dan); }
    </style>
</head>
<body>
<div class="wrap">
    <div class="header">
        <div style="font-weight:800; font-size:20px;">🎯 Trading <span style="color:var(--pri)">PRO</span></div>
        <div class="badge">BTCUSDT</div>
    </div>

    <div class="grid">
        <div class="card"><div class="lbl">💰 Preço</div><div class="val" id="price">--</div></div>
        <div class="card"><div class="lbl">📊 Volatilidade</div><div class="val" id="atr">--</div></div>
        <div class="card"><div class="lbl">📐 RSI (14)</div><div class="val" id="rsi">--</div></div>
        <div class="card"><div class="lbl">🌊 Volume</div><div class="val" id="vol">--</div></div>
    </div>

    <div class="card" style="margin-bottom:12px;">
        <div class="lbl">Tendência (EMA 200)</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
            <span class="val" id="ema200">--</span>
            <span id="trendStatus" style="font-size:12px; font-weight:700;">--</span>
        </div>
    </div>

    <div class="box-signal" id="signalBox">CARREGANDO...</div>

    <div class="risk-row">
        <div class="risk-it"><div class="lbl">🛑 Stop Loss</div><div class="val down" id="sl">--</div></div>
        <div class="risk-it"><div class="lbl">✅ Alvo (1:2)</div><div class="val up" id="tp">--</div></div>
    </div>

    <div class="log" id="log">🔌 Iniciando sistema...</div>
</div>

<script>
    let lastSig = null;
    const log = (msg) => {
        const el = document.getElementById('log');
        el.innerHTML = \`<div style="margin-bottom:2px">\${msg}</div>\` + el.innerHTML;
    };

    async function run() {
        try {
            const res = await fetch('/api/analysis?symbol=BTCUSDT');
            const d = await res.json();
            if(d.error) { log(\`❌ \${d.error}\`); return; }

            document.getElementById('price').innerText = \`$ \${d.price.toFixed(2)}\`;
            document.getElementById('atr').innerText = \`$\${d.indicators.atr.toFixed(2)}\`;
            document.getElementById('rsi').innerText = d.indicators.rsi.toFixed(1);
            document.getElementById('vol').innerText = d.indicators.volValid ? '✅ Alto' : '⚠️ Baixo';
            document.getElementById('vol').className = \`val \${d.indicators.volValid ? 'up' : 'down'}\`;
            
            document.getElementById('ema200').innerText = \`$ \${d.indicators.ema200.toFixed(0)}\`;
            const isUp = d.price > d.indicators.ema200;
            const trendEl = document.getElementById('trendStatus');
            trendEl.innerText = isUp ? '🟢 ALTA' : '🔴 BAIXA';
            trendEl.className = isUp ? 'up' : 'down';

            const box = document.getElementById('signalBox');
            box.innerText = d.signal === 'BUY' ? '🟢 COMPRA CONFIRMADA' : d.signal === 'SELL' ? '🔴 VENDA CONFIRMADA' : '⏳ AGUARDANDO...';
            box.style.borderColor = d.color;
            box.style.color = d.color;
            
            // Raciocínio do sistema
            document.querySelector('.reasons')?.remove();
            const rDiv = document.createElement('div'); rDiv.className = 'reasons';
            d.reasons.forEach(r => { const t = document.createElement('span'); t.className = 'tag'; t.innerText = r; rDiv.appendChild(t); });
            box.appendChild(rDiv);

            document.getElementById('sl').innerText = \`$\${d.risk.sl}\`;
            document.getElementById('tp').innerText = \`$\${d.risk.tp}\`;

            // Alerta Telegram
            if (d.signal !== 'WAIT' && d.signal !== lastSig) {
                lastSig = d.signal;
                const msg = \`🚨 <b>SINAL \${d.signal}</b>\\n\\n💰 Preço: \${d.price}\\n📊 Razão: \${d.reasons.join(', ')}\\n\\n🛑 Stop: \${d.risk.sl}\\n✅ Alvo: \${d.risk.tp}\`;
                fetch('/api/alert', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message: msg}) });
                log(\`📢 Alerta Telegram enviado!\`);
            }
            
            log(\`✅ Atualizado | \${d.signal} | RSI:\${d.indicators.rsi.toFixed(1)}\`);
        } catch(e) { log(\`❌ Erro de conexão\`); }
    }

    run();
    setInterval(run, 15000);
</script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(HTML));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 App rodando em http://localhost:${PORT}`));

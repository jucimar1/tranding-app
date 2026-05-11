// Configurações
const CFG = {
    riskPerTrade: 100, slMult: 1.5, tpMult: 2.5, trailTrigger: 1.0,
    minVol: 0.005, maxVol: 0.03,
    rsiBuyMin: 30, rsiBuyMax: 65, rsiSellMin: 35, rsiSellMax: 70,
    interval: '15m', limit: 100, telegram: { enabled: true }
};

// Estado
const S = {
    sym: 'BTCUSDT', price: 0, change: 0, bot: false, connected: false,
    ws: null, wsRetries: 0,
    ind: { rsi: 0, atr: 0, macd: 0, sig: 0, hist: 0, ema21: 0 },
    hist: [], klines: [], pos: null, lastSig: null, logTime: 0, logCount: 0
};

// Matemática
const M = {
    sma: (p, n) => p.slice(-n).reduce((a, b) => a + b, 0) / n,
    ema: (p, n) => {
        if (p.length < n) return null;
        let v = M.sma(p, n), k = 2 / (n + 1);
        for (let i = n; i < p.length; i++) v = (p[i] - v) * k + v;
        return v;
    },
    atr: (k, n = 14) => {
        if (k.length < n + 1) return 0;
        let sum = 0;
        for (let i = 1; i <= n; i++) {
            const h = +k[i][2], l = +k[i][3], pc = +k[i-1][4];
            sum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
        }
        return sum / n;
    },
    rsi: (p, n = 14) => {
        if (p.length < n + 1) return 50;
        let g = 0, l = 0;
        for (let i = p.length - n; i < p.length; i++) {
            const d = p[i] - p[i-1]; d >= 0 ? g += d : l -= d;
        }
        const ag = g/n, al = l/n;
        return al === 0 ? 100 : 100 - (100 / (1 + ag/al));
    },
    norm: (v, max) => Math.max(-1, Math.min(1, v / max))
};

// MACD
const MACD = {
    calc: (closes, f = 12, sl = 26, sp = 9) => {
        if (closes.length < sl + sp) return { last: null };
        const ef = [], es = [];
        let vf = M.sma(closes, f), vs = M.sma(closes, sl);
        for (let i = 0; i < closes.length; i++) {
            vf = i < f ? M.sma(closes.slice(0, i+1), i+1) : (closes[i] - vf) * (2/(f+1)) + vf;
            vs = i < sl ? M.sma(closes.slice(0, i+1), i+1) : (closes[i] - vs) * (2/(sl+1)) + vs;
            ef.push(vf); es.push(vs);
        }
        const macd = ef.map((a, i) => a - es[i]);
        const sig = [], k = 2/(sp+1);
        let vsig = M.sma(macd.slice(sl, sl+sp), sp);
        for (let i = 0; i < macd.length; i++) {
            if (i < sl+sp-1) sig.push(null);
            else if (i === sl+sp-1) sig.push(vsig);
            else { vsig = (macd[i] - vsig) * k + vsig; sig.push(vsig); }
        }
        const hist = macd.map((m, i) => sig[i] !== null ? m - sig[i] : null);
        const idx = hist.slice().reverse().findIndex(x => x !== null);
        const realIdx = idx === -1 ? -1 : hist.length - 1 - idx;
        return { last: realIdx >= 0 ? { m: macd[realIdx], s: sig[realIdx], h: hist[realIdx] } : null, hist };
    },
    cross: (hh) => {
        const v = hh.filter(x => x !== null).slice(-3);
        if (v.length < 2) return null;
        return (v[v.length-2] < 0 && v[v.length-1] >= 0) ? 'bull' :
               (v[v.length-2] > 0 && v[v.length-1] <= 0) ? 'bear' : null;
    }
};

// Estratégia
const Strat = {
    vol: (atr, price) => {
        if (!atr || !price) return { ok: false, t: 'N/A', b: '' };
        const p = atr / price;
        if (p < CFG.minVol) return { ok: false, t: 'Baixa', b: 'low' };
        if (p > CFG.maxVol) return { ok: false, t: 'Excessiva', b: 'high' };
        return { ok: true, t: 'Ideal', b: 'ideal', p };
    },
    trend: (price, ema21) => {
        if (!price || !ema21) return { d: null, t: 'Aguardando' };
        const diff = (price - ema21) / ema21;
        return diff > 0.01 ? { d: 'alta', t: 'Alta' } :
               diff < -0.01 ? { d: 'baixa', t: 'Baixa' } : { d: 'lateral', t: 'Lateral' };
    },
    exits: (entry, atr, dir) => {
        const sd = atr * CFG.slMult, td = atr * CFG.tpMult, trd = atr * CFG.trailTrigger;
        return dir === 'BUY' ? { stop: entry - sd, tp: entry + td, trailTrig: entry + trd } :
                               { stop: entry + sd, tp: entry - td, trailTrig: entry - trd };
    },
    checkExit: (pos, price, ind) => {
        if (!pos) return null;
        const { entry, dir, stop, tp, trailTrig } = pos;
        if (dir === 'BUY') {
            if (price <= stop) return { r: '🛑 STOP LOSS', t: 'stop' };
            if (price >= tp) return { r: '✅ TAKE PROFIT', t: 'target' };
            if (!pos.trailActive && price >= trailTrig) { pos.trailActive = true; UI.log('Trailing ativado!', 'success'); }
        } else {
            if (price >= stop) return { r: '🛑 STOP LOSS', t: 'stop' };
            if (price <= tp) return { r: '✅ TAKE PROFIT', t: 'target' };
            if (!pos.trailActive && price <= trailTrig) { pos.trailActive = true; UI.log('Trailing ativado!', 'success'); }
        }
        return null;
    }
};

// UI
const UI = {
    el: id => document.getElementById(id),
    log: (msg, type = 'info') => {
        const now = Date.now();
        if (now - S.logTime < 400) return;
        S.logTime = now; S.logCount++;
        const el = UI.el('log');
        const time = new Date().toLocaleTimeString('pt-BR');
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${msg}</span>`;
        el.insertBefore(entry, el.firstChild);
        while (el.children.length > 50) el.removeChild(el.lastChild);
        UI.el('logCount').innerText = `${S.logCount} entradas`;
    },
    signal: (text, icon, sub, type, reasons = [], isNew = false) => {
        const card = UI.el('signalCard');
        card.className = `card signal ${type}${isNew ? ' signal-new' : ''}`;
        UI.el('signalIcon').innerText = icon;
        const textEl = UI.el('signalText');
        textEl.innerText = text;
        textEl.className = `signal-text`;
        UI.el('signalSub').innerText = sub;
        const reasonsEl = UI.el('signalReasons');
        reasonsEl.innerHTML = reasons.map(r => `<span style="padding:4px 12px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-size:11px;font-weight:600;">${r}</span>`).join('');
    },
    vol: (atrPct, info) => {
        UI.el('valAtrPct').innerText = `${(atrPct * 100).toFixed(2)}%`;
        const badge = UI.el('volBadge');
        badge.innerText = info.t;
        badge.className = `vol-badge ${info.b === 'ideal' ? 'bullish' : info.b === 'low' ? 'bearish' : 'bearish'}`;
        badge.style.background = info.b === 'ideal' ? 'rgba(0,212,170,0.12)' : 'rgba(255,71,87,0.12)';
        badge.style.color = info.b === 'ideal' ? 'var(--green)' : 'var(--red)';
        const fill = UI.el('volBarFill');
        fill.style.width = `${Math.min((atrPct / 0.05) * 100, 100)}%`;
        fill.style.background = info.b === 'ideal' ? 'linear-gradient(90deg, var(--green), #00ffcc)' : 'linear-gradient(90deg, #cc3344, var(--red))';
    },
    macd: (hist, atr) => {
        const fill = UI.el('macdFill');
        if (!atr || hist === null) { fill.style.width = '0%'; return; }
        const w = Math.abs(M.norm(hist, atr * 0.8)) * 100;
        fill.className = `macd-fill ${hist >= 0 ? 'pos' : 'neg'}`;
        fill.style.width = `${w}%`;
        fill.style.left = hist >= 0 ? '50%' : `${50 - w}%`;
    },
    indicators: (rsi, ema21, trend, macdH, atr, volOk) => {
        UI.el('valRsi').innerText = rsi.toFixed(1);
        const rsiEl = UI.el('rsiStatus');
        rsiEl.innerText = rsi < 25 ? 'Sobrevendido' : rsi > 75 ? 'Sobrecomprado' : 'Neutro';
        rsiEl.className = `status-badge ${rsi < 25 ? 'bearish' : rsi > 75 ? 'bearish' : 'neutral'}`;
        UI.el('valEma21').innerText = `$${ema21.toFixed(0)}`;
        const trendEl = UI.el('trendStatus');
        trendEl.innerText = trend.t;
        trendEl.className = `status-badge ${trend.d === 'alta' ? 'bullish' : trend.d === 'baixa' ? 'bearish' : 'neutral'}`;
        UI.el('valMacd').innerText = macdH > 0.0001 ? 'Positivo' : macdH < -0.0001 ? 'Negativo' : 'Neutro';
        UI.el('macdStatus').innerText = macdH > 0.0001 ? 'Positivo' : 'Neutro';
        UI.el('valAtr').innerText = atr.toFixed(2);
        UI.el('atrStatus').innerText = volOk ? 'OK' : '---';
        UI.el('atrStatus').className = `status-badge ${volOk ? 'bullish' : 'neutral'}`;
    },
    exits: (e) => {
        UI.el('calcStop').innerText = `$${e.stop.toFixed(2)}`;
        UI.el('calcTrail').innerText = `$${e.trailTrig.toFixed(2)}`;
        UI.el('calcTp').innerText = `$${e.tp.toFixed(2)}`;
    },
    lot: (atr) => {
        if (!atr || !S.price) return;
        UI.el('calcLot').innerText = `${(CFG.riskPerTrade / (atr * CFG.slMult)).toFixed(4)} un`;
    },
    pnl: () => {
        const box = UI.el('pnlBox');
        if (!S.pos?.active || !S.price) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        const pnl = (S.price - S.pos.entry) / (S.pos.dir === 'BUY' ? 1 : -1) / S.pos.entry * 100;
        const pos = pnl >= 0;
        box.className = `pnl-box ${pos ? 'pos' : 'neg'}`;
        const valEl = UI.el('pnlVal');
        valEl.innerText = `${pos ? '+' : ''}${pnl.toFixed(2)}%`;
        valEl.className = `pnl-value ${pos ? 'pos' : 'neg'}`;
    },
    updatePrice: (price, change, symbol) => {
        const pEl = UI.el('curPrice');
        pEl.innerText = `$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        pEl.className = `price ${change >= 0 ? 'up' : 'down'}`;
        const cEl = UI.el('priceChange');
        cEl.innerText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        cEl.className = `change ${change >= 0 ? 'up' : 'down'}`;
        UI.el('displaySym').innerText = symbol;
        UI.el('priceSub').innerText = `Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`;
    },
    connection: (c) => {
        S.connected = c;
        const el = UI.el('connStatus');
        const txt = UI.el('connText');
        if (c) { el.className = 'status'; txt.innerText = 'CONECTADO'; }
        else { el.className = 'status offline'; txt.innerText = 'DESCONECTADO'; }
    },
    alert: async (msg) => {
        UI.log(msg, 'alert');
        if (!CFG.telegram.enabled) return;
        try {
            await fetch('/api/telegram', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            });
        } catch (e) { console.warn('Telegram error', e); }
    }
};

// WebSocket
const WS = {
    connect: () => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${protocol}//${window.location.host}`;
        console.log('🔌 WebSocket:', url);
        
        S.ws = new WebSocket(url);
        
        S.ws.onopen = () => {
            console.log('✅ WebSocket conectado');
            S.wsRetries = 0;
            UI.connection(true);
            UI.log('WebSocket conectado', 'success');
            S.ws.send(JSON.stringify({ type: 'subscribe', symbol: S.sym }));
        };
        
        S.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'price') {
                    S.price = msg.data.price; S.change = msg.data.change;
                    UI.updatePrice(msg.data.price, msg.data.change, msg.data.symbol);
                    if (S.pos?.active) UI.pnl();
                } else if (msg.type === 'kline') {
                    const c = msg.data;
                    if (S.klines.length > 0 && S.klines[S.klines.length - 1][0] === c[0]) S.klines[S.klines.length - 1] = c;
                    else { S.klines.push(c); if (S.klines.length > 100) S.klines.shift(); }
                    Engine.analyze();
                } else if (msg.type === 'klines') {
                    S.klines = msg.data;
                    console.log('📊 Klines:', S.klines.length);
                    Engine.analyze();
                }
            } catch (err) { console.error('Erro WS:', err); }
        };
        
        S.ws.onclose = () => {
            console.log('❌ WebSocket fechado');
            UI.connection(false);
            if (S.wsRetries < 5) {
                S.wsRetries++;
                setTimeout(WS.connect, 2000 * S.wsRetries);
            }
        };
    }
};

// Engine
const Engine = {
    analyze: () => {
        if (S.klines.length < 30 || !S.price) return;
        
        const closes = S.klines.map(x => +x[4]);
        const rsi = M.rsi(closes, 14);
        const atr = M.atr(S.klines, 14);
        const atrP = atr / S.price;
        const ema21 = M.ema(closes, 21);
        const macd = MACD.calc(closes);
        
        if (macd.last?.h !== null) {
            S.hist.push(macd.last.h);
            if (S.hist.length > 20) S.hist.shift();
        }
        
        const cross = MACD.cross(S.hist);
        const vol = Strat.vol(atr, S.price);
        const trend = Strat.trend(S.price, ema21);
        
        let act = null, text = 'Aguardando...', icon = '🔍', type = 'wait', reasons = [];
        
        const buyOK = cross === 'bull' && vol.ok && trend.d === 'alta' && rsi >= CFG.rsiBuyMin && rsi <= CFG.rsiBuyMax;
        const sellOK = cross === 'bear' && vol.ok && trend.d === 'baixa' && rsi >= CFG.rsiSellMin && rsi <= CFG.rsiSellMax;
        
        if (buyOK) {
            act = 'BUY'; text = 'COMPRA CONFIRMADA'; icon = '🟢'; type = 'buy';
            reasons = ['MACD ↑', 'Vol OK', 'Alta', `RSI ${rsi.toFixed(1)}`];
        } else if (sellOK) {
            act = 'SELL'; text = 'VENDA CONFIRMADA'; icon = '🔴'; type = 'sell';
            reasons = ['MACD ↓', 'Vol OK', 'Baixa', `RSI ${rsi.toFixed(1)}`];
        } else {
            if (!vol.ok) { text = `Volatilidade ${vol.t}`; icon = '⏳'; }
            else if (!cross) { text = 'Aguardando MACD...'; icon = '🔍'; }
            else { text = trend.t; icon = '⚖️'; }
        }
        
        const isNew = act && act !== S.lastSig;
        UI.signal(text, icon, `Analisando ${S.sym}...`, type, reasons, isNew);
        if (isNew && act) {
            S.lastSig = act;
            UI.alert(`🎯 <b>${act}</b> em ${S.sym}\n💰 $${S.price.toFixed(2)}\n📊 ${reasons.join(' • ')}`);
        }
        
        UI.indicators(rsi, ema21, trend, macd.last?.h || 0, atr, vol.ok);
        UI.macd(macd.last?.h, atr);
        UI.vol(atrP, vol);
        
        if (act && S.bot && !S.pos?.active) {
            const e = Strat.exits(S.price, atr, act);
            S.pos = { entry: S.price, dir: act, ...e, active: true, macdH: macd.last?.h };
            UI.exits(e); UI.lot(atr);
            UI.log(`Nova ${act} @ $${S.price.toFixed(2)}`, 'success');
        } else if (S.pos?.active) {
            const ex = Strat.checkExit(S.pos, S.price, { hist: macd.last?.h });
            if (ex) {
                const pnl = ((S.price - S.pos.entry) / (S.pos.dir === 'BUY' ? 1 : -1) / S.pos.entry * 100);
                UI.alert(`${ex.r} em ${S.sym}\n💰 Entrada: $${S.pos.entry.toFixed(2)}\n🔚 Saída: $${S.price.toFixed(2)}\n📊 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`);
                UI.log(`${ex.r} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, 'alert');
                S.pos = null; UI.el('pnlBox').style.display = 'none';
                UI.signal('Aguardando...', '🔁', 'Analisando...', 'neutral');
            } else { UI.exits(Strat.exits(S.pos.entry, atr, S.pos.dir)); UI.pnl(); }
        }
        UI.lot(atr);
    },
    restart: () => {
        const newSym = UI.el('inputSym').value.toUpperCase().trim() || 'BTCUSDT';
        if (newSym !== S.sym) {
            S.sym = newSym; S.hist = []; S.pos = null; S.lastSig = null; S.klines = [];
            UI.signal('Carregando...', '🔄', `Buscando ${newSym}...`, 'wait');
            UI.log(`Analisando ${newSym}...`);
            if (S.ws && S.ws.readyState === 1) {
                S.ws.send(JSON.stringify({ type: 'subscribe', symbol: newSym }));
            }
        }
        UI.el('inputSym').value = S.sym;
    },
    toggleBot: () => {
        S.bot = !S.bot;
        const b = UI.el('botToggle');
        b.className = `btn-bot${S.bot ? ' active' : ''}`;
        b.innerText = S.bot ? 'BOT: ON' : 'BOT: OFF';
        UI.log(S.bot ? 'Bot ativado' : 'Bot pausado', S.bot ? 'success' : 'warn');
    },
    init: () => {
        UI.log('Sistema inicializado', 'success');
        UI.log('Conectando WebSocket...', 'info');
        WS.connect();
    }
};

window.addEventListener('load', Engine.init);
document.addEventListener('keydown', e => {
    if (e.key === 'F9') { e.preventDefault(); Engine.restart(); }
});

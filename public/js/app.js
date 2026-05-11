/**
 * 🎯 TIMING PRO ULTRA v2.0 — REAL-TIME TRADING
 * Com fallback REST e logs de depuração
 */

const CFG = {
    riskPerTrade: 100,
    slMult: 1.5, tpMult: 2.5, trailTrigger: 1.0,
    minVol: 0.005, maxVol: 0.03,
    rsiBuyMin: 30, rsiBuyMax: 65, rsiSellMin: 35, rsiSellMax: 70,
    interval: '15m', limit: 100,
    telegram: { enabled: false }
};

const S = {
    sym: 'BTCUSDT', price: 0, change: 0, bot: false, connected: false,
    ws: null, wsReconnectAttempts: 0,
    ind: { rsi: 0, atr: 0, atrPct: 0, macd: 0, sig: 0, hist: 0, ema21: 0 },
    histHistory: [], klines: [], pos: null, lastSignal: null,
    logTime: 0, logCount: 0, useRestFallback: false
};

// 🧮 UTILITÁRIOS
const M = {
    sma(p, n) { return p.slice(-n).reduce((a, b) => a + b, 0) / n; },
    ema(p, n) {
        if (p.length < n) return null;
        let v = M.sma(p, n), k = 2 / (n + 1);
        for (let i = n; i < p.length; i++) v = (p[i] - v) * k + v;
        return v;
    },
    atr(k, n = 14) {
        if (k.length < n + 1) return 0;
        let sum = 0;
        for (let i = 1; i <= n; i++) {
            const h = +k[i][2], l = +k[i][3], pc = +k[i - 1][4];
            sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        return sum / n;
    },
    rsi(p, n = 14) {
        if (p.length < n + 1) return 50;
        let g = 0, l = 0;
        for (let i = p.length - n; i < p.length; i++) {
            const d = p[i] - p[i - 1]; d >= 0 ? g += d : l -= d;
        }
        const ag = g / n, al = l / n;
        return al === 0 ? 100 : 100 - (100 / (1 + ag / al));
    },
    norm(v, max) { return Math.max(-1, Math.min(1, v / max)); }
};

// 📈 MACD
const MACD = {
    calc(closes, f = 12, sl = 26, sp = 9) {
        if (closes.length < sl + sp) return { last: null };
        const ef = [], es = [];
        let vf = M.sma(closes, f), vs = M.sma(closes, sl);
        for (let i = 0; i < closes.length; i++) {
            vf = i < f ? M.sma(closes.slice(0, i + 1), i + 1) : (closes[i] - vf) * (2 / (f + 1)) + vf;
            vs = i < sl ? M.sma(closes.slice(0, i + 1), i + 1) : (closes[i] - vs) * (2 / (sl + 1)) + vs;
            ef.push(vf); es.push(vs);
        }
        const macd = ef.map((a, i) => a - es[i]);
        const sig = [], k = 2 / (sp + 1);
        let vsig = M.sma(macd.slice(sl, sl + sp), sp);
        for (let i = 0; i < macd.length; i++) {
            if (i < sl + sp - 1) sig.push(null);
            else if (i === sl + sp - 1) sig.push(vsig);
            else { vsig = (macd[i] - vsig) * k + vsig; sig.push(vsig); }
        }
        const hist = macd.map((m, i) => sig[i] !== null ? m - sig[i] : null);
        const lastIdx = hist.slice().reverse().findIndex(x => x !== null);
        const idx = lastIdx === -1 ? -1 : hist.length - 1 - lastIdx;
        return { last: idx >= 0 ? { m: macd[idx], s: sig[idx], h: hist[idx] } : null, hist };
    },
    cross(hh) {
        const v = hh.filter(x => x !== null).slice(-3);
        if (v.length < 2) return null;
        return (v[v.length - 2] < 0 && v[v.length - 1] >= 0) ? 'bull' :
               (v[v.length - 2] > 0 && v[v.length - 1] <= 0) ? 'bear' : null;
    }
};

// 🎯 ESTRATÉGIA
const Strat = {
    vol(atr, price) {
        if (!atr || !price) return { ok: false, t: 'N/A', b: '' };
        const p = atr / price;
        if (p < CFG.minVol) return { ok: false, t: 'Baixa', b: 'low' };
        if (p > CFG.maxVol) return { ok: false, t: 'Excessiva', b: 'high' };
        return { ok: true, t: 'Ideal', b: 'ideal', p };
    },
    trend(price, ema21) {
        if (!price || !ema21) return { d: null, t: 'Aguardando...' };
        const diff = (price - ema21) / ema21;
        return diff > 0.01 ? { d: 'alta', t: 'Alta' } :
               diff < -0.01 ? { d: 'baixa', t: 'Baixa' } : { d: 'lateral', t: 'Lateral' };
    },
    exits(entry, atr, dir) {
        const sd = atr * CFG.slMult, td = atr * CFG.tpMult, trd = atr * CFG.trailTrigger;
        return dir === 'BUY' ? { stop: entry - sd, tp: entry + td, trailTrig: entry + trd, sd, td } :
                             { stop: entry + sd, tp: entry - td, trailTrig: entry - trd, sd, td };
    },
    checkExit(pos, price, ind) {
        if (!pos) return null;
        const { entry, dir, stop, tp, trailTrig } = pos;
        if (dir === 'BUY') {
            if (price <= stop) return { r: '🛑 STOP LOSS', t: 'stop' };
            if (price >= tp) return { r: '✅ TAKE PROFIT', t: 'target' };
            if (!pos.trailActive && price >= trailTrig) { pos.trailActive = true; UI.log('🔄 Trailing ativado!', 'success'); }
            if (ind.hist < 0 && pos.macdHist > 0 && ind.hist < -Math.abs(ind.m) * 0.3) return { r: '️ MACD Reverteu', t: 'early' };
        } else {
            if (price >= stop) return { r: '🛑 STOP LOSS', t: 'stop' };
            if (price <= tp) return { r: '✅ TAKE PROFIT', t: 'target' };
            if (!pos.trailActive && price <= trailTrig) { pos.trailActive = true; UI.log(' Trailing ativado!', 'success'); }
            if (ind.hist > 0 && pos.macdHist < 0 && ind.hist > Math.abs(ind.m) * 0.3) return { r: '️ MACD Reverteu', t: 'early' };
        }
        return null;
    }
};

// 🖥️ UI
const UI = {
    el: id => document.getElementById(id),
    log(msg, type = 'info') {
        const now = Date.now();
        if (now - S.logTime < 400) return;
        S.logTime = now; S.logCount++;
        const el = UI.el('log');
        const time = new Date().toLocaleTimeString('pt-BR');
        const icons = { alert: '🚨', err: '❌', success: '✅', info: '💬', warn: '⚠️' };
        const classes = { alert: 'alert', err: 'error', success: 'success', warn: 'alert', info: '' };
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `<span class="log-time">${time}</span><span class="log-icon">${icons[type] || ''}</span><span class="log-msg ${classes[type] || ''}">${msg}</span>`;
        el.insertBefore(entry, el.firstChild);
        while (el.children.length > 50) el.removeChild(el.lastChild);
        UI.el('logCount').innerText = `${S.logCount} entradas`;
    },
    signal(text, icon, sub, type, reasons = [], isNew = false) {
        const card = UI.el('signalCard');
        card.className = `card signal-card ${type}-signal${isNew ? ' signal-new' : ''}`;
        UI.el('signalIcon').innerText = icon;
        const textEl = UI.el('signalText');
        textEl.innerText = text;
        textEl.className = `signal-text ${type}-text`;
        UI.el('signalSub').innerText = sub;
        const reasonsEl = UI.el('signalReasons');
        reasonsEl.innerHTML = reasons.map(r => `<span class="reason-tag ${type === 'buy' ? 'active' : ''}">${r}</span>`).join('');
        if (isNew) setTimeout(() => card.classList.remove('signal-new'), 1500);
    },
    vol(atrPct, volInfo) {
        UI.el('valAtrPct').innerText = `${(atrPct * 100).toFixed(2)}%`;
        const badge = UI.el('volBadge');
        badge.innerText = volInfo.t;
        badge.className = `vol-badge ${volInfo.b}`;
        const fill = UI.el('volBarFill');
        const pct = Math.min((atrPct / 0.05) * 100, 100);
        fill.style.width = `${pct}%`;
        fill.className = `vol-bar-fill ${volInfo.b}`;
    },
    macd(hist, atr) {
        const fill = UI.el('macdFill');
        if (!atr || hist === null || hist === undefined) { fill.style.width = '0%'; return; }
        const str = M.norm(hist, atr * 0.8);
        const w = Math.abs(str) * 100;
        fill.className = `macd-fill ${hist >= 0 ? 'positive' : 'negative'}`;
        fill.style.width = `${w}%`;
        fill.style.left = hist >= 0 ? '50%' : `${50 - w}%`;
    },
    indicators(rsi, ema21, trend, macdHist, macdStatus, atr, atrStatus) {
        UI.el('valRsi').innerText = rsi.toFixed(1);
        const rsiEl = UI.el('rsiStatus');
        rsiEl.innerText = rsi < 25 ? 'Sobrevendido' : rsi > 75 ? 'Sobrecomprado' : 'Neutro';
        rsiEl.className = `indicator-status ${rsi < 25 ? 'bearish' : rsi > 75 ? 'bearish' : 'neutral'}`;
        UI.el('valEma21').innerText = `$${ema21.toFixed(0)}`;
        const trendEl = UI.el('trendStatus');
        trendEl.innerText = trend.t;
        trendEl.className = `indicator-status ${trend.d === 'alta' ? 'bullish' : trend.d === 'baixa' ? 'bearish' : 'neutral'}`;
        UI.el('valMacd').innerText = macdStatus;
        const macdEl = UI.el('macdStatus');
        macdEl.innerText = macdHist > 0.0001 ? 'Positivo' : macdHist < -0.0001 ? 'Negativo' : 'Neutro';
        macdEl.className = `indicator-status ${macdHist > 0.0001 ? 'bullish' : macdHist < -0.0001 ? 'bearish' : 'neutral'}`;
        UI.el('valAtr').innerText = atr.toFixed(2);
        const atrEl = UI.el('atrStatus');
        atrEl.innerText = atrStatus;
        atrEl.className = `indicator-status ${atrStatus === 'OK' ? 'bullish' : 'neutral'}`;
    },
    exits(e) {
        UI.el('calcStop').innerText = `$${e.stop.toFixed(2)}`;
        UI.el('calcTrail').innerText = `$${e.trailTrig.toFixed(2)}`;
        UI.el('calcTp').innerText = `$${e.tp.toFixed(2)}`;
    },
    lot(atr) {
        if (!atr || !S.price) return;
        const d = atr * CFG.slMult;
        UI.el('calcLot').innerText = `${(CFG.riskPerTrade / d).toFixed(4)} un`;
    },
    pnl() {
        const box = UI.el('pnlBox');
        if (!S.pos?.active || !S.price) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        const pnl = (S.price - S.pos.entry) / (S.pos.dir === 'BUY' ? 1 : -1) / S.pos.entry * 100;
        const pos = pnl >= 0;
        box.className = `pnl-box ${pos ? 'positive' : 'negative'}`;
        const valEl = UI.el('pnlVal');
        valEl.innerText = `${pos ? '+' : ''}${pnl.toFixed(2)}%`;
        valEl.className = `pnl-value ${pos ? 'positive' : 'negative'}`;
    },
    updatePrice(price, change, symbol) {
        const priceEl = UI.el('curPrice');
        priceEl.innerText = `$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        priceEl.className = `price-value ${change >= 0 ? 'up' : 'down'}`;
        const changeEl = UI.el('priceChange');
        changeEl.innerText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        changeEl.className = `price-change ${change >= 0 ? 'up' : 'down'}`;
        UI.el('displaySym').innerText = symbol;
        UI.el('priceSub').innerText = `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
    },
    connection(connected) {
        S.connected = connected;
        const el = UI.el('connStatus');
        const text = UI.el('connText');
        if (connected) { el.className = 'connection-status'; text.innerText = 'CONECTADO'; }
        else { el.className = 'connection-status disconnected'; text.innerText = 'DESCONECTADO'; }
    },
    async alert(msg) {
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

// 🔌 WEBSOCKET + FALLBACK REST
const WS = {
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        console.log('🔌 Tentando conectar WebSocket:', wsUrl);

        S.ws = new WebSocket(wsUrl);

        S.ws.onopen = () => {
            console.log('✅ WebSocket conectado');
            S.wsReconnectAttempts = 0;
            S.useRestFallback = false;
            UI.connection(true);
            UI.log('Conexão WebSocket estabelecida', 'success');
            S.ws.send(JSON.stringify({ type: 'subscribe', symbol: S.sym }));
        };

        S.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                WS.handleMessage(message);
            } catch (error) {
                console.error('Erro parsing WS:', error);
            }
        };

        S.ws.onclose = () => {
            console.log('❌ WebSocket desconectado');
            UI.connection(false);
            if (!S.useRestFallback && S.wsReconnectAttempts < 3) {
                const delay = Math.min(1000 * Math.pow(2, S.wsReconnectAttempts), 5000);
                S.wsReconnectAttempts++;
                UI.log(`Reconectando em ${delay / 1000}s...`, 'warn');
                setTimeout(WS.connect, delay);
            } else if (!S.useRestFallback) {
                console.log('🔄 WebSocket falhou, ativando fallback REST');
                S.useRestFallback = true;
                UI.log('WebSocket indisponível. Usando API REST...', 'warn');
                Engine.loadDataViaRest();
            }
        };

        S.ws.onerror = (error) => {
            console.error('Erro WebSocket:', error);
            UI.log('Erro na conexão WebSocket', 'err');
        };
    },

    handleMessage(message) {
        switch (message.type) {
            case 'price':
                S.price = message.data.price;
                S.change = message.data.change;
                UI.updatePrice(message.data.price, message.data.change, message.data.symbol);
                if (S.pos?.active) UI.pnl();
                break;
            case 'kline':
                const candle = message.data;
                if (S.klines.length > 0 && S.klines[S.klines.length - 1][0] === candle[0]) {
                    S.klines[S.klines.length - 1] = candle;
                } else {
                    S.klines.push(candle);
                    if (S.klines.length > 100) S.klines.shift();
                }
                Engine.analyze();
                break;
            case 'klines':
                S.klines = message.data;
                Engine.analyze();
                break;
        }
    }
};

// 🧠 ENGINE
const Engine = {
    async loadDataViaRest() {
        try {
            UI.log('Carregando dados via REST API...', 'info');
            const res = await fetch(`/api/init?symbol=${S.sym}`);
            if (!res.ok) throw new Error('Erro na API');
            const data = await res.json();
            
            S.price = data.price;
            S.change = data.change;
            S.klines = data.klines;
            
            UI.updatePrice(data.price, data.change, data.symbol);
            UI.log('Dados carregados com sucesso via REST', 'success');
            Engine.analyze();
            
            // Continua tentando WebSocket em background
            setTimeout(() => {
                if (S.ws?.readyState !== WebSocket.OPEN) {
                    S.wsReconnectAttempts = 0;
                    WS.connect();
                }
            }, 10000);
        } catch (error) {
            UI.log(`Erro carregando dados: ${error.message}`, 'err');
        }
    },

    analyze() {
        if (S.klines.length < 30 || !S.price) return;

        try {
            const closes = S.klines.map(x => +x[4]);
            const rsi = M.rsi(closes, 14);
            const atr = M.atr(S.klines, 14);
            const atrP = atr / S.price;
            const ema21 = M.ema(closes, 21);
            const macd = MACD.calc(closes);

            if (macd.last?.h !== null && macd.last?.h !== undefined) {
                S.histHistory.push(macd.last.h);
                if (S.histHistory.length > 20) S.histHistory.shift();
            }

            const cross = MACD.cross(S.histHistory);
            const vol = Strat.vol(atr, S.price);
            const trend = Strat.trend(S.price, ema21);

            let act = null, signalText = 'Aguardando confirmação...', signalIcon = '🔍',
                signalType = 'wait', reasons = [];

            const buyOK = cross === 'bull' && vol.ok && trend.d === 'alta' && rsi >= CFG.rsiBuyMin && rsi <= CFG.rsiBuyMax;
            const sellOK = cross === 'bear' && vol.ok && trend.d === 'baixa' && rsi >= CFG.rsiSellMin && rsi <= CFG.rsiSellMax;

            if (buyOK) {
                act = 'BUY'; signalText = 'COMPRA CONFIRMADA'; signalIcon = '🟢'; signalType = 'buy';
                reasons = ['MACD ↑', 'Vol OK', 'Tendência Alta', `RSI ${rsi.toFixed(1)}`];
            } else if (sellOK) {
                act = 'SELL'; signalText = 'VENDA CONFIRMADA'; signalIcon = '🔴'; signalType = 'sell';
                reasons = ['MACD ↓', 'Vol OK', 'Tendência Baixa', `RSI ${rsi.toFixed(1)}`];
            } else {
                if (!vol.ok) { signalText = `Volatilidade ${vol.t}`; signalIcon = '⏳'; }
                else if (!cross) { signalText = 'Aguardando MACD...'; signalIcon = ''; }
                else if (trend.d !== (cross === 'bull' ? 'alta' : 'baixa')) { signalText = trend.t; signalIcon = '⚖️'; }
                else { signalText = 'Confirmando...'; signalIcon = '🔍'; }
            }

            const isNew = act && act !== S.lastSignal;
            UI.signal(signalText, signalIcon, `Analisando ${S.sym}...`, signalType, reasons, isNew);
            if (isNew && act) S.lastSignal = act;

            const macdStatusText = cross ? (cross === 'bull' ? '↗ Cruzou ↑' : '↘ Cruzou ↓') :
                                   (macd.last?.h > 0.0001 ? 'Positivo' : macd.last?.h < -0.0001 ? 'Negativo' : 'Neutro');

            UI.indicators(rsi, ema21, trend, macd.last?.h || 0, macdStatusText, atr, vol.ok ? 'OK' : '---');
            UI.macd(macd.last?.h, atr);
            UI.vol(atrP, vol);

            S.ind = { rsi, atr, atrPct: atrP, m: macd.last?.m, sig: macd.last?.s, hist: macd.last?.h, ema21 };

            if (act && S.bot && !S.pos?.active) {
                const e = Strat.exits(S.price, atr, act);
                S.pos = { entry: S.price, dir: act, ...e, active: true, opened: Date.now(), macdHist: macd.last?.h };
                UI.exits(e); UI.lot(atr);
                UI.log(`Nova ${act} @ $${S.price.toFixed(2)}`, 'success');
                UI.alert(`🎯 <b>${act}</b> em ${S.sym}\n💰 $${S.price.toFixed(2)}\n ${reasons.join(' • ')}`);
            } else if (S.pos?.active) {
                const ex = Strat.checkExit(S.pos, S.price, S.ind);
                if (ex) {
                    const pnl = ((S.price - S.pos.entry) / (S.pos.dir === 'BUY' ? 1 : -1) / S.pos.entry * 100);
                    const msg = `${ex.r} em ${S.sym}\n💰 Entrada: $${S.pos.entry.toFixed(2)}\n🔚 Saída: $${S.price.toFixed(2)}\n ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
                    UI.alert(msg); UI.log(`${ex.r} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, ex.t === 'target' ? 'alert' : 'info');
                    S.pos = null; UI.el('pnlBox').style.display = 'none';
                    UI.signal('Aguardando próxima...', '🔁', 'Analisando mercado...', 'neutral');
                } else { UI.exits(Strat.exits(S.pos.entry, S.ind.atr, S.pos.dir)); UI.pnl(); }
            }
            UI.lot(S.ind.atr);
        } catch (e) {
            console.error(e);
            UI.log(`Erro análise: ${e.message}`, 'err');
        }
    },

    restart() {
        const newSym = UI.el('inputSym').value.toUpperCase().trim() || 'BTCUSDT';
        if (newSym !== S.sym) {
            S.sym = newSym; S.histHistory = []; S.pos = null; S.lastSignal = null; S.klines = [];
            UI.signal('Carregando...', '🔄', `Buscando dados de ${newSym}...`, 'neutral');
            UI.log(`Analisando ${newSym}...`);
            if (S.ws && S.ws.readyState === WebSocket.OPEN) {
                S.ws.send(JSON.stringify({ type: 'subscribe', symbol: newSym }));
            } else {
                Engine.loadDataViaRest();
            }
        }
        UI.el('inputSym').value = S.sym;
    },

    toggleBot() {
        S.bot = !S.bot;
        const b = UI.el('botToggle');
        b.className = `btn-bot-toggle${S.bot ? ' active' : ''}`;
        b.innerHTML = `<span class="bot-indicator"></span>BOT: ${S.bot ? 'ON' : 'OFF'}`;
        UI.log(S.bot ? 'Bot ativado' : 'Bot pausado', S.bot ? 'success' : 'warn');
    },

    fullscreen() {
        document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {});
    },

    init() {
        UI.log('Sistema inicializado', 'success');
        UI.log('Conectando...', 'info');
        WS.connect();

        // Health check
        setInterval(async () => {
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                if (data.status !== 'ok') UI.log('Health check failed', 'warn');
            } catch (e) {}
        }, 60000);
    }
};

// 🚀 START
window.addEventListener('load', Engine.init);
document.addEventListener('keydown', e => {
    if (e.key === 'F9') { e.preventDefault(); Engine.restart(); }
    if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
});

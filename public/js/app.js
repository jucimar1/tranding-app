/**
 * 🎯 TIMING PRO ULTRA v2.0 — REAL-TIME TRADING
 * Conexão WebSocket para dados em tempo real
 */

// 🔧 CONFIGURAÇÕES
const CFG = {
    riskPerTrade: 100,
    slMult: 1.5, 
    tpMult: 2.5,
    trailTrigger: 1.0,
    minVol: 0.005, 
    maxVol: 0.03,
    rsiBuyMin: 30, 
    rsiBuyMax: 65,
    rsiSellMin: 35, 
    rsiSellMax: 70,
    interval: '15m', 
    limit: 100,
    telegram: { enabled:false }
};

// 📦 ESTADO GLOBAL
const S = {
    sym: 'BTCUSDT', 
    price: 0, 
    change: 0, 
    bot: false, 
    connected: false,
    ws: null,
    wsReconnectAttempts: 0,
    ind: { rsi:0, atr:0, atrPct:0, macd:0, sig:0, hist:0, ema21:0 },
    histHistory: [],
    klines: [],
    pos: null,
    lastSignal: null, 
    logTime: 0
};

// 🧮 UTILITÁRIOS MATEMÁTICOS
const M = {
    sma(p, n) { 
        return p.slice(-n).reduce((a,b)=>a+b,0)/n; 
    },
    
    ema(p, n) {
        if(p.length < n) return null;
        let v = M.sma(p, n), k = 2/(n+1);
        for(let i=n; i<p.length; i++) 
            v = (p[i]-v)*k + v;
        return v;
    },
    
    atr(k, n=14) {
        if(k.length < n+1) return 0;
        let sum = 0;
        for(let i=1; i<=n; i++) {
            const h=+k[i][2], l=+k[i][3], pc=+k[i-1][4];
            sum += Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
        }
        return sum/n;
    },
    
    rsi(p, n=14) {
        if(p.length < n+1) return 50;
        let g=0, l=0;
        for(let i=p.length-n; i<p.length; i++) { 
            const d=p[i]-p[i-1]; 
            d>=0 ? g+=d : l-=d; 
        }
        const ag=g/n, al=l/n; 
        return al===0 ? 100 : 100-(100/(1+ag/al));
    },
    
    norm(v, max) { 
        return Math.max(-1, Math.min(1, v/max)); 
    }
};

// 📈 MACD COMPLETO
const MACD = {
    calc(closes, f=12, sl=26, sp=9) {
        if(closes.length < sl+sp) return { last:null };
        
        const ef=[], es=[];
        let vf=M.sma(closes,f), vs=M.sma(closes,sl);
        
        for(let i=0; i<closes.length; i++) {
            vf = i<f ? M.sma(closes.slice(0,i+1), i+1) : (closes[i]-vf)*(2/(f+1)) + vf;
            vs = i<sl ? M.sma(closes.slice(0,i+1), i+1) : (closes[i]-vs)*(2/(sl+1)) + vs;
            ef.push(vf); 
            es.push(vs);
        }
        
        const macd = ef.map((a,i)=>a-es[i]);
        const sig=[], k=2/(sp+1); 
        let vsig = M.sma(macd.slice(sl, sl+sp), sp);
        
        for(let i=0; i<macd.length; i++) {
            if(i<sl+sp-1) sig.push(null);
            else if(i===sl+sp-1) sig.push(vsig);
            else { 
                vsig=(macd[i]-vsig)*k+vsig; 
                sig.push(vsig); 
            }
        }
        
        const hist = macd.map((m,i)=> sig[i]!==null ? m-sig[i] : null);
        const lastIdx = hist.slice().reverse().findIndex(x=>x!==null);
        const idx = lastIdx===-1 ? -1 : hist.length-1-lastIdx;
        
        return { 
            last: idx>=0 ? { m:macd[idx], s:sig[idx], h:hist[idx] } : null, 
            hist 
        };
    },
    
    cross(hh) {
        const v = hh.filter(x=>x!==null).slice(-3);
        if(v.length<2) return null;
        return (v[v.length-2]<0 && v[v.length-1]>=0) ? 'bull' :
               (v[v.length-2]>0 && v[v.length-1]<=0) ? 'bear' : null;
    }
};

// 🎯 ESTRATÉGIA
const Strat = {
    vol(atr, price) {
        if(!atr||!price) return {ok:false, t:'N/A', b:'c-neutral'};
        const p = atr/price;
        if(p < CFG.minVol) return {ok:false, t:'Baixa', b:'c-bad'};
        if(p > CFG.maxVol) return {ok:false, t:'Excessiva', b:'c-warn'};
        return {ok:true, t:'Ideal', b:'c-ok', p};
    },
    
    trend(price, ema21) {
        if(!price||!ema21) return {d:null, t:'Aguardando...'};
        const diff = (price-ema21)/ema21;
        return diff>0.01 ? {d:'alta', t:'🟢 Tendência Alta'} :
               diff<-0.01 ? {d:'baixa', t:'🔴 Tendência Baixa'} :
               {d:'lateral', t:'⚪ Consolidação'};
    },
    
    exits(entry, atr, dir) {
        const sd = atr*CFG.slMult, 
              td = atr*CFG.tpMult, 
              trd = atr*CFG.trailTrigger;
        return dir==='BUY' ? { 
            stop:entry-sd, 
            tp:entry+td, 
            trailTrig:entry+trd, 
            sd, td 
        } : { 
            stop:entry+sd, 
            tp:entry-td, 
            trailTrig:entry-trd, 
            sd, td 
        };
    },
    
    checkExit(pos, price, ind) {
        if(!pos) return null;
        const { entry, dir, stop, tp, trailTrig, sd } = pos;
        
        if(dir==='BUY') {
            if(price<=stop) return {r:'🛑 STOP LOSS', t:'stop'};
            if(price>=tp) return {r:'✅ TAKE PROFIT', t:'target'};
            if(!pos.trailActive && price>=trailTrig) { 
                pos.trailActive=true; 
                UI.log('🔄 Trailing ativado!'); 
            }
            if(ind.hist<0 && pos.macdHist>0 && ind.hist < -Math.abs(ind.m)*0.3) 
                return {r:'⚠️ MACD Reverteu', t:'early'};
        } else {
            if(price>=stop) return {r:'🛑 STOP LOSS', t:'stop'};
            if(price<=tp) return {r:'✅ TAKE PROFIT', t:'target'};
            if(!pos.trailActive && price<=trailTrig) { 
                pos.trailActive=true; 
                UI.log('🔄 Trailing ativado!'); 
            }
            if(ind.hist>0 && pos.macdHist<0 && ind.hist > Math.abs(ind.m)*0.3) 
                return {r:'⚠️ MACD Reverteu', t:'early'};
        }
        return null;
    }
};

// 🖥️ INTERFACE & LOG
const UI = {
    el: id => document.getElementById(id),
    
    log(msg, type='info') {
        const now=Date.now(); 
        if(now-S.logTime<800) return; 
        S.logTime=now;
        
        const el = UI.el('log');
        const time = new Date().toLocaleTimeString('pt-BR');
        const p = type==='alert'?'🚨':type==='err'?'❌':'💬';
        const c = type==='err'?'var(--dan)':type==='alert'?'var(--pri)':'var(--wrn)';
        
        el.innerHTML = `<span style="color:${c}">[${time}] ${p}</span> ${msg}<br>` + el.innerHTML;
        el.innerHTML = el.innerHTML.split('<br>').filter(x=>x.trim()).slice(0,6).join('<br>');
    },
    
    signal(text, cls, isNew) {
        const box = UI.el('signalDisplay');
        box.innerText = text; 
        box.className = `signal-box ${cls}${isNew?' signal-new':''}`;
        if(isNew) setTimeout(()=>box.classList.remove('signal-new'), 1500);
    },
    
    macd(hist, atr) {
        const f = UI.el('macdFill'); 
        if(!atr||hist===null) { 
            f.style.width='0%'; 
            return; 
        }
        const str = M.norm(hist, atr*0.8); 
        const w = Math.abs(str)*100;
        f.className = `macd-fill ${hist>=0?'macd-pos':'macd-neg'}`;
        f.style.width = `${w}%`; 
        f.style.left = hist>=0?'50%':`${50-w}%`;
    },
    
    exits(e) { 
        UI.el('calcStop').innerText=`$${e.stop.toFixed(2)}`; 
        UI.el('calcTrail').innerText=`$${e.trailTrig.toFixed(2)}`; 
        UI.el('calcTp').innerText=`$${e.tp.toFixed(2)}`; 
    },
    
    lot(atr) { 
        if(!atr||!S.price) return; 
        const d=atr*CFG.slMult; 
        UI.el('calcLot').innerText=`${(CFG.riskPerTrade/d).toFixed(4)} un`; 
    },
    
    pnl() {
        const box=UI.el('pnlBox'); 
        if(!S.pos?.active||!S.price){
            box.style.display='none';
            return;
        }
        box.style.display='block';
        const pnl = (S.price - S.pos.entry)/(S.pos.dir==='BUY'?1:-1)/S.pos.entry*100;
        const p = pnl>=0; 
        box.style.background=p?'rgba(14,203,129,0.15)':'rgba(246,70,93,0.15)';
        box.style.borderColor=p?'var(--suc)':'var(--dan)';
        UI.el('pnlVal').innerText=`${p?'+':''}${pnl.toFixed(2)}%`;
        UI.el('pnlVal').style.color=p?'var(--suc)':'var(--dan)';
    },
    
    async alert(msg) {
        UI.log(msg, 'alert');
        if(!CFG.telegram.enabled) return;
        
        try {
            await fetch('/api/telegram', {
                method:'POST', 
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ message: msg })
            });
        } catch(e) { 
            console.warn('Telegram error', e); 
        }
    }
};

// 🔌 WEBSOCKET CLIENT
const WS = {
    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        S.ws = new WebSocket(wsUrl);
        
        S.ws.onopen = () => {
            console.log('✅ WebSocket connected');
            S.connected = true;
            S.wsReconnectAttempts = 0;
            UI.el('connStatus').innerText = 'CONECTADO';
            UI.el('statusDot').className = 'dot online';
            UI.log('✅ Conexão WebSocket estabelecida');
            
            // Subscribe ao símbolo atual
            S.ws.send(JSON.stringify({
                type: 'subscribe',
                symbol: S.sym
            }));
        };
        
        S.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                WS.handleMessage(message);
            } catch(error) {
                console.error('Error parsing WS message:', error);
            }
        };
        
        S.ws.onclose = () => {
            console.log('❌ WebSocket disconnected');
            S.connected = false;
            UI.el('connStatus').innerText = 'DESCONECTADO';
            UI.el('statusDot').className = 'dot offline';
            
            // Auto-reconnect
            if(S.wsReconnectAttempts < 10) {
                const delay = Math.min(1000 * Math.pow(2, S.wsReconnectAttempts), 10000);
                S.wsReconnectAttempts++;
                UI.log(`🔄 Reconectando em ${delay/1000}s...`);
                setTimeout(WS.connect, delay);
            }
        };
        
        S.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            UI.log('❌ Erro na conexão WebSocket', 'err');
        };
    },
    
    handleMessage(message) {
        switch(message.type) {
            case 'price':
                S.price = message.data.price;
                S.change = message.data.change;
                Engine.updatePriceUI(message.data);
                if(S.pos?.active) UI.pnl();
                break;
                
            case 'kline':
                // Atualiza último candle ou adiciona novo
                const candle = message.data;
                if(S.klines.length > 0 && S.klines[S.klines.length - 1][0] === candle[0]) {
                    S.klines[S.klines.length - 1] = candle;
                } else {
                    S.klines.push(candle);
                    if(S.klines.length > 100) S.klines.shift();
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

// 🧠 ENGINE PRINCIPAL
const Engine = {
    updatePriceUI(data) {
        UI.el('curPrice').innerText = `$ ${data.price.toLocaleString('pt-BR', {minimumFractionDigits:2})}`;
        UI.el('curPrice').style.color = data.change >= 0 ? 'var(--suc)' : 'var(--dan)';
        UI.el('priceChange').innerText = `${data.change >= 0 ? '+' : ''}${data.change.toFixed(2)}%`;
        UI.el('displaySym').innerText = data.symbol;
    },
    
    async analyze() {
        if(S.klines.length < 30) return;
        
        try {
            const closes = S.klines.map(x => +x[4]);
            const rsi = M.rsi(closes, 14);
            const atr = M.atr(S.klines, 14);
            const atrP = atr / S.price;
            const ema21 = M.ema(closes, 21);
            const macd = MACD.calc(closes);
            
            if(macd.last?.h !== null && macd.last?.h !== undefined) {
                S.histHistory.push(macd.last.h); 
                if(S.histHistory.length > 20) S.histHistory.shift();
            }
            
            const cross = MACD.cross(S.histHistory);
            const vol = Strat.vol(atr, S.price);
            const trend = Strat.trend(S.price, ema21);
            
            // LÓGICA DE ENTRADA
            let act = null, 
                text = '🔍 AGUARDANDO CONFIRMAÇÃO...', 
                cls = 'wait', 
                isNew = false, 
                reasons = [];
                
            const buyOK = cross === 'bull' && vol.ok && trend.d === 'alta' && 
                         rsi >= CFG.rsiBuyMin && rsi <= CFG.rsiBuyMax;
            const sellOK = cross === 'bear' && vol.ok && trend.d === 'baixa' && 
                          rsi >= CFG.rsiSellMin && rsi <= CFG.rsiSellMax;
            
            if(buyOK) { 
                act = 'BUY'; 
                text = '🟢 COMPRA CONFIRMADA'; 
                cls = 'buy'; 
                reasons = ['MACD ↑','Vol OK','Tendência Alta',`RSI ${rsi.toFixed(1)}`]; 
            } else if(sellOK) { 
                act = 'SELL'; 
                text = '🔴 VENDA CONFIRMADA'; 
                cls = 'sell'; 
                reasons = ['MACD ↓','Vol OK','Tendência Baixa',`RSI ${rsi.toFixed(1)}`]; 
            } else {
                if(!vol.ok) { 
                    text = `⏳ Volatilidade ${vol.t}`; 
                    cls = 'neutral'; 
                } else if(!cross) { 
                    text = '⏳ Aguardando MACD...'; 
                    cls = 'neutral'; 
                } else if(trend.d !== (cross === 'bull' ? 'alta' : 'baixa')) { 
                    text = `⏳ ${trend.t}`; 
                    cls = 'neutral'; 
                } else { 
                    text = '⏳ Confirmando...'; 
                    cls = 'wait'; 
                }
            }
            
            isNew = act && act !== S.lastSignal;
            UI.signal(text, cls, isNew);
            if(isNew && act) S.lastSignal = act;
            
            // ATUALIZA UI
            UI.el('macdStatus').innerText = cross ? 
                (cross === 'bull' ? '🟢 CRUZOU ↑' : '🔴 CRUZOU ↓') : 
                (macd.last?.h > 0.0001 ? '🟢 Pos' : macd.last?.h < -0.0001 ? '🔴 Neg' : '⚪ Neutro');
            
            UI.el('macdStatus').className = `cond ${cross ? 
                (cross === 'bull' ? 'c-ok' : 'c-warn') : 
                (Math.abs(macd.last?.h || 0) > 0.001 ? 'c-ok' : 'c-neutral')}`;
            
            UI.macd(macd.last?.h, atr);
            UI.el('valRsi').innerText = rsi.toFixed(1); 
            UI.el('rsiStatus').innerText = rsi < 25 ? 'Sobrevendido' : rsi > 75 ? 'Sobrecomprado' : 'Neutro';
            UI.el('valEma21').innerText = `$${ema21.toFixed(2)}`; 
            UI.el('trendStatus').innerText = trend.t;
            UI.el('valAtrPct').innerHTML = `${(atrP * 100).toFixed(2)}%<span class="cond ${vol.b}">${vol.t}</span>`;
            
            S.ind = { rsi, atr, atrPct: atrP, m: macd.last?.m, sig: macd.last?.s, hist: macd.last?.h, ema21 };
            
            // GESTÃO DE POSIÇÃO
            if(act && S.bot && !S.pos?.active) {
                const e = Strat.exits(S.price, atr, act);
                S.pos = { entry: S.price, dir: act, ...e, active: true, opened: Date.now(), macdHist: macd.last?.h };
                UI.exits(e); 
                UI.lot(atr);
                UI.log(`🎯 Nova ${act} @ $${S.price.toFixed(2)}`);
                UI.alert(`🎯 <b>${act}</b> em <code>${S.sym}</code>\n💰 $${S.price.toFixed(2)}\n📊 ${reasons.join(' • ')}`);
            } else if(S.pos?.active) {
                const ex = Strat.checkExit(S.pos, S.price, S.ind);
                if(ex) {
                    const pnl = ((S.price - S.pos.entry) / (S.pos.dir === 'BUY' ? 1 : -1) / S.pos.entry * 100);
                    const msg = `${ex.r} em ${S.sym}\n💰 Entrada: $${S.pos.entry.toFixed(2)}\n🔚 Saída: $${S.price.toFixed(2)}\n📊 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
                    UI.alert(msg); 
                    UI.log(`${ex.r} | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, ex.t === 'target' ? 'alert' : 'info');
                    S.pos = null; 
                    UI.el('pnlBox').style.display = 'none';
                    UI.signal('🔁 Aguardando próxima...', 'wait');
                } else { 
                    UI.exits(Strat.exits(S.pos.entry, S.ind.atr, S.pos.dir)); 
                    UI.pnl(); 
                }
            }
            UI.lot(S.ind.atr);
        } catch(e) { 
            console.error(e); 
            UI.log(`❌ ${e.message}`, 'err'); 
        }
    },
    
    restart() { 
        const newSym = UI.el('inputSym').value.toUpperCase().trim() || 'BTCUSDT';
        if(newSym !== S.sym) {
            S.sym = newSym; 
            S.histHistory = []; 
            S.pos = null; 
            S.lastSignal = null;
            S.klines = [];
            UI.el('displaySym').innerText = newSym; 
            UI.el('pnlBox').style.display = 'none';
            UI.signal('🔄 Carregando...', 'wait'); 
            UI.log(`📊 Analisando ${newSym}...`);
            
            // Notifica servidor para mudar símbolo
            if(S.ws && S.ws.readyState === WebSocket.OPEN) {
                S.ws.send(JSON.stringify({
                    type: 'subscribe',
                    symbol: newSym
                }));
            }
        }
        UI.el('inputSym').value = S.sym;
    },
    
    toggleBot() {
        S.bot = !S.bot;
        const b = UI.el('botToggle'); 
        b.className = `btn-bot${S.bot ? ' active' : ''}`; 
        b.innerText = S.bot ? '🤖 BOT AUTOMÁTICO: ON' : '🤖 BOT AUTOMÁTICO: OFF';
        UI.log(S.bot ? '✅ Bot ativado' : '⏸️ Bot pausado');
    },
    
    fullscreen() { 
        document.fullscreenElement ? 
            document.exitFullscreen() : 
            document.documentElement.requestFullscreen().catch(()=>{}); 
    },
    
    init() {
        UI.el('cfgRisk').innerText = `R$ ${CFG.riskPerTrade.toFixed(2)}`;
        UI.log('🎯 Timing Pro ULTRA v2.0 carregado');
        
        // Conecta WebSocket
        WS.connect();
        
        // Health check periódico
        setInterval(async () => {
            try {
                const res = await fetch('/api/health');
                const data = await res.json();
                if(data.status !== 'ok') {
                    UI.log('⚠️ Server health check failed', 'warn');
                }
            } catch(e) {
                // Silencioso
            }
        }, 60000);
    }
};

// 🚀 INICIALIZAÇÃO
window.addEventListener('load', Engine.init);

document.addEventListener('keydown', e => { 
    if(e.key === 'F9'){
        e.preventDefault(); 
        Engine.restart();
    } 
    if(e.key === 'Escape' && document.fullscreenElement) 
        document.exitFullscreen(); 
});
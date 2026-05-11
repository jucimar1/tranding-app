const CFG = { riskPerTrade: 100, slMult: 1.5, tpMult: 2.5, trailTrigger: 1.0, minVol: 0.005, maxVol: 0.03, rsiBuyMin: 30, rsiBuyMax: 65, rsiSellMin: 35, rsiSellMax: 70, telegram: { enabled: true } };

const S = { sym: 'BTCUSDT', price: 0, change: 0, bot: false, connected: false, ws: null, hist: [], klines: [], pos: null, lastSig: null, logTime: 0, logCount: 0 };

const M = {
    sma: (p, n) => p.slice(-n).reduce((a, b) => a + b, 0) / n,
    ema: (p, n) => { if (p.length < n) return null; let v = M.sma(p, n), k = 2/(n+1); for(let i=n; i<p.length; i++) v=(p[i]-v)*k+v; return v; },
    atr: (k, n=14) => { if(k.length<n+1) return 0; let s=0; for(let i=1;i<=n;i++){const h=+k[i][2],l=+k[i][3],pc=+k[i-1][4]; s+=Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc));} return s/n; },
    rsi: (p, n=14) => { if(p.length<n+1) return 50; let g=0,l=0; for(let i=p.length-n;i<p.length;i++){const d=p[i]-p[i-1]; d>=0?g+=d:l-=d;} const ag=g/n,al=l/n; return al===0?100:100-(100/(1+ag/al)); },
    norm: (v, max) => Math.max(-1, Math.min(1, v/max))
};

const MACD = {
    calc: (closes, f=12, sl=26, sp=9) => {
        if(closes.length<sl+sp) return {last:null};
        const ef=[],es=[]; let vf=M.sma(closes,f), vs=M.sma(closes,sl);
        for(let i=0;i<closes.length;i++){ vf=i<f?M.sma(closes.slice(0,i+1),i+1):(closes[i]-vf)*(2/(f+1))+vf; vs=i<sl?M.sma(closes.slice(0,i+1),i+1):(closes[i]-vs)*(2/(sl+1))+vs; ef.push(vf); es.push(vs); }
        const macd=ef.map((a,i)=>a-es[i]), sig=[], k=2/(sp+1); let vsig=M.sma(macd.slice(sl,sl+sp),sp);
        for(let i=0;i<macd.length;i++){ if(i<sl+sp-1) sig.push(null); else if(i===sl+sp-1) sig.push(vsig); else {vsig=(macd[i]-vsig)*k+vsig; sig.push(vsig);} }
        const hist=macd.map((m,i)=>sig[i]!==null?m-sig[i]:null), idx=hist.slice().reverse().findIndex(x=>x!==null), r=idx===-1?-1:hist.length-1-idx;
        return {last: r>=0?{m:macd[r],s:sig[r],h:hist[r]}:null, hist};
    },
    cross: (hh) => { const v=hh.filter(x=>x!==null).slice(-3); if(v.length<2) return null; return (v[v.length-2]<0 && v[v.length-1]>=0)?'bull':(v[v.length-2]>0 && v[v.length-1]<=0)?'bear':null; }
};

const Strat = {
    vol: (atr, price) => { if(!atr||!price) return {ok:false,t:'N/A',b:''}; const p=atr/price; return p<CFG.minVol?{ok:false,t:'Baixa',b:'low'}:p>CFG.maxVol?{ok:false,t:'Excessiva',b:'high'}:{ok:true,t:'Ideal',b:'ideal'}; },
    trend: (price, ema) => { if(!price||!ema) return {d:null,t:'Aguardando'}; const diff=(price-ema)/ema; return diff>0.01?{d:'alta',t:'Alta'}:diff<-0.01?{d:'baixa',t:'Baixa'}:{d:'lateral',t:'Lateral'}; },
    exits: (entry, atr, dir) => { const sd=atr*CFG.slMult, td=atr*CFG.tpMult, trd=atr*CFG.trailTrigger; return dir==='BUY'?{stop:entry-sd,tp:entry+td,trailTrig:entry+trd}:{stop:entry+sd,tp:entry-td,trailTrig:entry-trd}; },
    checkExit: (pos, price) => { if(!pos) return null; const {entry,dir,stop,tp,trailTrig}=pos; if(dir==='BUY'){if(price<=stop) return {r:'🛑 STOP LOSS'}; if(price>=tp) return {r:'✅ TAKE PROFIT'}; if(!pos.trailActive && price>=trailTrig){pos.trailActive=true;UI.log('Trailing ativado!','success');}} else {if(price>=stop) return {r:'🛑 STOP LOSS'}; if(price<=tp) return {r:'✅ TAKE PROFIT'}; if(!pos.trailActive && price<=trailTrig){pos.trailActive=true;UI.log('Trailing ativado!','success');}} return null; }
};

const UI = {
    el: id => document.getElementById(id),
    log: (msg, type='info') => { const now=Date.now(); if(now-S.logTime<400) return; S.logTime=now; S.logCount++; const el=UI.el('log'), time=new Date().toLocaleTimeString('pt-BR'), entry=document.createElement('div'); entry.className='log-entry'; entry.innerHTML=`<span class="log-time">${time}</span> <span class="log-msg ${type}">${msg}</span>`; el.insertBefore(entry,el.firstChild); while(el.children.length>50) el.removeChild(el.lastChild); UI.el('logCount').innerText=`${S.logCount} entradas`; },
    signal: (text, icon, sub, type, reasons=[]) => { const c=UI.el('signalCard'); c.className=`card signal ${type}`; UI.el('signalIcon').innerText=icon; UI.el('signalText').innerText=text; UI.el('signalSub').innerText=sub; UI.el('signalReasons').innerHTML=reasons.map(r=>`<span style="padding:4px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.06);border-radius:20px;font-size:11px;">${r}</span>`).join(''); },
    vol: (pct, info) => { UI.el('valAtrPct').innerText=`${(pct*100).toFixed(2)}%`; const b=UI.el('volBadge'); b.innerText=info.t; b.style.background=info.b==='ideal'?'rgba(0,212,170,0.12)':'rgba(255,71,87,0.12)'; b.style.color=info.b==='ideal'?'var(--green)':'var(--red)'; const f=UI.el('volBarFill'); f.style.width=`${Math.min((pct/0.05)*100,100)}%`; f.style.background=info.b==='ideal'?'linear-gradient(90deg,var(--green),#00ffcc)':'linear-gradient(90deg,#cc3344,var(--red))'; },
    macd: (h, atr) => { const f=UI.el('macdFill'); if(!atr||h===null){f.style.width='0%';return;} const w=Math.abs(M.norm(h,atr*0.8))*100; f.className=`macd-fill ${h>=0?'pos':'neg'}`; f.style.width=`${w}%`; f.style.left=h>=0?'50%':`${50-w}%`; },
    indicators: (rsi, ema, trend, mh, atr, vok) => { UI.el('valRsi').innerText=rsi.toFixed(1); const rs=UI.el('rsiStatus'); rs.innerText=rsi<25?'Sobrevendido':rsi>75?'Sobrecomprado':'Neutro'; rs.className=`status-badge ${rsi<25||rsi>75?'bearish':'neutral'}`; UI.el('valEma21').innerText=`$${ema.toFixed(0)}`; const tr=UI.el('trendStatus'); tr.innerText=trend.t; tr.className=`status-badge ${trend.d==='alta'?'bullish':trend.d==='baixa'?'bearish':'neutral'}`; UI.el('valMacd').innerText=mh>0.0001?'Positivo':mh<-0.0001?'Negativo':'Neutro'; UI.el('valAtr').innerText=atr.toFixed(2); const at=UI.el('atrStatus'); at.innerText=vok?'OK':'---'; at.className=`status-badge ${vok?'bullish':'neutral'}`; },
    exits: e => { UI.el('calcStop').innerText=`$${e.stop.toFixed(2)}`; UI.el('calcTrail').innerText=`$${e.trailTrig.toFixed(2)}`; UI.el('calcTp').innerText=`$${e.tp.toFixed(2)}`; },
    lot: atr => { if(!atr||!S.price) return; UI.el('calcLot').innerText=`${(CFG.riskPerTrade/(atr*CFG.slMult)).toFixed(4)} un`; },
    pnl: () => { const b=UI.el('pnlBox'); if(!S.pos?.active||!S.price){b.style.display='none';return;} b.style.display='block'; const p=((S.price-S.pos.entry)/(S.pos.dir==='BUY'?1:-1)/S.pos.entry*100), pos=p>=0; b.className=`pnl-box ${pos?'pos':'neg'}`; const v=UI.el('pnlVal'); v.innerText=`${pos?'+':''}${p.toFixed(2)}%`; v.className=`pnl-value ${pos?'pos':'neg'}`; },
    updatePrice: (p, c, s) => { const pe=UI.el('curPrice'); pe.innerText=`$ ${p.toLocaleString('pt-BR',{minimumFractionDigits:2})}`; pe.className=`price ${c>=0?'up':'down'}`; const ce=UI.el('priceChange'); ce.innerText=`${c>=0?'+':''}${c.toFixed(2)}%`; ce.className=`change ${c>=0?'up':'down'}`; UI.el('displaySym').innerText=s; UI.el('priceSub').innerText=`Atualizado: ${new Date().toLocaleTimeString('pt-BR')}`; },
    connection: c => { S.connected=c; const e=UI.el('connStatus'), t=UI.el('connText'); if(c){e.className='status';t.innerText='CONECTADO';} else {e.className='status offline';t.innerText='OFFLINE';} },
    alert: async msg => { UI.log(msg,'alert'); if(!CFG.telegram.enabled) return; try { await fetch('/api/telegram',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})}); } catch(e){} }
};

const WS = {
    connect: () => {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        S.ws = new WebSocket(`${proto}//${window.location.host}`);
        S.ws.onopen = () => { S.wsRetries=0; UI.connection(true); UI.log('WebSocket ativo','success'); S.ws.send(JSON.stringify({type:'subscribe',symbol:S.sym})); };
        S.ws.onmessage = e => { try { const m=JSON.parse(e.data); if(m.type==='price'){S.price=m.data.price;S.change=m.data.change;UI.updatePrice(m.data.price,m.data.change,m.data.symbol);if(S.pos?.active)UI.pnl();} else if(m.type==='kline'){const c=m.data;if(S.klines.length&&S.klines[S.klines.length-1][0]===c[0])S.klines[S.klines.length-1]=c;else{S.klines.push(c);if(S.klines.length>100)S.klines.shift();}Engine.analyze();} else if(m.type==='klines'){S.klines=m.data;Engine.analyze();} } catch(err){} };
        S.ws.onclose = () => { UI.connection(false); if(S.wsRetries<5){S.wsRetries++;setTimeout(WS.connect,2000*S.wsRetries);} };
    }
};

const Engine = {
    loadData: async () => {
        try {
            UI.log('Carregando dados...','info');
            const res = await fetch(`/api/data?symbol=${S.sym}`);
            const d = await res.json();
            S.price=d.price; S.change=d.change; S.klines=d.klines;
            UI.updatePrice(d.price,d.change,d.symbol);
            UI.log(`Dados recebidos (${S.klines.length} velas)`,'success');
            Engine.analyze();
        } catch(e) { UI.log(`Erro: ${e.message}`,'error'); }
    },
    analyze: () => {
        if(S.klines.length<30 || !S.price) return;
        const closes=S.klines.map(x=>+x[4]), rsi=M.rsi(closes,14), atr=M.atr(S.klines,14), atrP=atr/S.price, ema=M.ema(closes,21), macd=MACD.calc(closes);
        if(macd.last?.h!==null){S.hist.push(macd.last.h);if(S.hist.length>20)S.hist.shift();}
        const cross=MACD.cross(S.hist), vol=Strat.vol(atr,S.price), trend=Strat.trend(S.price,ema);
        let act=null, txt='Aguardando...', icon='🔍', type='wait', reasons=[];
        const buyOK=cross==='bull'&&vol.ok&&trend.d==='alta'&&rsi>=CFG.rsiBuyMin&&rsi<=CFG.rsiBuyMax;
        const sellOK=cross==='bear'&&vol.ok&&trend.d==='baixa'&&rsi>=CFG.rsiSellMin&&rsi<=CFG.rsiSellMax;
        if(buyOK){act='BUY';txt='COMPRA CONFIRMADA';icon='🟢';type='buy';reasons=['MACD↑','VolOK','Alta',`RSI${rsi.toFixed(0)}`];}
        else if(sellOK){act='SELL';txt='VENDA CONFIRMADA';icon='🔴';type='sell';reasons=['MACD↓','VolOK','Baixa',`RSI${rsi.toFixed(0)}`];}
        else { if(!vol.ok){txt=`Vol ${vol.t}`;icon='⏳';} else if(!cross){txt='Aguardando MACD';icon='🔍';} else {txt=trend.t;icon='⚖️';} }
        const isNew=act&&act!==S.lastSig; UI.signal(txt,icon,`Analisando ${S.sym}`,type,reasons); if(isNew&&act){S.lastSig=act;UI.alert(`🎯 <b>${act}</b> ${S.sym}\n$${S.price}\n${reasons.join(' • ')}`);}
        UI.indicators(rsi,ema,trend,macd.last?.h||0,atr,vol.ok); UI.macd(macd.last?.h,atr); UI.vol(atrP,vol);
        if(act&&S.bot&&!S.pos?.active){const e=Strat.exits(S.price,atr,act);S.pos={entry:S.price,dir:act,...e,active:true};UI.exits(e);UI.lot(atr);UI.log(`Nova ${act} $${S.price}`,'success');}
        else if(S.pos?.active){const ex=Strat.checkExit(S.pos,S.price);if(ex){const pnl=((S.price-S.pos.entry)/(S.pos.dir==='BUY'?1:-1)/S.pos.entry*100);UI.alert(`${ex.r} ${S.sym}\nIn: $${S.pos.entry}\nOut: $${S.price}\n${pnl>=0?'+':''}${pnl.toFixed(2)}%`);UI.log(`${ex.r} ${pnl>=0?'+':''}${pnl.toFixed(2)}%`,'alert');S.pos=null;UI.el('pnlBox').style.display='none';UI.signal('Aguardando','🔁','Analisando','wait');} else {UI.exits(Strat.exits(S.pos.entry,atr,S.pos.dir));UI.pnl();}}
        UI.lot(atr);
    },
    restart: () => { const ns=UI.el('inputSym').value.toUpperCase().trim()||'BTCUSDT'; if(ns!==S.sym){S.sym=ns;S.hist=[];S.pos=null;S.lastSig=null;S.klines=[];UI.signal('Carregando','🔄',`Buscando ${ns}`,'wait');UI.log(`Analisando ${ns}`);Engine.loadData();} UI.el('inputSym').value=S.sym; },
    toggleBot: () => { S.bot=!S.bot; const b=UI.el('botToggle'); b.className=`btn-bot${S.bot?' active':''}`; b.innerText=S.bot?'BOT: ON':'BOT: OFF'; UI.log(S.bot?'Bot ativado':'Bot pausado',S.bot?'success':'warn'); },
    init: () => { UI.log('Sistema iniciado','success'); Engine.loadData(); WS.connect(); setInterval(Engine.loadData, 30000); }
};

window.addEventListener('load', Engine.init);
document.addEventListener('keydown', e => { if(e.key==='F9'){e.preventDefault();Engine.restart();} });

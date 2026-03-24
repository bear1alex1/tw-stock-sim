// ═══════════════════════════════════════════════════════
//  台股虛擬操盤系統 v2.0
//  新增：報酬率欄位、已實現損益統計分頁
// ═══════════════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v2';   // ← v2 新 key，避免舊資料衝突

let state = loadState();
const quoteCache     = {};
const stockNameCache = {};

function getStockName(s){return stockNameCache[s]||'';}
function setStockName(code,name){if(code&&name){const n=String(name).trim();if(n)stockNameCache[code]=n;}}

// ── Token ─────────────────────────────────────────────
const _a='310e6e442e6b38367d5f32090246751d0770333750711b2b1b1e6e3d1e49306e7c5f327b7a125d3e206a210d5e7f122d3d3a4e35327d106f457b01722d396735327e3d304a7b022d643a5d3d387a1709486c200832167325227c10155b6c2f042d3a7332386921384a7f11353d2d734523522e285b7911083d2d7332327e2e19416c20252c2663103f6a2e33417a150c2215773d387a1433457f122d3d394e313e7d131e477b12132c3b4e317f7e10150b181d753746161c114b26386a524b303734692b2e4703145b5b2e1d381e42363c593631765e392f181c57073c';
const _b=[84,119,36,116,75,51,121,95,50,54,120,66];
function _r(){try{return(_a.match(/.{2}/g)||[]).map((h,i)=>String.fromCharCode(parseInt(h,16)^_b[i%_b.length])).join('')}catch{return''}}

// ── 台灣時間 & 市場狀態 ────────────────────────────────
function getTWDate(){return new Date(Date.now()+(8*3600000));}
function getMarketState(){
  const tw=getTWDate(),dow=tw.getUTCDay();
  if(dow===0||dow===6)return 'CLOSED';
  const t=tw.getUTCHours()*100+tw.getUTCMinutes();
  if(t>=830 &&t<900 )return 'PRE';
  if(t>=900 &&t<1330)return 'REGULAR';
  if(t>=1330&&t<1340)return 'CLOSING';
  if(t>=1340&&t<1430)return 'POST';
  return 'CLOSED';
}
function getMarketLabel(s){return{PRE:'盤前',REGULAR:'盤中',CLOSING:'收盤中',POST:'盤後零股',CLOSED:'收盤'}[s]||'收盤';}
function getMarketBadgeClass(s){
  if(s==='REGULAR')return 'badge-market-open';
  if(s==='POST'||s==='CLOSING')return 'badge-market-post';
  return 'badge-wait';
}
function getCacheTTL(){const s=getMarketState();if(s==='REGULAR')return 8000;if(s==='POST'||s==='CLOSING')return 30000;return 300000;}
function getRefreshInterval(){const s=getMarketState();if(s==='REGULAR')return 10000;if(s==='POST')return 60000;if(s==='CLOSING')return 30000;if(s==='PRE')return 60000;return 300000;}

function updateClock(){
  const tw=getTWDate(),pad=n=>String(n).padStart(2,'0');
  const el=document.getElementById('twClock');
  if(el)el.textContent=`${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())} (台灣)`;
  const ms=getMarketState();
  const badge=document.getElementById('marketBadge');
  if(badge){badge.textContent=getMarketLabel(ms);badge.className=`badge ${getMarketBadgeClass(ms)}`;badge.style.fontSize='.7rem';}
}

// ── Utilities ──────────────────────────────────────────
function num(v){
  if(v==null)return null;
  const s=String(v).replace(/,/g,'').replace(/＋/g,'+').replace(/[▲▼]/g,'').trim();
  if(!s||/^[-–]+$/.test(s)||['---','N/A','--'].includes(s))return null;
  const n=parseFloat(s);return isFinite(n)?n:null;
}
function normalizeSymbol(s){return String(s||'').trim().toUpperCase().replace(/\.TWO?$/i,'');}
function formatMoney(v){return Math.round(Number(v)||0).toLocaleString('zh-TW');}
function formatPrice(v){const n=num(v);return(n!==null&&n>0)?n.toFixed(2):'—';}
function formatPct(v){const n=num(v);return n!==null?`${n>=0?'+':''}${n.toFixed(2)}%`:'—';}

async function timedFetch(url,ms=8000){
  const ctrl=new AbortController();const tid=setTimeout(()=>ctrl.abort(),ms);
  try{const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});clearTimeout(tid);return r;}
  catch(e){clearTimeout(tid);throw e;}
}
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().slice(0,10);}
function getTWDateStr(){const tw=getTWDate();return`${tw.getUTCFullYear()}${String(tw.getUTCMonth()+1).padStart(2,'0')}${String(tw.getUTCDate()).padStart(2,'0')}`;}

// ── State ──────────────────────────────────────────────
function getEmptyState(){
  return{cash:INITIAL_CASH,holdings:{},history:[],realizedTrades:[],watchlist:[],realizedPnL:0,priceSource:'auto',savedAt:null};
}
function loadState(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return getEmptyState();
    const p=JSON.parse(raw);
    return{
      cash:         num(p.cash)??INITIAL_CASH,
      holdings:     (p.holdings&&typeof p.holdings==='object')?p.holdings:{},
      history:      Array.isArray(p.history)?p.history:[],
      realizedTrades: Array.isArray(p.realizedTrades)?p.realizedTrades:[],
      watchlist:    Array.isArray(p.watchlist)?[...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))]:[],
      realizedPnL:  num(p.realizedPnL)??0,
      priceSource:  p.priceSource||'auto',
      savedAt:      p.savedAt||null
    };
  }catch{return getEmptyState();}
}
function saveState(s){
  s.savedAt=new Date().toISOString();
  localStorage.setItem(STORAGE_KEY,JSON.stringify(s));
  const el=document.getElementById('lastSaved');
  if(el)el.textContent='最後儲存：'+new Date(s.savedAt).toLocaleString('zh-TW');
}
function updateLastSavedLabel(){
  const el=document.getElementById('lastSaved');
  if(el)el.textContent=state.savedAt?'最後儲存：'+new Date(state.savedAt).toLocaleString('zh-TW'):'最後儲存：—';
}
function calcFee(price,shares,side){
  const amount=price*shares;
  const broker=Math.max(Math.round(amount*0.001425),20);
  const tax=side==='sell'?Math.round(amount*0.003):0;
  return{amount,broker,tax,total:broker+tax};
}

// ══════════════════════════════════════════════════════
//  報價來源
// ══════════════════════════════════════════════════════

async function fetchMIS(symbol){
  const PROXIES=[u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`];
  for(const ex of['tse','otc']){
    const target=`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${symbol}.tw&json=1&delay=0`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),6000);if(!r.ok)continue;
        const text=await r.text();if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);const item=json?.msgArray?.[0];if(!item?.c)continue;
        const stockN=item.n||item.nf||'';if(stockN)setStockName(symbol,stockN);
        const z=(item.z&&item.z!=='-'&&item.z!=='0'&&item.z!=='--')?num(item.z):null;
        const y=num(item.y);const ms=getMarketState();
        const price=(ms==='REGULAR'&&z)?z:(z??y);if(!price||price<=0)continue;
        const base=ms==='REGULAR'?y:(y??null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        return{price,previousClose:base,change,changePct,marketState:ms,source:'MIS'};
      }catch(e){console.warn('[MIS]',e.message);}
    }
  }
  return null;
}

async function fetchTWSEWeb(symbol){
  const url=`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&stockNo=${symbol}&date=${getTWDateStr()}`;
  const PROXIES=[u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,u=>`https://thingproxy.freeboard.io/fetch/${u}`];
  for(const px of PROXIES){
    try{
      const r=await timedFetch(px(url),8000);if(!r.ok)continue;
      const text=await r.text();if(!text||text.trim().startsWith('<'))continue;
      const json=JSON.parse(text);
      if(json.stat!=='OK'||!Array.isArray(json.data)||!json.data.length)continue;
      const titleM=(json.title||'').match(new RegExp(symbol+'\\s+([\\u4e00-\\u9fff\\w·\\-]+)'));
      if(titleM)setStockName(symbol,titleM[1]);
      const row=json.data[json.data.length-1];
      const close=num(row[6]);const changeRaw=num(row[7]);
      if(!close||close<=0)continue;
      const prevClose=changeRaw!==null?parseFloat((close-changeRaw).toFixed(2)):null;
      const changePct=prevClose?parseFloat((changeRaw/prevClose*100).toFixed(2)):null;
      return{price:close,previousClose:prevClose,change:changeRaw,changePct,marketState:getMarketState(),source:'TWSE'};
    }catch(e){console.warn('[TWSE-Web]',e.message);}
  }
  return null;
}

async function fetchYahooBackup(symbol){
  const PROXIES=[u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`];
  for(const sfx of['.TW','.TWO']){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),7000);if(!r.ok)continue;
        const text=await r.text();if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);const result=json?.chart?.result?.[0];if(!result)continue;
        const meta=result.meta;
        const yName=meta?.longName||meta?.shortName||'';
        if(yName)setStockName(symbol,yName.replace(/\s*\(.*\)/,'').trim());
        const closes=(result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
        const regPx=num(meta?.regularMarketPrice);
        const prev=num(meta?.regularMarketPreviousClose)??num(meta?.previousClose);
        const last=closes.length?closes[closes.length-1]:null;
        const ms=getMarketState();
        const price=(ms==='REGULAR')?(regPx??last):(last??regPx);if(!price||price<=0)continue;
        const base=prev??(closes.length>=2?closes[closes.length-2]:null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        return{price,previousClose:base,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(_){}
    }
  }
  return null;
}

async function fetchGoogleFinance(symbol){
  const PROXIES=[u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`];
  for(const ex of['TPE','TPEX']){
    const target=`https://www.google.com/finance/quote/${symbol}:${ex}`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),8000);if(!r.ok)continue;
        const html=await r.text();if(!html||html.length<500||html.includes('did not match'))continue;
        let price=null;
        const m1=html.match(/data-last-price="([\d.]+)"/);if(m1)price=num(m1[1]);
        if(!price){const m2=html.match(/class="YMlKec fxKbKc"[^>]*>([\d,]+\.?\d*)</);if(m2)price=num(m2[1].replace(/,/g,''));}
        if(!price){const m3=html.match(/NT\$\s*([\d,]+\.?\d*)/);if(m3)price=num(m3[1].replace(/,/g,''));}
        if(!price){for(const m of html.matchAll(/>([\d,]+\.\d{2})</g)){const v=num(m[1].replace(/,/g,''));if(v&&v>1&&v<100000){price=v;break;}}}
        if(!price||price<=0)continue;
        const nm=html.match(/<title>([^-（（]+)/);if(nm)setStockName(symbol,nm[1].trim());
        return{price,previousClose:null,change:null,changePct:null,marketState:getMarketState(),source:'Google'};
      }catch(e){console.warn('[Google]',e.message);}
    }
  }
  return null;
}

async function fetchFinMind(symbol){
  const urls=[
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}&token=${encodeURIComponent(_r())}`,
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}`
  ];
  for(const url of urls){
    try{
      const r=await timedFetch(url,10000);if(!r.ok)continue;
      const json=await r.json();if(json.status!==200)continue;
      const data=json.data;if(!Array.isArray(data)||!data.length)continue;
      data.sort((a,b)=>a.date.localeCompare(b.date));
      const latest=data[data.length-1];const close=num(latest.close);if(!close||close<=0)continue;
      const spread=num(latest.spread);
      const prev=spread!==null?parseFloat((close-spread).toFixed(2)):(data.length>=2?num(data[data.length-2].close):null);
      const change=prev!==null?parseFloat((close-prev).toFixed(2)):null;
      const changePct=prev?parseFloat((change/prev*100).toFixed(2)):null;
      return{price:close,previousClose:prev,change,changePct,marketState:getMarketState(),source:'FinMind'};
    }catch(e){console.warn('[FM]',e.message);}
  }
  return null;
}

let _twseCache=null,_twseTs=0,_twseP=null;
async function _doLoadTwse(){
  for(const url of['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL','https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL']){
    try{
      const r=await timedFetch(url,12000);if(!r.ok)continue;
      const arr=await r.json();if(!Array.isArray(arr)||arr.length<50)continue;
      const map={};
      for(const item of arr){
        const code=String(item.Code??item['股票代號']??'').trim();
        const name=String(item.StockName??item['股票名稱']??'').trim();
        if(code&&name)setStockName(code,name);
        const close=num(item.ClosingPrice)??num(item['收盤價'])??null;
        const changeRaw=num(item.Change)??null;
        if(code&&close&&close>0){
          const prevClose=changeRaw!==null?parseFloat((close-changeRaw).toFixed(2)):null;
          map[code]={close,prevClose,change:changeRaw,changePct:prevClose&&changeRaw?parseFloat((changeRaw/prevClose*100).toFixed(2)):null};
        }
      }
      if(Object.keys(map).length>100)return map;
    }catch(e){console.warn('[TWSE-API]',e.message);}
  }
  return null;
}
function loadTwse(){
  if(_twseCache&&Date.now()-_twseTs<getCacheTTL()*5)return Promise.resolve(_twseCache);
  if(!_twseP){_twseP=_doLoadTwse().then(m=>{if(m){_twseCache=m;_twseTs=Date.now();}_twseP=null;return _twseCache;});}
  return _twseP;
}

let _tpexCache=null,_tpexTs=0,_tpexP=null;
async function _doLoadTpex(){
  try{
    const r=await timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',12000);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const arr=await r.json();if(!Array.isArray(arr)||arr.length<10)throw new Error('empty');
    const map={};
    for(const item of arr){
      const code=String(item.SecuritiesCompanyCode??item['代號']??'').trim();
      const name=String(item.CompanyName??item['公司名稱']??item.Name??'').trim();
      if(code&&name)setStockName(code,name);
      const close=num(item.Close)??num(item['收盤'])??null;
      if(code&&close&&close>0)map[code]={close,prevClose:null,change:null,changePct:null};
    }
    return map;
  }catch(e){console.warn('[TPEx-API]',e.message);return null;}
}
function loadTpex(){
  if(_tpexCache&&Date.now()-_tpexTs<getCacheTTL()*5)return Promise.resolve(_tpexCache);
  if(!_tpexP){_tpexP=_doLoadTpex().then(m=>{if(m){_tpexCache=m;_tpexTs=Date.now();}_tpexP=null;return _tpexCache;});}
  return _tpexP;
}

// ── 主報價函數 ─────────────────────────────────────────
async function fetchBySource(symbol,src){
  const m={mis:fetchMIS,twse:fetchTWSEWeb,yahoo:fetchYahooBackup,google:fetchGoogleFinance,finmind:fetchFinMind};
  return m[src]?m[src](symbol):null;
}

async function fetchQuote(symbol){
  symbol=normalizeSymbol(symbol);if(!symbol)return null;
  const cached=quoteCache[symbol];
  if(cached&&Date.now()-cached.ts<getCacheTTL())return cached.data;
  const ms=getMarketState();const src=state.priceSource||'auto';
  let priorities=[];
  if(src==='auto') priorities=(ms==='REGULAR'||ms==='POST')?['mis','twse','yahoo','google','finmind']:['twse','yahoo','finmind','google','mis'];
  else if(src==='twse')  priorities=['twse', ms==='REGULAR'?'mis':'yahoo','yahoo','finmind','google'];
  else if(src==='yahoo') priorities=['yahoo',ms==='REGULAR'?'mis':'twse','twse','finmind','google'];
  else if(src==='google')priorities=['google','yahoo',ms==='REGULAR'?'mis':'twse','twse','finmind'];
  let data=null;
  if(priorities.length>=2){
    const [r1,r2]=await Promise.allSettled([fetchBySource(symbol,priorities[0]),fetchBySource(symbol,priorities[1])]);
    data=(r1.status==='fulfilled'?r1.value:null)??(r2.status==='fulfilled'?r2.value:null);
  }
  if(!data){for(const p of priorities.slice(2)){data=await fetchBySource(symbol,p);if(data?.price>0)break;}}
  if(!data){
    const [tw,tp]=await Promise.allSettled([loadTwse(),loadTpex()]);
    const twseMap=tw.status==='fulfilled'?tw.value:null;
    const tpexMap=tp.status==='fulfilled'?tp.value:null;
    if(twseMap?.[symbol]?.close>0){const d=twseMap[symbol];data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TWSE-API'};}
    else if(tpexMap?.[symbol]?.close>0){const d=tpexMap[symbol];data={price:d.close,previousClose:null,change:null,changePct:null,marketState:ms,source:'TPEx-API'};}
  }
  if(!data||data.price<=0){console.error(`[Quote] ❌ ${symbol}`);return null;}
  data.marketState=ms;
  quoteCache[symbol]={data,ts:Date.now()};
  return data;
}

// ── 來源選擇器 ─────────────────────────────────────────
const SOURCE_NOTES={
  auto:{REGULAR:'開盤中 → MIS 即時優先（10秒更新），失敗自動切爬蟲',POST:'盤後零股 → MIS → 爬蟲備援',CLOSING:'收盤中 → 爬蟲',PRE:'盤前 → 爬蟲昨日收盤',CLOSED:'收盤後 → 爬蟲，節省 API 配額'},
  twse:{_:'台灣證交所官網，失敗備援 Yahoo/FinMind'},
  yahoo:{_:'Yahoo Finance API，失敗備援 TWSE/FinMind'},
  google:{_:'Google Finance HTML 解析，失敗自動備援'}
};
function renderSourceSelector(){
  const src=state.priceSource||'auto';
  document.querySelectorAll('.source-btn').forEach(btn=>btn.classList.toggle('active',btn.dataset.source===src));
  const note=document.getElementById('sourceNote');
  if(note){const map=SOURCE_NOTES[src]||{};const ms=getMarketState();note.textContent=map[ms]||map['_']||'';}
}
function setSource(src){
  state.priceSource=src;saveState(state);
  Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
  renderSourceSelector();
  showToast(`✅ 已切換：${{auto:'🤖 自動',twse:'🏛️ 證交所',yahoo:'📊 Yahoo',google:'🔍 Google'}[src]||src}`);
  refreshWatchlistPrices();refreshHoldingsPrices();
}

// ── 虛擬現金 ───────────────────────────────────────────
function addVirtualCash(){
  const input=prompt('充值金額（元）：','1000000');if(input===null)return;
  const amount=num(input.replace(/,/g,''));if(!amount||amount<=0){alert('❌ 金額無效');return;}
  state.cash+=amount;saveState(state);renderDashboardQuick();
  showToast(`✅ 充值 ${formatMoney(amount)} 元`);
}
function setVirtualCash(){
  const input=prompt('設定現金金額（元）：',String(Math.round(state.cash)));if(input===null)return;
  const amount=num(input.replace(/,/g,''));if(!amount||amount<=0){alert('❌ 金額無效');return;}
  state.cash=amount;saveState(state);renderDashboardQuick();
  showToast(`✅ 現金設為 ${formatMoney(amount)} 元`);
}

// ══════════════════════════════════════════════════════
//  Watchlist UI
// ══════════════════════════════════════════════════════
function buildWatchRow(symbol,q){
  const name=getStockName(symbol);const price=q?.price??null;
  const chg=q?.change??null;const pct=q?.changePct??null;
  const ms=getMarketState();const isUp=(chg??0)>=0;
  const src=q?.source?` <span style="font-size:.58rem;color:#444;">[${q.source}]</span>`:'';
  return`
    <td><div class="font-mono font-bold">${symbol}</div>${name?`<div style="font-size:.72rem;color:#8b949e;">${name}</div>`:''}</td>
    <td style="font-weight:600;">${formatPrice(price)}${src}</td>
    <td>
      ${chg!==null&&pct!==null
        ?`<div class="${isUp?'text-up':'text-down'}" style="font-weight:700;">${isUp?'+':''}${chg.toFixed(2)} <span style="font-size:.78rem;">(${isUp?'+':''}${pct.toFixed(2)}%)</span></div>`
        :'<div style="color:#444;">—</div>'}
      <div style="display:flex;gap:4px;margin-top:4px;">
        <span class="badge ${!q?'badge-wait':(isUp?'badge-rise':'badge-fall')}">${!q?'讀取中':(isUp?'▲':'▼')}</span>
        <span class="badge ${getMarketBadgeClass(ms)}">${getMarketLabel(ms)}</span>
      </div>
    </td>
    <td>
      <button class="text-xs text-blue-400 hover:underline mr-2" data-trade="${symbol}">操盤</button>
      <button class="text-xs hover:underline" style="color:#ff4d4d;" data-remove="${symbol}">移除</button>
    </td>`;
}
function bindWatchlistEvents(){
  const tbody=document.getElementById('watchlistBody');
  tbody.querySelectorAll('[data-trade]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.trade;};});
  tbody.querySelectorAll('[data-remove]').forEach(btn=>{btn.onclick=()=>removeFromWatchlist(btn.dataset.remove);});
}
function renderWatchlistImmediate(){
  const tbody=document.getElementById('watchlistBody');tbody.innerHTML='';
  for(const symbol of state.watchlist){
    const tr=document.createElement('tr');tr.dataset.symbol=symbol;
    tr.innerHTML=buildWatchRow(symbol,quoteCache[symbol]?.data??null);tbody.appendChild(tr);
  }
  bindWatchlistEvents();
}
async function refreshWatchlistPrices(){
  const tbody=document.getElementById('watchlistBody');
  for(const symbol of state.watchlist){
    const q=await fetchQuote(symbol);
    const tr=tbody.querySelector(`[data-symbol="${symbol}"]`);
    if(tr){tr.innerHTML=buildWatchRow(symbol,q);bindWatchlistEvents();}
  }
}
function addToWatchlist(){
  const input=document.getElementById('searchInput');
  const symbol=normalizeSymbol(input.value);if(!symbol)return;
  if(!state.watchlist.includes(symbol)){state.watchlist.push(symbol);saveState(state);showToast(`✅ 已加入追蹤：${symbol}`);}
  input.value='';renderWatchlistImmediate();refreshWatchlistPrices();
}
function removeFromWatchlist(symbol){
  symbol=normalizeSymbol(symbol);state.watchlist=state.watchlist.filter(s=>s!==symbol);
  delete quoteCache[symbol];saveState(state);renderWatchlistImmediate();
}

// ══════════════════════════════════════════════════════
//  Trade（含已實現損益記帳）
// ══════════════════════════════════════════════════════
async function executeTrade(side){
  const symbol=normalizeSymbol(document.getElementById('tradeSymbol').value);
  const shares=parseInt(document.getElementById('tradeQty').value,10);
  const pInput=document.getElementById('tradePrice').value.trim();
  const msg=document.getElementById('tradeMsg');
  if(!symbol||!shares||shares<1){msg.textContent='❌ 請填寫股票代號與股數';return;}
  const btnBuy=document.getElementById('btnBuy');const btnSell=document.getElementById('btnSell');
  btnBuy.disabled=btnSell.disabled=true;msg.textContent='⏳ 正在取得報價…';
  let price=num(pInput);
  if(!price||price<=0){const q=await fetchQuote(symbol);price=q?.price??null;}
  btnBuy.disabled=btnSell.disabled=false;
  if(!price||price<=0){msg.textContent='❌ 無法取得報價，請手動輸入';return;}
  const fee=calcFee(price,shares,side);
  const name=getStockName(symbol);
  const label=`${symbol}${name?' '+name:''}`;

  if(side==='buy'){
    const total=fee.amount+fee.total;
    if(total>state.cash){msg.textContent=`❌ 現金不足（需 ${formatMoney(total)} 元）`;return;}
    state.cash-=total;
    if(!

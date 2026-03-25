// ═══════════════════════════════════════════════════════
//  台股虛擬操盤系統 v2.2  |  SPA分頁 + Firebase雲端 + K線
//  version:'2.2'
// ═══════════════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v2';

let state = loadState();
const quoteCache    = {};
const stockNameCache = {};   // { '2330': '台積電', ... }
let _rotateSourceIdx = 0;     // 每5秒自動輪替報價來源索引

function getStockName(symbol){ return stockNameCache[symbol] || ''; }
function setStockName(code, name){
  if(!code||!name) return;
  const n=String(name).trim();
  if(!n) return;
  const existing=stockNameCache[code]||'';
  // 已有中文名稱則不覆蓋（避免 Yahoo 英文名蓋掉台灣股名）
  if(existing&&/[\u4e00-\u9fff]/.test(existing)) return;
  stockNameCache[code]=n;
}

// ─── Token ────────────────────────────────────────────
const _a='310e6e442e6b38367d5f32090246751d0770333750711b2b1b1e6e3d1e49306e7c5f327b7a125d3e206a210d5e7f122d3d3a4e35327d106f457b01722d396735327e3d304a7b022d643a5d3d387a1709486c200832167325227c10155b6c2f042d3a7332386921384a7f11353d2d734523522e285b7911083d2d7332327e2e19416c20252c2663103f6a2e33417a150c2215773d387a1433457f122d3d394e313e7d131e477b12132c3b4e317f7e10150b181d753746161c114b26386a524b303734692b2e4703145b5b2e1d381e42363c593631765e392f181c57073c';
const _b=[84,119,36,116,75,51,121,95,50,54,120,66];
function _r(){try{return(_a.match(/.{2}/g)||[]).map((h,i)=>String.fromCharCode(parseInt(h,16)^_b[i%_b.length])).join('')}catch{return''}}

// ─── 台灣時間 & 市場狀態 ───────────────────────────────

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

function getMarketLabel(s){
  return{PRE:'盤前',REGULAR:'盤中',CLOSING:'收盤中',POST:'盤後零股',CLOSED:'收盤'}[s]||'收盤';
}

function getMarketBadgeClass(s){
  if(s==='REGULAR') return 'badge-market-open';
  if(s==='POST'||s==='CLOSING') return 'badge-market-post';
  return 'badge-wait';
}

function getCacheTTL(){
  const s=getMarketState();
  if(s==='REGULAR') return 4_500;   // 配合5秒滾動刷新
  if(s==='POST'||s==='CLOSING') return 4_500;
  return 300_000;
}
function getRefreshInterval(){
  const s=getMarketState();
  if(s==='REGULAR')  return 10_000;
  if(s==='POST')     return 60_000;
  if(s==='CLOSING')  return 30_000;
  if(s==='PRE')      return 60_000;
  return 300_000;
}

// ─── 時鐘 ──────────────────────────────────────────────

function updateClock(){
  const tw=getTWDate(),pad=n=>String(n).padStart(2,'0');
  const el=document.getElementById('twClock');
  if(el) el.textContent=`${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())} (台灣)`;
  const ms=getMarketState();
  const badge=document.getElementById('marketBadge');
  if(badge){
    badge.textContent=getMarketLabel(ms);
    badge.className=`badge ${getMarketBadgeClass(ms)}`;
    badge.style.fontSize='.7rem';
  }
}

// ─── Utilities ─────────────────────────────────────────

function num(v){
  if(v===null||v===undefined)return null;
  const s=String(v).replace(/,/g,'').replace(/＋/g,'+').replace(/▲/g,'').replace(/▼/g,'-').trim();
  if(!s||/^[-–]+$/.test(s)||s==='---'||s==='N/A'||s==='--')return null;
  const n=parseFloat(s); return isFinite(n)?n:null;
}
function normalizeSymbol(s){return String(s||'').trim().toUpperCase().replace(/\.TWO?$/i,'');}
function formatMoney(v){return Math.round(Number(v)||0).toLocaleString('zh-TW');}
function formatPrice(v){const n=num(v);return(n!==null&&n>0)?n.toFixed(2):'—';}

async function timedFetch(url,ms=8000){
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),ms);
  try{const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});clearTimeout(tid);return r;}
  catch(e){clearTimeout(tid);throw e;}
}

function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().slice(0,10);}
function getTWDateStr(){const tw=getTWDate();return`${tw.getUTCFullYear()}${String(tw.getUTCMonth()+1).padStart(2,'0')}${String(tw.getUTCDate()).padStart(2,'0')}`;}

// ─── State ─────────────────────────────────────────────

function getEmptyState(){
  return{cash:INITIAL_CASH,holdings:{},history:[],realizedTrades:[],assetHistory:[],watchlist:[],realizedPnL:0,feeDiscount:0.6,priceSource:'auto',alerts:{},dividendChecked:{},savedAt:null};
}

function loadState(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return getEmptyState();
    const p=JSON.parse(raw);
    return{
      cash:          num(p.cash)??INITIAL_CASH,
      holdings:      (p.holdings&&typeof p.holdings==='object')?p.holdings:{},
      history:       Array.isArray(p.history)?p.history:[],
      realizedTrades:Array.isArray(p.realizedTrades)?p.realizedTrades:[],
      assetHistory:  Array.isArray(p.assetHistory)?p.assetHistory:[],
      watchlist:     Array.isArray(p.watchlist)?[...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))]:[],
      realizedPnL:   num(p.realizedPnL)??0,
      feeDiscount:   num(p.feeDiscount)??0.6,
      priceSource:   p.priceSource||'auto',
      savedAt:       p.savedAt||null
    };
  }catch{return getEmptyState();}
}

function saveState(s){
  s.savedAt=new Date().toISOString();
  localStorage.setItem(STORAGE_KEY,JSON.stringify(s));
  if(typeof _saveToFirestoreDebounced==='function') _saveToFirestoreDebounced();
  const el=document.getElementById('lastSaved');
  if(el) el.textContent='最後儲存：'+new Date(s.savedAt).toLocaleString('zh-TW');
}
let _fsTimer=null;
function _saveToFirestoreDebounced(){
  if(_fsTimer)clearTimeout(_fsTimer);
  _fsTimer=setTimeout(saveToFirestore,3000);
}

function updateLastSavedLabel(){
  const el=document.getElementById('lastSaved');
  if(el) el.textContent=state.savedAt?'最後儲存：'+new Date(state.savedAt).toLocaleString('zh-TW'):'最後儲存：—';
}

function calcFee(price,shares,side){
  const amount=price*shares;
  const discount=state?.feeDiscount??0.6;
  const broker=Math.max(Math.round(amount*0.001425*discount),1);
  const tax=side==='sell'?Math.round(amount*0.003):0;
  return{amount,broker,tax,total:broker+tax};
}

// ═══════════════════════════════════════════════════════
//  報價來源
// ═══════════════════════════════════════════════════════

// ── A. MIS 即時（盤中） ────────────────────────────────

async function fetchMIS(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const ex of['tse','otc']){
    const target=`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${symbol}.tw&json=1&delay=0`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),6000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const item=json?.msgArray?.[0];
        if(!item?.c)continue;
        // ▼ 擷取名稱
        const stockN=item.n||item.nf||'';
        if(stockN) setStockName(symbol,stockN);
        const z=(item.z&&item.z!=='-'&&item.z!=='0'&&item.z!=='--')?num(item.z):null;
        const y=num(item.y);
        const ms=getMarketState();
        const price=(ms==='REGULAR'&&z)?z:(z??y);
        if(!price||price<=0)continue;
        const base=ms==='REGULAR'?y:(y??null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log(`[MIS] ✅ ${symbol}(${ex}) ${price}`);
        return{price,previousClose:base,change,changePct,marketState:ms,source:'MIS'};
      }catch(e){console.warn(`[MIS] ${e.message}`);}
    }
  }
  return null;
}

// ── B. TWSE 官網 STOCK_DAY ─────────────────────────────

async function fetchTWSEWeb(symbol){
  const date=getTWDateStr();
  const url=`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&stockNo=${symbol}&date=${date}`;
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u=>`https://thingproxy.freeboard.io/fetch/${u}`
  ];
  for(const px of PROXIES){
    try{
      const r=await timedFetch(px(url),8000);
      if(!r.ok)continue;
      const text=await r.text();
      if(!text||text.trim().startsWith('<'))continue;
      const json=JSON.parse(text);
      if(json.stat!=='OK'||!Array.isArray(json.data)||!json.data.length)continue;
      // ▼ 從標題解析名稱（格式：「113年03月 2330 台積電 各日成交資訊」）
      const titleM=(json.title||'').match(new RegExp(symbol+'\\s+([\\u4e00-\\u9fff\\w·\\-]+)'));
      if(titleM) setStockName(symbol,titleM[1]);
      // fields:[日期,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數]
      const row=json.data[json.data.length-1];
      const close=num(row[6]);
      const changeRaw=num(row[7]);
      if(!close||close<=0)continue;
      const prevClose=changeRaw!==null?parseFloat((close-changeRaw).toFixed(2)):null;
      const changePct=prevClose?parseFloat((changeRaw/prevClose*100).toFixed(2)):null;
      const ms=getMarketState();
      console.log(`[TWSE-Web] ✅ ${symbol} ${close}`);
      return{price:close,previousClose:prevClose,change:changeRaw,changePct,marketState:ms,source:'TWSE'};
    }catch(e){console.warn(`[TWSE-Web] ${e.message}`);}
  }
  return null;
}

// ── C. Yahoo Finance ────────────────────────────────────

// ── Yahoo Finance：v7/quote 即時端點 + v8/chart 備援 ──────
async function fetchYahooBackup(symbol){
  const ts=Date.now(); // cache-buster，繞過 proxy 快取
  const ms=getMarketState();
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}&_cb=${ts}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];

  // ── 方法 1：v7/finance/quote（最直接的即時報價）────────
  async function _tryV7(sfx){
    const target=`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}${sfx}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName&_=${ts}`;
    const urls=[target,...PROXIES.map(px=>px(target))];
    for(const url of urls){
      try{
        const r=await timedFetch(url,5000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const q=json?.quoteResponse?.result?.[0];
        if(!q)continue;
        const price=num(q.regularMarketPrice);
        if(!price||price<=0)continue;
        const change=num(q.regularMarketChange);
        const changePct=num(q.regularMarketChangePercent);
        const prev=num(q.regularMarketPreviousClose);
        // 只在沒有中文名稱時才嘗試設定（setStockName 內部會判斷）
        if(q.shortName) setStockName(symbol,q.shortName);
        console.log(`[Yahoo-v7] ✅ ${symbol}${sfx} ${price}`);
        return{price,previousClose:prev,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(_){}
    }
    return null;
  }

  // ── 方法 2：v8/chart（備援，用 2m 線確保即時）─────────
  async function _tryV8(sfx){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?interval=2m&range=1d&_=${ts}`;
    const urls=[target,...PROXIES.map(px=>px(target))];
    for(const url of urls){
      try{
        const r=await timedFetch(url,6000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const result=json?.chart?.result?.[0];
        if(!result)continue;
        const meta=result.meta;
        if(meta?.shortName) setStockName(symbol,meta.shortName);
        const closes=(result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
        const regPx=num(meta?.regularMarketPrice);
        const prev=num(meta?.regularMarketPreviousClose)??num(meta?.previousClose);
        const last=closes.length?closes[closes.length-1]:null;
        const price=(ms==='REGULAR')?(regPx??last):(last??regPx);
        if(!price||price<=0)continue;
        const base=prev??(closes.length>=2?closes[closes.length-2]:null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log(`[Yahoo-v8] ✅ ${symbol}${sfx} ${price}`);
        return{price,previousClose:base,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(_){}
    }
    return null;
  }

  // 先試 .TW，再試 .TWO，v7 優先，v8 備援
  for(const sfx of['.TW','.TWO']){
    const d=await _tryV7(sfx)??await _tryV8(sfx);
    if(d) return d;
  }
  return null;
}

// ── Stooq 爬蟲（CSV，穩定快速，免 API Key）─────────────
async function fetchStooq(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const sfx of['.tw','.twp']){
    const target=`https://stooq.com/q/l/?s=${symbol.toLowerCase()}${sfx}&f=sd2t2ohlcvn&h&e=csv&_=${Date.now()}`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),6000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.includes('No data'))continue;
        const lines=text.trim().split('\n');
        if(lines.length<2)continue;
        const headers=lines[0].split(',').map(h=>h.trim().toLowerCase());
        const vals=lines[1].split(',').map(v=>v.trim());
        const get=k=>{ const i=headers.indexOf(k); return i>=0?vals[i]:null; };
        const close=num(get('close'));
        if(!close||close<=0)continue;
        // Stooq 不提供昨收，用 open 估算漲跌（僅供參考）
        const open=num(get('open'));
        const change=(open&&open>0)?parseFloat((close-open).toFixed(2)):null;
        const changePct=(open&&open>0)?parseFloat((change/open*100).toFixed(2)):null;
        const name=get('name')||get('n')||'';
        if(name) setStockName(symbol,name.trim());
        const ms=getMarketState();
        console.log(`[Stooq] ✅ ${symbol}${sfx} ${close}`);
        return{price:close,previousClose:open,change,changePct,marketState:ms,source:'Stooq'};
      }catch(e){console.warn(`[Stooq] ${e.message}`);}
    }
  }
  return null;
}

// ── D. Google Finance（HTML 爬蟲）──────────────────────

async function fetchGoogleFinance(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const ex of['TPE','TPEX']){
    const target=`https://www.google.com/finance/quote/${symbol}:${ex}`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),8000);
        if(!r.ok)continue;
        const html=await r.text();
        if(!html||html.length<500||html.includes('did not match'))continue;
        let price=null;
        const m1=html.match(/data-last-price="([\d.]+)"/);           if(m1)price=num(m1[1]);
        if(!price){const m2=html.match(/class="YMlKec fxKbKc"[^>]*>([\d,]+\.?\d*)</); if(m2)price=num(m2[1].replace(/,/g,''));}
        if(!price){const m3=html.match(/"price"\s*:\s*"([\d.]+)"/);  if(m3)price=num(m3[1]);}
        if(!price){const m4=html.match(/NT\$\s*([\d,]+\.?\d*)/);     if(m4)price=num(m4[1].replace(/,/g,''));}
        if(!price){
          for(const m of html.matchAll(/>([\d,]+\.\d{2})</g)){
            const v=num(m[1].replace(/,/g,''));
            if(v&&v>1&&v<100000){price=v;break;}
          }
        }
        if(!price||price<=0)continue;
        // ▼ 解析名稱
        const nm=html.match(/<title>([^-（]+)/);
        if(nm) setStockName(symbol,nm[1].trim());
        const ms=getMarketState();
        console.log(`[Google] ✅ ${symbol}:${ex} ${price}`);
        return{price,previousClose:null,change:null,changePct:null,marketState:ms,source:'Google'};
      }catch(e){console.warn(`[Google] ${e.message}`);}
    }
  }
  return null;
}

// ── E. FinMind ─────────────────────────────────────────

async function fetchFinMind(symbol){
  const urls=[
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}&token=${encodeURIComponent(_r())}`,
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}`
  ];
  for(const url of urls){
    try{
      const r=await timedFetch(url,10000);
      if(!r.ok)continue;
      const json=await r.json();
      if(json.status!==200)continue;
      const data=json.data;
      if(!Array.isArray(data)||!data.length)continue;
      data.sort((a,b)=>a.date.localeCompare(b.date));
      const latest=data[data.length-1];
      const close=num(latest.close);
      if(!close||close<=0)continue;
      const spread=num(latest.spread);
      const prev=spread!==null?parseFloat((close-spread).toFixed(2)):(data.length>=2?num(data[data.length-2].close):null);
      const change=prev!==null?parseFloat((close-prev).toFixed(2)):null;
      const changePct=prev?parseFloat((change/prev*100).toFixed(2)):null;
      const ms=getMarketState();
      return{price:close,previousClose:prev,change,changePct,marketState:ms,source:'FinMind'};
    }catch(e){console.warn(`[FM] ${e.message}`);}
  }
  return null;
}

// ── F. TWSE/TPEx OpenAPI 整批 ──────────────────────────

let _twseCache=null,_twseTs=0,_twseP=null;
async function _doLoadTwse(){
  for(const url of['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL','https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL']){
    try{
      const r=await timedFetch(url,12000);if(!r.ok)continue;
      const arr=await r.json();if(!Array.isArray(arr)||arr.length<50)continue;
      const map={};
      for(const item of arr){
        const code=String(item.Code??item['股票代號']??'').trim();
        // ▼ 擷取名稱
        const name=String(item.StockName??item['股票名稱']??'').trim();
        if(code&&name) setStockName(code,name);
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
      // ▼ 擷取名稱
      const name=String(item.CompanyName??item['公司名稱']??item.Name??'').trim();
      if(code&&name) setStockName(code,name);
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

// ═══════════════════════════════════════════════════════
//  主報價函數
// ═══════════════════════════════════════════════════════

async function fetchBySource(symbol,src){
  switch(src){
    case 'yahoo':   return fetchYahooBackup(symbol);
    case 'stooq':   return fetchStooq(symbol);
    case 'finmind': return fetchFinMind(symbol);
    // 保留備援但不列入輪替主流程
    case 'mis':     return fetchMIS(symbol);
    case 'twse':    return fetchTWSEWeb(symbol);
    case 'google':  return fetchGoogleFinance(symbol);
    default: return null;
  }
}

async function fetchQuote(symbol){
  symbol=normalizeSymbol(symbol);
  if(!symbol)return null;
  const cached=quoteCache[symbol];
  if(cached&&Date.now()-cached.ts<getCacheTTL())return cached.data;

  const ms=getMarketState();
  const src=state.priceSource||'auto';
  let data=null;

  // ── 主流程來源（Yahoo 優先，Stooq 穩定備援，FinMind 最終備援）──
  // 每5秒 _rotateSourceIdx++ 輪替起點，保持多源交替
  const MAIN_SOURCES = ['yahoo','stooq','finmind'];
  let priorities=[];
  if(src==='auto'){
    const si = _rotateSourceIdx % MAIN_SOURCES.length;
    priorities = [...MAIN_SOURCES.slice(si), ...MAIN_SOURCES.slice(0,si)];
  }else if(MAIN_SOURCES.includes(src)){
    const rest = MAIN_SOURCES.filter(s=>s!==src);
    priorities = [src,...rest];
  }else{
    // 指定 mis/twse/google 等舊來源：先用指定，失敗再走 Yahoo
    priorities = [src,'yahoo','stooq','finmind'];
  }

  // 第一順位先單打（通常 Yahoo 直連很快）
  try{
    const first=await fetchBySource(symbol,priorities[0]);
    if(first?.price>0) data=first;
  }catch(_){}

  // 失敗則並行打第2、3順位
  if(!data?.price && priorities.length>=2){
    const [r1,r2]=await Promise.allSettled([
      fetchBySource(symbol,priorities[1]),
      priorities[2]?fetchBySource(symbol,priorities[2]):Promise.resolve(null)
    ]);
    data=(r1.status==='fulfilled'&&r1.value?.price>0?r1.value:null)??
         (r2.status==='fulfilled'&&r2.value?.price>0?r2.value:null);
  }

  // 仍失敗：依序試其餘
  if(!data?.price){
    for(const p of priorities.slice(3)){
      try{ data=await fetchBySource(symbol,p); }catch(_){}
      if(data?.price>0) break;
    }
  }

  // 最終安全網：TWSE / TPEx OpenAPI 批量資料
  if(!data?.price){
    const [tw,tp]=await Promise.allSettled([loadTwse(),loadTpex()]);
    const twseMap=tw.status==='fulfilled'?tw.value:null;
    const tpexMap=tp.status==='fulfilled'?tp.value:null;
    if(twseMap?.[symbol]?.close>0){
      const d=twseMap[symbol];
      data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TWSE-API'};
    }else if(tpexMap?.[symbol]?.close>0){
      const d=tpexMap[symbol];
      data={price:d.close,previousClose:null,change:null,changePct:null,marketState:ms,source:'TPEx-API'};
    }
  }

  if(!data||data.price<=0){console.error(`[Quote] ❌ ${symbol}`);return null;}
  data.marketState=ms;
  console.log(`[Quote] ✅ ${symbol}=${data.price} [${data.source}][輪${_rotateSourceIdx%MAIN_SOURCES.length+1}/${MAIN_SOURCES.length}][${getMarketLabel(ms)}]`);
  quoteCache[symbol]={data,ts:Date.now()};
  return data;
}

// ═══════════════════════════════════════════════════════
//  來源選擇器 UI
// ═══════════════════════════════════════════════════════

const SOURCE_NOTES={
  auto:{
    REGULAR:'盤中 → Yahoo 即時優先，Stooq 穩定備援，FinMind 最終安全網（5秒輪替）',
    POST:'盤後 → Yahoo → Stooq → FinMind 依序嘗試',
    CLOSING:'收盤中 → Yahoo → Stooq → FinMind',
    PRE:'盤前 → Yahoo 昨日收盤，Stooq / FinMind 備援',
    CLOSED:'休市 → 每25秒查一次，Yahoo → Stooq → FinMind'
  },
  yahoo:{_:'Yahoo Finance (query1+query2 直連/Proxy)，Stooq / FinMind 備援'},
  stooq:{_:'Stooq CSV 爬蟲（穩定免 Key），Yahoo / FinMind 備援'},
  finmind:{_:'FinMind 個人 API（每日有配額），Yahoo / Stooq 備援'},
  google:{_:'Google Finance HTML（備用），Yahoo / Stooq 補位'}
};

function renderSourceSelector(){
  const src=state.priceSource||'auto';
  document.querySelectorAll('.source-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.source===src);
  });
  const note=document.getElementById('sourceNote');
  if(note){
    const map=SOURCE_NOTES[src]||{};
    const ms=getMarketState();
    note.textContent=map[ms]||map['_']||'';
  }
}

function setSource(src){
  state.priceSource=src;
  saveState(state);
  Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
  renderSourceSelector();
  const labels={auto:'🤖 自動',yahoo:'📊 Yahoo',stooq:'📈 Stooq',finmind:'🧠 FinMind',twse:'🏛️ 證交所',google:'🔍 Google'};
  showToast(`✅ 已切換：${labels[src]||src}`);
  refreshWatchlistPrices();
  refreshHoldingsPrices();
}

// ═══════════════════════════════════════════════════════
//  虛擬現金
// ═══════════════════════════════════════════════════════

function addVirtualCash(){
  const input=prompt('輸入充值金額（元）：','1000000');
  if(input===null)return;
  const amount=num(input.replace(/,/g,''));
  if(!amount||amount<=0){alert('❌ 金額無效');return;}
  state.cash+=amount;saveState(state);renderDashboardQuick();
  showToast(`✅ 充值 ${formatMoney(amount)} 元，現金 ${formatMoney(state.cash)} 元`);
}

function setVirtualCash(){
  const input=prompt('設定虛擬現金金額（元）：',String(Math.round(state.cash)));
  if(input===null)return;
  const amount=num(input.replace(/,/g,''));
  if(!amount||amount<=0){alert('❌ 金額無效');return;}
  state.cash=amount;saveState(state);renderDashboardQuick();
  showToast(`✅ 虛擬現金已設為 ${formatMoney(amount)} 元`);
}

// ═══════════════════════════════════════════════════════
//  Watchlist UI
// ═══════════════════════════════════════════════════════

// ── 只更新價格欄位內容（不重建整列，避免閃爍）──────
function _watchPriceCellHTML(q){
  const price = q?.price??null;
  const src   = q?.source?`<span style="font-size:.58rem;color:#444;margin-left:3px;">[${q.source}]</span>`:'';
  return `<span style="font-weight:600;">${formatPrice(price)}</span>${src}`;
}
function _watchChangeCellHTML(q){
  const chg   = q?.change??null;
  const pct   = q?.changePct??null;
  const ms    = getMarketState();
  const isUp     = (chg??0)>=0;
  const chgCls   = isUp?'text-up':'text-down';
  const badgeCls = !q?'badge-wait':(isUp?'badge-rise':'badge-fall');
  const arrow    = !q?'—':(isUp?'▲':'▼');
  return `${chg!==null&&pct!==null
    ?`<div class="${chgCls}" style="font-weight:700;">
        ${isUp?'+':''}${chg.toFixed(2)}
        <span style="font-size:.78rem;font-weight:400;">(${isUp?'+':''}${pct.toFixed(2)}%)</span>
      </div>`
    :'<div style="color:#444;">—</div>'}
    <div style="display:flex;gap:4px;margin-top:4px;">
      <span class="badge ${badgeCls}">${!q?'讀取中':arrow}</span>
      <span class="badge ${getMarketBadgeClass(ms)}">${getMarketLabel(ms)}</span>
    </div>`;
}

function buildWatchRow(symbol,q){
  const name = getStockName(symbol);
  const alert= state.alerts?.[symbol];
  const alertBadge= alert?`<span title="停損:${alert.stopLoss||'—'} 停利:${alert.takeProfit||'—'}" style="font-size:.6rem;color:#f3b73b;margin-left:4px;">🔔</span>`:'';
  return`
    <td>
      <div class="font-mono font-bold">${symbol}${alertBadge}</div>
      ${name?`<div style="font-size:.72rem;color:#8b949e;margin-top:1px;cursor:pointer;text-decoration:underline dotted;" onclick="toggleFundamentals('${symbol}')">${name}</div>`:'<div style="font-size:.72rem;color:#555;margin-top:1px;cursor:pointer;" onclick="toggleFundamentals(''+symbol+'')">📊 查看基本面</div>'}
    </td>
    <td class="wl-price">${_watchPriceCellHTML(q)}</td>
    <td class="wl-change">${_watchChangeCellHTML(q)}</td>
    <td>
      <button class="text-xs text-blue-400 hover:underline mr-2" data-trade="${symbol}">操盤</button>
      <button class="text-xs hover:underline mr-2" style="color:#f3b73b;" data-alert="${symbol}">🔔</button>
      <button class="text-xs hover:underline" style="color:#ff4d4d;" data-remove="${symbol}">移除</button>
    </td>`;
}

function bindWatchlistEvents(){
  const tbody=document.getElementById('watchlistBody');
  tbody.querySelectorAll('[data-trade]').forEach(btn=>{
    btn.onclick=()=>{
      const sym=btn.dataset.trade;
      // 1. 填入代號
      const inp=document.getElementById('tradeSymbol');
      if(inp){ inp.value=sym; }
      // 2. 導航到交易頁（SPA __navigate）
      if(typeof window.__navigate==='function'){
        window.__navigate('trade');
      } else {
        // fallback：操作 side-item
        document.querySelectorAll('#sideNav .side-item,#bottomNav .nav-item').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
        const sb=document.querySelector('[data-page="trade"]');
        const pg=document.getElementById('page-trade');
        if(sb) sb.classList.add('active');
        if(pg) pg.classList.add('active');
      }
      // 3. 自動帶入現價
      setTimeout(async ()=>{
        const q=quoteCache[normalizeSymbol(sym)]?.data;
        const priceEl=document.getElementById('tradePrice');
        if(priceEl&&q?.price>0) priceEl.value=q.price.toFixed(2);
        updateFeePreview();
      },200);
    };
  });
  tbody.querySelectorAll('[data-remove]').forEach(btn=>{btn.onclick=()=>removeFromWatchlist(btn.dataset.remove);});
  tbody.querySelectorAll('[data-alert]').forEach(btn=>{btn.onclick=()=>setAlert(btn.dataset.alert);});
}

function renderWatchlistImmediate(){
  const tbody=document.getElementById('watchlistBody');
  tbody.innerHTML='';
  for(const symbol of state.watchlist){
    const cached=quoteCache[symbol]?.data??null;
    const tr=document.createElement('tr');tr.dataset.symbol=symbol;
    tr.innerHTML=buildWatchRow(symbol,cached);tbody.appendChild(tr);
  }
  bindWatchlistEvents();
}

async function refreshWatchlistPrices(){
  const tbody=document.getElementById('watchlistBody');
  if(!state.watchlist.length) return;
  // 所有股票並行抓取，不阻塞等待
  const results=await Promise.allSettled(
    state.watchlist.map(s=>fetchQuote(s))
  );
  state.watchlist.forEach((symbol,i)=>{
    const q=results[i].status==='fulfilled'?results[i].value:null;
    const tr=tbody.querySelector(`[data-symbol="${symbol}"]`);
    if(!tr) return;
    const priceCell =tr.querySelector('.wl-price');
    const changeCell=tr.querySelector('.wl-change');
    if(priceCell)  priceCell.innerHTML =_watchPriceCellHTML(q);
    if(changeCell) changeCell.innerHTML=_watchChangeCellHTML(q);
  });
}

function addToWatchlist(){
  const input=document.getElementById('searchInput');
  const symbol=normalizeSymbol(input.value);
  if(!symbol)return;
  if(!state.watchlist.includes(symbol)){state.watchlist.push(symbol);saveState(state);showToast(`✅ 已加入追蹤：${symbol}`);}
  input.value='';
  renderWatchlistImmediate();
  refreshWatchlistPrices();
}

function removeFromWatchlist(symbol){
  symbol=normalizeSymbol(symbol);
  state.watchlist=state.watchlist.filter(s=>s!==symbol);
  delete quoteCache[symbol];saveState(state);renderWatchlistImmediate();
}

// ═══════════════════════════════════════════════════════
//  Trade
// ═══════════════════════════════════════════════════════

async function executeTrade(side){
  const symbol=normalizeSymbol(document.getElementById('tradeSymbol').value);
  const shares=parseInt(document.getElementById('tradeQty').value,10);
  const pInput=document.getElementById('tradePrice').value.trim();
  const msg=document.getElementById('tradeMsg');
  if(!symbol||!shares||shares<1){msg.textContent='❌ 請填寫股票代號與股數';return;}
  const btnBuy=document.getElementById('btnBuy');
  const btnSell=document.getElementById('btnSell');
  btnBuy.disabled=btnSell.disabled=true;
  msg.textContent='⏳ 正在取得報價…';
  let price=num(pInput);
  if(!price||price<=0){const q=await fetchQuote(symbol);price=q?.price??null;}
  btnBuy.disabled=btnSell.disabled=false;
  if(!price||price<=0){msg.textContent='❌ 無法取得報價，請手動輸入成交價';return;}
  const fee=calcFee(price,shares,side);
  if(side==='buy'){
    const total=fee.amount+fee.total;
    if(total>state.cash){msg.textContent=`❌ 現金不足（需 ${formatMoney(total)} 元）`;return;}
    state.cash-=total;
    if(!state.holdings[symbol])state.holdings[symbol]={shares:0,avgPrice:0};
    const h=state.holdings[symbol];const ns=h.shares+shares;
    h.avgPrice=((h.avgPrice*h.shares)+(price*shares))/ns;h.shares=ns;
    showToast(`🔴 買入 ${symbol}${getStockName(symbol)?' '+getStockName(symbol):''} ${shares} 股 @ ${price}，花費 ${formatMoney(total)} 元`);
  }else{
    const h=state.holdings[symbol];
    if(!h||h.shares<shares){msg.textContent='❌ 持股不足';return;}
    const proceeds=fee.amount-fee.total;
    state.realizedPnL+=proceeds-h.avgPrice*shares;state.cash+=proceeds;
    h.shares-=shares;if(h.shares===0)delete state.holdings[symbol];
    showToast(`🟢 賣出 ${symbol}${getStockName(symbol)?' '+getStockName(symbol):''} ${shares} 股 @ ${price}，入帳 ${formatMoney(proceeds)} 元`);
  }
  state.history.unshift({time:new Date().toLocaleString('zh-TW'),symbol,side,shares,price,amount:fee.amount,fee:fee.total});
  if(!state.watchlist.includes(symbol)){state.watchlist.unshift(symbol);state.watchlist=[...new Set(state.watchlist)];}
  saveState(state);msg.textContent='';document.getElementById('tradePrice').value='';
  renderDashboardQuick();renderHistory();renderRealized();
  renderWatchlistImmediate();renderHoldingsImmediate();
  refreshWatchlistPrices();refreshHoldingsPrices();
  setTimeout(()=>{renderCharts();recordAssetSnapshot();saveToFirestore();},600);
}

// ═══════════════════════════════════════════════════════
//  Holdings
// ═══════════════════════════════════════════════════════

function buildHoldingRow(symbol,h,q){
  const name  = getStockName(symbol);
  const price = (q?.price>0)?q.price:h.avgPrice;
  const mkt   = price*h.shares;
  const pnl   = mkt-h.avgPrice*h.shares;
  const ms    = getMarketState();
  const isUp  = pnl>=0;

  return`
    <td>
      <div class="font-mono font-bold">${symbol}${(state.alerts?.[symbol])?'<span style="font-size:.6rem;color:#f3b73b;margin-left:4px;">🔔</span>':''}</div>
      ${name?`<div style="font-size:.72rem;color:#8b949e;margin-top:1px;">${name}</div>`:''}
    </td>
    <td>${h.shares} 股</td>
    <td>${formatPrice(h.avgPrice)}</td>
    <td>
      <span style="font-weight:600;">${formatPrice(price)}</span>
      <span style="font-size:.7rem;color:${ms==='REGULAR'?'#388bfd':'#555'};margin-left:4px;">${q?getMarketLabel(ms):''}</span>
    </td>
    <td class="${isUp?'text-up':'text-down'}" style="font-weight:700;">
      ${isUp?'+':''}${formatMoney(pnl)}
    </td>
    <td>
      <button class="text-xs text-blue-400 hover:underline mr-2" data-sell="${symbol}">賣出</button>
      <button class="text-xs hover:underline" style="color:#f3b73b;" data-setalert="${symbol}">🔔</button>
    </td>`;
}

function renderHoldingsImmediate(){
  const tbody=document.getElementById('holdingsBody');
  const empty=document.getElementById('holdingsEmpty');
  tbody.innerHTML='';
  const symbols=Object.keys(state.holdings);
  if(!symbols.length){empty.style.display='';document.getElementById('holdingsValue').textContent='$ 0';return 0;}
  empty.style.display='none';let total=0;
  for(const symbol of symbols){
    const h=state.holdings[symbol];const q=quoteCache[symbol]?.data??null;
    const price=(q?.price>0)?q.price:h.avgPrice;total+=price*h.shares;
    const tr=document.createElement('tr');tr.dataset.hsymbol=symbol;
    tr.innerHTML=buildHoldingRow(symbol,h,q);tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-setalert]').forEach(btn=>{btn.onclick=()=>setAlert(btn.dataset.setalert);});
  tbody.querySelectorAll('[data-sell]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(total);
  if(typeof renderHoldingsOverview==='function')renderHoldingsOverview();
  return total;
}

async function refreshHoldingsPrices(){
  const tbody=document.getElementById('holdingsBody');let total=0;
  for(const symbol of Object.keys(state.holdings)){
    const h=state.holdings[symbol];const q=await fetchQuote(symbol);
    const tr=tbody.querySelector(`[data-hsymbol="${symbol}"]`);
    if(q?.price>0) checkAlerts(symbol,q.price);
    if(tr){
      tr.innerHTML=buildHoldingRow(symbol,h,q);
      tbody.querySelectorAll('[data-setalert]').forEach(btn=>{btn.onclick=()=>setAlert(btn.dataset.setalert);});
      tbody.querySelectorAll('[data-sell]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
    }
    total+=((q?.price>0)?q.price:h.avgPrice)*h.shares;
  }
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(total);
  renderDashboardQuick(total);
}

// ─── History ───────────────────────────────────────────

function renderHistory(){
  const tbody=document.getElementById('tradeHistoryBody');
  const empty=document.getElementById('historyEmpty');
  tbody.innerHTML='';
  if(!state.history.length){empty.style.display='';return;}
  empty.style.display='none';
  state.history.slice(0,50).forEach(r=>{
    const name=getStockName(r.symbol);
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="text-xs" style="color:#555;white-space:nowrap;">${r.time}</td>
      <td>
        <div class="font-mono font-bold">${r.symbol}</div>
        ${name?`<div style="font-size:.7rem;color:#8b949e;">${name}</div>`:''}
      </td>
      <td><span class="badge ${r.side==='buy'?'badge-buy':'badge-sell'}">${r.side==='buy'?'買入':'賣出'}</span></td>
      <td>${r.shares} 股</td>
      <td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-xs" style="color:#555;">${formatMoney(r.fee)}</td>`;
    tbody.appendChild(tr);
  });
}

// ─── Dashboard ─────────────────────────────────────────

function renderDashboardQuick(hv){
  if(hv===undefined){const txt=document.getElementById('holdingsValue').textContent.replace(/[^\d]/g,'');hv=parseInt(txt,10)||0;}
  document.getElementById('cashDisplay').textContent  ='$ '+formatMoney(state.cash);
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(hv);
  document.getElementById('totalAsset').textContent   ='$ '+formatMoney(state.cash+hv);
  const pnl=num(state.realizedPnL)??0;
  const el=document.getElementById('totalPnL');
  el.textContent=`${pnl>=0?'+':''}${formatMoney(pnl)} 元`;
  el.className=`text-xl font-bold ${pnl>=0?'text-up':'text-down'}`;
  // ── 最大回撤
  const dd=calcMaxDrawdown();
  const ddEl=document.getElementById('maxDrawdown');
  if(ddEl) ddEl.textContent=dd!=null?`-${dd}%`:'—';
  // ── 持股數
  const hcEl=document.getElementById('holdingsCount');
  if(hcEl) hcEl.textContent=Object.keys(state.holdings||{}).length+' 種';
  // ── 勝率
  const trades=state.realizedTrades||[];
  const wins=trades.filter(t=>t.netPnl>0).length;
  const wr=trades.length?((wins/trades.length)*100).toFixed(1)+'%':'—';
  const wrEl=document.getElementById('dashWinRate');
  if(wrEl) wrEl.textContent=wr;
}

// ─── Backup ────────────────────────────────────────────

function exportDataToJson(){
  const payload={exportedAt:new Date().toISOString(),version:'2.0',data:loadState()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
  const a=document.createElement('a');a.href=url;a.download=`stock_backup_${today}.json`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast(`💾 備份已下載：stock_backup_${today}.json`);
}

function importDataFromJson(event){
  const file=event.target.files?.[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=(e)=>{
    try{
      const parsed=JSON.parse(e.target.result);const imported=parsed.data||parsed;
      if(!imported||typeof imported.cash==='undefined'||!Array.isArray(imported.watchlist)){alert('❌ 無效備份格式');return;}
      imported.watchlist=[...new Set(imported.watchlist.map(normalizeSymbol).filter(Boolean))];
      if(!Array.isArray(imported.realizedTrades))imported.realizedTrades=[];
      localStorage.setItem(STORAGE_KEY,JSON.stringify(imported));
      showToast('✅ 備份載入！');setTimeout(()=>location.reload(),1000);
    }catch(err){alert('❌ 解析失敗：'+err.message);}
    finally{event.target.value='';}
  };
  reader.readAsText(file,'utf-8');
}

function resetAllData(){
  if(!confirm('⚠️ 確定要重置為初始 100 萬嗎？'))return;
  localStorage.removeItem(STORAGE_KEY);location.reload();
}

function showToast(msg){
  const el=document.getElementById('toast');if(!el)return;
  el.textContent=msg;el.style.display='block';
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>{el.style.display='none';},3500);
}

// ─── 智慧排程 ──────────────────────────────────────────

let _refreshTimer=null;
// ── 5秒滾動刷新（輪替來源） ─────────────────────────────
let _wlRefreshTimer=null;
function startWatchlistAutoRefresh(){
  if(_wlRefreshTimer) clearInterval(_wlRefreshTimer);
  _wlRefreshTimer=setInterval(async()=>{
    _rotateSourceIdx++;  // 每5秒換下一個起始來源
    const ms=getMarketState();
    // 非交易時段降頻：每 5 輪才真正打一次
    if((ms==='CLOSED'||ms==='PRE')&&_rotateSourceIdx%5!==0) return;
    // 清除 quote cache（確保拿到新資料）
    [...state.watchlist,...Object.keys(state.holdings)].forEach(s=>{
      delete quoteCache[normalizeSymbol(s)];
    });
    // 每 12 輪（約 1 分鐘）清一次批量快取
    if(_rotateSourceIdx%12===0){
      _twseCache=null;_twseTs=0;_tpexCache=null;_tpexTs=0;
    }
    console.log(`[AutoRefresh] 🔄 第${_rotateSourceIdx}輪 ${new Date().toLocaleTimeString('zh-TW')}`);
    renderSourceSelector();
    await refreshWatchlistPrices();
    await refreshHoldingsPrices();
  },5000);
  console.log('[AutoRefresh] ✅ 5秒輪替刷新已啟動');
}
// 舊名稱相容
function scheduleNextRefresh(){ startWatchlistAutoRefresh(); }


// ═══════════════════════════════════════════════════════
// 中文股名預載 (TWSE OpenAPI batch)
// ═══════════════════════════════════════════════════════
async function preloadStockNames(){
  try{
    for(const url of[
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
      'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL'
    ]){
      const r=await timedFetch(url,10000);
      if(!r.ok)continue;
      const arr=await r.json();
      if(!Array.isArray(arr)||arr.length<50)continue;
      let count=0;
      for(const item of arr){
        const code=String(item.Code||item['證券代號']||'').trim();
        const name=String(item.Name||item.StockName||item['證券名稱']||'').trim();
        if(code&&name&&/[\u4e00-\u9fff]/.test(name)){stockNameCache[code]=name;count++;}
      }
      console.log(`[StockNames] ✅ TWSE 載入 ${count} 筆中文股名`);
      if(count>100)break;
    }
    // TPEx
    const r2=await timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',10000);
    if(r2.ok){
      const arr2=await r2.json();
      if(Array.isArray(arr2)){
        let c2=0;
        for(const item of arr2){
          const code=String(item.SecuritiesCompanyCode||'').trim();
          const name=String(item.CompanyName||item.Name||'').trim();
          if(code&&name&&/[\u4e00-\u9fff]/.test(name)&&!stockNameCache[code]){stockNameCache[code]=name;c2++;}
        }
        console.log(`[StockNames] ✅ TPEx 載入 ${c2} 筆中文股名`);
      }
    }
    // 更新目前追蹤清單顯示
    renderWatchlistImmediate();
    renderHoldingsImmediate();
    renderHoldingsOverview();
  }catch(e){console.warn('[StockNames]',e.message);}
}

// ═══════════════════════════════════════════════════════
// 最大回撤計算
// ═══════════════════════════════════════════════════════
function calcMaxDrawdown(){
  const hist=state.assetHistory||[];
  if(hist.length<2)return null;
  let peak=hist[0].total,maxDD=0;
  for(const h of hist){
    if(h.total>peak)peak=h.total;
    const dd=peak>0?(peak-h.total)/peak*100:0;
    if(dd>maxDD)maxDD=dd;
  }
  return maxDD.toFixed(2);
}

// ═══════════════════════════════════════════════════════
// 停損停利警示
// ═══════════════════════════════════════════════════════
let _alertBlinkTimer=null;
function setAlert(symbol){
  symbol=normalizeSymbol(symbol);
  const cur=state.alerts?.[symbol]||{};
  const sl=prompt(`${symbol} 停損價（跌到此價自動提醒，留空取消）：`,cur.stopLoss||'');
  if(sl===null)return;
  const tp=prompt(`${symbol} 停利價（漲到此價自動提醒，留空取消）：`,cur.takeProfit||'');
  if(tp===null)return;
  if(!state.alerts)state.alerts={};
  const slNum=num(sl),tpNum=num(tp);
  if(!slNum&&!tpNum){delete state.alerts[symbol];showToast(`✅ 已清除 ${symbol} 警示`);saveState(state);renderWatchlistImmediate();renderHoldingsImmediate();return;}
  state.alerts[symbol]={stopLoss:slNum||null,takeProfit:tpNum||null,triggered:false};
  saveState(state);
  showToast(`🔔 ${symbol} 停損:${slNum||'—'} / 停利:${tpNum||'—'} 已設定`);
  renderWatchlistImmediate();renderHoldingsImmediate();
}

function checkAlerts(symbol,price){
  if(!state.alerts||!price)return;
  const a=state.alerts[symbol];
  if(!a||a.triggered)return;
  let hit=null;
  if(a.stopLoss&&price<=a.stopLoss)hit={type:'🔴 停損',val:a.stopLoss};
  if(a.takeProfit&&price>=a.takeProfit)hit={type:'🟢 停利',val:a.takeProfit};
  if(!hit)return;
  a.triggered=true;saveState(state);
  const msg=`⚠️ ${symbol} ${hit.type}觸發！現價 ${price} 已${hit.type.includes('停損')?'跌穿':'突破'} ${hit.val}`;
  showToast(msg);
  const origTitle=document.title;
  let blink=true;
  if(_alertBlinkTimer)clearInterval(_alertBlinkTimer);
  _alertBlinkTimer=setInterval(()=>{document.title=blink?`⚠️ ${symbol} ${hit.type}！`:'台股操盤 v2.2';blink=!blink;},600);
  setTimeout(()=>{clearInterval(_alertBlinkTimer);document.title=origTitle;},15000);
}

// ═══════════════════════════════════════════════════════
// 基本面資料（Yahoo Finance v10/quoteSummary）
// ═══════════════════════════════════════════════════════
const _fundCache={};
async function fetchFundamentals(symbol){
  if(_fundCache[symbol]&&Date.now()-_fundCache[symbol].ts<3600000)return _fundCache[symbol].data;
  const ts=Date.now();
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}&_cb=${ts}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const sfx of['.TW','.TWO']){
    const target=`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}${sfx}?modules=defaultKeyStatistics,financialData,earningsTrend&_=${ts}`;
    for(const url of[target,...PROXIES.map(px=>px(target))]){
      try{
        const r=await timedFetch(url,8000);if(!r.ok)continue;
        const text=await r.text();if(!text||text.startsWith('<'))continue;
        const json=JSON.parse(text);
        const res=json?.quoteSummary?.result?.[0];if(!res)continue;
        const ks=res.defaultKeyStatistics||{};
        const fd=res.financialData||{};
        const et=res.earningsTrend||{};
        const epsArr=(et.trend||[]).slice(0,4).map(t=>({
          period:t.period,
          eps:num(t.epsActual?.raw)??num(t.earningsEstimate?.avg?.raw)
        })).filter(t=>t.eps!=null);
        const data={
          pe:num(ks.trailingPE?.raw),
          forwardPE:num(ks.forwardPE?.raw),
          dividendYield:ks.dividendYield?.raw!=null?(ks.dividendYield.raw*100).toFixed(2):null,
          eps:num(ks.trailingEps?.raw),
          epsQuarters:epsArr
        };
        _fundCache[symbol]={data,ts:Date.now()};
        return data;
      }catch(_){}
    }
  }
  return null;
}

async function toggleFundamentals(symbol){
  const rowId=`fund-${symbol}`;
  const existing=document.getElementById(rowId);
  if(existing){existing.remove();return;}
  const tbody=document.getElementById('watchlistBody');
  const tr=tbody.querySelector(`[data-symbol="${symbol}"]`);
  if(!tr)return;
  const fRow=document.createElement('tr');fRow.id=rowId;
  fRow.innerHTML=`<td colspan="4" style="padding:8px 16px;background:#0a0f16;border-left:3px solid #388bfd;">
    <span style="font-size:.78rem;color:var(--muted);">📊 載入基本面資料…</span></td>`;
  tr.after(fRow);
  const d=await fetchFundamentals(symbol);
  if(!d){fRow.innerHTML=`<td colspan="4" style="padding:8px 16px;background:#0a0f16;border-left:3px solid #ff4d4d;">
    <span style="font-size:.78rem;color:#ff4d4d;">❌ 無法取得基本面資料（請確認代號或稍後再試）</span></td>`;return;}
  const eps4=d.epsQuarters.length?d.epsQuarters.map(q=>`<span style="margin-right:12px;">${q.period}：<strong>${q.eps}</strong></span>`).join(''):'—';
  fRow.innerHTML=`<td colspan="4" style="padding:10px 16px;background:#0a0f16;border-left:3px solid #388bfd;">
    <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:.82rem;align-items:center;">
      <span>📈 本益比(TTM)：<strong style="color:#f3b73b;font-size:1rem;">${d.pe?d.pe.toFixed(1):'—'}</strong></span>
      <span>🔮 預估本益比：<strong style="color:#f3b73b;">${d.forwardPE?d.forwardPE.toFixed(1):'—'}</strong></span>
      <span>💰 殖利率：<strong style="color:#2ecc71;font-size:1rem;">${d.dividendYield?d.dividendYield+'%':'—'}</strong></span>
      <span>📊 EPS(TTM)：<strong style="color:#fff;">${d.eps??'—'}</strong></span>
    </div>
    <div style="margin-top:8px;font-size:.78rem;color:var(--muted);">近四季 EPS：${eps4}</div>
  </td>`;
}

// ═══════════════════════════════════════════════════════
// 除息自動模擬（FinMind TaiwanStockDividend）
// ═══════════════════════════════════════════════════════
async function checkDividends(){
  const today=getTWDate().toISOString().slice(0,10);
  if(!state.dividendChecked)state.dividendChecked={};
  for(const symbol of Object.keys(state.holdings)){
    const h=state.holdings[symbol];
    if(!h?.shares)continue;
    const key=`${symbol}_${today}`;
    if(state.dividendChecked[key])continue;
    try{
      const url=`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&stock_id=${symbol}&start_date=${daysAgo(3)}&token=${encodeURIComponent(_r())}`;
      const r=await timedFetch(url,8000);if(!r.ok)continue;
      const json=await r.json();
      if(json.status!==200||!Array.isArray(json.data))continue;
      for(const d of json.data){
        if(d.date!==today)continue;
        const cashDiv=num(d.CashDividend||d.cash_dividend||0)||0;
        if(cashDiv<=0)continue;
        const income=Math.round(cashDiv*h.shares);
        if(income<=0)continue;
        state.cash+=income;
        state.dividendChecked[key]=true;
        state.history.unshift({time:new Date().toLocaleString('zh-TW'),symbol,side:'dividend',shares:h.shares,price:cashDiv,amount:income,fee:0});
        saveState(state);renderDashboardQuick();renderHistory();
        showToast(`💰 ${symbol} 除息：每股 ${cashDiv} 元 × ${h.shares} 股 = ${formatMoney(income)} 元已入帳！`);
      }
    }catch(e){console.warn('[Dividend]',e.message);}
  }
}
// ─── Console 診斷 ──────────────────────────────────────

window.testAPI=async function(symbol='2330'){
  symbol=normalizeSymbol(symbol);
  console.log(`\n===== 診斷 ${symbol} | ${getMarketLabel(getMarketState())} =====`);
  console.log('[A] MIS:');     console.log(await fetchMIS(symbol)||'FAIL');
  console.log('[B] TWSE-Web:');console.log(await fetchTWSEWeb(symbol)||'FAIL');
  console.log('[C] Yahoo:');   console.log(await fetchYahooBackup(symbol)||'FAIL');
  console.log('[D] Google:');  console.log(await fetchGoogleFinance(symbol)||'FAIL');
  console.log('[E] FinMind:'); console.log(await fetchFinMind(symbol)||'FAIL');
  console.log('=====\n');
};


// ══════════════════════════════════════════════════════
//  已實現損益分頁
// ══════════════════════════════════════════════════════
function renderRealized(){
  const tbody  = document.getElementById('realizedBody');
  const empty  = document.getElementById('realizedEmpty');
  if(!tbody)return;
  const trades = state.realizedTrades||[];
  const totalPnl = trades.reduce((s,t)=>s+t.netPnl,0);
  const wins     = trades.filter(t=>t.netPnl>0).length;
  const losses   = trades.filter(t=>t.netPnl<0).length;
  const winRate  = trades.length?((wins/trades.length)*100).toFixed(1)+'%':'—';
  const avgPnl   = trades.length?(totalPnl/trades.length):0;
  const set=(id,val,cls)=>{const el=document.getElementById(id);if(el){el.textContent=val;if(cls)el.className='val '+cls;}};
  set('rTotalPnl',  trades.length?(totalPnl>=0?'+':'')+formatMoney(totalPnl)+' 元':'—', trades.length?(totalPnl>=0?'text-up':'text-down'):'');
  set('rTotalTrades',trades.length?`${trades.length} 筆（勝 ${wins} / 敗 ${losses}）`:'—');
  set('rWinRate',   winRate);
  set('rAvgPnl',    trades.length?(avgPnl>=0?'+':'')+formatMoney(avgPnl)+' 元':'—', trades.length?(avgPnl>=0?'text-up':'text-down'):'');
  tbody.innerHTML='';
  if(!trades.length){if(empty)empty.style.display='';return;}
  if(empty)empty.style.display='none';
  trades.slice(0,100).forEach(r=>{
    const name=r.name||getStockName(r.symbol)||'';
    const isWin=r.netPnl>=0;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="text-xs" style="color:#555;white-space:nowrap;">${r.time}</td>
      <td><div class="font-mono font-bold">${r.symbol}</div>${name?`<div style="font-size:.7rem;color:#8b949e;">${name}</div>`:''}</td>
      <td>${r.shares} 股</td>
      <td>${formatPrice(r.avgBuyPrice)}</td>
      <td>${formatPrice(r.sellPrice)}</td>
      <td class="${isWin?'text-up':'text-down'}" style="font-weight:700;">${isWin?'+':''}${formatMoney(r.netPnl)}</td>
      <td class="${isWin?'text-up':'text-down'}" style="font-weight:700;">${r.retPct>=0?'+':''}${r.retPct.toFixed(2)}%</td>`;
    tbody.appendChild(tr);
  });
}

function initTabs(){
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const target=btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const panel=document.getElementById('tab-'+target);
      if(panel)panel.classList.add('active');
      if(target==='realized')renderRealized();
    });
  });
}


// ══════════════════════════════════════════════════════
//  手續費設定
// ══════════════════════════════════════════════════════
function setFeeDiscount(){
  const cur=((state.feeDiscount??0.6)*10).toFixed(1);
  const input=prompt(`手續費折數（目前 ${cur} 折）\n請輸入折數（1~10，如 6=六折）：`,cur);
  if(input===null)return;
  const d=parseFloat(input);
  if(isNaN(d)||d<1||d>10){alert('❌ 請輸入 1~10');return;}
  state.feeDiscount=parseFloat((d/10).toFixed(2));
  saveState(state);
  showToast(`✅ 手續費設為 ${d} 折（${(state.feeDiscount*0.1425).toFixed(4)}%）`);
  updateFeeLabel();
}
function updateFeeLabel(){
  const d=state.feeDiscount??0.6;
  const lbl=`${(d*10).toFixed(0)} 折（${(d*0.1425).toFixed(4)}%）`;
  const el=document.getElementById('feeLabel');if(el)el.textContent=lbl;
  const el2=document.getElementById('feeLabel2');if(el2)el2.textContent=lbl;
}
function updateFeePreview(){
  const preview=document.getElementById('feePreview');if(!preview)return;
  const symbol=normalizeSymbol(document.getElementById('tradeSymbol')?.value||'');
  const shares=parseInt(document.getElementById('tradeQty')?.value||'0',10);
  const price=num(document.getElementById('tradePrice')?.value)||
    (symbol&&quoteCache[symbol]?.data?.price)||0;
  if(!price||!shares){preview.style.display='none';return;}
  const fB=calcFee(price,shares,'buy');const fS=calcFee(price,shares,'sell');
  preview.style.display='block';
  preview.innerHTML=`買入總額 <b>$${formatMoney(fB.amount+fB.total)}</b>（手續費 ${formatMoney(fB.broker)}）&nbsp;|&nbsp; 賣出到手 <b>$${formatMoney(fS.amount-fS.total)}</b>（交稅 ${formatMoney(fS.tax)}）`;
}

// ══════════════════════════════════════════════════════
//  每日資產快照
// ══════════════════════════════════════════════════════
function recordAssetSnapshot(){
  const today=new Date().toISOString().slice(0,10);
  if(!Array.isArray(state.assetHistory))state.assetHistory=[];
  const hv=parseInt((document.getElementById('holdingsValue')?.textContent||'0').replace(/[^\d]/g,''),10)||0;
  const total=state.cash+hv;
  const last=state.assetHistory[state.assetHistory.length-1];
  if(last&&last.date===today){last.total=total;}
  else{state.assetHistory.push({date:today,total});}
  if(state.assetHistory.length>365)state.assetHistory=state.assetHistory.slice(-365);
  saveState(state);
  if(getMarketState()==='CLOSED') setTimeout(saveToFirestore,2000);
}

// ══════════════════════════════════════════════════════
//  Holdings Overview (資產總覽 mini table)
// ══════════════════════════════════════════════════════
function renderHoldingsOverview(){
  const tbody=document.getElementById('holdingsBodyOverview');
  const empty=document.getElementById('holdingsEmptyOverview');
  if(!tbody)return;
  tbody.innerHTML='';
  const symbols=Object.keys(state.holdings);
  if(!symbols.length){
    if(empty)empty.style.display='block';
    return;
  }
  if(empty)empty.style.display='none';
  for(const symbol of symbols){
    const h=state.holdings[symbol];
    const q=quoteCache[symbol]?.data??null;
    const name=getStockName(symbol);
    const price=(q?.price>0)?q.price:h.avgPrice;
    const pnl=price*h.shares-h.avgPrice*h.shares;
    const retPct=h.avgPrice>0?((price-h.avgPrice)/h.avgPrice*100):0;
    const isUp=pnl>=0;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td><div style="font-weight:700;">${symbol}</div>${name?`<div style="font-size:.7rem;color:var(--muted);">${name}</div>`:''}</td>
      <td>${h.shares}</td><td>${formatPrice(h.avgPrice)}</td>
      <td style="font-weight:600;">${formatPrice(price)}</td>
      <td class="${isUp?'up':'down'}">${isUp?'+':''}${formatMoney(pnl)}</td>
      <td class="${retPct>=0?'up':'down'}">${retPct>=0?'+':''}${retPct.toFixed(2)}%</td>`;
    tbody.appendChild(tr);
  }
}

// ══════════════════════════════════════════════════════
//  Chart.js 圖表
// ══════════════════════════════════════════════════════
let _pieChart=null,_lineChart=null;
function renderCharts(){renderPieChart();renderLineChart();}

function renderPieChart(){
  const canvas=document.getElementById('chartPie');
  if(!canvas||typeof Chart==='undefined')return;
  const labels=['現金'],data=[state.cash],colors=['#388bfd'];
  const palette=['#ff4d4d','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e74c3c','#3498db','#e67e22'];
  let pi=0;
  for(const sym of Object.keys(state.holdings)){
    const h=state.holdings[sym];const q=quoteCache[sym]?.data;
    const price=(q?.price>0)?q.price:h.avgPrice;
    labels.push(sym+(getStockName(sym)?' '+getStockName(sym):''));
    data.push(price*h.shares);colors.push(palette[pi++%palette.length]);
  }
  if(_pieChart){_pieChart.destroy();_pieChart=null;}
  _pieChart=new Chart(canvas,{type:'doughnut',
    data:{labels,datasets:[{data,backgroundColor:colors,borderWidth:2,borderColor:'#161b22'}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'right',labels:{color:'#8b949e',font:{size:11},boxWidth:12}},
        tooltip:{callbacks:{label:ctx=>{
          const t=ctx.dataset.data.reduce((a,b)=>a+b,0);
          const pct=t?((ctx.parsed/t)*100).toFixed(1):'0';
          return ` ${ctx.label}: $${Math.round(ctx.parsed).toLocaleString()} (${pct}%)`;
        }}}}}});
}

function renderLineChart(){
  const canvas=document.getElementById('chartLine');
  if(!canvas||typeof Chart==='undefined')return;
  const hist=state.assetHistory||[];
  if(hist.length<2){
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#555';ctx.font='13px sans-serif';ctx.textAlign='center';
    ctx.fillText('需至少 2 天資料才能顯示走勢',canvas.width/2,canvas.height/2);return;
  }
  if(_lineChart){_lineChart.destroy();_lineChart=null;}
  _lineChart=new Chart(canvas,{type:'line',
    data:{labels:hist.map(d=>d.date),datasets:[{label:'總資產',data:hist.map(d=>d.total),
      borderColor:'#388bfd',backgroundColor:'rgba(56,139,253,0.08)',
      borderWidth:2,pointRadius:3,pointBackgroundColor:'#388bfd',fill:true,tension:0.3}]},
    options:{responsive:true,maintainAspectRatio:false,
      scales:{x:{ticks:{color:'#8b949e',maxRotation:45,font:{size:10}},grid:{color:'#21262d'}},
        y:{ticks:{color:'#8b949e',callback:v=>'$'+Math.round(v/10000)+'萬'},grid:{color:'#21262d'}}},
      plugins:{legend:{labels:{color:'#8b949e'}},
        tooltip:{callbacks:{label:ctx=>`總資產：$${Math.round(ctx.parsed.y).toLocaleString()}`}}}}});
}

// ══════════════════════════════════════════════════════
//  K 線圖（Lightweight Charts）
// ══════════════════════════════════════════════════════
let _kwChart=null;
async function showKLine(symbol){
  symbol=normalizeSymbol(symbol);
  if(typeof window.__navigate==='function')window.__navigate('market');
  const panel=document.getElementById('klinePanel');
  const title=document.getElementById('klineTitle');
  if(!panel)return;
  panel.style.display='block';
  if(title)title.textContent=`📊 ${symbol} ${getStockName(symbol)} K線（近3個月）`;
  const container=document.getElementById('klineContainer');if(!container)return;
  if(typeof LightweightCharts==='undefined'){
    container.innerHTML='<p style="color:var(--muted);text-align:center;padding:20px;">⏳ 圖表庫載入中…</p>';return;
  }
  container.innerHTML='<p style="color:var(--muted);text-align:center;padding:20px;">⏳ 載入K線資料…</p>';
  if(_kwChart){try{_kwChart.remove();}catch(_){}_kwChart=null;}
  const data=await fetchKLineData(symbol);
  container.innerHTML='';
  _kwChart=LightweightCharts.createChart(container,{
    width:container.clientWidth||600,height:260,
    layout:{background:{color:'#0d1117'},textColor:'#8b949e'},
    grid:{vertLines:{color:'#21262d'},horzLines:{color:'#21262d'}},
    rightPriceScale:{borderColor:'#30363d'},timeScale:{borderColor:'#30363d'}
  });
  const series=_kwChart.addCandlestickSeries({
    upColor:'#ff4d4d',downColor:'#2ecc71',
    borderUpColor:'#ff4d4d',borderDownColor:'#2ecc71',
    wickUpColor:'#ff4d4d',wickDownColor:'#2ecc71'
  });
  if(data&&data.length){series.setData(data);_kwChart.timeScale().fitContent();}
  else{container.innerHTML='<p style="color:var(--muted);text-align:center;padding:20px;">❌ 無法取得K線資料</p>';}
}

async function fetchKLineData(symbol){
  const start=daysAgo(90);
  const PROXIES=[u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`];
  const fmUrl=`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${start}`;
  try{
    const r=await timedFetch(fmUrl,12000);
    if(r.ok){
      const json=await r.json();
      if(json.status===200&&Array.isArray(json.data)&&json.data.length){
        json.data.sort((a,b)=>a.date.localeCompare(b.date));
        return json.data.map(d=>({time:d.date,open:parseFloat(d.open),high:parseFloat(d.max),low:parseFloat(d.min),close:parseFloat(d.close)})).filter(d=>d.open&&d.high&&d.low&&d.close);
      }
    }
  }catch(e){console.warn('[KLine-FM]',e.message);}
  for(const sfx of['.TW','.TWO']){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=3mo&interval=1d`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),8000);if(!r.ok)continue;
        const text=await r.text();if(!text||text.startsWith('<'))continue;
        const json=JSON.parse(text);const result=json?.chart?.result?.[0];if(!result)continue;
        const ts=result.timestamp||[];const q=result.indicators?.quote?.[0]||{};const out=[];
        for(let i=0;i<ts.length;i++){
          const o=num(q.open?.[i]),h=num(q.high?.[i]),l=num(q.low?.[i]),c=num(q.close?.[i]);
          if(o&&h&&l&&c)out.push({time:new Date(ts[i]*1000).toISOString().slice(0,10),open:o,high:h,low:l,close:c});
        }
        if(out.length)return out;
      }catch(_){}
    }
  }
  return[];
}

function closeKLine(){
  const panel=document.getElementById('klinePanel');if(panel)panel.style.display='none';
  if(_kwChart){try{_kwChart.remove();}catch(_){}_kwChart=null;}
}

// ══════════════════════════════════════════════════════
//  Firebase Authentication + Firestore
// ══════════════════════════════════════════════════════
// ▼▼▼ 請至 Firebase Console 取得設定後填入 ▼▼▼
const FIREBASE_CONFIG = {
  apiKey:            "",   // Web API Key
  authDomain:        "",   // xxx.firebaseapp.com
  projectId:         "",   // 專案 ID
  storageBucket:     "",
  messagingSenderId: "",
  appId:             ""
};
// ▲▲▲ 留空 = 純本地模式，功能不受影響 ▲▲▲

const FIREBASE_READY = !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.projectId);
let _fireApp=null,_fireAuth=null,_fireDb=null,_fireUser=null;

function initFirebase(){
  if(!FIREBASE_READY||_fireApp)return;
  try{
    _fireApp  = firebase.initializeApp(FIREBASE_CONFIG);
    _fireAuth = firebase.auth();
    _fireDb   = firebase.firestore();
    _fireAuth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
    _fireAuth.onAuthStateChanged(onFirebaseAuthChanged);
    console.log('[Firebase] ✅ 初始化成功');
  }catch(e){console.error('[Firebase]',e);}
}

async function onFirebaseAuthChanged(user){
  _fireUser=user;
  if(user){ showToast(`✅ 已登入：${user.displayName||user.email}`); await loadUserDataFromFirestore(user.uid); }
  refreshCloudUI();
}

async function cloudGoogleSignIn(){
  if(!FIREBASE_READY){alert('⚠️ 請先在 app.js 填入 Firebase 設定');return;}
  initFirebase();
  try{
    const provider=new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});
    await _fireAuth.signInWithPopup(provider);
  }catch(e){ if(e.code!=='auth/popup-closed-by-user') showToast('❌ 登入失敗：'+e.message); }
}

async function cloudLogout(){
  if(_fireAuth) await _fireAuth.signOut();
  _fireUser=null; refreshCloudUI(); showToast('已登出 Google 帳號');
}

async function loadUserDataFromFirestore(uid){
  if(!_fireDb)return;
  try{
    const docRef=_fireDb.collection('users').doc(uid);
    const snap=await docRef.get();
    if(!snap.exists){
      const d=getEmptyState();
      await docRef.set({balance:d.cash,portfolio:d.holdings,history:d.history,
        realizedTrades:d.realizedTrades,assetHistory:d.assetHistory,
        realizedPnL:d.realizedPnL,feeDiscount:d.feeDiscount,
        watchlist:d.watchlist,savedAt:new Date().toISOString()});
      showToast('🎉 新帳號已初始化 $1,000,000 虛擬資金！');
    }else{
      const data=snap.data();
      state.cash          = num(data.balance)      ?? state.cash;
      state.holdings      = data.portfolio         || state.holdings;
      state.history       = data.history           || state.history;
      state.realizedTrades= data.realizedTrades    || state.realizedTrades;
      state.assetHistory  = data.assetHistory      || state.assetHistory;
      state.realizedPnL   = num(data.realizedPnL)  ?? state.realizedPnL;
      state.feeDiscount   = num(data.feeDiscount)  ?? state.feeDiscount;
      state.watchlist     = data.watchlist         || state.watchlist;
      saveState(state);
      renderDashboardQuick();renderHoldingsImmediate();renderHistory();
      renderRealized();renderHoldingsOverview();renderWatchlistImmediate();renderCharts();updateFeeLabel();
      showToast('☁️ 已從雲端載入帳務資料');
    }
  }catch(e){console.error('[Firestore]',e);showToast('❌ 雲端讀取失敗：'+e.message);}
}

async function saveToFirestore(){
  if(!_fireUser||!_fireDb)return;
  try{
    await _fireDb.collection('users').doc(_fireUser.uid).set({
      balance:state.cash,portfolio:state.holdings,history:state.history,
      realizedTrades:state.realizedTrades,assetHistory:state.assetHistory,
      realizedPnL:state.realizedPnL,feeDiscount:state.feeDiscount,
      watchlist:state.watchlist,savedAt:new Date().toISOString()
    },{merge:true});
  }catch(e){console.error('[Firestore save]',e);}
}

async function cloudSyncSnapshot(){
  if(!_fireUser){showToast('⚠️ 請先登入');return;}
  await saveToFirestore();
  const msg=document.getElementById('cloudSyncMsg');
  if(msg)msg.textContent=`✅ 已同步（${new Date().toLocaleString('zh-TW')}）`;
  showToast('☁️ 雲端同步完成');
}

async function cloudFetchHistory(){
  if(!_fireUser){showToast('⚠️ 請先登入');return;}
  const msg=document.getElementById('cloudSyncMsg');if(msg)msg.textContent='⏳ 從雲端讀取…';
  await loadUserDataFromFirestore(_fireUser.uid);
  if(msg)msg.textContent='✅ 已從雲端還原資料';
}

function refreshCloudUI(){
  const dot=document.getElementById('cloudStatusDot');
  const txt=document.getElementById('cloudStatusText');
  const form=document.getElementById('cloudLoginForm');
  const logged=document.getElementById('cloudLoggedIn');
  const info=document.getElementById('cloudUserInfo');
  const topBtn=document.getElementById('btnCloudLogin');
  if(!FIREBASE_READY){
    if(dot)dot.style.background='#555';
    if(txt)txt.textContent='未設定 Firebase（本地模式）';
    if(form)form.style.display='flex';if(logged)logged.style.display='none';
    const m=document.getElementById('cloudMsg');
    if(m)m.textContent='請在 app.js 填入 FIREBASE_CONFIG 以啟用雲端';
    return;
  }
  if(_fireUser){
    if(dot)dot.style.background='#2ecc71';if(txt)txt.textContent='已登入 Google';
    if(form)form.style.display='none';if(logged){logged.style.display='flex';}
    const name=_fireUser.displayName||_fireUser.email||'使用者';
    const avatar=_fireUser.photoURL;
    if(info)info.innerHTML=avatar?`<img src="${avatar}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${name}`:`👤 ${name}`;
    if(topBtn){topBtn.textContent='☁️ '+name.split(' ')[0];topBtn.style.background='#1a2d1a';}
  }else{
    if(dot)dot.style.background='#d29922';if(txt)txt.textContent='尚未登入';
    if(form)form.style.display='flex';if(logged)logged.style.display='none';
    if(info)info.textContent='';
    if(topBtn){topBtn.textContent='☁️ 雲端';topBtn.style.background='#1a2d1a';}
  }
}

function openCloudModal(){if(typeof window.__navigate==='function')window.__navigate('cloud');}
function closeCloudModal(){}

function restoreCloudSession(){if(FIREBASE_READY)initFirebase();}

// ══════════════════════════════════════════════════════
//  SPA page-enter hook
// ══════════════════════════════════════════════════════
window.__onPageEnter=function(page){
  if(page==='overview'){renderCharts();renderHoldingsOverview();}
  if(page==='market'){renderWatchlistImmediate();refreshWatchlistPrices();}
  if(page==='portfolio'){renderHoldingsImmediate();renderRealized();renderHistory();}
  if(page==='trade'){renderSourceSelector();updateFeeLabel();}
  if(page==='cloud'){initFirebase();refreshCloudUI();}
};

// ═══════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded',()=>{
  updateLastSavedLabel();
  initTabs();

  document.getElementById('btnAddWatch').addEventListener('click',addToWatchlist);
  document.getElementById('btnBuy').addEventListener('click',()=>executeTrade('buy'));
  document.getElementById('btnSell').addEventListener('click',()=>executeTrade('sell'));
  document.getElementById('btnExport').addEventListener('click',exportDataToJson);
  document.getElementById('btnReset').addEventListener('click',resetAllData);
  document.getElementById('importFile').addEventListener('change',importDataFromJson);
  document.getElementById('btnAddCash').addEventListener('click',addVirtualCash);
  document.getElementById('btnSetCash').addEventListener('click',setVirtualCash);
  document.getElementById('btnFee')?.addEventListener('click',setFeeDiscount);
  document.getElementById('btnFee2')?.addEventListener('click',setFeeDiscount);
  document.getElementById('btnCloseKLine')?.addEventListener('click',closeKLine);
  document.getElementById('btnGoMarket')?.addEventListener('click',()=>{window.__navigate&&window.__navigate('market');});
  document.getElementById('btnCloudLogin')?.addEventListener('click',()=>{window.__navigate&&window.__navigate('cloud');});
  document.getElementById('btnCloudSignIn')?.addEventListener('click',cloudGoogleSignIn);
  document.getElementById('btnCloudLogout')?.addEventListener('click',cloudLogout);
  document.getElementById('btnCloudSync')?.addEventListener('click',cloudSyncSnapshot);
  document.getElementById('btnCloudFetch')?.addEventListener('click',cloudFetchHistory);
  document.getElementById('btnExportCloud')?.addEventListener('click',exportDataToJson);
  document.getElementById('importFileCloud')?.addEventListener('change',importDataFromJson);
  document.getElementById('btnExportTop')?.addEventListener('click',exportDataToJson);
  document.getElementById('importFileTop')?.addEventListener('change',importDataFromJson);
  document.getElementById('btnResetCloud')?.addEventListener('click',()=>{
    if(confirm('⚠️ 確定要重置所有資料嗎？此操作無法還原！')){ localStorage.removeItem(STORAGE_KEY); location.reload(); }
  });
  ['tradeSymbol','tradeQty','tradePrice'].forEach(id=>{
    document.getElementById(id)?.addEventListener('input',updateFeePreview);
  });

  document.querySelectorAll('.source-btn').forEach(btn=>{
    btn.addEventListener('click',()=>setSource(btn.dataset.source));
  });

  document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')addToWatchlist();});
  document.getElementById('tradeSymbol').addEventListener('blur',()=>{
    document.getElementById('tradeSymbol').value=normalizeSymbol(document.getElementById('tradeSymbol').value);
  });
  document.getElementById('tradeQty').addEventListener('keydown',e=>{if(e.key==='Enter')executeTrade('buy');});

  updateClock();setInterval(updateClock,1000);

  restoreCloudSession();
  updateFeeLabel();
  renderDashboardQuick(0);
  renderHoldingsImmediate();
  renderHistory();
  renderRealized();
  renderHoldingsOverview();
  renderWatchlistImmediate();
  renderSourceSelector();
  setTimeout(()=>{renderCharts();recordAssetSnapshot();},800);

  refreshWatchlistPrices().then(()=>refreshHoldingsPrices());
  scheduleNextRefresh();
  // 啟動時預載中文股名 + 檢查除息
  preloadStockNames();
  checkDividends();
});

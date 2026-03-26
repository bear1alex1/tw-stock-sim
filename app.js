const APP_VERSION = '3.1';   // ← 只改這裡就能更版

// ═══════════════════════════════════════════════════════
//  台股虛擬操盤系統 v3.1  |  SPA分頁 + Firebase雲端 + K線
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
  if(existing&&/[\u4e00-\u9fff]/.test(existing)) return;
  stockNameCache[code]=n;
}

// ─── Token ────────────────────────────────────────────
const _a='310e6e442e6b38367d5f32090246751d0770333750711b2b1b1e6e3d1e49306e7c5f327b7a125d3e206a210d5e7f122d3d3a4e35327d106f457b01722d396735327e3d304a7b022d643a5d3d387a1709486c200832167325227c10155b6c2f042d3a7332386921384a7f11353d2d734523522e285b7911083d2d7332327e2e19416c20252c2663103f6a2e33417a150c2215773d387a1433457f122d3d394e313e7d131e477b12132c3b4e317f7e10150b181d753746161c114b26386a524b303734692b2e4703145b5b2e1d381e42363c593631765e392f181c57073c';
const _b=[84,119,36,116,75,51,121,95,50,54,120,66];
function _r(){try{return(_a.match(/.{2}/g)||[]).map((h,i)=>String.fromCharCode(parseInt(h,16)^_b[i%_b.length])).join('')}catch{return''}}

// ─── 台灣時間 & 市場狀態 ───────────────────────────────

function getTWDate(){return new Date(Date.now()+(8*3600000));}

/** 核心任務 1：判斷台灣時間週一~五 08:30-13:35 */
function isTaiwanTradingTime(){
  const tw=getTWDate(),dow=tw.getUTCDay();
  if(dow===0||dow===6) return false;
  const t=tw.getUTCHours()*60+tw.getUTCMinutes(); // 分鐘數
  return t>=510 && t<815; // 08:30=510, 13:35=815
}

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
  return isTaiwanTradingTime()?4_500:300_000;
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
        const stockN=item.n||item.nf||'';
        if(stockN) setStockName(symbol,stockN);
        const ms=getMarketState();
        const z=(item.z&&item.z!=='-'&&item.z!=='0'&&item.z!=='--')?num(item.z):null;
        const y=num(item.y);
        // 盤中若沒有成交價 z，代表 MIS 只回參考價，不能拿來覆蓋既有漲跌
        if(ms==='REGULAR'&&!z)continue;
        const price=z??y;
        if(!price||price<=0)continue;
        const base=y??null;
        const change=base!==null?parseFloat((price-base).toFixed(2)):null;
        const changePct=(base!==null&&base!==0)?parseFloat((change/base*100).toFixed(2)):null;
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
  const ts=Date.now();
  const ms=getMarketState();
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}&_cb=${ts}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];

  async function _tryV7(sfx){
    const target=`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}${sfx}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName,longName&lang=zh-TW&region=TW&_=${ts}`;
    const urls=[target,...PROXIES.map(function(px){return px(target);})];
    for(const url of urls){
      try{
        const r=await timedFetch(url,5000); if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const q=json&&json.quoteResponse&&json.quoteResponse.result&&json.quoteResponse.result[0];
        if(!q)continue;
        const price=num(q.regularMarketPrice); if(!price||price<=0)continue;
        const change=num(q.regularMarketChange);
        const changePct=num(q.regularMarketChangePercent);
        const prev=num(q.regularMarketPreviousClose);
        const yName=q.longName||q.shortName||""; if(yName)setStockName(symbol,yName.replace(/\s*\(.*?\)/g,"").trim());
        console.log('[Yahoo-v7] OK '+symbol+sfx+' '+price);
        return{price,previousClose:prev,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(e){}
    }
    return null;
  }

  async function _tryV8(sfx){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?interval=2m&range=1d&_=${ts}`;
    const urls=[target,...PROXIES.map(function(px){return px(target);})];
    for(const url of urls){
      try{
        const r=await timedFetch(url,6000); if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const result=json&&json.chart&&json.chart.result&&json.chart.result[0];
        if(!result)continue;
        const meta=result.meta;
        if(meta&&meta.shortName) setStockName(symbol,meta.shortName);
        const closes=(result.indicators&&result.indicators.quote&&result.indicators.quote[0]&&result.indicators.quote[0].close||[]).map(num).filter(function(v){return v&&v>0;});
        const regPx=num(meta&&meta.regularMarketPrice);
        const prev=num(meta&&meta.regularMarketPreviousClose)||num(meta&&meta.previousClose);
        const last=closes.length?closes[closes.length-1]:null;
        const price=(ms==='REGULAR')?(regPx||last):(last||regPx);
        if(!price||price<=0)continue;
        const base=prev||(closes.length>=2?closes[closes.length-2]:null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log('[Yahoo-v8] OK '+symbol+sfx+' '+price);
        return{price,previousClose:base,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(e){}
    }
    return null;
  }

  for(const sfx of['.TW','.TWO']){
    const d=(await _tryV7(sfx))||(await _tryV8(sfx));
    if(d) return d;
  }
  return null;
}

// ── Stooq 爬蟲（CSV，穩定快速，免 API Key）─────────────
async function fetchStooq(symbol){
  const ts=Date.now();
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}&_cb=${ts}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const sfx of['.tw','.twp']){
    const target=`https://stooq.com/q/l/?s=${symbol.toLowerCase()}${sfx}&f=sd2t2ohlcvn&h&e=csv&_=${ts}`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),6000); if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.includes('No data'))continue;
        const lines=text.trim().split('\n');
        if(lines.length<2)continue;
        const headers=lines[0].split(',').map(function(h){return h.trim().toLowerCase();});
        const vals=lines[1].split(',').map(function(v){return v.trim();});
        const get=function(k){const i=headers.indexOf(k);return i>=0?vals[i]:null;};
        const close=num(get('close')); if(!close||close<=0)continue;
        const open=num(get('open'));
        const change=(open&&open>0)?parseFloat((close-open).toFixed(2)):null;
        const changePct=(open&&open>0)?parseFloat((change/open*100).toFixed(2)):null;
        const name=get('name')||'';
        if(name) setStockName(symbol,name.trim());
        const ms=getMarketState();
        console.log('[Stooq] OK '+symbol+sfx+' '+close);
        return{price:close,previousClose:open,change,changePct,marketState:ms,source:'Stooq'};
      }catch(e){console.warn('[Stooq] '+e.message);}
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
  for(const url of[
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL'
  ]){
    try{
      const r=await timedFetch(url+'?_='+Date.now(),12000);if(!r.ok)continue;
      const arr=await r.json();if(!Array.isArray(arr)||arr.length<50)continue;
      const map={};
      for(const item of arr){
        // TWSE STOCK_DAY_ALL 正確欄位：Code, Name, ClosingPrice, Change
        const code=String(item.Code??item['證券代號']??item['股票代號']??'').trim();
        const name=String(item.Name??item.StockName??item['證券名稱']??item['股票名稱']??'').trim();
        if(code&&name&&/[一-鿿！-～]/.test(name))setStockName(code,name);
        const close=num(item.ClosingPrice??item['收盤價']);
        const changeRaw=num(item.Change??item['漲跌價差']);
        if(code&&close&&close>0){
          const prevClose=changeRaw!=null?parseFloat((close-changeRaw).toFixed(2)):null;
          const changePct=prevClose&&changeRaw?parseFloat((changeRaw/prevClose*100).toFixed(2)):null;
          map[code]={close,prevClose,change:changeRaw,changePct};
        }
      }
      const cnt=Object.keys(map).length;
      console.log('[TWSE] loaded '+cnt+' stocks');
      if(cnt>100)return map;
    }catch(e){console.warn('[TWSE-API]',e.message);}
  }
  return null;
}
// 縮短批量快取至 8 秒，確保每次刷新都能拿到最新價格
function loadTwse(){
  if(_twseCache&&Date.now()-_twseTs<8000)return Promise.resolve(_twseCache);
  if(!_twseP){_twseP=_doLoadTwse().then(function(m){if(m){_twseCache=m;_twseTs=Date.now();}_twseP=null;return _twseCache;});}
  return _twseP;
}

let _tpexCache=null,_tpexTs=0,_tpexP=null;
async function _doLoadTpex(){
  try{
    const r=await timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes?_='+Date.now(),12000);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const arr=await r.json();if(!Array.isArray(arr)||arr.length<10)throw new Error('empty');
    const map={};
    for(const item of arr){
      const code=String(item.SecuritiesCompanyCode??item['代號']??'').trim();
      const name=String(item.CompanyName??item['公司名稱']??item['公司簡稱']??item.Name??'').trim();
      if(code&&name&&/[一-鿿！-～]/.test(name))setStockName(code,name);
      const close=num(item.Close??item['收盤'])??null;
      const changeRaw=num(item.Change??item['漲跌'])??null;
      const prev=num(item.PreviousClose??item['昨收'])??null;
      const changePct=(prev&&changeRaw)?parseFloat((changeRaw/prev*100).toFixed(2)):null;
      if(code&&close&&close>0)map[code]={close,prevClose:prev,change:changeRaw,changePct};
    }
    console.log('[TPEx] loaded '+Object.keys(map).length+' stocks');
    return map;
  }catch(e){console.warn('[TPEx-API]',e.message);return null;}
}
function loadTpex(){
  if(_tpexCache&&Date.now()-_tpexTs<8000)return Promise.resolve(_tpexCache);
  if(!_tpexP){_tpexP=_doLoadTpex().then(function(m){if(m){_tpexCache=m;_tpexTs=Date.now();}_tpexP=null;return _tpexCache;});}
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
  const preferLive=(ms==='REGULAR'||ms==='PRE'||ms==='CLOSING'||ms==='POST');
  let data=null;

  // ── 盤中優先即時來源，避免被 TWSE/TPEx 日資料蓋住 ──
  if(preferLive){
    const src=state.priceSource||'auto';
    const liveFallbacks=['yahoo','mis','stooq','finmind'];
    const priorities=(src!=='auto'&&src!=='twse'&&src!=='tpex'&&src!=='google')
      ?[src,...liveFallbacks.filter(function(s){return s!==src;})]
      :liveFallbacks;
    try{const f=await fetchBySource(symbol,priorities[0]);if(f&&f.price>0)data=f;}catch(e){}
    if(!data||data.price<=0){
      const [r1,r2,r3]=await Promise.allSettled([
        fetchBySource(symbol,priorities[1]||'mis'),
        fetchBySource(symbol,priorities[2]||'stooq'),
        fetchBySource(symbol,priorities[3]||'finmind')
      ]);
      data=(r1.status==='fulfilled'&&r1.value&&r1.value.price>0)?r1.value:
           (r2.status==='fulfilled'&&r2.value&&r2.value.price>0)?r2.value:
           (r3.status==='fulfilled'&&r3.value&&r3.value.price>0)?r3.value:null;
    }
  }

  // ── 非盤中或即時來源失敗，再取 TWSE/TPEx OpenAPI ──
  if(!data||data.price<=0){
    const [tw,tp]=await Promise.allSettled([loadTwse(),loadTpex()]);
    const twseMap=tw.status==='fulfilled'?tw.value:null;
    const tpexMap=tp.status==='fulfilled'?tp.value:null;
    if(twseMap&&twseMap[symbol]&&twseMap[symbol].close>0){
      const d=twseMap[symbol];
      data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TWSE'};
    }else if(tpexMap&&tpexMap[symbol]&&tpexMap[symbol].close>0){
      const d=tpexMap[symbol];
      data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TPEx'};
    }
  }

  // ── 最後備援 ──
  if((!data||data.price<=0) && !preferLive){
    const src=state.priceSource||'auto';
    const FALLBACKS=['yahoo','mis','stooq','finmind'];
    const priorities=(src!=='auto'&&src!=='twse'&&src!=='tpex'&&src!=='google')
      ?[src,...FALLBACKS.filter(function(s){return s!==src;})]
      :FALLBACKS;
    try{const f=await fetchBySource(symbol,priorities[0]);if(f&&f.price>0)data=f;}catch(e){}
    if(!data||data.price<=0){
      const [r1,r2,r3]=await Promise.allSettled([
        fetchBySource(symbol,priorities[1]||'mis'),
        fetchBySource(symbol,priorities[2]||'stooq'),
        fetchBySource(symbol,priorities[3]||'finmind')
      ]);
      data=(r1.status==='fulfilled'&&r1.value&&r1.value.price>0)?r1.value:
           (r2.status==='fulfilled'&&r2.value&&r2.value.price>0)?r2.value:
           (r3.status==='fulfilled'&&r3.value&&r3.value.price>0)?r3.value:null;
    }
  }

  if(!data||data.price<=0){console.error('[Quote] FAIL',symbol);return null;}
  data.marketState=ms;
  console.log('[Quote]',symbol,data.price,data.source);
  quoteCache[symbol]={data,ts:Date.now()};
  return data;
}

const SOURCE_NOTES={
  auto:{
    REGULAR:'盤中 → TWSE/TPEx 直接取值（免Proxy，每8秒更新），Yahoo/Stooq 備援',
    POST:'盤後 → Yahoo → Stooq → FinMind 依序嘗試',
    CLOSING:'收盤中 → Yahoo → Stooq → FinMind',
    PRE:'盤前 → Yahoo 昨日收盤，Stooq / FinMind 備援',
    CLOSED:'休市 → 每25秒查一次，Yahoo → Stooq → FinMind'
  },
  yahoo:{_:'Yahoo Finance v7即時報價 (query1+query2)，Stooq / FinMind 備援'},
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

// ── 只更新價格/漲跌欄（避免閃爍）─────────────────────────
function _mergeQuote(oldQ,newQ){
  if(!oldQ&&!newQ)return null;
  if(!oldQ)return newQ;
  if(!newQ)return oldQ;
  return {
    ...oldQ,
    ...newQ,
    price:(newQ.price!=null&&newQ.price>0)?newQ.price:oldQ.price,
    previousClose:newQ.previousClose!=null?newQ.previousClose:oldQ.previousClose,
    change:newQ.change!=null?newQ.change:oldQ.change,
    changePct:newQ.changePct!=null?newQ.changePct:oldQ.changePct,
    marketState:newQ.marketState||oldQ.marketState,
    source:newQ.source||oldQ.source
  };
}

function _watchPriceCellHTML(q,opt={}){
  const price=q&&q.price?q.price:null;
  const src=q&&q.source?'<span style="font-size:.58rem;color:#444;margin-left:3px;">['+q.source+']</span>':'';
  const chg=q&&q.change!=null?q.change:null;
  const pct=q&&q.changePct!=null?q.changePct:null;
  let color='';
  if(chg!==null) color=chg>0?'#ff4d4d':chg<0?'#2ecc71':'#8b949e';
  const isLimitUp=pct!==null&&pct>=9.5;
  const isLimitDown=pct!==null&&pct<=-9.5;
  const limitCls=isLimitUp?' price-limit-up':(isLimitDown?' price-limit-down':'');
  return '<span class="price-cell'+limitCls+'" style="font-weight:600;'+(color?('color:'+color+';'):'')+'">'+formatPrice(price)+'</span>'+src;
}
function _watchChangeCellHTML(q,opt={}){
  const loading=!!opt.loading;
  const chg=q&&q.change!=null?q.change:null;
  const pct=q&&q.changePct!=null?q.changePct:null;
  const ms=getMarketState();
  const isUp=(chg||0)>=0;
  const chgCls=isUp?'text-up':'text-down';
  const badgeCls=!q?'badge-wait':(isUp?'badge-rise':'badge-fall');
  const arrow=!q?'—':(isUp?'▲':'▼');
  let html='';
  if(chg!==null&&pct!==null){
    html+='<div class="'+chgCls+'" style="font-weight:700;">'+(isUp?'+':'')+chg.toFixed(2);
    html+=' <span style="font-size:.78rem;font-weight:400;">('+(isUp?'+':'')+pct.toFixed(2)+'%)</span></div>';
  }else{
    html+='<div style="color:#444;">—</div>';
  }
  html+='<div style="display:flex;gap:4px;margin-top:4px;align-items:center;">';
  html+='<span class="badge '+(loading?'badge-wait':badgeCls)+'">'+(loading?'<span class="mini-loader" aria-label="loading"></span>':(q?arrow:'—'))+'</span>';
  html+='<span class="badge '+getMarketBadgeClass(ms)+'">'+getMarketLabel(ms)+'</span>';
  html+='</div>';
  return html;
}

function buildWatchRow(symbol,q){
  const name=getStockName(symbol);
  const al=state.alerts&&state.alerts[symbol];
  const alertDot=al?'<span style="font-size:.6rem;color:#f3b73b;margin-left:3px;" title="'+(al.stopLoss?'停損:'+al.stopLoss:'')+(al.takeProfit?' 停利:'+al.takeProfit:'')+'">&#128276;</span>':'';
  let nameDiv='';
  if(name){
    nameDiv='<div style="font-size:.72rem;color:#8b949e;margin-top:1px;cursor:pointer;text-decoration:underline dotted;" data-fund="'+symbol+'">'+name+'</div>';
  }else{
    nameDiv='<div style="font-size:.72rem;color:#555;margin-top:1px;cursor:pointer;" data-fund="'+symbol+'">&#128202; 查看基本面</div>';
  }
  return'<td>'
    +'<div class="font-mono font-bold">'+symbol+alertDot+'</div>'
    +nameDiv
    +'</td>'
    +'<td class="wl-price">'+_watchPriceCellHTML(q)+'</td>'
    +'<td class="wl-change">'+_watchChangeCellHTML(q)+'</td>'
    +'<td>'
    +'<button class="text-xs text-blue-400 hover:underline mr-2" data-trade="'+symbol+'">操盤</button>'
    +'<button class="text-xs hover:underline mr-2" style="color:#f3b73b;" data-alert="'+symbol+'">⚠</button>'
    +'<button class="text-xs hover:underline" style="color:#ff4d4d;" data-remove="'+symbol+'">移除</button>'
    +'</td>';
}

function bindWatchlistEvents(){
  const tbody=document.getElementById('watchlistBody');
  tbody.querySelectorAll('[data-trade]').forEach(function(btn){
    btn.onclick=function(){
      const sym=btn.dataset.trade;
      const inp=document.getElementById('tradeSymbol');
      if(inp)inp.value=sym;
      if(typeof window.__navigate==='function')window.__navigate('trade');
      else{
        document.querySelectorAll('#sideNav .side-item,#bottomNav .nav-item').forEach(function(b){b.classList.remove('active');});
        document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
        const sb=document.querySelector('[data-page="trade"]');
        const pg=document.getElementById('page-trade');
        if(sb)sb.classList.add('active');
        if(pg)pg.classList.add('active');
      }
      setTimeout(function(){
        const q=quoteCache[normalizeSymbol(sym)]&&quoteCache[normalizeSymbol(sym)].data;
        const pe=document.getElementById('tradePrice');
        if(pe&&q&&q.price>0)pe.value=q.price.toFixed(2);
        updateFeePreview();
      },200);
    };
  });
  tbody.querySelectorAll('[data-remove]').forEach(function(btn){btn.onclick=function(){removeFromWatchlist(btn.dataset.remove);};});
  tbody.querySelectorAll('[data-alert]').forEach(function(btn){btn.onclick=function(){setAlert(btn.dataset.alert);};});
  tbody.querySelectorAll('[data-fund]').forEach(function(btn){btn.onclick=function(){toggleFundamentals(btn.dataset.fund);};});
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
  if(!state.watchlist.length)return;

  state.watchlist.forEach(function(symbol){
    const tr=tbody.querySelector('[data-symbol="'+symbol+'"]');
    if(!tr)return;
    const oldQ=quoteCache[symbol]&&quoteCache[symbol].data?quoteCache[symbol].data:null;
    const pc=tr.querySelector('.wl-price');
    const cc=tr.querySelector('.wl-change');
    if(pc)pc.innerHTML=_watchPriceCellHTML(oldQ,{loading:true});
    if(cc)cc.innerHTML=_watchChangeCellHTML(oldQ,{loading:true});
  });

  const results=await Promise.allSettled(state.watchlist.map(function(s){return fetchQuote(s);}));

  state.watchlist.forEach(function(symbol,i){
    const oldQ=quoteCache[symbol]&&quoteCache[symbol].data?quoteCache[symbol].data:null;
    const newQ=results[i].status==='fulfilled'?results[i].value:null;
    const q=_mergeQuote(oldQ,newQ);
    const tr=tbody.querySelector('[data-symbol="'+symbol+'"]');
    if(!tr)return;
    const pc=tr.querySelector('.wl-price');
    const cc=tr.querySelector('.wl-change');

    if(newQ&&newQ.price){
      quoteCache[symbol]={data:q,ts:Date.now()};
    }

    if(pc)pc.innerHTML=_watchPriceCellHTML(q,{loading:false});
    if(cc)cc.innerHTML=_watchChangeCellHTML(q,{loading:false});
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
      <div class="font-mono font-bold">${symbol}</div>
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
      <button class="text-xs text-blue-400 hover:underline" data-sell="${symbol}">快速賣出</button>
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
  tbody.querySelectorAll('[data-setalert]').forEach(function(btn){btn.onclick=function(){setAlert(btn.dataset.setalert);};});
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
    if(tr){
      tr.innerHTML=buildHoldingRow(symbol,h,q);
      tbody.querySelectorAll('[data-setalert]').forEach(function(btn){btn.onclick=function(){setAlert(btn.dataset.setalert);};});
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
  const pnl=num(state.realizedPnL)||0;
  const el=document.getElementById('totalPnL');
  el.textContent=(pnl>=0?'+':'')+formatMoney(pnl)+' 元';
  el.className='text-xl font-bold '+(pnl>=0?'text-up':'text-down');
  // Max Drawdown
  const ddEl=document.getElementById('maxDrawdown');
  if(ddEl){const dd=calcMaxDrawdown();ddEl.textContent=dd!=null?('-'+dd+'%'):'—';}
  // Win Rate
  const trades=state.realizedTrades||[];
  const wins=trades.filter(function(t){return t.netPnl>0;}).length;
  const wr=trades.length?((wins/trades.length)*100).toFixed(1)+'%':'—';
  const wrEl=document.getElementById('dashWinRate');
  if(wrEl)wrEl.textContent=wr;
  // Holdings Count
  const hcEl=document.getElementById('holdingsCount');
  if(hcEl)hcEl.textContent=Object.keys(state.holdings||{}).length+' 種';
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

// ─── 智慧型報價調度系統（核心任務 1）────────────────────

let _schedulerTimer=null;   // 唯一定時器
let _schedulerCheck=null;   // 30s 交易時段檢查器
let _isLiveRunning=false;   // 盤中刷新是否運作中

/** 批次報價：將所有追蹤+持股合併為一次 API 請求 */
async function fetchPriceBatch(){
  const syms=[...new Set([...state.watchlist,...Object.keys(state.holdings)])];
  if(!syms.length)return;

  const ms=getMarketState();
  const preferLive=(ms==='REGULAR'||ms==='PRE'||ms==='CLOSING'||ms==='POST');
  console.log('[Batch] tick '+new Date().toLocaleTimeString('zh-TW')+' n='+syms.length+' live='+preferLive);

  const resolved={};
  const wlBody=document.getElementById('watchlistBody');
  const hlBody=document.getElementById('holdingsBody');

  // 先進入讀取中，但保留上一筆成功值
  if(wlBody){
    for(const symbol of syms){
      const tr=wlBody.querySelector('tr[data-symbol="'+symbol+'"]');
      if(!tr)continue;
      const oldQ=quoteCache[symbol]&&quoteCache[symbol].data?quoteCache[symbol].data:null;
      const pc=tr.querySelector('.wl-price');
      const cc=tr.querySelector('.wl-change');
      if(pc)pc.innerHTML=_watchPriceCellHTML(oldQ,{loading:true});
      if(cc)cc.innerHTML=_watchChangeCellHTML(oldQ,{loading:true});
    }
  }

  // ── A. 盤中優先 Yahoo 批量即時報價，避免日資料造成整頁靜止 ──
  if(preferLive){
    const ts=Date.now();
    for(const sfx of['.TW','.TWO']){
      const pending=syms.filter(s=>!resolved[s]);
      if(!pending.length)break;
      const symStr=pending.map(s=>s+sfx).join(',');
      const baseUrl='https://query1.finance.yahoo.com/v7/finance/quote?symbols='+symStr
        +'&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName,longName'
        +'&lang=zh-TW&region=TW&_='+ts;
      const urls=[
        baseUrl,
        'https://corsproxy.io/?'+encodeURIComponent(baseUrl),
        'https://api.allorigins.win/raw?url='+encodeURIComponent(baseUrl)
      ];
      let quotes=[];
      for(const url of urls){
        try{
          const r=await timedFetch(url,5000);
          if(!r.ok)continue;
          const text=await r.text();
          if(!text||text.trim().startsWith('<'))continue;
          const j=JSON.parse(text);
          const rows=(j&&j.quoteResponse&&j.quoteResponse.result)||[];
          if(rows.length){quotes=rows;break;}
        }catch(e){console.warn('[Batch-Y7]',e.message);}
      }
      for(const q of quotes){
        const sym=normalizeSymbol((q.symbol||'').replace(/\.(TW|TWO)$/i,''));
        if(!sym||resolved[sym])continue;
        const price=num(q.regularMarketPrice);
        if(!price||price<=0)continue;
        const yName=q.longName||q.shortName||'';
        if(yName)setStockName(sym,yName.replace(/\s*\(.*?\)/g,'').trim());
        resolved[sym]={
          price,
          previousClose:num(q.regularMarketPreviousClose),
          change:num(q.regularMarketChange),
          changePct:num(q.regularMarketChangePercent),
          marketState:ms,
          source:'Yahoo'
        };
      }
    }
  }

  // ── B. 非盤中才補 TWSE/TPEx 日資料；盤中避免用日資料覆蓋即時漲跌 ──
  if(!preferLive){
    const [twMap,tpMap]=await Promise.allSettled([loadTwse(),loadTpex()])
      .then(r=>[(r[0].status==='fulfilled'?r[0].value:null),(r[1].status==='fulfilled'?r[1].value:null)]);

    for(const s of syms){
      if(resolved[s])continue;
      if(twMap&&twMap[s]&&twMap[s].close>0){
        const d=twMap[s];
        resolved[s]={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TWSE'};
      }else if(tpMap&&tpMap[s]&&tpMap[s].close>0){
        const d=tpMap[s];
        resolved[s]={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:ms,source:'TPEx'};
      }
    }
  }

  // ── C. 逐股即時補洞，優先 Yahoo，其次 MIS；失敗時保留舊值 ──
  const missing=syms.filter(s=>!resolved[s]);
  if(missing.length){
    const jobs=missing.map(async function(symbol){
      try{
        const q=preferLive
          ? (await fetchYahooBackup(symbol)) || (await fetchMIS(symbol)) || (await fetchStooq(symbol)) || (await fetchFinMind(symbol))
          : (await fetchYahooBackup(symbol)) || (await fetchMIS(symbol)) || (await fetchStooq(symbol)) || (await fetchFinMind(symbol));
        if(q&&q.price>0) resolved[symbol]=q;
      }catch(e){console.warn('[Batch-fill]',symbol,e.message);}
    });
    await Promise.allSettled(jobs);
  }

  // ── D. 更新 quoteCache + DOM（失敗時保留上一筆成功值）──
  for(const symbol of syms){
    const incoming=resolved[symbol]||null;
    const oldQ=quoteCache[symbol]&&quoteCache[symbol].data?quoteCache[symbol].data:null;
    const q=_mergeQuote(oldQ,incoming);
    if(!q||!q.price)continue;
    const oldPrice=oldQ&&oldQ.price?oldQ.price:null;

    if(incoming&&incoming.price){
      quoteCache[symbol]={data:q,ts:Date.now()};
    }

    if(wlBody){
      const tr=wlBody.querySelector('tr[data-symbol="'+symbol+'"]');
      if(tr){
        const pc=tr.querySelector('.wl-price');
        const cc=tr.querySelector('.wl-change');
        if(pc)pc.innerHTML=_watchPriceCellHTML(q,{loading:false});
        if(cc)cc.innerHTML=_watchChangeCellHTML(q,{loading:false});
        if(pc&&oldPrice&&q.price!==oldPrice){
          const cls=q.price>oldPrice?'price-flash-up':'price-flash-down';
          pc.classList.remove('price-flash-up','price-flash-down');
          void pc.offsetWidth;
          pc.classList.add(cls);
          pc.addEventListener('animationend',function h(){pc.classList.remove(cls);pc.removeEventListener('animationend',h);},{once:true});
        }
        const nameDiv=tr.querySelector('[data-fund]');
        if(nameDiv){
          const cached=stockNameCache[symbol];
          if(cached&&!/^—+$/.test(cached)&&nameDiv.textContent!==cached){
            nameDiv.textContent=cached;
            nameDiv.style.color='#8b949e';
            nameDiv.style.textDecoration='underline dotted';
          }
        }
      }
    }

    if(hlBody){
      const tr=hlBody.querySelector('tr[data-hsymbol="'+symbol+'"]');
      if(tr&&state.holdings[symbol]){
        tr.innerHTML=buildHoldingRow(symbol,state.holdings[symbol],q);
        tr.querySelectorAll('[data-setalert]').forEach(function(btn){btn.onclick=function(){setAlert(btn.dataset.setalert);};});
        tr.querySelectorAll('[data-sell]').forEach(function(btn){btn.onclick=function(){document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
      }
    }

    checkAlerts(symbol,q.price);
  }

  let total=0;
  Object.keys(state.holdings).forEach(function(s){
    const h=state.holdings[s];
    const q=quoteCache[s]&&quoteCache[s].data;
    total+=((q&&q.price>0)?q.price:h.avgPrice)*h.shares;
  });
  renderDashboardQuick(total);
  renderSourceSelector();
}

/** 智慧調度器：盤中每5秒刷新，非盤中停止 */
function startSmartScheduler(){
  // 清除舊定時器
  if(_schedulerTimer){clearInterval(_schedulerTimer);_schedulerTimer=null;}
  if(_schedulerCheck){clearInterval(_schedulerCheck);_schedulerCheck=null;}

  function _startLive(){
    if(_isLiveRunning)return;
    _isLiveRunning=true;
    // 清除批量快取以取得最新資料
    _twseCache=null;_twseTs=0;_tpexCache=null;_tpexTs=0;
    _schedulerTimer=setInterval(function(){
      // 每 60 秒強制重取批量資料
      _rotateSourceIdx++;
      if(_rotateSourceIdx%12===0){_twseCache=null;_twseTs=0;_tpexCache=null;_tpexTs=0;}
      fetchPriceBatch();
    },5000);
    console.log('[Scheduler] 盤中模式啟動，每 5 秒刷新');
  }

  function _stopLive(){
    if(!_isLiveRunning)return;
    _isLiveRunning=false;
    if(_schedulerTimer){clearInterval(_schedulerTimer);_schedulerTimer=null;}
    console.log('[Scheduler] 非盤中，停止自動刷新，保留最後收盤價');
  }

  // 初始化：根據當前時間決定
  if(isTaiwanTradingTime()) _startLive();
  else console.log('[Scheduler] 當前非交易時段，僅保留最後報價');

  // 每 30 秒檢查一次是否進入/離開交易時段
  _schedulerCheck=setInterval(function(){
    if(isTaiwanTradingTime()){ _startLive(); }
    else{ _stopLive(); }
  },30000);
}


// ═══════════════════════════════════════════════════════
//  中文股名批量預載 (TWSE + TPEx OpenAPI)
// ═══════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
//  股票名稱批量預載
//  策略：TWSE/TPEx opendata(主) → Yahoo TW 爬蟲(逐股備援)
// ════════════════════════════════════════════════════════
async function preloadStockNames(){
  var total=0;

  // ── A. TWSE 上市清單（t187ap03_L 永久清單）──────────────
  var twseSrcs=[
    'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
  ];
  for(var si=0;si<twseSrcs.length;si++){
    try{
      var r=await timedFetch(twseSrcs[si],12000);
      if(!r.ok)continue;
      var arr=await r.json();
      if(!Array.isArray(arr)||arr.length<10)continue;
      var cnt=0;
      for(var j=0;j<arr.length;j++){
        var item=arr[j];
        var code=String(item['有價證券代號']||item.Code||item['證券代號']||'').trim();
        var name=String(item['有價證券名稱']||item.Name||item['證券名稱']||'').trim();
        if(code&&name&&/[\u4e00-\u9fff]/.test(name)){stockNameCache[code]=name;cnt++;}
      }
      console.log('[Names-TWSE] src'+si+': '+cnt+' names');
      total+=cnt;
      if(cnt>100)break;
    }catch(e){console.warn('[Names-TWSE] src'+si,e.message);}
  }

  // ── B. TPEx 上櫃清單 ─────────────────────────────────────
  var tpexSrcs=[
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'
  ];
  for(var ti=0;ti<tpexSrcs.length;ti++){
    try{
      var r2=await timedFetch(tpexSrcs[ti],12000);
      if(!r2.ok)continue;
      var arr2=await r2.json();
      if(!Array.isArray(arr2))continue;
      var c2=0;
      for(var k=0;k<arr2.length;k++){
        var it=arr2[k];
        var code2=String(it['有價證券代號']||it.SecuritiesCompanyCode||it['代號']||'').trim();
        var name2=String(it['有價證券名稱']||it.CompanyName||it['公司簡稱']||it.Name||'').trim();
        if(code2&&name2&&/[\u4e00-\u9fff]/.test(name2)&&!stockNameCache[code2]){
          stockNameCache[code2]=name2;c2++;
        }
      }
      console.log('[Names-TPEx] src'+ti+': '+c2+' names');
      total+=c2;
      if(c2>10)break;
    }catch(e){console.warn('[Names-TPEx] src'+ti,e.message);}
  }

  console.log('[Names] TWSE+TPEx total='+total);

  // ── C. fetchChineseName 補漏（Yahoo Search → 頁面標題）──
  var missing=[...state.watchlist,...Object.keys(state.holdings)].filter(
    function(s){return !stockNameCache[normalizeSymbol(s)]||!/[\u4e00-\u9fff]/.test(stockNameCache[normalizeSymbol(s)]);});
  if(missing.length){
    console.log('[Names] fetching '+missing.length+' missing names...');
    for(var mi=0;mi<missing.length;mi++){
      fetchChineseName(normalizeSymbol(missing[mi]));
    }
  }

  if(total>0||missing.length>0){
    renderWatchlistImmediate();
    renderHoldingsImmediate();
    if(typeof renderHoldingsOverview==='function')renderHoldingsOverview();
  }
}

// ═══════════════════════════════════════════════════════
//  最大回撤計算
// ═══════════════════════════════════════════════════════
function calcMaxDrawdown(){
  var hist=state.assetHistory||[];
  if(hist.length<2)return null;
  var peak=hist[0].total,maxDD=0;
  for(var i=0;i<hist.length;i++){
    if(hist[i].total>peak)peak=hist[i].total;
    var dd=peak>0?(peak-hist[i].total)/peak*100:0;
    if(dd>maxDD)maxDD=dd;
  }
  return maxDD.toFixed(2);
}

// ═══════════════════════════════════════════════════════
//  停損停利警示
// ═══════════════════════════════════════════════════════
var _alertBlinkTimer=null;
function setAlert(symbol){
  symbol=normalizeSymbol(symbol);
  var cur=(state.alerts&&state.alerts[symbol])||{};
  var sl=prompt(symbol+' 停損價（跌到此價提醒，留空取消）：',cur.stopLoss||'');
  if(sl===null)return;
  var tp=prompt(symbol+' 停利價（漲到此價提醒，留空取消）：',cur.takeProfit||'');
  if(tp===null)return;
  if(!state.alerts)state.alerts={};
  var slNum=num(sl),tpNum=num(tp);
  if(!slNum&&!tpNum){
    delete state.alerts[symbol];
    showToast('\u2705 \u5df2\u6e05\u9664 '+symbol+' \u8b66\u793a');
    saveState(state);renderWatchlistImmediate();renderHoldingsImmediate();return;
  }
  state.alerts[symbol]={stopLoss:slNum||null,takeProfit:tpNum||null,triggered:false};
  saveState(state);
  showToast('\ud83d\udd14 '+symbol+' \u505c\u640d:'+(slNum||'\u2014')+' / \u505c\u5229:'+(tpNum||'\u2014')+' \u5df2\u8a2d\u5b9a');
  renderWatchlistImmediate();renderHoldingsImmediate();
}

function checkAlerts(symbol,price){
  if(!state.alerts||!price)return;
  var a=state.alerts[symbol];
  if(!a||a.triggered)return;
  var hit=null;
  if(a.stopLoss&&price<=a.stopLoss)hit={type:'\ud83d\udd34 \u505c\u640d',val:a.stopLoss};
  if(a.takeProfit&&price>=a.takeProfit)hit={type:'\ud83d\udfe2 \u505c\u5229',val:a.takeProfit};
  if(!hit)return;
  a.triggered=true;saveState(state);
  var msg='\u26a0\ufe0f '+symbol+' '+hit.type+'\u89f8\u767c\uff01\u73fe\u50f9 '+price+' \u5df2'+(hit.type.indexOf('\u505c\u640d')>=0?'\u8dcc\u7a7f':'\u7a81\u7834')+' '+hit.val;
  showToast(msg);
  var origTitle=document.title;var blink=true;
  if(_alertBlinkTimer)clearInterval(_alertBlinkTimer);
  _alertBlinkTimer=setInterval(function(){
    document.title=blink?('\u26a0\ufe0f '+symbol+' '+hit.type+'!'):'\u53f0\u80a1\u64cd\u76e4 v2.3';
    blink=!blink;
  },600);
  setTimeout(function(){clearInterval(_alertBlinkTimer);document.title=origTitle;},15000);
}

// ═══════════════════════════════════════════════════════
//  基本面資料 (Yahoo Finance v10/quoteSummary)
// ═══════════════════════════════════════════════════════
var _fundCache={};

// ════════════════════════════════════════════════════════
//  基本面：Yahoo Finance v10/quoteSummary（直連，不爬 HTML）
//  + TWSE BWIBBU_d / TPEx 補充
// ════════════════════════════════════════════════════════
async function fetchFundamentals(symbol){
  if(_fundCache[symbol]&&Date.now()-_fundCache[symbol].ts<3600000)return _fundCache[symbol].data;
  var data={pe:null,pbr:null,dividendYield:null,eps:null,epsQuarters:[]};
  var ok=false;

  // ── A. Yahoo v10/quoteSummary（直連，免 Proxy）──────────
  var ySfxList=['.TW','.TWO'];
  var yModules='summaryDetail,defaultKeyStatistics,financialData';
  var yBases=[
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/'
  ];
  for(var bi=0;bi<yBases.length&&!ok;bi++){
    for(var si=0;si<ySfxList.length&&!ok;si++){
      var yUrl=yBases[bi]+symbol+ySfxList[si]
        +'?modules='+yModules+'&lang=zh-TW&region=TW&_='+Date.now();
      try{
        var r=await timedFetch(yUrl,6000);
        if(!r.ok)continue;
        var j=await r.json();
        var res=j&&j.quoteSummary&&j.quoteSummary.result&&j.quoteSummary.result[0];
        if(!res)continue;
        var ks=res.defaultKeyStatistics||{};
        var sd=res.summaryDetail||{};
        var pe=num((ks.trailingPE&&ks.trailingPE.raw)||(sd.trailingPE&&sd.trailingPE.raw));
        var pbr=num(ks.priceToBook&&ks.priceToBook.raw);
        var dy=sd.dividendYield&&sd.dividendYield.raw!=null?sd.dividendYield.raw:null;
        var eps=num(ks.trailingEps&&ks.trailingEps.raw);
        if(pe||dy!=null||eps){
          data.pe=pe;data.pbr=pbr;
          data.dividendYield=dy!=null?(dy*100).toFixed(2):null;
          data.eps=eps;ok=true;
          console.log('[Fund-Y10] '+symbol+ySfxList[si]+' pe='+pe+' dy='+dy+' eps='+eps);
        }
      }catch(e){console.warn('[Fund-Y10]',e.message);}
    }
  }

  // ── B. TWSE BWIBBU_d（上市補充，免 Proxy）────────────────
  if(!data.pe&&!data.dividendYield){
    try{
      var r2=await timedFetch('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_d',10000);
      if(r2.ok){
        var arr2=await r2.json();
        if(Array.isArray(arr2)){
          for(var ii=0;ii<arr2.length;ii++){
            var it=arr2[ii];
            var code=String(it.Code||it['股票代號']||'').trim();
            if(code!==symbol)continue;
            data.pe=num(it.PEratio||it['本益比'])||null;
            data.dividendYield=String(num(it.DividendYield||it['殖利率'])||'')||null;
            data.pbr=num(it.PBratio||it['股價淨值比'])||null;
            ok=true;break;
          }
        }
      }
    }catch(e){console.warn('[Fund-TWSE]',e.message);}
  }

  // ── C. TPEx（上櫃股）────────────────────────────────────
  if(!data.pe&&!data.dividendYield){
    try{
      var r3=await timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',10000);
      if(r3.ok){
        var arr3=await r3.json();
        if(Array.isArray(arr3)){
          for(var jj=0;jj<arr3.length;jj++){
            var it3=arr3[jj];
            var c3=String(it3.SecuritiesCompanyCode||it3['代號']||'').trim();
            if(c3!==symbol)continue;
            data.pe=num(it3.PriceEarningRatio||it3['本益比'])||null;
            data.dividendYield=String(num(it3.DividendYield||it3['殖利率'])||'')||null;
            ok=true;break;
          }
        }
      }
    }catch(e){console.warn('[Fund-TPEx]',e.message);}
  }

  // ── D. FinMind 近四季 EPS ────────────────────────────────
  try{
    var epUrl='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements'
      +'&stock_id='+symbol+'&start_date='+daysAgo(400)+'&token='+encodeURIComponent(_r());
    var re=await timedFetch(epUrl,8000);
    if(re.ok){
      var je=await re.json();
      if(je.status===200&&Array.isArray(je.data)){
        var eps_raw=je.data.filter(function(d){return d.type==='EPS';})
          .sort(function(a,b){return b.date.localeCompare(a.date);}).slice(0,4);
        if(!data.eps&&eps_raw.length)data.eps=num(eps_raw[0].value);
        data.epsQuarters=eps_raw.map(function(d){return{period:d.date.slice(0,7),eps:num(d.value)};});
        if(eps_raw.length)ok=true;
      }
    }
  }catch(e){console.warn('[Fund-EPS]',e.message);}

  if(!ok){console.warn('[Fund] FAIL '+symbol);return null;}
  _fundCache[symbol]={data:data,ts:Date.now()};
  return data;
}

async function toggleFundamentals(symbol){
  var rowId='fund-'+symbol;
  var existing=document.getElementById(rowId);
  if(existing){existing.remove();return;}
  var tbody=document.getElementById('watchlistBody');
  var tr=tbody&&tbody.querySelector('[data-symbol="'+symbol+'"]');
  if(!tr)return;
  var fRow=document.createElement('tr');fRow.id=rowId;
  fRow.innerHTML='<td colspan="4" style="padding:8px 16px;background:#0a0f16;border-left:3px solid #388bfd;">'
    +'<span style="font-size:.78rem;color:var(--muted);">\ud83d\udcca \u8f09\u5165\u57fa\u672c\u9762\u8cc7\u6599\u2026</span></td>';
  tr.after(fRow);

  var d=await fetchFundamentals(symbol);

  if(!d){
    fRow.innerHTML='<td colspan="4" style="padding:8px 16px;background:#0a0f16;border-left:3px solid var(--border);">'
      +'<span style="font-size:.78rem;color:var(--muted);">\u26a0\ufe0f \u66ab\u7121\u6578\u64da\uff0c\u8acb\u7a0d\u5f8c\u518d\u8a66</span></td>';
    return;
  }

  var eps4=d.epsQuarters&&d.epsQuarters.length
    ?d.epsQuarters.map(function(q){
        return '<span style="margin-right:10px;">'+q.period+'\uff1a<strong>'+q.eps+'</strong></span>';
      }).join('')
    :'\u2014';

  var dy=d.dividendYield?d.dividendYield+'%':'\u2014';

  fRow.innerHTML='<td colspan="4" style="padding:10px 16px;background:#0a0f16;border-left:3px solid #388bfd;">'
    +'<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:.82rem;align-items:center;">'
    +(d.pe?'<span>\ud83d\udcc8 \u672c\u76ca\u6bd4(TTM)\uff1a<strong style="color:#f3b73b;font-size:1rem;">'+d.pe.toFixed(1)+'</strong></span>':'')
    +(d.dividendYield?'<span>\ud83d\udcb0 \u6b96\u5229\u7387\uff1a<strong style="color:#2ecc71;font-size:1rem;">'+dy+'</strong></span>':'')
    +(d.eps?'<span>\ud83d\udcca EPS(TTM)\uff1a<strong style="color:#fff;">'+d.eps+'</strong></span>':'')
    +(d.pbr?'<span>\ud83c\udfe6 \u6de8\u5024\u6bd4\uff1a<strong style="color:#8b949e;">'+d.pbr.toFixed(2)+'</strong></span>':'')
    +'</div>'
    +'<div style="margin-top:6px;font-size:.78rem;color:var(--muted);">\u8fd14\u5b63 EPS\uff1a'+eps4+'</div>'
    +(d.name?'<div style="margin-top:4px;font-size:.72rem;color:#388bfd;">\u2714 \u540d\u7a31\u5df2\u66f4\u65b0\uff1a'+d.name+'</div>':'')
    +'</td>';
}

// ═══════════════════════════════════════════════════════
//  除息自動模擬 (FinMind TaiwanStockDividend)
// ═══════════════════════════════════════════════════════
async function checkDividends(){
  var today=getTWDate().toISOString().slice(0,10);
  if(!state.dividendChecked)state.dividendChecked={};
  var syms=Object.keys(state.holdings);
  for(var i=0;i<syms.length;i++){
    var symbol=syms[i];
    var h=state.holdings[symbol];
    if(!h||!h.shares)continue;
    var key=symbol+'_'+today;
    if(state.dividendChecked[key])continue;
    try{
      var url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockDividend&stock_id='+symbol+'&start_date='+daysAgo(3)+'&token='+encodeURIComponent(_r());
      var r=await timedFetch(url,8000);if(!r.ok)continue;
      var json=await r.json();
      if(json.status!==200||!Array.isArray(json.data))continue;
      for(var j=0;j<json.data.length;j++){
        var d=json.data[j];
        if(d.date!==today)continue;
        var cashDiv=num(d.CashDividend||d.cash_dividend||0)||0;
        if(cashDiv<=0)continue;
        var income=Math.round(cashDiv*h.shares);
        if(income<=0)continue;
        state.cash+=income;
        state.dividendChecked[key]=true;
        state.history.unshift({time:new Date().toLocaleString('zh-TW'),symbol:symbol,side:'dividend',shares:h.shares,price:cashDiv,amount:income,fee:0});
        saveState(state);renderDashboardQuick();renderHistory();
        showToast('\ud83d\udcb0 '+symbol+' \u9664\u606f\uff1a\u6bcf\u80a1 '+cashDiv+' \u5143 \xd7 '+h.shares+' \u80a1 = '+formatMoney(income)+' \u5143\u5df2\u5165\u5e33\uff01');
      }
    }catch(e){console.warn('[Dividend]',e.message);}
  }
}


// Yahoo Finance Search → 繁體中文股名（直連，免 Proxy）
var _nameReqSet={};
async function fetchChineseName(symbol){
  if(_nameReqSet[symbol])return;
  _nameReqSet[symbol]=true;
  var ts=Date.now();
  var urls=[
    'https://query1.finance.yahoo.com/v1/finance/search?q='+symbol+'&lang=zh-Hant-TW&region=TW&quotesCount=5&_='+ts,
    'https://query2.finance.yahoo.com/v1/finance/search?q='+symbol+'&lang=zh-Hant-TW&region=TW&quotesCount=5&_='+ts
  ];
  for(var i=0;i<urls.length;i++){
    try{
      var r=await timedFetch(urls[i],5000);
      if(!r.ok)continue;
      var j=await r.json();
      var quotes=(j&&j.finance&&j.finance.result&&j.finance.result[0]&&j.finance.result[0].quotes)||
                 (j&&j.quotes)||[];
      for(var k=0;k<quotes.length;k++){
        var q=quotes[k];
        var sym=(q.symbol||'').replace(/\.(TW|TWO)$/i,'');
        if(sym!==symbol)continue;
        var cn=q.shortname||q.longname||q.shortName||q.longName||'';
        if(cn&&/[\u4e00-\u9fff]/.test(cn)){
          stockNameCache[symbol]=cn.replace(/\s*\(.*?\)/g,'').trim();
          console.log('[CN-Name] '+symbol+' = '+stockNameCache[symbol]);
          // 立刻更新 DOM
          var tbody=document.getElementById('watchlistBody');
          if(tbody){
            var tr=tbody.querySelector('[data-symbol="'+symbol+'"]');
            if(tr){
              var nd=tr.querySelector('[data-fund]');
              if(nd){nd.textContent=stockNameCache[symbol];nd.style.color='#8b949e';nd.style.textDecoration='underline dotted';}
            }
          }
          _nameReqSet[symbol]=false;
          return;
        }
      }
    }catch(e){}
  }
  // Yahoo Search 失敗，改爬 tw.stock.yahoo.com quote 頁面 title
  var PROXIES=[
    function(u){return'https://api.allorigins.win/raw?url='+encodeURIComponent(u);},
    function(u){return'https://corsproxy.io/?'+encodeURIComponent(u);}
  ];
  for(var sfx of['.TW','.TWO']){
    var pageUrl='https://tw.stock.yahoo.com/quote/'+symbol+sfx;
    for(var pi=0;pi<PROXIES.length;pi++){
      try{
        var r2=await timedFetch(PROXIES[pi](pageUrl),8000);
        if(!r2.ok)continue;
        var html=await r2.text();
        if(!html||html.length<500)continue;
        var m=html.match(/<title>([^<(（\s]+)/);
        if(m){
          var n=m[1].trim();
          if(n&&/[\u4e00-\u9fff]/.test(n)){
            stockNameCache[symbol]=n;
            console.log('[CN-Title] '+symbol+' = '+n);
            var tbody2=document.getElementById('watchlistBody');
            if(tbody2){
              var tr2=tbody2.querySelector('[data-symbol="'+symbol+'"]');
              if(tr2){var nd2=tr2.querySelector('[data-fund]');if(nd2){nd2.textContent=n;nd2.style.color='#8b949e';nd2.style.textDecoration='underline dotted';}}
            }
            _nameReqSet[symbol]=false;
            return;
          }
        }
      }catch(e){}
    }
  }
  _nameReqSet[symbol]=false;
}
// ═══════════════════════════════════════════════════════
//  直接即時報價（繞過所有快取層，每次強制重新請求）
// ═══════════════════════════════════════════════════════
async function fetchPriceNow(symbol){
  const ts=Date.now();
  const ms=getMarketState();

  // ── A. 優先：Yahoo Finance v7（不走 proxy，直連，加時間戳）──
  for(const sfx of['.TW','.TWO']){
    const url='https://query1.finance.yahoo.com/v7/finance/quote'
      +'?symbols='+symbol+sfx
      +'&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,shortName,longName'
      +'&lang=zh-TW&region=TW&_='+ts;
    try{
      const r=await timedFetch(url,4000);
      if(!r.ok)continue;
      const j=await r.json();
      const q=j&&j.quoteResponse&&j.quoteResponse.result&&j.quoteResponse.result[0];
      if(!q||!q.regularMarketPrice)continue;
      const price=num(q.regularMarketPrice);
      if(!price||price<=0)continue;
      // 先用 longName/shortName（可能英文）
      const yRaw=q.longName||q.shortName||'';
      if(yRaw)setStockName(symbol,yRaw.replace(/\s*\(.*?\)/g,'').trim());
      // 若名稱不是中文，非同步補抓 Yahoo Search 繁體中文名
      if(!stockNameCache[symbol]||!/[\u4e00-\u9fff]/.test(stockNameCache[symbol])){
        fetchChineseName(symbol);
      }
      console.log('[Direct-Y7] '+symbol+sfx+'='+price+' t='+ts);
      return{
        price,
        previousClose:num(q.regularMarketPreviousClose),
        change:num(q.regularMarketChange),
        changePct:num(q.regularMarketChangePercent),
        marketState:ms,source:'Yahoo'
      };
    }catch(e){}
  }

  // ── B. 備援：TWSE/TPEx 批量（CORS 直連，含中文名稱）─────
  try{
    const [tw,tp]=await Promise.allSettled([
      timedFetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL?_='+ts,8000),
      timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes?_='+ts,8000)
    ]);
    for(const res of[tw,tp]){
      if(res.status!=='fulfilled'||!res.value.ok)continue;
      const arr=await res.value.json();
      if(!Array.isArray(arr))continue;
      for(const item of arr){
        const code=String(item.Code||item.SecuritiesCompanyCode||'').trim();
        if(code!==symbol)continue;
        const name=String(item.Name||item.CompanyName||'').trim();
        if(name&&/[\u4e00-\u9fff]/.test(name))setStockName(symbol,name);
        const close=num(item.ClosingPrice||item.Close);
        const chg=num(item.Change);
        if(!close||close<=0)continue;
        const prev=chg!=null?parseFloat((close-chg).toFixed(2)):null;
        const pct=prev&&chg?parseFloat((chg/prev*100).toFixed(2)):null;
        console.log('[Direct-TW] '+symbol+'='+close+' t='+ts);
        return{price:close,previousClose:prev,change:chg,changePct:pct,marketState:ms,source:'TWSE'};
      }
    }
  }catch(e){}

  // ── C. 最終備援：Stooq CSV ─────────────────────────────
  for(const sfx of['.tw','.twp']){
    const url='https://corsproxy.io/?'+encodeURIComponent('https://stooq.com/q/l/?s='+symbol.toLowerCase()+sfx+'&f=sd2t2ohlcvn&h&e=csv')+'&_cb='+ts;
    try{
      const r=await timedFetch(url,6000);if(!r.ok)continue;
      const txt=await r.text();if(!txt||txt.includes('No data'))continue;
      const lines=txt.trim().split('\n');if(lines.length<2)continue;
      const h=lines[0].split(',').map(function(x){return x.trim().toLowerCase();});
      const v=lines[1].split(',').map(function(x){return x.trim();});
      const g=function(k){const i=h.indexOf(k);return i>=0?v[i]:null;};
      const close=num(g('close'));if(!close||close<=0)continue;
      const open=num(g('open'));
      const chg=open?parseFloat((close-open).toFixed(2)):null;
      const pct=open?parseFloat((chg/open*100).toFixed(2)):null;
      return{price:close,previousClose:open,change:chg,changePct:pct,marketState:ms,source:'Stooq'};
    }catch(e){}
  }
  return null;
}

// ═══════════════════════════════════════════════════════
//  5 秒即時刷新主循環（直接寫 DOM，不依賴 cache）
// ═══════════════════════════════════════════════════════
// [v2.6] startLiveRefresh 已由 startSmartScheduler + fetchPriceBatch 取代
// 保留空函式以相容可能的外部呼叫
function startLiveRefresh(){ startSmartScheduler(); }
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

  // 版號注入
  const vEl=document.getElementById('appVersion');
  if(vEl)vEl.textContent='v'+APP_VERSION;
  document.title='台股虛擬操盤 v'+APP_VERSION;
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

  // [v2.6] 統一智慧調度器，取代原本雙 Timer
  startSmartScheduler();
  // 初次載入時手動觸發一次報價
  fetchPriceBatch();
  preloadStockNames();
  checkDividends();
});

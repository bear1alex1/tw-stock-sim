// ═══════════════════════════════════════════════════════
//  台股虛擬操盤系統 v1.9
// ═══════════════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v1';

let state = loadState();
const quoteCache = {};

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

function getMarketLabel(s){return{PRE:'盤前',REGULAR:'盤中',CLOSING:'收盤中',POST:'盤後零股',CLOSED:'收盤'}[s]||'收盤';}
function getMarketBadgeClass(s){if(s==='REGULAR')return'badge-up';if(s==='POST'||s==='CLOSING')return'badge-down';return'badge-wait';}

function getCacheTTL(){
  const s=getMarketState();
  if(s==='REGULAR')return 8_000;
  if(s==='POST'||s==='CLOSING')return 30_000;
  return 300_000;
}
function getRefreshInterval(){
  const s=getMarketState();
  if(s==='REGULAR')return 10_000;
  if(s==='POST')return 60_000;
  if(s==='CLOSING')return 30_000;
  if(s==='PRE')return 60_000;
  return 300_000;
}

// ─── 時鐘 ──────────────────────────────────────────────

function updateClock(){
  const tw=getTWDate(),pad=n=>String(n).padStart(2,'0');
  const el=document.getElementById('twClock');
  if(el)el.textContent=`${pad(tw.getUTCHours())}:${pad(tw.getUTCMinutes())}:${pad(tw.getUTCSeconds())} (台灣)`;
  const ms=getMarketState();
  const badge=document.getElementById('marketBadge');
  if(badge){badge.textContent=getMarketLabel(ms);badge.className=`badge ${getMarketBadgeClass(ms)}`;badge.style.fontSize='.7rem';}
}

// ─── Utilities ─────────────────────────────────────────

function num(v){
  if(v===null||v===undefined)return null;
  const s=String(v).replace(/,/g,'').replace(/＋/g,'+').replace(/▲/g,'').replace(/▼/g,'-').trim();
  if(!s||/^[-–]+$/.test(s)||s==='---'||s==='N/A'||s==='--')return null;
  const n=parseFloat(s);return isFinite(n)?n:null;
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

function getTWDateStr(){
  const tw=getTWDate();
  return `${tw.getUTCFullYear()}${String(tw.getUTCMonth()+1).padStart(2,'0')}${String(tw.getUTCDate()).padStart(2,'0')}`;
}

// ─── State ─────────────────────────────────────────────

function getEmptyState(){
  return{cash:INITIAL_CASH,holdings:{},history:[],watchlist:[],realizedPnL:0,priceSource:'auto',savedAt:null};
}

function loadState(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return getEmptyState();
    const p=JSON.parse(raw);
    return{
      cash:        num(p.cash)??INITIAL_CASH,
      holdings:    (p.holdings&&typeof p.holdings==='object')?p.holdings:{},
      history:     Array.isArray(p.history)?p.history:[],
      watchlist:   Array.isArray(p.watchlist)?[...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))]:[],
      realizedPnL: num(p.realizedPnL)??0,
      priceSource: p.priceSource||'auto',
      savedAt:     p.savedAt||null
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

// ─── Fee ───────────────────────────────────────────────

function calcFee(price,shares,side){
  const amount=price*shares;
  const broker=Math.max(Math.round(amount*0.001425),20);
  const tax=side==='sell'?Math.round(amount*0.003):0;
  return{amount,broker,tax,total:broker+tax};
}

// ═══════════════════════════════════════════════════════
//  報價來源實作
// ═══════════════════════════════════════════════════════

// ── A. TWSE MIS 即時 API（盤中用，每5秒更新）─────────────

async function fetchMIS(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  const EXCH=['tse','otc'];
  for(const ex of EXCH){
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
        const z=(item.z&&item.z!=='-'&&item.z!=='0'&&item.z!=='--')?num(item.z):null;
        const y=num(item.y);
        const ms=getMarketState();
        const price=(ms==='REGULAR'&&z)?z:(z??y);
        if(!price||price<=0)continue;
        const base=(ms==='REGULAR')?y:(y??null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log(`[MIS] ✅ ${symbol}(${ex}) ${price}`);
        return{price,previousClose:base,change,changePct,marketState:ms,source:'MIS'};
      }catch(e){console.warn(`[MIS] ${e.message}`);}
    }
  }
  return null;
}

// ── B. TWSE 官網 STOCK_DAY（爬蟲，每日收盤資料）──────────

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
      // fields: [日期,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數]
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

// ── C. Yahoo Finance API（proxy）────────────────────────

async function fetchYahooBackup(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  const SUFFIXES=['.TW','.TWO'];
  for(const sfx of SUFFIXES){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),7000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const result=json?.chart?.result?.[0];
        if(!result)continue;
        const meta=result.meta;
        const closes=(result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
        const regPx=num(meta?.regularMarketPrice);
        const prev=num(meta?.regularMarketPreviousClose)??num(meta?.previousClose);
        const last=closes.length?closes[closes.length-1]:null;
        const ms=getMarketState();
        const price=(ms==='REGULAR')?(regPx??last):(last??regPx);
        if(!price||price<=0)continue;
        const base=prev??(closes.length>=2?closes[closes.length-2]:null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log(`[Yahoo] ✅ ${symbol}${sfx} ${price}`);
        return{price,previousClose:base,change,changePct,marketState:ms,source:'Yahoo'};
      }catch(_){}
    }
  }
  return null;
}

// ── D. Google Finance（HTML 爬蟲，多策略解析）──────────────

async function fetchGoogleFinance(symbol){
  const EXCHANGES=['TPE','TPEX'];
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  for(const ex of EXCHANGES){
    const target=`https://www.google.com/finance/quote/${symbol}:${ex}`;
    for(const px of PROXIES){
      try{
        const r=await timedFetch(px(target),8000);
        if(!r.ok)continue;
        const html=await r.text();
        if(!html||html.length<500)continue;
        if(html.includes('did not match any results')||html.includes('找不到'))continue;

        let price=null;
        // 策略1：data-last-price 屬性
        const m1=html.match(/data-last-price="([\d.]+)"/);
        if(m1)price=num(m1[1]);
        // 策略2：Google Finance 價格 class
        if(!price){const m2=html.match(/class="YMlKec fxKbKc"[^>]*>([\d,]+\.?\d*)</);if(m2)price=num(m2[1].replace(/,/g,''));}
        // 策略3：JSON 結構資料
        if(!price){const m3=html.match(/"price"\s*:\s*"([\d.]+)"/);if(m3)price=num(m3[1]);}
        // 策略4：NT$ 符號旁邊的數字
        if(!price){const m4=html.match(/NT\$\s*([\d,]+\.?\d*)/);if(m4)price=num(m4[1].replace(/,/g,''));}
        // 策略5：通用數字模式（找合理範圍的台股價格）
        if(!price){
          const matches=[...html.matchAll(/>([\d,]+\.\d{2})</g)];
          for(const m of matches){
            const v=num(m[1].replace(/,/g,''));
            if(v&&v>1&&v<100000){price=v;break;}
          }
        }
        if(!price||price<=0)continue;
        const ms=getMarketState();
        console.log(`[Google] ✅ ${symbol}:${ex} ${price}`);
        return{price,previousClose:null,change:null,changePct:null,marketState:ms,source:'Google'};
      }catch(e){console.warn(`[Google] ${e.message}`);}
    }
  }
  return null;
}

// ── E. FinMind（token 授權，收盤後歷史資料）────────────────

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

// ── F. TWSE/TPEx OpenAPI 整批（最後備援）──────────────────

let _twseCache=null,_twseTs=0,_twseP=null;
async function _doLoadTwse(){
  for(const url of['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL','https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL']){
    try{
      const r=await timedFetch(url,12000);if(!r.ok)continue;
      const arr=await r.json();if(!Array.isArray(arr)||arr.length<50)continue;
      const map={};
      for(const item of arr){
        const code=String(item.Code??item['股票代號']??'').trim();
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
//  主報價函數（依來源設定 + 市場狀態智慧切換）
// ═══════════════════════════════════════════════════════

async function fetchBySource(symbol,src){
  switch(src){
    case 'mis':     return fetchMIS(symbol);
    case 'twse':    return fetchTWSEWeb(symbol);
    case 'yahoo':   return fetchYahooBackup(symbol);
    case 'google':  return fetchGoogleFinance(symbol);
    case 'finmind': return fetchFinMind(symbol);
    default:        return null;
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

  // ── 依使用者選擇決定優先順序 ──
  let priorities=[];
  if(src==='auto'){
    if(ms==='REGULAR'||ms==='POST'){
      // 開盤中：MIS 即時優先，失敗才切爬蟲
      priorities=['mis','twse','yahoo','google','finmind'];
    }else{
      // 收盤後：直接爬蟲，節省 MIS API 配額
      priorities=['twse','yahoo','finmind','google','mis'];
    }
  }else if(src==='twse'){
    priorities=['twse', ms==='REGULAR'?'mis':'yahoo', 'yahoo','finmind','google'];
  }else if(src==='yahoo'){
    priorities=['yahoo', ms==='REGULAR'?'mis':'twse', 'twse','finmind','google'];
  }else if(src==='google'){
    priorities=['google','yahoo', ms==='REGULAR'?'mis':'twse', 'twse','finmind'];
  }

  // 前兩個來源平行抓（加速）
  if(priorities.length>=2){
    const [r1,r2]=await Promise.allSettled([
      fetchBySource(symbol,priorities[0]),
      fetchBySource(symbol,priorities[1])
    ]);
    data=(r1.status==='fulfilled'?r1.value:null)??
         (r2.status==='fulfilled'?r2.value:null);
  }

  // 還是沒資料：依序試剩下的
  if(!data){
    for(const p of priorities.slice(2)){
      data=await fetchBySource(symbol,p);
      if(data?.price>0)break;
    }
  }

  // 最終備援：TWSE/TPEx OpenAPI 整批
  if(!data){
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
  data.marketState=ms; // 市場狀態永遠用台灣時間決定
  console.log(`[Quote] ✅ ${symbol}=${data.price} [${data.source}][${getMarketLabel(ms)}]`);
  quoteCache[symbol]={data,ts:Date.now()};
  return data;
}

// ═══════════════════════════════════════════════════════
//  來源選擇器 UI
// ═══════════════════════════════════════════════════════

const SOURCE_NOTES={
  auto:{REGULAR:'開盤中：MIS 即時 → 爬蟲備援（自動切換）',CLOSING:'收盤中：爬蟲取最新收盤價',POST:'盤後零股：MIS 即時 → 爬蟲備援',PRE:'盤前：爬蟲取昨日收盤價',CLOSED:'收盤後：爬蟲取收盤價，節省 API 配額'},
  twse: {_:'使用台灣證交所官網，API 不足時切換 Yahoo / FinMind'},
  yahoo:{_:'使用 Yahoo 股市，失敗時切換 TWSE / FinMind'},
  google:{_:'使用 Google Finance（HTML 解析），失敗自動備援'}
};

function getSourceNote(src,ms){
  const map=SOURCE_NOTES[src];
  if(!map)return '';
  return map[ms]||map['_']||'';
}

function renderSourceSelector(){
  const src=state.priceSource||'auto';
  document.querySelectorAll('.source-btn').forEach(btn=>{
    btn.classList.toggle('active',btn.dataset.source===src);
  });
  const note=document.getElementById('sourceNote');
  if(note)note.textContent=getSourceNote(src,getMarketState());
}

function setSource(src){
  state.priceSource=src;
  saveState(state);
  Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
  renderSourceSelector();
  const labels={auto:'🤖 自動',twse:'🏛️ 證交所',yahoo:'📊 Yahoo',google:'🔍 Google'};
  showToast(`✅ 已切換：${labels[src]||src}`);
  refreshWatchlistPrices();
  refreshHoldingsPrices();
}

// ═══════════════════════════════════════════════════════
//  虛擬現金管理
// ═══════════════════════════════════════════════════════

function addVirtualCash(){
  const input=prompt('輸入充值金額（元）：','1000000');
  if(input===null)return;
  const amount=num(input.replace(/,/g,''));
  if(!amount||amount<=0||amount>1_000_000_000){alert('❌ 金額無效（請輸入 1～10億 之間）');return;}
  state.cash+=amount;
  saveState(state);
  renderDashboardQuick();
  showToast(`✅ 充值 ${formatMoney(amount)} 元，目前現金 ${formatMoney(state.cash)} 元`);
}

function setVirtualCash(){
  const input=prompt('設定虛擬現金金額（元）：',String(Math.round(state.cash)));
  if(input===null)return;
  const amount=num(input.replace(/,/g,''));
  if(!amount||amount<=0||amount>1_000_000_000){alert('❌ 金額無效');return;}
  state.cash=amount;
  saveState(state);
  renderDashboardQuick();
  showToast(`✅ 虛擬現金已設為 ${formatMoney(amount)} 元`);
}

// ═══════════════════════════════════════════════════════
//  Watchlist UI
// ═══════════════════════════════════════════════════════

function buildWatchRow(symbol,q){
  const price=q?.price??null;
  const chg=q?.change??null;
  const pct=q?.changePct??null;
  const ms=getMarketState();
  const label=getMarketLabel(ms);
  const src=q?.source?` <span style="font-size:.6rem;color:#8b949e;">[${q.source}]</span>`:'';
  const bcls=!q?'badge-wait':getMarketBadgeClass(ms);
  return`
    <td class="font-mono font-bold">${symbol}</td>
    <td>${formatPrice(price)}${src}</td>
    <td>
      ${chg!==null&&pct!==null
        ?`<div class="${chg>=0?'text-up':'text-down'}">${chg>=0?'+':''}${chg.toFixed(2)} (${pct>=0?'+':''}${pct.toFixed(2)}%)</div>`
        :'<div>—</div>'}
      <div class="mt-1"><span class="badge ${bcls}">${!q?'讀取中…':label}</span></div>
    </td>
    <td>
      <button class="text-xs text-blue-400 hover:underline mr-2" data-trade="${symbol}">操盤</button>
      <button class="text-xs text-red-500 hover:underline" data-remove="${symbol}">移除</button>
    </td>`;
}

function bindWatchlistEvents(){
  const tbody=document.getElementById('watchlistBody');
  tbody.querySelectorAll('[data-trade]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.trade;};});
  tbody.querySelectorAll('[data-remove]').forEach(btn=>{btn.onclick=()=>removeFromWatchlist(btn.dataset.remove);});
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
  for(const symbol of state.watchlist){
    const q=await fetchQuote(symbol);
    const tr=tbody.querySelector(`[data-symbol="${symbol}"]`);
    if(tr){tr.innerHTML=buildWatchRow(symbol,q);bindWatchlistEvents();}
  }
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
    showToast(`✅ 買入 ${symbol} ${shares} 股 @ ${price}，花費 ${formatMoney(total)} 元`);
  }else{
    const h=state.holdings[symbol];
    if(!h||h.shares<shares){msg.textContent='❌ 持股不足';return;}
    const proceeds=fee.amount-fee.total;
    state.realizedPnL+=proceeds-h.avgPrice*shares;state.cash+=proceeds;
    h.shares-=shares;if(h.shares===0)delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${shares} 股 @ ${price}，入帳 ${formatMoney(proceeds)} 元`);
  }
  state.history.unshift({time:new Date().toLocaleString('zh-TW'),symbol,side,shares,price,amount:fee.amount,fee:fee.total});
  if(!state.watchlist.includes(symbol)){state.watchlist.unshift(symbol);state.watchlist=[...new Set(state.watchlist)];}
  saveState(state);msg.textContent='';document.getElementById('tradePrice').value='';
  renderDashboardQuick();renderHistory();
  renderWatchlistImmediate();renderHoldingsImmediate();
  refreshWatchlistPrices();refreshHoldingsPrices();
}

// ═══════════════════════════════════════════════════════
//  Holdings
// ═══════════════════════════════════════════════════════

function buildHoldingRow(symbol,h,q){
  const price=(q?.price>0)?q.price:h.avgPrice;
  const mkt=price*h.shares;const pnl=mkt-h.avgPrice*h.shares;
  const ms=getMarketState();
  const cls=ms==='REGULAR'?'text-green-400':'text-gray-400';
  return`
    <td class="font-mono font-bold">${symbol}</td>
    <td>${h.shares} 股</td>
    <td>${formatPrice(h.avgPrice)}</td>
    <td>${formatPrice(price)}<span class="text-xs ${cls} ml-1">${q?getMarketLabel(ms):''}</span></td>
    <td class="${pnl>=0?'text-up':'text-down'}">${pnl>=0?'+':''}${formatMoney(pnl)}</td>
    <td><button class="text-xs text-blue-400 hover:underline" data-sell="${symbol}">快速賣出</button></td>`;
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
  tbody.querySelectorAll('[data-sell]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(total);
  return total;
}

async function refreshHoldingsPrices(){
  const tbody=document.getElementById('holdingsBody');let total=0;
  for(const symbol of Object.keys(state.holdings)){
    const h=state.holdings[symbol];const q=await fetchQuote(symbol);
    const tr=tbody.querySelector(`[data-hsymbol="${symbol}"]`);
    if(tr){
      tr.innerHTML=buildHoldingRow(symbol,h,q);
      tbody.querySelectorAll('[data-sell]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
    }
    total+=((q?.price>0)?q.price:h.avgPrice)*h.shares;
  }
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(total);
  renderDashboardQuick(total);
}

// ─── History ───────────────────────────────────────────

function renderHistory(){
  const tbody=document.getElementById('tradeHistoryBody');const empty=document.getElementById('historyEmpty');
  tbody.innerHTML='';
  if(!state.history.length){empty.style.display='';return;}
  empty.style.display='none';
  state.history.slice(0,50).forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="text-xs text-gray-500">${r.time}</td>
      <td class="font-mono font-bold">${r.symbol}</td>
      <td><span class="badge ${r.side==='buy'?'badge-up':'badge-down'}">${r.side==='buy'?'買入':'賣出'}</span></td>
      <td>${r.shares} 股</td><td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(r.fee)}</td>`;
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
}

// ─── Backup/Restore ────────────────────────────────────

function exportDataToJson(){
  const payload={exportedAt:new Date().toISOString(),version:'1.9',data:loadState()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
  const a=document.createElement('a');a.href=url;a.download=`stock_backup_${today}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
function scheduleNextRefresh(){
  if(_refreshTimer)clearTimeout(_refreshTimer);
  const interval=getRefreshInterval();
  _refreshTimer=setTimeout(async()=>{
    Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
    _twseCache=null;_twseTs=0;_tpexCache=null;_tpexTs=0;
    renderSourceSelector(); // 更新來源說明（市場狀態可能改變）
    await refreshWatchlistPrices();
    await refreshHoldingsPrices();
    scheduleNextRefresh();
  },interval);
  console.log(`[排程] ${getMarketLabel(getMarketState())} → ${interval/1000}s 後更新`);
}

// ─── Console 診斷 ──────────────────────────────────────

window.testAPI=async function(symbol='2330'){
  symbol=normalizeSymbol(symbol);
  console.log(`\n===== 診斷 ${symbol} | ${getMarketLabel(getMarketState())} =====`);
  console.log('[A] MIS:');    console.log(await fetchMIS(symbol)||'FAIL');
  console.log('[B] TWSE-Web:');console.log(await fetchTWSEWeb(symbol)||'FAIL');
  console.log('[C] Yahoo:');  console.log(await fetchYahooBackup(symbol)||'FAIL');
  console.log('[D] Google:'); console.log(await fetchGoogleFinance(symbol)||'FAIL');
  console.log('[E] FinMind:');console.log(await fetchFinMind(symbol)||'FAIL');
  console.log(`=====\n`);
};

// ═══════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded',()=>{
  updateLastSavedLabel();

  // 按鈕綁定
  document.getElementById('btnAddWatch').addEventListener('click',addToWatchlist);
  document.getElementById('btnBuy').addEventListener('click',()=>executeTrade('buy'));
  document.getElementById('btnSell').addEventListener('click',()=>executeTrade('sell'));
  document.getElementById('btnExport').addEventListener('click',exportDataToJson);
  document.getElementById('btnReset').addEventListener('click',resetAllData);
  document.getElementById('importFile').addEventListener('change',importDataFromJson);
  document.getElementById('btnAddCash').addEventListener('click',addVirtualCash);
  document.getElementById('btnSetCash').addEventListener('click',setVirtualCash);

  // 來源選擇按鈕
  document.querySelectorAll('.source-btn').forEach(btn=>{
    btn.addEventListener('click',()=>setSource(btn.dataset.source));
  });

  // 鍵盤快捷
  document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')addToWatchlist();});
  document.getElementById('tradeSymbol').addEventListener('blur',()=>{
    document.getElementById('tradeSymbol').value=normalizeSymbol(document.getElementById('tradeSymbol').value);
  });
  document.getElementById('tradeQty').addEventListener('keydown',e=>{if(e.key==='Enter')executeTrade('buy');});

  // 時鐘每秒更新
  updateClock();setInterval(updateClock,1000);

  // 初始渲染
  renderDashboardQuick(0);
  renderHoldingsImmediate();
  renderHistory();
  renderWatchlistImmediate();
  renderSourceSelector();

  // 背景取價
  refreshWatchlistPrices().then(()=>refreshHoldingsPrices());

  // 智慧排程
  scheduleNextRefresh();

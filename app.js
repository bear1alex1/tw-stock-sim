const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v1';
const CACHE_TTL    = 120_000;

let state      = loadState();
const quoteCache = {};

const _a = '310e6e442e6b38367d5f32090246751d0770333750711b2b1b1e6e3d1e49306e7c5f327b7a125d3e206a210d5e7f122d3d3a4e35327d106f457b01722d396735327e3d304a7b022d643a5d3d387a1709486c200832167325227c10155b6c2f042d3a7332386921384a7f11353d2d734523522e285b7911083d2d7332327e2e19416c20252c2663103f6a2e33417a150c2215773d387a1433457f122d3d394e313e7d131e477b12132c3b4e317f7e10150b181d753746161c114b26386a524b303734692b2e4703145b5b2e1d381e42363c593631765e392f181c57073c';
const _b = [84,119,36,116,75,51,121,95,50,54,120,66];
function _r(){try{return(_a.match(/.{2}/g)||[]).map((h,i)=>String.fromCharCode(parseInt(h,16)^_b[i%_b.length])).join('')}catch{return''}}

// ── Utilities ──────────────────────────────────────────────

function num(v){
  if(v===null||v===undefined)return null;
  const s=String(v).replace(/,/g,'').replace(/＋/g,'+').replace(/▲/g,'').replace(/▼/g,'-').trim();
  if(!s||/^[-–]+$/.test(s)||s==='---'||s==='N/A')return null;
  const n=parseFloat(s);
  return isFinite(n)?n:null;
}
function normalizeSymbol(s){return String(s||'').trim().toUpperCase().replace(/\.TWO?$/i,'');}
function formatMoney(v){return Math.round(Number(v)||0).toLocaleString('zh-TW');}
function formatPrice(v){const n=num(v);return(n!==null&&n>0)?n.toFixed(2):'—';}

async function timedFetch(url, ms=8000){
  const ctrl=new AbortController();
  const tid=setTimeout(()=>ctrl.abort(),ms);
  try{const r=await fetch(url,{cache:'no-store',signal:ctrl.signal});clearTimeout(tid);return r;}
  catch(e){clearTimeout(tid);throw e;}
}

function getToday(){return new Date().toISOString().slice(0,10);}
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().slice(0,10);}

// ── State ──────────────────────────────────────────────────

function getEmptyState(){return{cash:INITIAL_CASH,holdings:{},history:[],watchlist:[],realizedPnL:0,savedAt:null};}

function loadState(){
  try{
    const raw=localStorage.getItem(STORAGE_KEY);
    if(!raw)return getEmptyState();
    const p=JSON.parse(raw);
    return{
      cash:       num(p.cash)??INITIAL_CASH,
      holdings:   (p.holdings&&typeof p.holdings==='object')?p.holdings:{},
      history:    Array.isArray(p.history)?p.history:[],
      watchlist:  Array.isArray(p.watchlist)?[...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))]:[],
      realizedPnL:num(p.realizedPnL)??0,
      savedAt:    p.savedAt||null
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

// ══════════════════════════════════════════════════════════
//  來源 1 ── FinMind（主力）
// ══════════════════════════════════════════════════════════

async function fetchFinMind(symbol){
  const urls=[
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}&token=${encodeURIComponent(_r())}`,
    `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&stock_id=${symbol}&start_date=${daysAgo(14)}`
  ];
  for(const url of urls){
    try{
      const r=await timedFetch(url,10000);
      if(!r.ok){console.warn(`[FM] HTTP ${r.status}`);continue;}
      const json=await r.json();
      if(json.status!==200){console.warn(`[FM] API status=${json.status} msg=${json.msg}`);continue;}
      const data=json.data;
      if(!Array.isArray(data)||!data.length){console.warn('[FM] 空資料');continue;}
      data.sort((a,b)=>a.date.localeCompare(b.date));
      const latest=data[data.length-1];
      const close=num(latest.close);
      if(!close||close<=0){console.warn('[FM] close無效:',latest.close);continue;}
      const spread=num(latest.spread);
      const prev=spread!==null?parseFloat((close-spread).toFixed(2)):(data.length>=2?num(data[data.length-2].close):null);
      const change=prev!==null?parseFloat((close-prev).toFixed(2)):null;
      const changePct=prev?parseFloat((change/prev*100).toFixed(2)):null;
      console.log(`[FM] ✅ ${symbol} ${close} (${latest.date})`);
      return{price:close,previousClose:prev,change,changePct,marketState:'CLOSED',source:'FinMind'};
    }catch(e){console.warn(`[FM] ❌ ${e.message}`);}
  }
  return null;
}

// ══════════════════════════════════════════════════════════
//  來源 2 ── TWSE OpenAPI（上市整批）
// ══════════════════════════════════════════════════════════

let _twseCache=null, _twseTs=0, _twseP=null;

async function _doLoadTwse(){
  const endpoints=[
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL'
  ];
  for(const url of endpoints){
    try{
      const r=await timedFetch(url,12000);
      if(!r.ok)continue;
      const arr=await r.json();
      if(!Array.isArray(arr)||arr.length<50)continue;
      console.log('[TWSE] 欄位範例:',JSON.stringify(arr[0]));
      const map={};
      for(const item of arr){
        const code=String(item.Code??item['股票代號']??item['證券代號']??'').trim();
        const close=num(item.ClosingPrice)??num(item['收盤價'])??num(item.Close)??num(item.close)??null;
        const prev=num(item.OpeningPrice)??null;
        const changeRaw=num(item.Change)??num(item['漲跌價差'])??null;
        if(code&&close&&close>0){
          const prevClose=changeRaw!==null?parseFloat((close-changeRaw).toFixed(2)):null;
          map[code]={close,prevClose,change:changeRaw,changePct:prevClose&&changeRaw?parseFloat((changeRaw/prevClose*100).toFixed(2)):null};
        }
      }
      const cnt=Object.keys(map).length;
      if(cnt>100){console.log(`[TWSE] ✅ ${cnt} 支 from ${url}`);return map;}
    }catch(e){console.warn('[TWSE] ❌',e.message);}
  }
  return null;
}

function loadTwse(){
  if(_twseCache&&Date.now()-_twseTs<CACHE_TTL)return Promise.resolve(_twseCache);
  if(!_twseP){
    _twseP=_doLoadTwse().then(m=>{
      if(m){_twseCache=m;_twseTs=Date.now();}
      _twseP=null;return _twseCache;
    });
  }
  return _twseP;
}

// ══════════════════════════════════════════════════════════
//  來源 3 ── TPEx OpenAPI（上櫃整批）
// ══════════════════════════════════════════════════════════

let _tpexCache=null, _tpexTs=0, _tpexP=null;

async function _doLoadTpex(){
  try{
    const r=await timedFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',12000);
    if(!r.ok)throw new Error('HTTP '+r.status);
    const arr=await r.json();
    if(!Array.isArray(arr)||arr.length<10)throw new Error('empty');
    console.log('[TPEx] 欄位範例:',JSON.stringify(arr[0]));
    const map={};
    for(const item of arr){
      const code=String(item.SecuritiesCompanyCode??item['代號']??'').trim();
      const close=num(item.Close)??num(item['收盤'])??num(item['收盤價'])??null;
      if(code&&close&&close>0)map[code]={close,prevClose:null,change:null,changePct:null};
    }
    console.log(`[TPEx] ✅ ${Object.keys(map).length} 支`);
    return map;
  }catch(e){console.warn('[TPEx] ❌',e.message);return null;}
}

function loadTpex(){
  if(_tpexCache&&Date.now()-_tpexTs<CACHE_TTL)return Promise.resolve(_tpexCache);
  if(!_tpexP){
    _tpexP=_doLoadTpex().then(m=>{
      if(m){_tpexCache=m;_tpexTs=Date.now();}
      _tpexP=null;return _tpexCache;
    });
  }
  return _tpexP;
}

// ══════════════════════════════════════════════════════════
//  來源 4 ── TWSE MIS 即時 API（需 proxy）
// ══════════════════════════════════════════════════════════

async function fetchMIS(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u=>`https://thingproxy.freeboard.io/fetch/${u}`
  ];
  const EXCH=['tse','otc'];
  for(const ex of EXCH){
    const target=`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${symbol}.tw&json=1&delay=0`;
    for(const makeProxy of PROXIES){
      try{
        const r=await timedFetch(makeProxy(target),6000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const item=json?.msgArray?.[0];
        if(!item?.c)continue;
        const z=(item.z&&item.z!=='-'&&item.z!=='0'&&item.z!=='--')?num(item.z):null;
        const y=num(item.y);
        const price=z??y;
        if(!price||price<=0)continue;
        const change=y?parseFloat((price-y).toFixed(2)):null;
        const changePct=y?parseFloat((change/y*100).toFixed(2)):null;
        console.log(`[MIS] ✅ ${symbol}(${ex}) ${price}`);
        return{price,previousClose:y,change,changePct,marketState:z?'REGULAR':'CLOSED',source:'MIS'};
      }catch(e){console.warn(`[MIS] ${ex} proxy fail: ${e.message}`);}
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
//  來源 5 ── Yahoo Finance（proxy 備援）
// ══════════════════════════════════════════════════════════

async function fetchYahoo(symbol){
  const PROXIES=[
    u=>`https://corsproxy.io/?${encodeURIComponent(u)}`,
    u=>`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
  ];
  const SUFFIXES=['.TW','.TWO'];
  for(const sfx of SUFFIXES){
    const target=`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
    for(const makeProxy of PROXIES){
      try{
        const r=await timedFetch(makeProxy(target),7000);
        if(!r.ok)continue;
        const text=await r.text();
        if(!text||text.trim().startsWith('<'))continue;
        const json=JSON.parse(text);
        const result=json?.chart?.result?.[0];
        if(!result)continue;
        const meta=result.meta;
        const closes=(result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
        const mState=String(meta?.marketState||'CLOSED').toUpperCase();
        const regPx=num(meta?.regularMarketPrice);
        const prev=num(meta?.regularMarketPreviousClose)??num(meta?.previousClose);
        const last=closes.length?closes[closes.length-1]:null;
        const price=mState==='REGULAR'?(regPx??last):(last??regPx);
        if(!price||price<=0)continue;
        const base=prev??(closes.length>=2?closes[closes.length-2]:null);
        const change=base?parseFloat((price-base).toFixed(2)):null;
        const changePct=base?parseFloat((change/base*100).toFixed(2)):null;
        console.log(`[Yahoo] ✅ ${symbol}${sfx} ${price}`);
        return{price,previousClose:base,change,changePct,marketState:mState,source:'Yahoo'};
      }catch(_){}
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
//  主報價函數（5層並行）
// ══════════════════════════════════════════════════════════

async function fetchQuote(symbol){
  symbol=normalizeSymbol(symbol);
  if(!symbol)return null;
  const cached=quoteCache[symbol];
  if(cached&&Date.now()-cached.ts<CACHE_TTL)return cached.data;

  const [fmR,twseR,tpexR,misR,yhR]=await Promise.allSettled([
    fetchFinMind(symbol),
    loadTwse(),
    loadTpex(),
    fetchMIS(symbol),
    fetchYahoo(symbol)
  ]);

  const fm  =fmR.status==='fulfilled'?fmR.value:null;
  const twse=twseR.status==='fulfilled'?twseR.value:null;
  const tpex=tpexR.status==='fulfilled'?tpexR.value:null;
  const mis =misR.status==='fulfilled'?misR.value:null;
  const yh  =yhR.status==='fulfilled'?yhR.value:null;

  let data=null;

  if(mis?.price>0&&mis.marketState==='REGULAR'){
    data=mis;
  } else if(fm?.price>0){
    data=fm;
  } else if(twse?.[symbol]?.close>0){
    const d=twse[symbol];
    data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:'CLOSED',source:'TWSE'};
  } else if(tpex?.[symbol]?.close>0){
    const d=tpex[symbol];
    data={price:d.close,previousClose:d.prevClose,change:d.change,changePct:d.changePct,marketState:'CLOSED',source:'TPEx'};
  } else if(mis?.price>0){
    data=mis;
  } else if(yh?.price>0){
    data=yh;
  }

  if(!data||data.price<=0){
    console.error(`[Quote] ❌ ${symbol} 所有來源失敗`);
    return null;
  }
  console.log(`[Quote] ✅ ${symbol} = ${data.price} [${data.source}]`);
  quoteCache[symbol]={data,ts:Date.now()};
  return data;
}

// F12 Console 診斷工具
window.testAPI=async function(symbol='2330'){
  symbol=normalizeSymbol(symbol);
  console.log(`\n===== 診斷 ${symbol} =====`);
  console.log('[1] FinMind:'); const fm=await fetchFinMind(symbol); console.log(fm||'FAIL');
  console.log('[2] TWSE bulk:'); const tw=await _doLoadTwse(); console.log(tw?.[symbol]||'FAIL');
  console.log('[3] TPEx bulk:'); const tp=await _doLoadTpex(); console.log(tp?.[symbol]||'FAIL');
  console.log('[4] MIS:');  const ms=await fetchMIS(symbol);  console.log(ms||'FAIL');
  console.log('[5] Yahoo:'); const yh=await fetchYahoo(symbol); console.log(yh||'FAIL');
  console.log(`===== 結束 =====\n`);
};

// ── Watchlist ──────────────────────────────────────────────

function buildWatchRow(symbol,q){
  const price=q?.price??null;
  const chg=q?.change??null;
  const pct=q?.changePct??null;
  const src=q?.source?` <span style="font-size:.6rem;color:#8b949e;">[${q.source}]</span>`:'';
  const label=!q?'讀取中…':q.marketState==='REGULAR'?'盤中':'收盤';
  const bcls=!q?'badge-wait':(chg??0)>=0?'badge-up':'badge-down';
  return `
    <td class="font-mono font-bold">${symbol}</td>
    <td>${formatPrice(price)}${src}</td>
    <td>
      ${chg!==null&&pct!==null
        ?`<div class="${chg>=0?'text-up':'text-down'}">${chg>=0?'+':''}${chg.toFixed(2)} (${pct>=0?'+':''}${pct.toFixed(2)}%)</div>`
        :'<div>—</div>'}
      <div class="mt-1"><span class="badge ${bcls}">${label}</span></div>
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
    const tr=document.createElement('tr');
    tr.dataset.symbol=symbol;
    tr.innerHTML=buildWatchRow(symbol,cached);
    tbody.appendChild(tr);
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
  delete quoteCache[symbol];
  saveState(state);
  renderWatchlistImmediate();
}

// ── Trade ──────────────────────────────────────────────────

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
    const h=state.holdings[symbol];
    const ns=h.shares+shares;
    h.avgPrice=((h.avgPrice*h.shares)+(price*shares))/ns;
    h.shares=ns;
    showToast(`✅ 買入 ${symbol} ${shares} 股 @ ${price}，花費 ${formatMoney(total)} 元`);
  }else{
    const h=state.holdings[symbol];
    if(!h||h.shares<shares){msg.textContent='❌ 持股不足';return;}
    const proceeds=fee.amount-fee.total;
    state.realizedPnL+=proceeds-h.avgPrice*shares;
    state.cash+=proceeds;
    h.shares-=shares;
    if(h.shares===0)delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${shares} 股 @ ${price}，入帳 ${formatMoney(proceeds)} 元`);
  }
  state.history.unshift({time:new Date().toLocaleString('zh-TW'),symbol,side,shares,price,amount:fee.amount,fee:fee.total});
  if(!state.watchlist.includes(symbol)){state.watchlist.unshift(symbol);state.watchlist=[...new Set(state.watchlist)];}
  saveState(state);
  msg.textContent='';
  document.getElementById('tradePrice').value='';
  renderDashboardQuick();
  renderHistory();
  renderWatchlistImmediate();
  renderHoldingsImmediate();
  refreshWatchlistPrices();
  refreshHoldingsPrices();
}

// ── Holdings ───────────────────────────────────────────────

function buildHoldingRow(symbol,h,q){
  const price=(q?.price>0)?q.price:h.avgPrice;
  const mkt=price*h.shares;
  const pnl=mkt-h.avgPrice*h.shares;
  const stateLabel=q?(q.marketState==='REGULAR'?'盤中':'收盤'):'';
  const stateClass=q?.marketState==='REGULAR'?'text-green-400':'text-gray-400';
  return `
    <td class="font-mono font-bold">${symbol}</td>
    <td>${h.shares} 股</td>
    <td>${formatPrice(h.avgPrice)}</td>
    <td>${formatPrice(price)}<span class="text-xs ${stateClass} ml-1">${stateLabel}</span></td>
    <td class="${pnl>=0?'text-up':'text-down'}">${pnl>=0?'+':''}${formatMoney(pnl)}</td>
    <td><button class="text-xs text-blue-400 hover:underline" data-sell="${symbol}">快速賣出</button></td>`;
}

function renderHoldingsImmediate(){
  const tbody=document.getElementById('holdingsBody');
  const empty=document.getElementById('holdingsEmpty');
  tbody.innerHTML='';
  const symbols=Object.keys(state.holdings);
  if(!symbols.length){empty.style.display='';document.getElementById('holdingsValue').textContent='$ 0';return 0;}
  empty.style.display='none';
  let total=0;
  for(const symbol of symbols){
    const h=state.holdings[symbol];
    const q=quoteCache[symbol]?.data??null;
    const price=(q?.price>0)?q.price:h.avgPrice;
    total+=price*h.shares;
    const tr=document.createElement('tr');
    tr.dataset.hsymbol=symbol;
    tr.innerHTML=buildHoldingRow(symbol,h,q);
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-sell]').forEach(btn=>{btn.onclick=()=>{document.getElementById('tradeSymbol').value=btn.dataset.sell;};});
  document.getElementById('holdingsValue').textContent='$ '+formatMoney(total);
  return total;
}

async function refreshHoldingsPrices(){
  const tbody=document.getElementById('holdingsBody');
  let total=0;
  for(const symbol of Object.keys(state.holdings)){
    const h=state.holdings[symbol];
    const q=await fetchQuote(symbol);
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

function renderHistory(){
  const tbody=document.getElementById('tradeHistoryBody');
  const empty=document.getElementById('historyEmpty');
  tbody.innerHTML='';
  if(!state.history.length){empty.style.display='';return;}
  empty.style.display='none';
  state.history.slice(0,50).forEach(r=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td class="text-xs text-gray-500">${r.time}</td>
      <td class="font-mono font-bold">${r.symbol}</td>
      <td><span class="badge ${r.side==='buy'?'badge-up':'badge-down'}">${r.side==='buy'?'買入':'賣出'}</span></td>
      <td>${r.shares} 股</td>
      <td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(r.fee)}</td>`;
    tbody.appendChild(tr);
  });
}

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

function exportDataToJson(){
  const payload={exportedAt:new Date().toISOString(),version:'1.7',data:loadState()};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
  const a=document.createElement('a');
  a.href=url;a.download=`stock_backup_${today}.json`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast(`💾 備份已下載：stock_backup_${today}.json`);
}

function importDataFromJson(event){
  const file=event.target.files?.[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=(e)=>{
    try{
      const parsed=JSON.parse(e.target.result);
      const imported=parsed.data||parsed;
      if(!imported||typeof imported.cash==='undefined'||!Array.isArray(imported.watchlist)){alert('❌ 無效的備份檔案格式');return;}
      imported.watchlist=[...new Set(imported.watchlist.map(normalizeSymbol).filter(Boolean))];
      localStorage.setItem(STORAGE_KEY,JSON.stringify(imported));
      showToast('✅ 備份載入成功！正在重新整理…');
      setTimeout(()=>location.reload(),1000);
    }catch(err){alert('❌ JSON 解析失敗：'+err.message);}
    finally{event.target.value='';}
  };
  reader.readAsText(file,'utf-8');
}

function resetAllData(){
  if(!confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？'))return;
  localStorage.removeItem(STORAGE_KEY);location.reload();
}

function showToast(msg){
  const el=document.getElementById('toast');if(!el)return;
  el.textContent=msg;el.style.display='block';
  clearTimeout(showToast._t);
  showToast._t=setTimeout(()=>{el.style.display='none';},3500);
}

document.addEventListener('DOMContentLoaded',()=>{
  updateLastSavedLabel();
  document.getElementById('btnAddWatch').addEventListener('click',addToWatchlist);
  document.getElementById('btnBuy').addEventListener('click',()=>executeTrade('buy'));
  document.getElementById('btnSell').addEventListener('click',()=>executeTrade('sell'));
  document.getElementById('btnExport').addEventListener('click',exportDataToJson);
  document.getElementById('btnReset').addEventListener('click',resetAllData);
  document.getElementById('importFile').addEventListener('change',importDataFromJson);
  document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Enter')addToWatchlist();});
  document.getElementById('tradeSymbol').addEventListener('blur',()=>{document.getElementById('tradeSymbol').value=normalizeSymbol(document.getElementById('tradeSymbol').value);});
  document.getElementById('tradeQty').addEventListener('keydown',e=>{if(e.key==='Enter')executeTrade('buy');});

  renderDashboardQuick(0);
  renderHoldingsImmediate();
  renderHistory();
  renderWatchlistImmediate();
  refreshWatchlistPrices();
  refreshHoldingsPrices();

  setInterval(()=>{
    Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
    _twseCache=null;_twseTs=0;
    _tpexCache=null;_tpexTs=0;
    refreshWatchlistPrices();
    refreshHoldingsPrices();
  },120_000);
});

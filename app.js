const APP_VERSION = '3.9.0';   // ← 只改這裡就能更版

// ═══════════════════════════════════════════════════════
//  台股虛擬操盤系統 v3.9.3  |  SPA分頁 + Firebase雲端 + K線
// ═══════════════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v2';

let state = loadState();
const quoteCache    = {};
const stockNameCache = {};   // { '2330': '台積電', ... }
const stockMetaCache = {};
let _stockInfoLoaded = false;
let _stockInfoPromise = null;
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

function getStockMeta(symbol){ return stockMetaCache[normalizeSymbol(symbol)]||{}; }
function getSymbolMatches(keyword, limit=8){
  const q=normalizeSymbol(keyword||'');
  if(!q)return [];
  const items=Object.keys(stockNameCache).filter(function(code){
    const name=getStockName(code)||'';
    return code.startsWith(q)||name.indexOf(q)>=0;
  }).sort(function(a,b){
    const ae=a===q?0:a.startsWith(q)?1:2;
    const be=b===q?0:b.startsWith(q)?1:2;
    return ae-be || a.localeCompare(b);
  }).slice(0,limit);
  return items.map(function(code){
    const meta=getStockMeta(code);
    return {code:code,name:getStockName(code)||'',industry:meta.industry_category||meta.type||''};
  });
}
function renderSymbolHint(inputId, hintId){
  const input=document.getElementById(inputId);
  const hint=document.getElementById(hintId);
  if(!input||!hint)return;
  const symbol=normalizeSymbol(input.value||'');
  if(!symbol){
    hint.textContent='請輸入股票代號';
    hint.classList.remove('strong');
    return;
  }
  const name=getStockName(symbol)||'';
  if(name){
    hint.textContent=symbol+' '+name;
    hint.classList.add('strong');
    return;
  }
  hint.textContent=symbol+' 載入名稱中…';
  hint.classList.add('strong');
  fetchChineseName(symbol).then(function(){
    const h=document.getElementById(hintId), i=document.getElementById(inputId);
    if(!h||!i)return;
    const s=normalizeSymbol(i.value||'');
    if(!s)return;
    const n=getStockName(s)||'';
    h.textContent=n?(s+' '+n):(s+' 查無名稱');
  });
}
function hideSymbolSuggest(suggestId){
  const box=document.getElementById(suggestId);
  if(box){box.innerHTML='';box.classList.remove('show');}
}
function showSymbolSuggest(inputId, suggestId, hintId){
  const input=document.getElementById(inputId);
  const box=document.getElementById(suggestId);
  if(!input||!box)return;
  const q=normalizeSymbol(input.value||'');
  renderSymbolHint(inputId,hintId);
  if(!q){hideSymbolSuggest(suggestId);return;}
  if(!_stockInfoLoaded)preloadStockNames();
  const matches=getSymbolMatches(q,6);
  if(!matches.length){
    box.innerHTML='';
    box.classList.remove('show');
    return;
  }
  box.innerHTML=matches.map(function(it){
    return '<div class="symbol-suggest-item" data-fill-for="'+inputId+'" data-code="'+it.code+'">'
      +'<span class="symbol-suggest-code">'+it.code+'</span>'
      +'<span class="symbol-suggest-name">'+(it.name||'—')+'</span>'
      +(it.industry?'<span class="symbol-suggest-meta">'+it.industry+'</span>':'')
      +'</div>';
  }).join('');
  box.classList.add('show');
  box.querySelectorAll('[data-fill-for]').forEach(function(item){
    item.onclick=function(){
      input.value=item.dataset.code;
      hideSymbolSuggest(suggestId);
      renderSymbolHint(inputId,hintId);
      if(inputId==='aiSymbol')generateAIReport(item.dataset.code);
      if(inputId==='scenarioSymbol')calculateScenarioProfit();
      if(inputId==='tradeSymbol')updateFeePreview();
    };
  });
}
function bindSymbolAutocomplete(inputId, suggestId, hintId){
  const input=document.getElementById(inputId);
  if(!input)return;
  input.addEventListener('focus',function(){showSymbolSuggest(inputId,suggestId,hintId);});
  input.addEventListener('input',function(){
    input.value=normalizeSymbol(input.value||'');
    showSymbolSuggest(inputId,suggestId,hintId);
  });
  input.addEventListener('blur',function(){
    input.value=normalizeSymbol(input.value||'');
    renderSymbolHint(inputId,hintId);
    setTimeout(function(){hideSymbolSuggest(suggestId);},180);
  });
}
function refreshAllSymbolHints(){
  [['tradeSymbol','tradeSymbolHint'],['searchInput','searchInputHint'],['aiSymbol','aiSymbolHint'],['scenarioSymbol','scenarioSymbolName']].forEach(function(pair){
    if(document.getElementById(pair[0]))renderSymbolHint(pair[0],pair[1]);
  });
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
  return{cash:INITIAL_CASH,holdings:{},history:[],realizedTrades:[],assetHistory:[],watchlist:[],realizedPnL:0,feeDiscount:0.6,priceSource:'auto',alerts:{},dividendChecked:{},screenHistory:[],screenCustomList:'',savedAt:null};
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
      screenHistory: Array.isArray(p.screenHistory)?p.screenHistory:[],
      screenCustomList: typeof p.screenCustomList==='string'?p.screenCustomList:'',
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

function isETF(symbol){
  const s=normalizeSymbol(symbol);
  if(!s)return false;
  const meta=stockMetaCache[s]||{};
  const pool=[meta.stock_name||'',meta.industry_category||'',meta.type||'',getStockName(s)||''].join(' ');
  if(/^00\d{2,}$/.test(s))return true;
  return /ETF|指數股票型|槓桿|反向/i.test(pool);
}
function getSellTaxRate(symbol){ return isETF(symbol)?0.001:0.003; }
function calcFee(price,shares,side,symbol){
  symbol=symbol||'';
  const amount=price*shares;
  const discount=state?.feeDiscount??0.6;
  const broker=Math.floor(amount*0.001425*discount);
  const tax=side==='sell'?Math.floor(amount*getSellTaxRate(symbol)):0;
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
  const nameDiv='<div data-name="'+symbol+'" style="font-size:.72rem;color:'+(name?'#8b949e':'#555')+';margin-top:1px;">'+(name||'—')+'</div>';
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
  fetchChineseName(symbol);
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
  const fee=calcFee(price,shares,side,symbol);
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
  fetchChineseName(symbol);
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
        const nameDiv=tr.querySelector('[data-name]');
        if(nameDiv){
          const cached=stockNameCache[symbol];
          if(cached&&!/^—+$/.test(cached)&&nameDiv.textContent!==cached){
            nameDiv.textContent=cached;
            nameDiv.style.color='#8b949e';
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
  if(_stockInfoLoaded)return;
  if(_stockInfoPromise)return _stockInfoPromise;
  _stockInfoPromise=(async function(){
    try{
      var url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&token='+encodeURIComponent(_r());
      var r=await timedFetch(url,12000);
      if(!r.ok)throw new Error('HTTP '+r.status);
      var j=await r.json();
      var arr=(j&&j.data)||[];
      var cnt=0;
      for(var i=0;i<arr.length;i++){
        var it=arr[i]||{};
        var code=normalizeSymbol(String(it.stock_id||it.stockId||'')); 
        var name=String(it.stock_name||it.stockName||it['stock_name']||''). trim();
        if(!code||!name)continue;
        stockNameCache[code]=name;
        stockMetaCache[code]={
          stock_id:code,stock_name:name,
          industry_category:String(it.industry_category||it.industryCategory||''). trim(),
          type:String(it.type||it.market||''). trim()
        };
        cnt++;
      }
      _stockInfoLoaded=cnt>100;
      console.log('[FinMind-StockInfo] loaded '+cnt+' symbols');
      if(cnt>0){
        renderWatchlistImmediate();
        renderHoldingsImmediate();
        if(typeof renderHoldingsOverview==='function')renderHoldingsOverview();
        if(typeof renderAISymbolOptions==='function')renderAISymbolOptions();
        if(typeof renderScenarioSymbolOptions==='function')renderScenarioSymbolOptions();
        if(typeof renderScenarioHoldingOptions==='function')renderScenarioHoldingOptions();
        refreshAllSymbolHints();
      }
    }catch(e){
      console.warn('[FinMind-StockInfo]',e.message);
    }finally{
      _stockInfoPromise=null;
    }
  })();
  return _stockInfoPromise;
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
function _updateNameInDOM(symbol){
  var name=getStockName(symbol);
  if(!name)return;
  var wlBody=document.getElementById('watchlistBody');
  if(wlBody){
    var tr=wlBody.querySelector('[data-symbol="'+symbol+'"]');
    if(tr){var nd=tr.querySelector('[data-name]');if(nd)nd.textContent=name;}
  }
  var hlBody=document.getElementById('holdingsBody');
  if(hlBody){
    var tr2=hlBody.querySelector('[data-hsymbol="'+symbol+'"]');
    if(tr2){var nd2=tr2.querySelector('[data-hname]');if(nd2)nd2.textContent=name;}
  }
}
async function fetchChineseName(symbol){
  symbol=normalizeSymbol(symbol||"");
  if(!symbol)return null;
  if(stockNameCache[symbol]&&/[\u4e00-\u9fff]/.test(stockNameCache[symbol]))return stockNameCache[symbol];
  if(_nameReqSet[symbol])return null;
  _nameReqSet[symbol]=true;
  try{
    if(!_stockInfoLoaded)await preloadStockNames();
    if(stockNameCache[symbol]&&/[\u4e00-\u9fff]/.test(stockNameCache[symbol])){
      _updateNameInDOM(symbol);
      return stockNameCache[symbol];
    }
    var url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&stock_id='+encodeURIComponent(symbol)+'&token='+encodeURIComponent(_r());
    var r=await timedFetch(url,8000);
    if(r.ok){
      var j=await r.json();
      var arr=(j&&j.data)||[];
      if(arr.length){
        var it=arr[0]||{};
        var name=String(it.stock_name||it.stockName||it['stock_name']||''). trim();
        if(name){
          stockNameCache[symbol]=name;
          stockMetaCache[symbol]={stock_id:symbol,stock_name:name,
            industry_category:String(it.industry_category||it.industryCategory||''). trim(),
            type:String(it.type||it.market||''). trim()};
          _updateNameInDOM(symbol);
          return name;
        }
      }
    }
  }catch(e){ console.warn('[FinMind-Name]',e.message); }
  finally{ _nameReqSet[symbol]=false; }
  return null;
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
  const fB=calcFee(price,shares,'buy',symbol);const fS=calcFee(price,shares,'sell',symbol);
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
  if(page==='aiReport'){initAIReportPage();}
};

// ═══════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════




function calcRSI(values, period=14){
  if(!Array.isArray(values)||values.length<period+1)return null;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const diff=(num(values[i])||0)-(num(values[i-1])||0);
    if(diff>=0)gains+=diff; else losses+=Math.abs(diff);
  }
  let avgGain=gains/period, avgLoss=losses/period;
  for(let i=period+1;i<values.length;i++){
    const diff=(num(values[i])||0)-(num(values[i-1])||0);
    const gain=diff>0?diff:0;
    const loss=diff<0?Math.abs(diff):0;
    avgGain=((avgGain*(period-1))+gain)/period;
    avgLoss=((avgLoss*(period-1))+loss)/period;
  }
  if(avgLoss===0)return 100;
  const rs=avgGain/avgLoss;
  return parseFloat((100-(100/(1+rs))).toFixed(2));
}


const SCREEN_SCAN_SOFT_LIMIT = 100;
const SCREEN_SCAN_HARD_LIMIT = 150;
const SCREEN_BATCH_SIZE = 5;
const SCREEN_BATCH_DELAY = 220;
const SCREEN_ADMIN_HASH = '0912d4684c7301ab4f8e436d0dab16d0979e5e96082e552ce1590f917ecf0f76';
const SCREEN_ADMIN_PEPPER = 'twstock.screen.admin|S390';
const SCREEN_CONCEPT_MAP = {
  apple:['2317','2330','2308','2382','2357','3008','2324','4938','2474','3711','3406','6414','6669','3037','6269','6271'],
  ai:['2330','2317','2382','3231','6669','2383','3017','2376','2356','3034','2329','3661','3653','3014'],
  ev:['2308','2351','1319','1536','2201','2204','3017','3665','4931','2231','6288'],
  server:['2317','2382','6669','3231','3017','2376','2329','3035','8210','3443','2356'],
  cooling:['3324','3017','6125','6230','3653','3014','4938'],
  cowos:['2330','3711','6239','3131','3583','2360','2467','6147']
};
const SCREEN_MESSAGES = {
  pending:'目前尚有未完成的掃描工作，請先等待完成或按「停止掃描」後再重新開始。',
  adminOnly:'此功能僅限管理員解鎖後使用。',
  generalLimit:'本次候選股票超過一般使用者上限 100 檔。請縮小條件、改用類別掃描，或請管理員解鎖後再執行。',
  hardLimit:'本次候選股票已超過安全硬上限 150 檔。為避免過多請求造成延遲、失敗或資料來源限流，系統已停止執行。',
  adminLargeConfirm:'本次候選股票超過 100 檔，將以節流批次模式執行。仍要繼續嗎？',
  noData:'目前沒有可匯出的篩選結果。',
  pdfLibMissing:'PDF 匯出元件尚未就緒，請重新整理頁面後再試。',
  pdfBusy:'正在產生 PDF，請稍候。',
  partial:'本次掃描已完成，但部分股票資料取得失敗，請稍後重試。',
  stopped:'掃描已停止，系統已保留目前已完成的結果。',
  rateLimited:'資料來源暫時限制請求次數，系統已停止本次掃描並保留已完成結果。',
  adminBadPwd:'密碼驗證失敗，請重新輸入。',
  adminCooldown:'驗證失敗次數過多，請稍後再試。',
  adminUnlocked:'管理員模式已解鎖。',
  adminLocked:'已返回一般模式，管理員控制項已隱藏。'
};
let _screenScanJob={running:false,cancelled:false};
let _screenLastResult={rows:[],criteria:null,stats:null,generatedAt:null};
let _screenAdmin={unlocked:false,fullscan:false,widerange:false,failed:0,cooldownUntil:0,pdfBusy:false};
function sleep(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
function getScreenMessage(key){return SCREEN_MESSAGES[key]||'系統忙碌中，請稍後再試。';}
function notifyScreenIssue(key, statusText){
  const msg=getScreenMessage(key);
  const status=document.getElementById('screenRunStatus');
  const summary=document.getElementById('screenResultSummary');
  if(status && statusText)status.textContent=statusText;
  if(summary && statusText)summary.textContent=statusText;
  alert(msg);
  return msg;
}
async function sha256Hex(input){
  if(!window.crypto||!window.crypto.subtle)throw new Error('SubtleCrypto unavailable');
  const data=new TextEncoder().encode(input);
  const hash=await window.crypto.subtle.digest('SHA-256',data);
  return Array.from(new Uint8Array(hash)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
}
function getScreenAdminSaltedInput(pwd){
  return SCREEN_ADMIN_PEPPER+'|'+String(pwd||'')+'|unlock';
}
function isScreenAdminUnlocked(){return !!_screenAdmin.unlocked;}
function canUseAllStocks(){return isScreenAdminUnlocked() && !!_screenAdmin.fullscan;}
function canUseWideRange(){return isScreenAdminUnlocked() && !!_screenAdmin.widerange;}
function getAllStockSymbols(){
  return Object.keys(stockMetaCache).filter(function(code){
    return /^\d{4}$/.test(code) && !!(stockNameCache[code]||getStockMeta(code).stock_name||'');
  }).sort();
}
function padStockCode(v){
  const n=parseInt(String(v||'').trim(),10);
  if(!isFinite(n) || n<0)return '';
  return String(n).padStart(4,'0');
}
function updateScreenAdminUI(){
  const status=document.getElementById('screenAdminStatus');
  const tools=document.getElementById('screenAdminTools');
  const allOpt=document.querySelector('#screenUniverse option[value="allStocks"]');
  if(status){
    if(isScreenAdminUnlocked()){
      status.textContent='管理模式｜'+(canUseAllStocks()?'全掃已開啟':'全掃未開啟')+'｜'+(canUseWideRange()?'大範圍已開啟':'大範圍未開啟');
      status.classList.add('ok');
    }else{
      status.textContent='一般模式｜全掃已鎖定';
      status.classList.remove('ok');
    }
  }
  if(tools)tools.classList.toggle('show',isScreenAdminUnlocked());
  if(allOpt){
    const allow=canUseAllStocks();
    allOpt.hidden=!allow;
    allOpt.disabled=!allow;
    if(!allow && document.getElementById('screenUniverse') && document.getElementById('screenUniverse').value==='allStocks'){
      document.getElementById('screenUniverse').value='watchlist';
    }
  }
  setScreenPoolHint();
}
function openScreenAdminModal(){
  const now=Date.now();
  if(_screenAdmin.cooldownUntil && now<_screenAdmin.cooldownUntil){
    alert(getScreenMessage('adminCooldown'));
    return;
  }
  const modal=document.getElementById('screenAdminModal');
  const input=document.getElementById('screenAdminPassword');
  const msg=document.getElementById('screenAdminModalMsg');
  if(msg)msg.textContent='';
  if(input)input.value='';
  if(modal){modal.classList.add('show');modal.setAttribute('aria-hidden','false');}
  setTimeout(function(){if(input)input.focus();},60);
}
function closeScreenAdminModal(){
  const modal=document.getElementById('screenAdminModal');
  if(modal){modal.classList.remove('show');modal.setAttribute('aria-hidden','true');}
}
async function submitScreenAdminUnlock(){
  const input=document.getElementById('screenAdminPassword');
  const msg=document.getElementById('screenAdminModalMsg');
  const pwd=input?input.value:'';
  if(!pwd){if(msg)msg.textContent='請先輸入密碼';return;}
  try{
    const digest=await sha256Hex(getScreenAdminSaltedInput(pwd));
    if(digest===SCREEN_ADMIN_HASH){
      _screenAdmin.unlocked=true;
      _screenAdmin.failed=0;
      if(msg)msg.textContent=getScreenMessage('adminUnlocked');
      updateScreenAdminUI();
      setTimeout(closeScreenAdminModal,220);
      return;
    }
    _screenAdmin.failed+=1;
    if(_screenAdmin.failed>=3){
      _screenAdmin.cooldownUntil=Date.now()+30000;
      _screenAdmin.failed=0;
      if(msg)msg.textContent=getScreenMessage('adminCooldown');
      return;
    }
    if(msg)msg.textContent=getScreenMessage('adminBadPwd');
  }catch(e){
    if(msg)msg.textContent='驗證失敗：'+(e&&e.message?e.message:e);
  }
}
function lockScreenAdmin(){
  _screenAdmin.unlocked=false;
  _screenAdmin.fullscan=false;
  _screenAdmin.widerange=false;
  updateScreenAdminUI();
  alert(getScreenMessage('adminLocked'));
}
function handleScreenAdminAction(action){
  if(!isScreenAdminUnlocked()){alert(getScreenMessage('adminOnly'));return;}
  if(action==='fullscan'){
    _screenAdmin.fullscan=!_screenAdmin.fullscan;
    if(_screenAdmin.fullscan)alert('管理員已開啟「全部股票」選項。');
  }else if(action==='widerange'){
    _screenAdmin.widerange=!_screenAdmin.widerange;
    alert(_screenAdmin.widerange?'管理員已開啟大範圍掃描。':'已關閉大範圍掃描。');
  }else if(action==='lockback'){
    lockScreenAdmin();
    return;
  }
  updateScreenAdminUI();
}
function setScreenPoolHint(){
  const sel=document.getElementById('screenUniverse');
  const hint=document.getElementById('screenPoolHint');
  const ta=document.getElementById('screenCustomList');
  const rs=document.getElementById('screenRangeStart');
  const re=document.getElementById('screenRangeEnd');
  if(!sel||!hint||!ta||!rs||!re)return;
  const v=sel.value||'watchlist';
  const customOn=(v==='custom');
  const rangeOn=(v==='range');
  ta.disabled=!customOn;
  ta.style.opacity=customOn?'1':'.55';
  rs.disabled=!rangeOn;
  re.disabled=!rangeOn;
  rs.style.opacity=rangeOn?'1':'.55';
  re.style.opacity=rangeOn?'1':'.55';
  if(v==='watchlist')hint.textContent='目前將使用追蹤清單作為篩選資料池。';
  else if(v==='holdings')hint.textContent='目前將使用持股庫存作為篩選資料池。';
  else if(v==='union')hint.textContent='目前將合併追蹤清單與持股庫存進行篩選。';
  else if(v==='custom')hint.textContent='目前將使用你手動輸入的自訂代號清單進行篩選。';
  else if(v==='allStocks')hint.textContent=canUseAllStocks()?'目前將以全部股票代號作為候選池，再套用類別與條件篩選。':'全部股票模式已被鎖定，僅限管理員開啟。';
  else hint.textContent=canUseWideRange()?'目前將依代號範圍建立候選池，再套用類別與條件篩選。':'目前將依代號範圍建立候選池；一般模式建議控制在 100 檔內。';
}
async function populateScreenCategoryOptions(){
  const type=document.getElementById('screenCategoryType');
  const value=document.getElementById('screenCategoryValue');
  if(!type||!value)return;
  const current=value.value||'';
  const mode=type.value||'none';
  if(mode==='industry'){
    await preloadStockNames();
    const categories=[...new Set(Object.keys(stockMetaCache).map(function(code){return String(getStockMeta(code).industry_category||'').trim();}).filter(Boolean))].sort(function(a,b){return a.localeCompare(b,'zh-Hant');});
    value.innerHTML='<option value="">全部產業</option>'+categories.map(function(c){return '<option value="'+c+'">'+c+'</option>';}).join('');
    value.disabled=false;
  }else if(mode==='concept'){
    const labels={apple:'蘋果概念股',ai:'AI 概念股',ev:'電動車概念股',server:'伺服器概念股',cooling:'散熱概念股',cowos:'CoWoS 概念股'};
    value.innerHTML='<option value="">全部主題</option>'+Object.keys(labels).map(function(k){return '<option value="'+k+'">'+labels[k]+'</option>';}).join('');
    value.disabled=false;
  }else{
    value.innerHTML='<option value="">全部類別</option>';
    value.disabled=true;
  }
  if([...value.options].some(function(opt){return opt.value===current;}))value.value=current;
}
function filterByCategory(arr, criteria){
  let out=[...arr];
  if(criteria.categoryType==='industry' && criteria.categoryValue){
    out=out.filter(function(symbol){
      return String(getStockMeta(symbol).industry_category||'').trim()===criteria.categoryValue;
    });
  }else if(criteria.categoryType==='concept' && criteria.categoryValue){
    const pool=new Set(SCREEN_CONCEPT_MAP[criteria.categoryValue]||[]);
    out=out.filter(function(symbol){return pool.has(symbol);});
  }
  return out;
}
async function getScreenerUniverse(criteria){
  const mode=criteria.universe||'watchlist';
  let arr=[];
  if(mode==='watchlist')arr=[...(state.watchlist||[])];
  else if(mode==='holdings')arr=Object.keys(state.holdings||{});
  else if(mode==='union')arr=[...(state.watchlist||[]),...Object.keys(state.holdings||{})];
  else if(mode==='custom'){
    const raw=document.getElementById('screenCustomList')?.value||state.screenCustomList||'';
    arr=raw.split(/[\s,，;；]+/).map(normalizeSymbol).filter(Boolean);
  }else{
    await preloadStockNames();
    const all=getAllStockSymbols();
    if(mode==='allStocks')arr=all;
    else if(mode==='range'){
      const s=parseInt(criteria.rangeStart||'0',10);
      const e=parseInt(criteria.rangeEnd||'0',10);
      if(!isFinite(s)||!isFinite(e)||s<=0||e<=0||s>e)return [];
      arr=all.filter(function(code){
        const n=parseInt(code,10);
        return isFinite(n)&&n>=s&&n<=e;
      });
    }
  }
  arr=[...new Set(arr.map(normalizeSymbol).filter(Boolean))];
  return filterByCategory(arr, criteria);
}
function getActiveScreenFilters(){
  return [...document.querySelectorAll('[data-screen-filter].active')].map(function(el){return el.dataset.screenFilter;});
}
function getScreenerCriteria(){
  const criteria={
    simple:getActiveScreenFilters(),
    minTotal:num(document.getElementById('screenMinTotal')?.value),
    minFund:num(document.getElementById('screenMinFund')?.value),
    maxRsi:num(document.getElementById('screenMaxRsi')?.value),
    minVolRatio:num(document.getElementById('screenMinVolRatio')?.value),
    minRevYoY:num(document.getElementById('screenMinRevYoY')?.value),
    minEPS:num(document.getElementById('screenMinEPS')?.value),
    sortBy:document.getElementById('screenSortBy')?.value||'totalDesc',
    limit:parseInt(document.getElementById('screenLimit')?.value||'20',10)||20,
    universe:document.getElementById('screenUniverse')?.value||'watchlist',
    rangeStart:padStockCode(document.getElementById('screenRangeStart')?.value||''),
    rangeEnd:padStockCode(document.getElementById('screenRangeEnd')?.value||''),
    categoryType:document.getElementById('screenCategoryType')?.value||'none',
    categoryValue:document.getElementById('screenCategoryValue')?.value||''
  };
  state.screenCustomList=document.getElementById('screenCustomList')?.value||'';
  saveState(state);
  return criteria;
}
function formatScreenCriteria(criteria){
  const tags=[];
  const universeMap={watchlist:'追蹤清單',holdings:'持股庫存',union:'追蹤+持股',custom:'自訂清單',allStocks:'全部股票',range:'代號範圍'};
  tags.push('資料池：'+(universeMap[criteria.universe]||criteria.universe));
  if(criteria.universe==='range' && criteria.rangeStart && criteria.rangeEnd)tags.push('代號 '+criteria.rangeStart+'~'+criteria.rangeEnd);
  if(criteria.categoryType==='industry' && criteria.categoryValue)tags.push('產業：'+criteria.categoryValue);
  if(criteria.categoryType==='concept' && criteria.categoryValue){
    const labels={apple:'蘋果概念股',ai:'AI 概念股',ev:'電動車概念股',server:'伺服器概念股',cooling:'散熱概念股',cowos:'CoWoS 概念股'};
    tags.push('主題：'+(labels[criteria.categoryValue]||criteria.categoryValue));
  }
  (criteria.simple||[]).forEach(function(k){
    const map={buyFit:'適合買進',sellWatch:'考慮賣出',volumeSpike:'量能異動',oversold:'超跌反彈'};
    tags.push(map[k]||k);
  });
  if(criteria.minTotal!=null)tags.push('綜合≥'+criteria.minTotal);
  if(criteria.minFund!=null)tags.push('基本面≥'+criteria.minFund);
  if(criteria.maxRsi!=null)tags.push('RSI≤'+criteria.maxRsi);
  if(criteria.minVolRatio!=null)tags.push('量比≥'+criteria.minVolRatio);
  if(criteria.minRevYoY!=null)tags.push('營收年增≥'+criteria.minRevYoY+'%');
  if(criteria.minEPS!=null)tags.push('EPS≥'+criteria.minEPS);
  return tags;
}
function getScoreTone(score){
  const n=num(score);
  if(n==null)return 'neutral';
  if(n>=65)return 'positive';
  if(n<=35)return 'negative';
  return 'neutral';
}
function getSignedTone(v){
  const n=num(v);
  if(n==null)return '';
  return n>0?'positive':n<0?'negative':'';
}
function buildScreenReasonBadges(item, criteria){
  const tags=[];
  if((criteria.simple||[]).includes('buyFit') && item.price>item.ma20 && item.totalScore>=65){
    tags.push({text:'站上 MA20', tone:'positive'});
    tags.push({text:'綜合分數偏強', tone:'positive'});
  }
  if((criteria.simple||[]).includes('sellWatch') && item.price<item.ma20 && item.totalScore<=35){
    tags.push({text:'跌破 MA20', tone:'negative'});
    tags.push({text:'綜合分數偏弱', tone:'negative'});
  }
  if((criteria.simple||[]).includes('volumeSpike') && (item.volRatio||0)>=1.5)tags.push({text:'量比放大', tone:'positive'});
  if((criteria.simple||[]).includes('oversold') && (item.rsi||999)<30)tags.push({text:'RSI < 30', tone:'negative'});
  if(criteria.minFund!=null && item.fundScore>=criteria.minFund)tags.push({text:'基本面達標', tone:'positive'});
  if(criteria.minRevYoY!=null && item.revYoY!=null && item.revYoY>=criteria.minRevYoY)tags.push({text:'營收年增達標', tone:item.revYoY>=0?'positive':'negative'});
  if(criteria.minEPS!=null && item.ttmEPS!=null && item.ttmEPS>=criteria.minEPS)tags.push({text:'EPS 達標', tone:item.ttmEPS>=0?'positive':'negative'});
  if(criteria.categoryType==='industry' && criteria.categoryValue)tags.push({text:'產業命中', tone:'neutral'});
  if(criteria.categoryType==='concept' && criteria.categoryValue)tags.push({text:'主題命中', tone:'neutral'});
  if(!tags.length){
    if(item.totalScore>=65)tags.push({text:'綜合偏多', tone:'positive'});
    else if(item.totalScore<=35)tags.push({text:'綜合偏弱', tone:'negative'});
    else tags.push({text:'條件命中', tone:'neutral'});
  }
  return tags.slice(0,5);
}
function renderToneValue(value, formatted){
  const tone=getSignedTone(value);
  return '<span class="'+(tone==='positive'?'screen-price-positive':tone==='negative'?'screen-price-negative':'')+'">'+formatted+'</span>';
}
function setScreenerRunning(running){
  const runBtn=document.getElementById('btnRunScreener');
  const stopBtn=document.getElementById('btnStopScreener');
  const clearBtn=document.getElementById('btnClearScreener');
  const pdfBtn=document.getElementById('btnExportScreenPdf');
  if(runBtn)runBtn.disabled=!!running;
  if(clearBtn)clearBtn.disabled=!!running;
  if(pdfBtn)pdfBtn.disabled=!!running||!!_screenAdmin.pdfBusy;
  if(stopBtn)stopBtn.style.display=running?'':'none';
}
function renderScreenResults(rows, criteria, stats){
  const tbody=document.getElementById('screenResultBody');
  const empty=document.getElementById('screenResultEmpty');
  const summary=document.getElementById('screenResultSummary');
  if(!tbody||!empty||!summary)return;
  tbody.innerHTML='';
  const sortBy=criteria.sortBy||'totalDesc';
  rows.sort(function(a,b){
    if(sortBy==='rsiAsc')return (a.rsi??999)-(b.rsi??999);
    if(sortBy==='volDesc')return (b.volRatio??-999)-(a.volRatio??-999);
    if(sortBy==='revDesc')return (b.revYoY??-999)-(a.revYoY??-999);
    return (b.totalScore??0)-(a.totalScore??0);
  });
  rows=rows.slice(0,Math.max(5,Math.min(100,criteria.limit||20)));
  _screenLastResult={rows:[...rows],criteria:criteria,stats:stats,generatedAt:new Date().toISOString()};
  const scanned=stats&&stats.total!=null?stats.total:0;
  const ok=stats&&stats.ok!=null?stats.ok:0;
  const failed=stats&&stats.failed!=null?stats.failed:0;
  const skipped=stats&&stats.skipped!=null?stats.skipped:0;
  if(!rows.length){
    empty.style.display='';
    summary.innerHTML='<span class="screen-result-chip">掃描 '+scanned+' 檔</span><span class="screen-result-chip positive">成功 '+ok+' 檔</span><span class="screen-result-chip negative">失敗 '+failed+' 檔</span><span class="screen-result-chip">略過 '+skipped+' 檔</span>';
    return;
  }
  empty.style.display='none';
  summary.innerHTML='<span class="screen-result-chip">掃描 '+scanned+' 檔</span><span class="screen-result-chip positive">成功 '+ok+' 檔</span><span class="screen-result-chip negative">失敗 '+failed+' 檔</span><span class="screen-result-chip">略過 '+skipped+' 檔</span>'+(formatScreenCriteria(criteria).map(function(t){return '<span class="screen-result-chip">'+t+'</span>';}).join(''));
  rows.forEach(function(r){
    const totalTone=getScoreTone(r.totalScore);
    const techTone=getScoreTone(r.techScore);
    const fundTone=getScoreTone(r.fundScore);
    const priceAbove = r.price!=null && r.ma20!=null ? r.price>=r.ma20 : null;
    const reasons=buildScreenReasonBadges(r, criteria);
    const revText=r.revYoY==null?'—':((r.revYoY>=0?'+':'')+r.revYoY.toFixed(1)+'%');
    const epsText=r.ttmEPS==null?'—':((r.ttmEPS>=0?'+':'')+r.ttmEPS.toFixed(2));
    const tr=document.createElement('tr');
    tr.innerHTML=''
      +'<td><div class="font-mono font-bold">'+r.symbol+'</div>'
      +(r.name?'<div style="font-size:.72rem;color:#8b949e;">'+r.name+'</div>':'')
      +'<div class="screen-reasons">'+reasons.map(function(tag){return '<span class="screen-reason '+tag.tone+'">'+tag.text+'</span>';}).join('')+'</div></td>'
      +'<td><div class="screen-score-wrap"><span class="screen-score-box '+totalTone+'">'+r.totalScore+'</span></div><div class="screen-score-sub">綜合分數</div></td>'
      +'<td><div class="screen-score-wrap"><span class="screen-score-box '+techTone+'">'+r.techScore+'</span><span class="screen-score-box '+fundTone+'">'+r.fundScore+'</span></div><div class="screen-score-sub">技術 / 基本面</div></td>'
      +'<td><div class="'+(priceAbove===true?'screen-price-positive':priceAbove===false?'screen-price-negative':'')+'">'+formatPrice(r.price)+'</div><div style="font-size:.72rem;color:#8b949e;">MA20 '+formatPrice(r.ma20)+'</div></td>'
      +'<td><div>'+(r.rsi==null?'—':r.rsi.toFixed(2))+'</div><div style="font-size:.72rem;color:#8b949e;">量比 '+(r.volRatio==null?'—':r.volRatio.toFixed(2))+'</div></td>'
      +'<td><div>'+renderToneValue(r.revYoY, revText)+'</div><div style="font-size:.72rem;color:#8b949e;">EPS '+renderToneValue(r.ttmEPS, epsText)+'</div></td>'
      +'<td><button class="btn-xs" data-screen-ai="'+r.symbol+'">AI</button> <button class="btn-xs btn-xs-gray" data-screen-trade="'+r.symbol+'">交易</button></td>';
    tbody.appendChild(tr);
  });
  bindScreenerResultEvents();
}
function buildScreenPdfFileName(){
  const d=new Date();
  const pad=function(v){return String(v).padStart(2,'0');};
  return 'screener_'+d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'_'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds())+'.pdf';
}
async function exportScreenerPdf(){
  if(_screenAdmin.pdfBusy){alert(getScreenMessage('pdfBusy'));return;}
  if(!_screenLastResult.rows||!_screenLastResult.rows.length){alert(getScreenMessage('noData'));return;}
  if(!(window.html2canvas&&window.jspdf&&window.jspdf.jsPDF)){alert(getScreenMessage('pdfLibMissing'));return;}
  _screenAdmin.pdfBusy=true;
  setScreenerRunning(_screenScanJob.running);
  try{
    const source=document.getElementById('screenResultCard');
    if(!source)throw new Error('screenResultCard missing');
    const wrap=document.createElement('div');
    wrap.className='screen-offscreen-pdf';
    const head=document.createElement('div');
    const now=new Date();
    head.innerHTML=''
      +'<div style="font-size:22px;font-weight:900;color:#fff;margin-bottom:6px;">台股虛擬操盤系統｜篩選結果報表</div>'
      +'<div style="font-size:12px;color:#9fb4d2;line-height:1.8;">匯出日期：'+now.toLocaleDateString('zh-TW')+'｜匯出時間：'+now.toLocaleTimeString('zh-TW')+'｜版本：v3.9.3</div>'
      +'<div style="font-size:12px;color:#dbeafe;line-height:1.8;margin-bottom:14px;">篩選條件：'+formatScreenCriteria(_screenLastResult.criteria||{}).join('、')+'</div>';
    const clone=source.cloneNode(true);
    clone.style.marginTop='0';
    wrap.appendChild(head);
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    const canvas=await window.html2canvas(wrap,{backgroundColor:'#0d1117',scale:2,useCORS:true});
    const img=canvas.toDataURL('image/png');
    const pdf=new window.jspdf.jsPDF({orientation:'landscape',unit:'pt',format:'a4'});
    const pageW=pdf.internal.pageSize.getWidth();
    const pageH=pdf.internal.pageSize.getHeight();
    const imgW=pageW-24;
    const imgH=canvas.height*imgW/canvas.width;
    let hLeft=imgH;
    let posY=12;
    pdf.addImage(img,'PNG',12,posY,imgW,imgH);
    hLeft-=pageH;
    while(hLeft>0){
      posY=hLeft-imgH+12;
      pdf.addPage();
      pdf.addImage(img,'PNG',12,posY,imgW,imgH);
      hLeft-=pageH;
    }
    pdf.save(buildScreenPdfFileName());
    wrap.remove();
  }catch(e){
    alert('PDF 匯出失敗：'+(e&&e.message?e.message:e));
  }finally{
    _screenAdmin.pdfBusy=false;
    setScreenerRunning(_screenScanJob.running);
  }
}
async function runScreener(){
  const status=document.getElementById('screenRunStatus');
  const summary=document.getElementById('screenResultSummary');
  const empty=document.getElementById('screenResultEmpty');
  if(_screenScanJob.running){
    notifyScreenIssue('pending','仍有掃描工作執行中');
    return;
  }
  const criteria=getScreenerCriteria();
  if(criteria.universe==='allStocks' && !canUseAllStocks()){
    notifyScreenIssue('adminOnly','全部股票模式已鎖定');
    if(status)status.textContent='全部股票模式僅限管理員';
    return;
  }
  const symbols=await getScreenerUniverse(criteria);
  if(!symbols.length){
    if(status)status.textContent='沒有可篩選的股票';
    if(summary)summary.textContent='請先建立追蹤清單、持股、自訂清單，或調整代號範圍 / 類別條件。';
    document.getElementById('screenResultBody').innerHTML='';
    if(empty)empty.style.display='';
    return;
  }
  if(symbols.length>SCREEN_SCAN_HARD_LIMIT){
    notifyScreenIssue('hardLimit','超過安全硬上限，已取消');
    return;
  }
  if(symbols.length>SCREEN_SCAN_SOFT_LIMIT && !canUseWideRange()){
    notifyScreenIssue('generalLimit','超過一般使用者上限，已取消');
    return;
  }
  if(symbols.length>SCREEN_SCAN_SOFT_LIMIT && canUseWideRange()){
    if(!confirm(getScreenMessage('adminLargeConfirm'))){
      if(status)status.textContent='已取消大量掃描';
      if(summary)summary.textContent='你已取消大範圍掃描。';
      return;
    }
  }
  _screenScanJob.running=true;
  _screenScanJob.cancelled=false;
  setScreenerRunning(true);
  if(status)status.textContent='開始分析 '+symbols.length+' 檔…';
  if(summary)summary.innerHTML='<span class="screen-result-chip">準備掃描 '+symbols.length+' 檔</span><span class="screen-result-chip">批次 '+SCREEN_BATCH_SIZE+' 檔 / '+SCREEN_BATCH_DELAY+'ms 節流</span>';
  document.getElementById('screenResultBody').innerHTML='';
  if(empty)empty.style.display='';
  const rows=[];
  let okCount=0, failCount=0, skipCount=0;
  try{
    for(let i=0;i<symbols.length;i++){
      if(_screenScanJob.cancelled)break;
      const symbol=normalizeSymbol(symbols[i]);
      if(status)status.textContent='分析中 '+(i+1)+' / '+symbols.length+'：'+symbol+'｜成功 '+okCount+'｜失敗 '+failCount+'｜略過 '+skipCount;
      try{
        const priceRows=await fetchAIReportData(symbol);
        if(!priceRows||priceRows.length<30){skipCount++;continue;}
        const tech=analyzeAIData(symbol, priceRows);
        const fund=await analyzeAIFundamental(symbol, tech.name||getStockName(symbol)||'');
        const closes=priceRows.map(function(r){return r.close;});
        const vols=priceRows.map(function(r){return num(r.volume)||0;});
        const last=priceRows[priceRows.length-1]||{};
        const avg5v=(vols.slice(-6,-1).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(5,vols.length-1)))||0;
        const volRatio=avg5v>0?((num(last.volume)||0)/avg5v):null;
        const rsi=calcRSI(closes,14);
        const totalScore=Math.round((tech.comprehensiveScore||0)*0.6 + (fund.score||0)*0.4);
        const item={
          symbol:symbol,
          name:tech.name||getStockName(symbol)||'',
          price:num(last.close),
          ma20:num(tech.m20),
          techScore:num(tech.comprehensiveScore)||0,
          fundScore:num(fund.score)||0,
          totalScore:totalScore,
          rsi:rsi,
          volRatio:volRatio,
          revYoY:extractMetricValue(fund.metrics,'月營收年增'),
          ttmEPS:extractMetricValue(fund.metrics,'近四季 EPS'),
          tech:tech,
          fund:fund
        };
        okCount++;
        if(evaluateScreenResult(item, criteria))rows.push(item);
      }catch(e){
        failCount++;
        const msg=e&&e.message?String(e.message):String(e||'');
        if(/limit|429|upper limit/i.test(msg)){
          _screenScanJob.cancelled=true;
          console.warn('[Screener-RateLimit]',symbol,msg);
          break;
        }
        console.warn('[Screener]',symbol,msg);
      }
      if((i+1)%SCREEN_BATCH_SIZE===0 && i<symbols.length-1)await sleep(SCREEN_BATCH_DELAY);
    }
    const stats={total:symbols.length,ok:okCount,failed:failCount,skipped:skipCount};
    renderScreenResults(rows, criteria, stats);
    if(_screenScanJob.cancelled){
      if(status)status.textContent='掃描已中止｜已完成 '+(okCount+failCount+skipCount)+' / '+symbols.length+' 檔';
      alert(failCount>0&&okCount===0?getScreenMessage('rateLimited'):getScreenMessage('stopped'));
    }else{
      if(status)status.textContent='篩選完成｜掃描 '+symbols.length+' 檔｜命中 '+rows.length+' 檔｜成功 '+okCount+'｜失敗 '+failCount+'｜略過 '+skipCount;
      if(failCount>0)alert(getScreenMessage('partial'));
    }
    state.screenHistory=[{time:new Date().toLocaleString('zh-TW'),poolLabel:poolLabelByValue(criteria.universe),count:rows.length,filters:formatScreenCriteria(criteria)}].concat(state.screenHistory||[]).slice(0,20);
    saveState(state);
    renderScreenerHistory();
  }finally{
    _screenScanJob.running=false;
    setScreenerRunning(false);
  }
}
function bindScreenerUI(){
  document.querySelectorAll('[data-screen-filter]').forEach(function(card){
    card.addEventListener('click',function(){card.classList.toggle('active');});
  });
  document.getElementById('screenUniverse')?.addEventListener('change',setScreenPoolHint);
  document.getElementById('screenCategoryType')?.addEventListener('change',populateScreenCategoryOptions);
  document.getElementById('screenCustomList')?.addEventListener('input',function(){state.screenCustomList=this.value; saveState(state);});
  document.getElementById('btnRunScreener')?.addEventListener('click',runScreener);
  document.getElementById('btnStopScreener')?.addEventListener('click',function(){
    if(!_screenScanJob.running)return;
    _screenScanJob.cancelled=true;
    const status=document.getElementById('screenRunStatus');
    if(status)status.textContent='已收到停止指令，將在目前批次結束後停止。';
  });
  document.getElementById('btnExportScreenPdf')?.addEventListener('click',exportScreenerPdf);
  document.getElementById('btnClearScreener')?.addEventListener('click',clearScreenerInputs);
  document.getElementById('btnClearScreenHistory')?.addEventListener('click',function(){state.screenHistory=[];saveState(state);renderScreenerHistory();});
  document.getElementById('btnToggleScreenAdv')?.addEventListener('click',function(){
    const p=document.getElementById('screenAdvPanel');
    if(!p)return;
    const show=!p.classList.contains('show');
    p.classList.toggle('show',show);
    this.textContent=show?'收合進階條件 ▲':'展開進階條件 ▼';
  });
  document.getElementById('screenAdminEntry')?.addEventListener('click',openScreenAdminModal);
  document.getElementById('btnScreenAdminCancel')?.addEventListener('click',closeScreenAdminModal);
  document.getElementById('btnScreenAdminSubmit')?.addEventListener('click',submitScreenAdminUnlock);
  document.getElementById('screenAdminPassword')?.addEventListener('keydown',function(e){if(e.key==='Enter')submitScreenAdminUnlock();});
  document.getElementById('screenAdminModal')?.addEventListener('click',function(e){if(e.target===this)closeScreenAdminModal();});
  document.querySelectorAll('[data-admin-act]').forEach(function(btn){
    btn.addEventListener('click',function(){handleScreenAdminAction(btn.dataset.adminAct);});
  });
  const ta=document.getElementById('screenCustomList');
  if(ta && state.screenCustomList && !ta.value)ta.value=state.screenCustomList;
  setScreenPoolHint();
  populateScreenCategoryOptions();
  renderScreenerHistory();
  updateScreenAdminUI();
  setScreenerRunning(false);
}
function renderScreenerHistory(){
  const box=document.getElementById('screenHistoryList');
  if(!box)return;
  const list=Array.isArray(state.screenHistory)?state.screenHistory:[];
  if(!list.length){box.innerHTML='<div class="screen-empty">尚無篩選紀錄</div>';return;}
  box.innerHTML=list.slice(0,8).map(function(it){
    return '<div class="screen-history-item">'
      +'<div class="screen-history-title">'+it.time+'｜'+it.poolLabel+'｜命中 '+it.count+' 檔</div>'
      +'<div class="screen-history-sub">'+(it.filters&&it.filters.length?it.filters.join('、'):'未設定條件')+'</div>'
      +'</div>';
  }).join('');
}
function clearScreenerInputs(){
  document.querySelectorAll('[data-screen-filter].active').forEach(function(el){el.classList.remove('active');});
  ['screenMinTotal','screenMinFund','screenMaxRsi','screenMinVolRatio','screenMinRevYoY','screenMinEPS'].forEach(function(id){
    const el=document.getElementById(id); if(el)el.value='';
  });
  const sort=document.getElementById('screenSortBy'); if(sort)sort.value='totalDesc';
  const limit=document.getElementById('screenLimit'); if(limit)limit.value='20';
  const rs=document.getElementById('screenRangeStart'); if(rs)rs.value='';
  const re=document.getElementById('screenRangeEnd'); if(re)re.value='';
  const ct=document.getElementById('screenCategoryType'); if(ct)ct.value='none';
  const cv=document.getElementById('screenCategoryValue'); if(cv){cv.innerHTML='<option value=>全部類別</option>';cv.value='';cv.disabled=true;}
  document.getElementById('screenResultBody').innerHTML='';
  document.getElementById('screenResultSummary').textContent='篩選條件已清除。';
  document.getElementById('screenResultEmpty').style.display='';
  document.getElementById('screenRunStatus').textContent='尚未開始篩選';
  _screenLastResult={rows:[],criteria:null,stats:null,generatedAt:null};
  setScreenPoolHint();
}

function poolLabelByValue(v){
  return v==='holdings'?'持股庫存':v==='union'?'追蹤+持股':v==='custom'?'自訂清單':'追蹤清單';
}
function bindScreenerResultEvents(){
  const tbody=document.getElementById('screenResultBody');
  if(!tbody)return;
  tbody.querySelectorAll('[data-screen-trade]').forEach(function(btn){
    btn.onclick=function(){
      const sym=btn.dataset.screenTrade;
      const inp=document.getElementById('tradeSymbol');
      if(inp)inp.value=sym;
      renderSymbolHint('tradeSymbol','tradeSymbolHint');
      if(typeof window.__navigate==='function')window.__navigate('trade');
      setTimeout(function(){
        const q=quoteCache[normalizeSymbol(sym)]&&quoteCache[normalizeSymbol(sym)].data;
        const pe=document.getElementById('tradePrice');
        if(pe&&q&&q.price>0)pe.value=q.price.toFixed(2);
        updateFeePreview();
      },150);
    };
  });
  tbody.querySelectorAll('[data-screen-ai]').forEach(function(btn){
    btn.onclick=function(){
      const sym=btn.dataset.screenAi;
      const inp=document.getElementById('aiSymbol');
      if(inp)inp.value=sym;
      renderSymbolHint('aiSymbol','aiSymbolHint');
      if(typeof window.__navigate==='function')window.__navigate('aiReport');
      setTimeout(function(){generateAIReport(sym);},120);
    };
  });
}

function renderScreenResults(rows, criteria, stats){
  const tbody=document.getElementById('screenResultBody');
  const empty=document.getElementById('screenResultEmpty');
  const summary=document.getElementById('screenResultSummary');
  if(!tbody||!empty||!summary)return;
  tbody.innerHTML='';
  const sortBy=criteria.sortBy||'totalDesc';
  rows.sort(function(a,b){
    if(sortBy==='rsiAsc')return (a.rsi??999)-(b.rsi??999);
    if(sortBy==='volDesc')return (b.volRatio??-999)-(a.volRatio??-999);
    if(sortBy==='revDesc')return (b.revYoY??-999)-(a.revYoY??-999);
    return (b.totalScore??0)-(a.totalScore??0);
  });
  rows=rows.slice(0,Math.max(5,Math.min(100,criteria.limit||20)));
  const scanned=stats&&stats.total!=null?stats.total:0;
  const ok=stats&&stats.ok!=null?stats.ok:0;
  const failed=stats&&stats.failed!=null?stats.failed:0;
  const skipped=stats&&stats.skipped!=null?stats.skipped:0;
  if(!rows.length){
    empty.style.display='';
    summary.innerHTML='<span class="screen-result-chip">掃描 '+scanned+' 檔</span><span class="screen-result-chip positive">成功 '+ok+' 檔</span><span class="screen-result-chip negative">失敗 '+failed+' 檔</span><span class="screen-result-chip">略過 '+skipped+' 檔</span>';
    return;
  }
  empty.style.display='none';
  summary.innerHTML='<span class="screen-result-chip">掃描 '+scanned+' 檔</span><span class="screen-result-chip positive">成功 '+ok+' 檔</span><span class="screen-result-chip negative">失敗 '+failed+' 檔</span><span class="screen-result-chip">略過 '+skipped+' 檔</span>'+(formatScreenCriteria(criteria).map(function(t){return '<span class="screen-result-chip">'+t+'</span>';}).join(''));
  rows.forEach(function(r){
    const totalTone=getScoreTone(r.totalScore);
    const techTone=getScoreTone(r.techScore);
    const fundTone=getScoreTone(r.fundScore);
    const priceAbove = r.price!=null && r.ma20!=null ? r.price>=r.ma20 : null;
    const reasons=buildScreenReasonBadges(r, criteria);
    const revText=r.revYoY==null?'—':((r.revYoY>=0?'+':'')+r.revYoY.toFixed(1)+'%');
    const epsText=r.ttmEPS==null?'—':((r.ttmEPS>=0?'+':'')+r.ttmEPS.toFixed(2));
    const tr=document.createElement('tr');
    tr.innerHTML=''
      +'<td><div class="font-mono font-bold">'+r.symbol+'</div>'
      +(r.name?'<div style="font-size:.72rem;color:#8b949e;">'+r.name+'</div>':'')
      +'<div class="screen-reasons">'+reasons.map(function(tag){return '<span class="screen-reason '+tag.tone+'">'+tag.text+'</span>';}).join('')+'</div></td>'
      +'<td><div class="screen-score-wrap"><span class="screen-score-box '+totalTone+'">'+r.totalScore+'</span></div><div class="screen-score-sub">綜合分數</div></td>'
      +'<td><div class="screen-score-wrap"><span class="screen-score-box '+techTone+'">'+r.techScore+'</span><span class="screen-score-box '+fundTone+'">'+r.fundScore+'</span></div><div class="screen-score-sub">技術 / 基本面</div></td>'
      +'<td><div class="'+(priceAbove===true?'screen-price-positive':priceAbove===false?'screen-price-negative':'')+'">'+formatPrice(r.price)+'</div><div style="font-size:.72rem;color:#8b949e;">MA20 '+formatPrice(r.ma20)+'</div></td>'
      +'<td><div>'+(r.rsi==null?'—':r.rsi.toFixed(2))+'</div><div style="font-size:.72rem;color:#8b949e;">量比 '+(r.volRatio==null?'—':r.volRatio.toFixed(2))+'</div></td>'
      +'<td><div>'+renderToneValue(r.revYoY, revText)+'</div><div style="font-size:.72rem;color:#8b949e;">EPS '+renderToneValue(r.ttmEPS, epsText)+'</div></td>'
      +'<td><button class="btn-xs" data-screen-ai="'+r.symbol+'">AI</button> <button class="btn-xs btn-xs-gray" data-screen-trade="'+r.symbol+'">交易</button></td>';
    tbody.appendChild(tr);
  });
  bindScreenerResultEvents();
}
function extractMetricValue(metrics, label){
  const item=(metrics||[]).find(function(m){return m.label===label;});
  if(!item)return null;
  return num(item.value);
}
function evaluateScreenResult(item, criteria){
  const filters=criteria.simple||[];
  for(const f of filters){
    if(f==='buyFit' && !(item.price>item.ma20 && item.totalScore>=65))return false;
    if(f==='sellWatch' && !(item.price<item.ma20 && item.totalScore<=35))return false;
    if(f==='volumeSpike' && !((item.volRatio||0)>=1.5))return false;
    if(f==='oversold' && !((item.rsi||999)<30))return false;
  }
  if(criteria.minTotal!=null && item.totalScore<criteria.minTotal)return false;
  if(criteria.minFund!=null && item.fundScore<criteria.minFund)return false;
  if(criteria.maxRsi!=null && (item.rsi==null || item.rsi>criteria.maxRsi))return false;
  if(criteria.minVolRatio!=null && (item.volRatio==null || item.volRatio<criteria.minVolRatio))return false;
  if(criteria.minRevYoY!=null && (item.revYoY==null || item.revYoY<criteria.minRevYoY))return false;
  if(criteria.minEPS!=null && (item.ttmEPS==null || item.ttmEPS<criteria.minEPS))return false;
  return true;
}

async function runScreener(){
  const status=document.getElementById('screenRunStatus');
  const summary=document.getElementById('screenResultSummary');
  const empty=document.getElementById('screenResultEmpty');
  if(_screenScanJob.running){
    alert('目前尚有未完成的掃描工作，请先等待完成或按「停止掃描」後再重新開始。');
    return;
  }
  const criteria=getScreenerCriteria();
  const symbols=await getScreenerUniverse(criteria);
  if(!symbols.length){
    if(status)status.textContent='沒有可篩選的股票';
    if(summary)summary.textContent='請先建立追蹤清單、持股、自訂清單，或調整代號範圍 / 類別條件。';
    document.getElementById('screenResultBody').innerHTML='';
    if(empty)empty.style.display='';
    return;
  }
  if(symbols.length>SCREEN_SCAN_HARD_LIMIT){
    const msg='本次候選股票共 '+symbols.length+' 檔，已超過安全上限 '+SCREEN_SCAN_HARD_LIMIT+' 檔。\n為避免過多請求造成延遲、失敗或資料來源限流，本次不執行。\n請改用類別、代號範圍或縮小條件後再試。';
    alert(msg);
    if(status)status.textContent='超過安全上限，已取消掃描';
    if(summary)summary.textContent='安全限制：超過 '+SCREEN_SCAN_HARD_LIMIT+' 檔不執行。';
    return;
  }
  if(symbols.length>SCREEN_SCAN_SOFT_LIMIT){
    const ok=confirm('本次候選股票共 '+symbols.length+' 檔，已超過建議上限 '+SCREEN_SCAN_SOFT_LIMIT+' 檔。\n系統將以批次節流模式執行。\n若你之後再次點擊開始篩選，系統會提示「尚有未完成的掃描工作」。\n\n是否仍要繼續？');
    if(!ok){
      if(status)status.textContent='已取消大量掃描';
      if(summary)summary.textContent='你已取消超過建議上限的掃描。';
      return;
    }
  }
  _screenScanJob.running=true;
  _screenScanJob.cancelled=false;
  setScreenerRunning(true);
  if(status)status.textContent='開始分析 '+symbols.length+' 檔…';
  if(summary)summary.innerHTML='<span class="screen-result-chip">準備掃描 '+symbols.length+' 檔</span><span class="screen-result-chip">批次 '+SCREEN_BATCH_SIZE+' 檔 / '+SCREEN_BATCH_DELAY+'ms 節流</span>';
  document.getElementById('screenResultBody').innerHTML='';
  if(empty)empty.style.display='';
  const rows=[];
  let okCount=0, failCount=0, skipCount=0;
  try{
    for(let i=0;i<symbols.length;i++){
      if(_screenScanJob.cancelled)break;
      const symbol=normalizeSymbol(symbols[i]);
      if(status)status.textContent='分析中 '+(i+1)+' / '+symbols.length+'：'+symbol+'｜成功 '+okCount+'｜失敗 '+failCount+'｜略過 '+skipCount;
      try{
        const priceRows=await fetchAIReportData(symbol);
        if(!priceRows||priceRows.length<30){skipCount++;continue;}
        const tech=analyzeAIData(symbol, priceRows);
        const fund=await analyzeAIFundamental(symbol, tech.name||getStockName(symbol)||'');
        const closes=priceRows.map(function(r){return r.close;});
        const vols=priceRows.map(function(r){return num(r.volume)||0;});
        const last=priceRows[priceRows.length-1]||{};
        const avg5v=(vols.slice(-6,-1).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(5,vols.length-1)))||0;
        const volRatio=avg5v>0?((num(last.volume)||0)/avg5v):null;
        const rsi=calcRSI(closes,14);
        const totalScore=Math.round((tech.comprehensiveScore||0)*0.6 + (fund.score||0)*0.4);
        const item={
          symbol:symbol,
          name:tech.name||getStockName(symbol)||'',
          price:num(last.close),
          ma20:num(tech.m20),
          techScore:num(tech.comprehensiveScore)||0,
          fundScore:num(fund.score)||0,
          totalScore:totalScore,
          rsi:rsi,
          volRatio:volRatio,
          revYoY:extractMetricValue(fund.metrics,'月營收年增'),
          ttmEPS:extractMetricValue(fund.metrics,'近四季 EPS'),
          tech:tech,
          fund:fund
        };
        okCount++;
        if(evaluateScreenResult(item, criteria))rows.push(item);
      }catch(e){
        failCount++;
        console.warn('[Screener]',symbol,e&&e.message?e.message:e);
      }
      if((i+1)%SCREEN_BATCH_SIZE===0 && i<symbols.length-1)await sleep(SCREEN_BATCH_DELAY);
    }
    const stats={total:symbols.length,ok:okCount,failed:failCount,skipped:skipCount};
    renderScreenResults(rows, criteria, stats);
    if(_screenScanJob.cancelled){
      if(status)status.textContent='掃描已中止｜已完成 '+(okCount+failCount+skipCount)+' / '+symbols.length+' 檔';
      alert('掃描已停止。系統保留目前已完成的結果，尚有未完成的掃描工作未繼續執行。');
    }else{
      if(status)status.textContent='篩選完成｜掃描 '+symbols.length+' 檔｜命中 '+rows.length+' 檔｜成功 '+okCount+'｜失敗 '+failCount+'｜略過 '+skipCount;
    }
    state.screenHistory=[{time:new Date().toLocaleString('zh-TW'),poolLabel:poolLabelByValue(criteria.universe),count:rows.length,filters:formatScreenCriteria(criteria)}].concat(state.screenHistory||[]).slice(0,20);
    saveState(state);
    renderScreenerHistory();
  }finally{
    _screenScanJob.running=false;
    setScreenerRunning(false);
  }
}

function bindScreenerUI(){
  document.querySelectorAll('[data-screen-filter]').forEach(function(card){
    card.addEventListener('click',function(){card.classList.toggle('active');});
  });
  document.getElementById('screenUniverse')?.addEventListener('change',setScreenPoolHint);
  document.getElementById('screenCategoryType')?.addEventListener('change',populateScreenCategoryOptions);
  document.getElementById('screenCustomList')?.addEventListener('input',function(){state.screenCustomList=this.value; saveState(state);});
  document.getElementById('btnRunScreener')?.addEventListener('click',runScreener);
  document.getElementById('btnStopScreener')?.addEventListener('click',function(){
    if(!_screenScanJob.running)return;
    _screenScanJob.cancelled=true;
    const status=document.getElementById('screenRunStatus');
    if(status)status.textContent='已收到停止指令，將在目前批次結束後停止。';
  });
  document.getElementById('btnClearScreener')?.addEventListener('click',clearScreenerInputs);
  document.getElementById('btnClearScreenHistory')?.addEventListener('click',function(){state.screenHistory=[];saveState(state);renderScreenerHistory();});
  document.getElementById('btnToggleScreenAdv')?.addEventListener('click',function(){
    const p=document.getElementById('screenAdvPanel');
    if(!p)return;
    const show=!p.classList.contains('show');
    p.classList.toggle('show',show);
    this.textContent=show?'收合進階條件 ▲':'展開進階條件 ▼';
  });
  const ta=document.getElementById('screenCustomList');
  if(ta && state.screenCustomList && !ta.value)ta.value=state.screenCustomList;
  setScreenPoolHint();
  populateScreenCategoryOptions();
  renderScreenerHistory();
  setScreenerRunning(false);
}
function navigateToPage(page){
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  const target=document.getElementById('page-'+page);
  if(target)target.classList.add('active');
  document.querySelectorAll('#sideNav .side-item,#bottomNav .nav-item').forEach(function(btn){
    btn.classList.toggle('active',btn.dataset.page===page);
  });
  if(page==='aiReport' && typeof initAIReportPage==='function')initAIReportPage();
  if(page==='screener')renderScreenerHistory();
  window.scrollTo({top:0,behavior:'smooth'});
}
function bindPageNavigation(){
  window.__navigate=navigateToPage;
  document.querySelectorAll('#sideNav .side-item,#bottomNav .nav-item').forEach(function(btn){
    btn.addEventListener('click',function(){navigateToPage(btn.dataset.page);});
  });
}

// ═══════════════════════════════════════════════════════
//  AI 診斷報告 (v3.3) - 規則引擎版
// ═══════════════════════════════════════════════════════
const aiReportCache = {};

function calcMA(values, period){
  const out=new Array(values.length).fill(null);
  let sum=0;
  for(let i=0;i<values.length;i++){
    sum+=num(values[i])||0;
    if(i>=period)sum-=num(values[i-period])||0;
    if(i>=period-1)out[i]=parseFloat((sum/period).toFixed(2));
  }
  return out;
}

function renderAISymbolOptions(){
  const dl=document.getElementById('aiSymbols');
  if(!dl)return;
  const syms=[...new Set([...(state.watchlist||[]),...Object.keys(state.holdings||{})])].sort();
  dl.innerHTML=syms.map(function(s){
    const n=getStockName(s)||'';
    return '<option value="'+s+'">'+s+(n?' '+n:'')+'</option>';
  }).join('');
}

async function fetchAIReportData(symbol){
  symbol=normalizeSymbol(symbol);
  if(!symbol)return null;
  const cached=aiReportCache[symbol];
  if(cached&&Date.now()-cached.ts<15*60*1000)return cached.data;
  const start=daysAgo(150);
  const url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id='+encodeURIComponent(symbol)+'&start_date='+start+'&token='+encodeURIComponent(_r());
  const r=await timedFetch(url,12000);
  if(!r.ok)throw new Error('AI 資料讀取失敗');
  const j=await r.json();
  let arr=(j&&j.data)||[];
  arr=arr.map(function(it){
    return {
      date:String(it.date||''),
      open:num(it.open||it.Open||it.start_price),
      high:num(it.max||it.high||it.High||it.max_price),
      low:num(it.min||it.low||it.Low||it.min_price),
      close:num(it.close||it.Close||it.end_price),
      volume:num(it.Trading_Volume||it.trading_volume||it.volume||it.TradingShares||0)
    };
  }).filter(function(it){return it.date&&it.close>0;}).sort(function(a,b){return a.date.localeCompare(b.date);});
  aiReportCache[symbol]={ts:Date.now(),data:arr};
  return arr;
}

function _aiColor(isUp){return isUp?'#ff4d4d':'#2ecc71';}

function analyzeAICandlePattern(rows){
  const last=rows[rows.length-1], prev=rows[rows.length-2]||last;
  const body=Math.abs(last.close-last.open);
  const range=Math.max(0.01,last.high-last.low);
  const upper=last.high-Math.max(last.open,last.close);
  const lower=Math.min(last.open,last.close)-last.low;
  const isBull=last.close>=last.open;
  if(body/range<0.18)return '近一日 K 線接近十字，代表多空拉鋸，短線方向尚未明朗，建議搭配後續量能與均線位置確認。';
  if(isBull&&body/range>0.62&&last.close>prev.close)return '近一日 K 線偏強，實體明顯且收在相對高位，代表短線買盤仍有延續性，可留意是否形成續攻。';
  if(!isBull&&body/range>0.62&&last.close<prev.close)return '近一日 K 線偏弱，實體黑K明顯，賣壓主導盤勢，若後續量能放大，短線仍需保守應對。';
  if(lower/range>0.35&&isBull)return '近一日出現下影線，低檔有承接，但尚未形成明確反轉，建議觀察是否站回短均線。';
  if(upper/range>0.35&&!isBull)return '近一日上影線較長，顯示上檔壓力仍在，若無法帶量突破，容易持續震盪整理。';
  return '近期 K 線呈現一般震盪結構，暫未出現極端轉折訊號，可配合均線與量價關係綜合判讀。';
}

function analyzeAIVolumePrice(rows){
  const last=rows[rows.length-1], prev=rows[rows.length-2]||last;
  const vols=rows.map(r=>r.volume||0);
  const avg5=(vols.slice(-6,-1).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(5,vols.length-1)))||0;
  const volRatio=avg5>0?(last.volume/avg5):1;
  const up=last.close>=prev.close;
  if(volRatio>=1.6&&up)return '今日屬於量增上漲，表示市場追價意願轉強，若股價同步站穩 MA20，通常有利延續波段攻勢。';
  if(volRatio>=1.6&&!up)return '今日出現放量下跌，代表賣壓明顯宣洩，短線風險升高，建議先觀察是否止跌再考慮布局。';
  if(volRatio<=0.75&&up)return '今日量縮上漲，屬於溫和墊高，代表籌碼相對穩定，但若後續無法補量，突破力道可能有限。';
  if(volRatio<=0.75&&!up)return '今日量縮下跌，代表市場追殺意願有限，但底部訊號仍未成形，較適合等待整理完成。';
  return '近期量價變化偏中性，尚未出現明顯爆量攻擊或恐慌性出貨，建議與均線方向一起觀察。';
}

function analyzeAIData(symbol, rows){
  const name=getStockName(symbol)||'';
  const sample=rows.slice(-60);
  const closes=sample.map(r=>r.close);
  const vols=sample.map(r=>r.volume||0);
  const ma5=calcMA(closes,5);
  const ma20=calcMA(closes,20);
  const ma60=calcMA(closes,60);
  const last=sample[sample.length-1];
  const prev=sample[sample.length-2]||last;
  const lastClose=last.close;
  const m5=ma5[ma5.length-1]||lastClose;
  const m20=ma20[ma20.length-1]||lastClose;
  const m60=ma60[ma60.length-1]||lastClose;
  const prevM5=ma5[ma5.length-2]||m5;
  const prevM20=ma20[ma20.length-2]||m20;
  const recent20=sample.slice(-20);
  const high20=Math.max.apply(null,recent20.map(r=>r.high||r.close));
  const low20=Math.min.apply(null,recent20.map(r=>r.low||r.close));
  let score=0;
  if(lastClose>m20)score+=2; else score-=2;
  if(m5>m20)score+=2; else score-=2;
  if(m20>m60)score+=2; else score-=1;
  if(m20>(ma20[ma20.length-6]||m20))score+=1; else score-=1;
  if(lastClose>=high20*0.985)score+=1;
  if(lastClose<=low20*1.015)score-=1;
  if(lastClose>prev.close)score+=1; else score-=1;
  const avg5v=(vols.slice(-6,-1).reduce((a,b)=>a+b,0)/Math.max(1,Math.min(5,vols.length-1)))||0;
  const volRatio=avg5v>0?(last.volume/avg5v):1;
  if(volRatio>1.4&&lastClose>prev.close)score+=1;
  if(volRatio>1.4&&lastClose<prev.close)score-=1;

  let regime='震盪';
  if(score>=5)regime='多方偏強';
  else if(score>=2)regime='多方整理';
  else if(score<=-5)regime='空方偏弱';
  else if(score<=-2)regime='空方整理';

  const comprehensiveScore=Math.max(0,Math.min(100,Math.round(((score+9)/19)*100)));
  const scoreLabel = comprehensiveScore>=80?'強勢偏多':comprehensiveScore>=65?'偏多觀察':comprehensiveScore>=45?'中性整理':comprehensiveScore>=30?'弱勢危險':'高風險';
  const scoreClass = comprehensiveScore>=65?'risk':comprehensiveScore>=45?'mid':'good';
  const cross = (prevM5<=prevM20&&m5>m20)?'黃金交叉':(prevM5>=prevM20&&m5<m20)?'死亡交叉':'無明確交叉';
  const holderTag = comprehensiveScore>=80?'續抱為主':comprehensiveScore>=65?'保守續抱':comprehensiveScore>=45?'逢高調節':comprehensiveScore>=30?'減碼觀察':'建議賣出';
  const entryTag  = comprehensiveScore>=80?'分批買入':comprehensiveScore>=65?'拉回布局':comprehensiveScore>=45?'等待突破':comprehensiveScore>=30?'觀望為主':'暫不買入';
  const holderAdvice = score>=5
    ? '趨勢維持多方結構，若已持有可先續抱，並以 MA20 作為波段防守；若跌破月線再考慮調節。'
    : score>=2
    ? '目前屬整理偏多，賣出上不必過度急躁，但若短線跌破 MA20，建議先小幅調節部位。'
    : score<=-5
    ? '走勢明顯轉弱，建議優先執行減碼或停損，避免在空方結構中持續承受回檔風險。'
    : '目前仍偏弱勢震盪，賣出建議以風險控管為主，逢反彈調節會比急著攤平更合適。';
  const entryAdvice = score>=5
    ? '目前結構偏強，買入可採分批布局，較適合等回測 MA5 或 MA20 不破時再切入。'
    : score>=2
    ? '目前仍有多方基礎，但買入時不宜躁進，較適合等待帶量突破近 20 日高點後再跟進。'
    : score<=-5
    ? '目前空方較強，買入勝率偏低，不建議急著接刀，宜先觀望等待止跌訊號。'
    : '目前方向仍不明確，買入建議以觀望為主，待趨勢與量能同步改善後再提高勝率。';

  const techSummary = '【'+regime+'】股價'+(lastClose>m20?'站上':'跌破')+'月線，MA5 '+(m5>m20?'位於':'跌破')+' MA20，'+cross+'；近20日區間約 '+formatPrice(low20)+' ～ '+formatPrice(high20)+'，目前收盤 '+formatPrice(lastClose)+'。';
  const candlePattern = analyzeAICandlePattern(sample);
  const volumePrice = analyzeAIVolumePrice(sample);
  const indicatorHtml = [
    '<span class="ai-indi-chip">收盤 '+formatPrice(lastClose)+'</span>',
    '<span class="ai-indi-chip">MA5 '+formatPrice(m5)+'</span>',
    '<span class="ai-indi-chip">MA20 '+formatPrice(m20)+'</span>',
    '<span class="ai-indi-chip">MA60 '+formatPrice(m60)+'</span>',
    '<span class="ai-indi-chip">量比 '+(volRatio||1).toFixed(2)+'x</span>',
    '<span class="ai-indi-chip">交叉 '+cross+'</span>'
  ].join('');
  return {symbol,name,rows:sample,ma5,ma20,ma60,score,comprehensiveScore,scoreLabel,scoreClass,regime,holderTag,entryTag,holderAdvice,entryAdvice,techSummary,candlePattern,volumePrice,indicatorHtml,lastClose,m20};
}


const aiFundamentalCache = {};

async function fetchAIBWIBBU(symbol){
  symbol=normalizeSymbol(symbol);
  const date=getTWDateStr();
  const target='https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU?response=json&date='+date+'&stockNo='+encodeURIComponent(symbol);
  const urls=[target,'https://corsproxy.io/?'+encodeURIComponent(target),'https://api.allorigins.win/raw?url='+encodeURIComponent(target)];
  for(const url of urls){
    try{
      const r=await timedFetch(url,8000);
      if(!r.ok)continue;
      const txt=await r.text();
      if(!txt||txt.trim().startsWith('<'))continue;
      const j=JSON.parse(txt);
      if(j.stat!=='OK'||!Array.isArray(j.data)||!j.data.length)continue;
      const row=j.data[j.data.length-1]||[];
      return {dividendYield:num(row[1]), per:num(row[3]), pbr:num(row[4]), quarter:row[5]||''};
    }catch(e){}
  }
  return null;
}

async function fetchAIMonthRevenue(symbol){
  symbol=normalizeSymbol(symbol);
  const key='rev:'+symbol;
  if(aiFundamentalCache[key]&&Date.now()-aiFundamentalCache[key].ts<12*3600*1000)return aiFundamentalCache[key].data;
  try{
    const url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id='+encodeURIComponent(symbol)+'&start_date='+encodeURIComponent(daysAgo(620));
    const r=await timedFetch(url,12000);
    if(!r.ok)throw new Error('month revenue');
    const j=await r.json();
    const data=(j&&j.data)||[];
    aiFundamentalCache[key]={ts:Date.now(),data:data};
    return data;
  }catch(e){return [];}
}

async function fetchAIFinancialStatements(symbol){
  symbol=normalizeSymbol(symbol);
  const key='fs:'+symbol;
  if(aiFundamentalCache[key]&&Date.now()-aiFundamentalCache[key].ts<12*3600*1000)return aiFundamentalCache[key].data;
  try{
    const url='https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id='+encodeURIComponent(symbol)+'&start_date='+encodeURIComponent(daysAgo(1100));
    const r=await timedFetch(url,12000);
    if(!r.ok)throw new Error('fs');
    const j=await r.json();
    const data=(j&&j.data)||[];
    aiFundamentalCache[key]={ts:Date.now(),data:data};
    return data;
  }catch(e){return [];}
}

async function fetchAINews(symbol, name){
  symbol=normalizeSymbol(symbol);
  const key='news:'+symbol;
  if(aiFundamentalCache[key]&&Date.now()-aiFundamentalCache[key].ts<60*60*1000)return aiFundamentalCache[key].data;
  const q=encodeURIComponent((symbol+' '+(name||'')+' 訂單 EPS 營收 法說 台股').trim());
  const target='https://news.google.com/rss/search?q='+q+'&hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
  const urls=['https://corsproxy.io/?'+encodeURIComponent(target),'https://api.allorigins.win/raw?url='+encodeURIComponent(target),target];
  for(const url of urls){
    try{
      const r=await timedFetch(url,9000);
      if(!r.ok)continue;
      const xml=await r.text();
      if(!xml||xml.indexOf('<rss')===-1)continue;
      const doc=(new DOMParser()).parseFromString(xml,'text/xml');
      const items=[...doc.querySelectorAll('item')].slice(0,6).map(function(it){
        const t=(it.querySelector('title')?.textContent||'').replace(/\s*-\s*[^-]+$/,'').trim();
        const link=it.querySelector('link')?.textContent||'';
        return {title:t,link:link};
      }).filter(function(it){return it.title;});
      aiFundamentalCache[key]={ts:Date.now(),data:items};
      return items;
    }catch(e){}
  }
  return [];
}

function _pickQuarterEPS(rows){
  const map={};
  (rows||[]).forEach(function(r){
    const name=((r.origin_name||'')+' '+(r.type||'')).toLowerCase();
    if(name.indexOf('每股盈餘')===-1&&name.indexOf('基本每股盈餘')===-1&&name.indexOf('eps')===-1)return;
    const d=r.date||'';
    const v=num(r.value);
    if(!d||v===null)return;
    if(map[d]==null)map[d]=v;
  });
  return Object.keys(map).sort().map(function(d){return {date:d,value:map[d]};});
}

function _calcFundLabel(score){
  return score>=75?'體質穩健':score>=60?'基本面尚可':score>=45?'中性觀察':score>=30?'偏弱留意':'保守看待';
}

function _calcTotalLabel(score){
  return score>=80?'強勢偏多':score>=65?'偏多觀察':score>=45?'中性整理':score>=30?'弱勢危險':'高風險';
}

async function analyzeAIFundamental(symbol, name){
  const [bw, revRows, fsRows, newsRows] = await Promise.all([
    fetchAIBWIBBU(symbol),
    fetchAIMonthRevenue(symbol),
    fetchAIFinancialStatements(symbol),
    fetchAINews(symbol, name)
  ]);
  let score=50;
  const revs=(revRows||[]).slice().sort(function(a,b){return String(a.date).localeCompare(String(b.date));});
  const lastRev=revs[revs.length-1]||null;
  const prevRev=revs[revs.length-2]||null;
  let sameMonthPrevYear=null;
  if(lastRev){
    sameMonthPrevYear = revs.filter(function(r){return r.revenue_month===lastRev.revenue_month && r.revenue_year===lastRev.revenue_year-1;}).slice(-1)[0]||null;
  }
  const revYoY=(lastRev&&sameMonthPrevYear&&num(sameMonthPrevYear.revenue)>0)?((num(lastRev.revenue)-num(sameMonthPrevYear.revenue))/num(sameMonthPrevYear.revenue)*100):null;
  const revMoM=(lastRev&&prevRev&&num(prevRev.revenue)>0)?((num(lastRev.revenue)-num(prevRev.revenue))/num(prevRev.revenue)*100):null;
  if(revYoY!=null){ if(revYoY>=20)score+=12; else if(revYoY>=10)score+=8; else if(revYoY>=0)score+=4; else if(revYoY<=-20)score-=12; else if(revYoY<=-10)score-=8; else score-=4; }
  if(revMoM!=null){ if(revMoM>=10)score+=6; else if(revMoM>=0)score+=3; else if(revMoM<=-10)score-=6; else if(revMoM<0)score-=3; }

  const epsQs=_pickQuarterEPS(fsRows);
  const ttmEPS=epsQs.slice(-4).reduce(function(a,b){return a+(num(b.value)||0);},0);
  const prevTTMEPS=epsQs.length>=8?epsQs.slice(-8,-4).reduce(function(a,b){return a+(num(b.value)||0);},0):null;
  const epsYoY=(prevTTMEPS!==null&&Math.abs(prevTTMEPS)>0)?((ttmEPS-prevTTMEPS)/Math.abs(prevTTMEPS)*100):null;
  if(ttmEPS>20)score+=15; else if(ttmEPS>10)score+=10; else if(ttmEPS>0)score+=5; else score-=15;
  if(epsYoY!=null){ if(epsYoY>=20)score+=12; else if(epsYoY>=0)score+=6; else if(epsYoY<=-20)score-=12; else if(epsYoY<0)score-=6; }

  const per=bw&&bw.per!=null?bw.per:null;
  const pbr=bw&&bw.pbr!=null?bw.pbr:null;
  const dy=bw&&bw.dividendYield!=null?bw.dividendYield:null;
  if(per!=null){ if(per>0&&per<=25)score+=8; else if(per<=35)score+=4; else score-=4; }
  if(pbr!=null){ if(pbr>0&&pbr<=3)score+=5; else if(pbr<=6)score+=2; else score-=3; }
  if(dy!=null){ if(dy>=4)score+=6; else if(dy>=2)score+=3; else if(dy>0)score+=1; }

  const posWords=['訂單','接單','法說','擴產','增產','營收創高','創高','合作','上修','調升','AI','獲利','成長'];
  const negWords=['砍單','下修','調降','虧損','衰退','下滑','疲弱','利空','裁員','停工'];
  let newsBias=0;
  (newsRows||[]).forEach(function(n){
    const t=(n.title||'');
    posWords.forEach(function(w){if(t.indexOf(w)!==-1)newsBias+=1;});
    negWords.forEach(function(w){if(t.indexOf(w)!==-1)newsBias-=1;});
  });
  if(newsBias>=4)score+=10; else if(newsBias>=2)score+=6; else if(newsBias<=-4)score-=10; else if(newsBias<=-2)score-=6;

  score=Math.max(0,Math.min(100,Math.round(score)));
  const label=_calcFundLabel(score);
  const scoreClass=score>=65?'risk':score>=45?'mid':'good';
  const revPart=revYoY==null?'最新月營收資料不足。':'最新月營收年增 '+(revYoY>=0?'+':'')+revYoY.toFixed(1)+'%，月增 '+((revMoM||0)>=0?'+':'')+(revMoM==null?0:revMoM).toFixed(1)+'%。';
  const epsPart=epsQs.length>=4?'近四季 EPS 合計 '+ttmEPS.toFixed(2)+(epsYoY!=null?'，相較前四季 '+(epsYoY>=0?'+':'')+epsYoY.toFixed(1)+'%。':'。'):'EPS 資料不足，暫以營收與估值判讀。';
  const newsPart=(newsRows||[]).length?('近期消息面'+(newsBias>=2?'偏多':newsBias<=-2?'偏空':'中性')+'，以標題關鍵字做輔助判斷。'):'近期未取得足夠新聞，消息面權重降低。';
  const metrics = [
    {label:'月營收年增', value:revYoY==null?'—':(revYoY>=0?'+':'')+revYoY.toFixed(1)+'%'},
    {label:'月營收月增', value:revMoM==null?'—':(revMoM>=0?'+':'')+revMoM.toFixed(1)+'%'},
    {label:'近四季 EPS', value:epsQs.length>=4?ttmEPS.toFixed(2):'—'},
    {label:'EPS 趨勢', value:epsYoY==null?'—':(epsYoY>=0?'+':'')+epsYoY.toFixed(1)+'%'},
    {label:'本益比', value:per==null?'—':per},
    {label:'殖利率', value:dy==null?'—':dy+'%'},
    {label:'股價淨值比', value:pbr==null?'—':pbr},
    {label:'消息面', value:newsBias>=2?'偏多':newsBias<=-2?'偏空':'中性'}
  ];
  return {score,label,scoreClass,summary:revPart+' '+epsPart+' '+newsPart,metrics,newsRows:(newsRows||[]).slice(0,3),newsBias,orderHint:newsBias>=2?'利多/接單關鍵字偏多':newsBias<=-2?'利空關鍵字偏多':'未見明顯訂單偏向'};
}

function renderAIChart(report){
  const cvs=document.getElementById('aiTrendCanvas');
  if(!cvs||!report||!report.rows||!report.rows.length)return;
  const rect=cvs.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const w=Math.max(320,Math.floor((rect.width||cvs.parentElement.clientWidth||640)*dpr));
  const h=Math.max(180,Math.floor((rect.height||180)*dpr));
  cvs.width=w;cvs.height=h;
  const ctx=cvs.getContext('2d');
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#111827';ctx.fillRect(0,0,w,h);
  const pad={l:44*dpr,r:18*dpr,t:14*dpr,b:24*dpr};
  const plotW=w-pad.l-pad.r, plotH=h-pad.t-pad.b;
  const vals=[];
  report.rows.forEach((r,i)=>{vals.push(r.close); if(report.ma5[i]!=null)vals.push(report.ma5[i]); if(report.ma20[i]!=null)vals.push(report.ma20[i]);});
  const minV=Math.min.apply(null,vals)*0.98;
  const maxV=Math.max.apply(null,vals)*1.02;
  const yOf=v=>pad.t + (maxV-v)/(maxV-minV||1)*plotH;
  const xOf=i=>pad.l + (i/(report.rows.length-1||1))*plotW;
  ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.lineWidth=1*dpr;
  for(let g=0;g<4;g++){
    const y=pad.t + g*(plotH/3);
    ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(w-pad.r,y); ctx.stroke();
  }
  ctx.fillStyle='rgba(255,255,255,.55)'; ctx.font=(11*dpr)+'px sans-serif';
  [maxV,(maxV+minV)/2,minV].forEach(function(v,idx){
    const y=pad.t + idx*(plotH/2);
    ctx.fillText(formatPrice(v),4*dpr,y+4*dpr);
  });
  function drawSeries(arr,color,dashed){
    ctx.save();
    ctx.strokeStyle=color; ctx.lineWidth=2*dpr;
    if(dashed)ctx.setLineDash([5*dpr,4*dpr]);
    ctx.beginPath();
    let started=false;
    for(let i=0;i<arr.length;i++){
      const v=arr[i]; if(v==null)continue;
      const x=xOf(i), y=yOf(v);
      if(!started){ctx.moveTo(x,y); started=true;} else ctx.lineTo(x,y);
    }
    ctx.stroke(); ctx.restore();
  }
  drawSeries(report.rows.map(r=>r.close),'#60a5fa',false);
  drawSeries(report.ma5,'#fbbf24',true);
  drawSeries(report.ma20,'#34d399',false);
  ctx.fillStyle='rgba(255,255,255,.45)';
  const labels=[report.rows[0].date, report.rows[Math.floor(report.rows.length/2)].date, report.rows[report.rows.length-1].date];
  [0,0.5,1].forEach(function(p,idx){
    const x=pad.l + plotW*p;
    ctx.fillText(labels[idx].replace(/\d{4}-/,'').replace('-','/'),x-18*dpr,h-6*dpr);
  });
}

function renderAIReport(report){
  const title='🤖 AI 診斷報告';
  const chartTitle='📈 近期走勢圖（近60日）';
  document.getElementById('aiReportTitle').textContent=title;
  const focus=document.getElementById('aiQueryFocus');
  if(focus){
    focus.innerHTML='<div class="ai-query-main">'
      +'<span class="ai-query-badge">'+report.symbol+'</span>'
      +'<div><div class="ai-query-name">'+(report.name||'未命名股票')+'</div><div class="ai-query-sub">AI 診斷對象｜'+report.regime+'｜技術 '+report.technicalScore+'｜基本面 '+((report.fundamental&&report.fundamental.score)||0)+'</div></div>'
      +'</div>'
      +'<div class="ai-score-pill '+report.scoreClass+'">綜合評分：'+report.comprehensiveScore+'分（'+report.scoreLabel+'）</div>';
    focus.classList.add('show');
  }
  document.getElementById('aiChartTitle').textContent=chartTitle;
  document.getElementById('aiHolderTitle').textContent='💼 賣出建議';
  document.getElementById('aiEntryTitle').textContent='🛒 買入建議';
  document.getElementById('aiHolderTag').textContent=report.holderTag;
  document.getElementById('aiEntryTag').textContent=report.entryTag;
  document.getElementById('aiHolderAdvice').textContent=report.holderAdvice;
  document.getElementById('aiEntryAdvice').textContent=report.entryAdvice;
  document.getElementById('aiTechSummary').textContent=report.techSummary;
  document.getElementById('aiCandlePattern').textContent=report.candlePattern;
  document.getElementById('aiVolumePrice').textContent=report.volumePrice;
  document.getElementById('aiIndicatorBar').innerHTML=report.indicatorHtml;
  if(report.fundamental){
    var fs=document.getElementById('aiFundScore');
    var fsum=document.getElementById('aiFundSummary');
    var fm=document.getElementById('aiFundMetrics');
    var ns=document.getElementById('aiNewsSummary');
    var nl=document.getElementById('aiNewsList');
    if(fs)fs.innerHTML='<span class="ai-score-pill '+report.fundamental.scoreClass+'">'+report.fundamental.score+'分</span> <span style="font-size:.92rem;font-weight:800;margin-left:8px;">'+report.fundamental.label+'</span>';
    if(fsum)fsum.textContent=report.fundamental.summary;
    if(fm)fm.innerHTML=(report.fundamental.metrics||[]).map(function(m){
      var cls='orange';
      var v=String(m.value||'—');
      if(v.indexOf('+')!==-1||v==='偏多')cls='red';
      if(v.indexOf('-')!==-1||v==='偏空')cls='green';
      return '<span class="ai-fund-chip '+cls+'">'+m.label+'：'+v+'</span>';
    }).join('');
    if(ns)ns.textContent='消息面判讀：'+report.fundamental.orderHint+'。';
    if(nl)nl.innerHTML=(report.fundamental.newsRows||[]).length?(report.fundamental.newsRows||[]).map(function(it){return '<div class="ai-news-item">'+it.title+'</div>';}).join(''):'<div class="ai-news-item">暫未取得足夠新聞標題，消息面目前僅作輔助，不單獨主導評分。</div>';
  }
  document.getElementById('aiReportOutput').style.display='block';
  renderAIChart(report);
}

async function generateAIReport(symbolArg){
  const input=document.getElementById('aiSymbol');
  const loading=document.getElementById('aiReportLoading');
  const out=document.getElementById('aiReportOutput');
  if(!input||!loading||!out)return;
  const symbol=normalizeSymbol(symbolArg||input.value||'');
  if(!symbol){showToast('❌ 請先輸入股票代號');return;}
  input.value=symbol;
  renderSymbolHint('aiSymbol','aiSymbolHint');
  loading.style.display='block';
  out.style.display='none';
  try{
    await fetchChineseName(symbol);
    const rows=await fetchAIReportData(symbol);
    if(!rows||rows.length<30)throw new Error('歷史資料不足');
    const report=analyzeAIData(symbol,rows);
    report.technicalScore=report.comprehensiveScore;
    report.technicalLabel=report.scoreLabel;
    report.fundamental=await analyzeAIFundamental(symbol, report.name||getStockName(symbol)||'');
    report.comprehensiveScore=Math.round((report.technicalScore||0)*0.6 + ((report.fundamental&&report.fundamental.score)||0)*0.4);
    report.scoreLabel=_calcTotalLabel(report.comprehensiveScore);
    report.scoreClass=report.comprehensiveScore>=65?'risk':report.comprehensiveScore>=45?'mid':'good';
    renderAIReport(report);
  }catch(e){
    showToast('❌ AI 診斷失敗：'+(e.message||'請稍後再試'));
  }finally{
    loading.style.display='none';
  }
}

function initAIReportPage(){
  renderAISymbolOptions();
  const input=document.getElementById('aiSymbol');
  if(!input)return;
  if(!input.value){
    input.value=normalizeSymbol(document.getElementById('tradeSymbol')?.value||state.watchlist?.[0]||Object.keys(state.holdings||{})[0]||'');
  }
  renderSymbolHint('aiSymbol','aiSymbolHint');
}

// ═══════════════════════════════════════════════════════
//  投資模擬試算 (v3.2)
// ═══════════════════════════════════════════════════════

function getHoldingScenarioItems(){
  return Object.keys(state.holdings||{}).sort().map(function(sym){
    var h=state.holdings[sym]||{};
    return {symbol:sym,shares:parseInt(h.shares||0,10)||0,avgPrice:num(h.avgPrice)||0,name:getStockName(sym)||''};
  }).filter(function(it){return it.shares>0;});
}
function renderScenarioHoldingOptions(){
  var sel=document.getElementById('scenarioHoldingSelect');
  if(!sel)return;
  var items=getHoldingScenarioItems();
  sel.innerHTML='<option value="">請選擇持股庫存（可自動帶入買入價與股數）</option>' + items.map(function(it){
    return '<option value="'+it.symbol+'">'+it.symbol+(it.name?' '+it.name:'')+'｜'+it.shares+'股｜均價 '+formatPrice(it.avgPrice)+'</option>';
  }).join('');
}
function fillScenarioFromHolding(symbol, keepExit){
  var sym=normalizeSymbol(symbol||'');
  var h=(state.holdings||{})[sym];
  var hint=document.getElementById('scenarioHoldingHint');
  if(!h){
    if(hint)hint.textContent='目前選取的代號不在持股庫存中，可手動輸入買入價、股數與賣出價進行試算。';
    return false;
  }
  var avg=num(h.avgPrice)||0;
  var shares=parseInt(h.shares||0,10)||0;
  var inpSym=document.getElementById('scenarioSymbol');
  var inpEntry=document.getElementById('scenarioEntryPrice');
  var inpShares=document.getElementById('scenarioShares');
  var sel=document.getElementById('scenarioHoldingSelect');
  if(inpSym)inpSym.value=sym;
  if(inpEntry&&avg>0)inpEntry.value=avg.toFixed(2);
  if(inpShares&&shares>0)inpShares.value=shares;
  if(sel)sel.value=sym;
  if(hint)hint.textContent='已從持股庫存帶入：'+sym+(getStockName(sym)?' '+getStockName(sym):'')+'，均價 '+formatPrice(avg)+'，股數 '+shares+' 股。請手動輸入賣出價進行試算。';
  _scenarioUpdateSymbolLabel();
  if(!keepExit){
    var exit=document.getElementById('scenarioExitPrice');
    if(exit)exit.value='';
  }
  calculateScenarioProfit();
  return true;
}
function syncScenarioHoldingSelect(){
  var sym=normalizeSymbol(document.getElementById('scenarioSymbol')?.value||'');
  var sel=document.getElementById('scenarioHoldingSelect');
  if(sel)sel.value=(state.holdings&&state.holdings[sym])?sym:'';
}

function renderScenarioSymbolOptions(){
  var dl=document.getElementById('scenarioSymbols');
  if(!dl)return;
  var syms=[...new Set([...(state.watchlist||[]),...Object.keys(state.holdings||{})])].sort();
  dl.innerHTML=syms.map(function(s){
    var n=getStockName(s)||'';
    return '<option value="'+s+'">'+s+(n?' '+n:'')+'</option>';
  }).join('');
}
function _scenarioUpdateSymbolLabel(){
  var inp=document.getElementById('scenarioSymbol');
  var lbl=document.getElementById('scenarioSymbolName');
  var hint=document.getElementById('scenarioHoldingHint');
  if(!inp||!lbl)return;
  var sym=normalizeSymbol(inp.value||'');
  inp.value=sym;
  var n=sym?getStockName(sym):'';
  lbl.textContent=sym?(n?(sym+' '+n):(sym+' 載入名稱中…')):'請輸入股票代號';
  syncScenarioHoldingSelect();
  var h=(state.holdings||{})[sym];
  if(hint){
    if(sym&&h)hint.textContent='此代號在持股庫存中，均價 '+formatPrice(h.avgPrice)+'，股數 '+h.shares+' 股，可一鍵帶入試算。';
    else if(sym)hint.textContent='目前選取的代號不在持股庫存中，可手動輸入買入價、股數與賣出價進行試算。';
    else hint.textContent='若選擇已持有股票，系統會自動帶入均價與股數，你只需輸入賣出價即可試算。';
  }
  if(sym&&!n){
    fetchChineseName(sym).then(function(){
      var cur=document.getElementById('scenarioSymbolName');
      if(cur){
        var nm=getStockName(sym)||'';
        cur.textContent=nm?(sym+' '+nm):sym;
      }
      renderScenarioSymbolOptions();
      renderScenarioHoldingOptions();
    });
  }
}
function _scenarioReset(){
  ['scenarioBuyCost','scenarioSellNet','scenarioProfit','scenarioRoi','scenarioFeeNote'].forEach(function(id){
    var el=document.getElementById(id);if(el){el.textContent='—';el.style.color='';}
  });
  var btn=document.getElementById('btnApplyScenario');
  if(btn)btn.disabled=true;
  var bar=document.getElementById('scenarioBar');
  if(bar)bar.style.setProperty('--bar-pct','0%');
}
function calculateScenarioProfit(){
  var sym=normalizeSymbol(document.getElementById('scenarioSymbol')?.value||'');
  var shares=parseInt(document.getElementById('scenarioShares')?.value||'0',10);
  var entry=num(document.getElementById('scenarioEntryPrice')?.value);
  var exit=num(document.getElementById('scenarioExitPrice')?.value);
  _scenarioUpdateSymbolLabel();
  if(!sym||!shares||shares<1||!entry||entry<=0||!exit||exit<=0){_scenarioReset();return null;}
  var discount=state?.feeDiscount??0.6;
  var buyAmt=entry*shares;
  var buyFee=Math.floor(buyAmt*0.001425*discount);
  var buyCost=buyAmt+buyFee;
  var sellAmt=exit*shares;
  var sellFee=Math.floor(sellAmt*0.001425*discount);
  var taxRate=getSellTaxRate(sym);
  var sellTax=Math.floor(sellAmt*taxRate);
  var sellNet=sellAmt-sellFee-sellTax;
  var profit=sellNet-buyCost;
  var roi=buyCost>0?(profit/buyCost*100):0;
  var pEl=document.getElementById('scenarioProfit');
  var rEl=document.getElementById('scenarioRoi');
  var bEl=document.getElementById('scenarioBuyCost');
  var sEl=document.getElementById('scenarioSellNet');
  var nEl=document.getElementById('scenarioFeeNote');
  var bar=document.getElementById('scenarioBar');
  if(bEl)bEl.textContent='$'+formatMoney(buyCost);
  if(sEl)sEl.textContent='$'+formatMoney(sellNet);
  if(pEl){pEl.textContent=(profit>=0?'+':'')+formatMoney(profit)+'元';pEl.style.color=profit>=0?'#ff4d4d':'#2ecc71';}
  if(rEl){rEl.textContent=(roi>=0?'+':'')+roi.toFixed(2)+'%';rEl.style.color=roi>=0?'#ff4d4d':'#2ecc71';}
  if(nEl)nEl.textContent='已扣除所有稅費 | 折數 '+discount+' | '+(isETF(sym)?'ETF稅0.1%':'股票稅0.3%');
  if(bar){bar.style.setProperty('--bar-pct',Math.min(Math.abs(roi),30)/30*100+'%');bar.style.background=profit>=0?'linear-gradient(90deg,#ff4d4d,#ff7676)':'linear-gradient(90deg,#2ecc71,#52d68a)';}
  var btn=document.getElementById('btnApplyScenario');
  if(btn)btn.disabled=false;
  return{sym,shares,entry,exit,buyCost,sellNet,profit,roi};
}
function openScenarioModal(){
  var modal=document.getElementById('scenarioModal');
  if(!modal)return;
  var sym=normalizeSymbol(document.getElementById('tradeSymbol')?.value||'');
  var qty=document.getElementById('tradeQty')?.value||'';
  var pr=num(document.getElementById('tradePrice')?.value)||null;
  renderScenarioSymbolOptions();
  renderScenarioHoldingOptions();
  if(sym)document.getElementById('scenarioSymbol').value=sym;
  if(qty)document.getElementById('scenarioShares').value=qty;
  if(pr){document.getElementById('scenarioEntryPrice').value=pr.toFixed(2);}
  else if(sym&&quoteCache[sym]?.data?.price){document.getElementById('scenarioEntryPrice').value=quoteCache[sym].data.price.toFixed(2);}
  _scenarioUpdateSymbolLabel();
  calculateScenarioProfit();
  modal.style.display='flex';
  modal.classList.add('show');
}
function openHoldingScenarioModal(){
  var modal=document.getElementById('scenarioModal');
  if(!modal)return;
  renderScenarioSymbolOptions();
  renderScenarioHoldingOptions();
  var sym=normalizeSymbol(document.getElementById('tradeSymbol')?.value||'');
  var items=getHoldingScenarioItems();
  if((!sym||!state.holdings[sym])&&items.length)sym=items[0].symbol;
  if(!sym||!state.holdings[sym]){showToast('❌ 目前沒有持股庫存可帶入');openScenarioModal();return;}
  fillScenarioFromHolding(sym,false);
  modal.style.display='flex';
  modal.classList.add('show');
  setTimeout(function(){document.getElementById('scenarioExitPrice')?.focus();},50);
}
function closeScenarioModal(){
  var modal=document.getElementById('scenarioModal');
  if(modal){modal.style.display='none';modal.classList.remove('show');}
}
function applyScenarioToTrade(){
  var s=calculateScenarioProfit();
  if(!s)return;
  var symEl=document.getElementById('tradeSymbol');
  var qtyEl=document.getElementById('tradeQty');
  var prEl=document.getElementById('tradePrice');
  if(symEl)symEl.value=s.sym;
  if(qtyEl)qtyEl.value=s.shares;
  if(prEl)prEl.value=s.entry.toFixed(2);
  updateFeePreview();
  closeScenarioModal();
  var pg=document.getElementById('page-trade');
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active');});
  if(pg)pg.classList.add('active');
  document.querySelectorAll('#sideNav .side-item,#bottomNav .nav-item').forEach(function(b){
    b.classList.toggle('active',b.dataset.page==='trade');
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  updateLastSavedLabel();
  initTabs();
  bindPageNavigation();
  bindScreenerUI();

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
  bindSymbolAutocomplete('tradeSymbol','tradeSymbolSuggest','tradeSymbolHint');
  bindSymbolAutocomplete('searchInput','searchInputSuggest','searchInputHint');
  bindSymbolAutocomplete('aiSymbol','aiSymbolSuggest','aiSymbolHint');
  bindSymbolAutocomplete('scenarioSymbol','scenarioSymbolSuggest','scenarioSymbolName');
  document.getElementById('tradeSymbol').addEventListener('blur',()=>{
    document.getElementById('tradeSymbol').value=normalizeSymbol(document.getElementById('tradeSymbol').value);
  });
  document.getElementById('tradeQty').addEventListener('keydown',e=>{if(e.key==='Enter')executeTrade('buy');});
  document.getElementById('btnGenAIReport')?.addEventListener('click',function(){generateAIReport();});
  document.getElementById('aiSymbol')?.addEventListener('keydown',function(e){if(e.key==='Enter')generateAIReport();});
  document.getElementById('btnOpenScenario')?.addEventListener('click',openScenarioModal);
  document.getElementById('btnHoldingScenario')?.addEventListener('click',openHoldingScenarioModal);
  document.getElementById('btnCloseScenario')?.addEventListener('click',closeScenarioModal);
  document.getElementById('btnApplyScenario')?.addEventListener('click',applyScenarioToTrade);
  document.getElementById('scenarioModal')?.addEventListener('click',function(e){if(e.target===this)closeScenarioModal();});
  ['scenarioSymbol','scenarioShares','scenarioEntryPrice','scenarioExitPrice'].forEach(function(id){
    document.getElementById(id)?.addEventListener('input',calculateScenarioProfit);
  });
  document.getElementById('scenarioHoldingSelect')?.addEventListener('change',function(){
    if(this.value)fillScenarioFromHolding(this.value,true);
    else _scenarioUpdateSymbolLabel();
  });
  document.getElementById('scenarioSymbol')?.addEventListener('change',function(){
    var sym=normalizeSymbol(this.value||'');
    if(sym&&state.holdings&&state.holdings[sym])fillScenarioFromHolding(sym,true);
    else _scenarioUpdateSymbolLabel();
  });

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
  renderScreenerHistory();
  refreshAllSymbolHints();
  setTimeout(()=>{renderCharts();recordAssetSnapshot();},800);

  // [v2.6] 統一智慧調度器，取代原本雙 Timer
  startSmartScheduler();
  // 初次載入時手動觸發一次報價
  fetchPriceBatch();
  preloadStockNames();
  checkDividends();
});


/* v3.9.1 hotfix */
(function(){
  var HOTFIX_VER = 'v3.9.1';
  var __origAnalyzeAIFundamentals = (typeof analyzeAIFundamentals === 'function') ? analyzeAIFundamentals : null;
  var __hotfixApplied = false;

  function hotfixText(id, value){
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  function hotfixHtml(id, value){
    var el = document.getElementById(id);
    if (el) el.innerHTML = value;
  }
  function cloneRebind(el){
    if (!el || !el.parentNode) return el;
    var clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }
  function bindClickById(id, handler){
    var el = document.getElementById(id);
    if (!el) return null;
    el = cloneRebind(el);
    if (handler) el.addEventListener('click', handler);
    return el;
  }
  function bindEnterById(id, handler){
    var el = document.getElementById(id);
    if (!el) return null;
    el = cloneRebind(el);
    if (handler) {
      el.addEventListener('keydown', function(e){ if (e.key === 'Enter') handler(e); });
    }
    return el;
  }
  function renderFundMetrics(metrics){
    if (!Array.isArray(metrics) || !metrics.length) return '暫無資料';
    return metrics.map(function(m){
      if (typeof m === 'string') return '<div>' + m + '</div>';
      var label = m && m.label != null ? m.label : '指標';
      var value = m && m.value != null ? m.value : '—';
      var cls = m && m.tone === 'positive' ? ' class="ai-fund-chip red"' : (m && m.tone === 'negative' ? ' class="ai-fund-chip green"' : ' class="ai-fund-chip orange"');
      return '<div><span' + cls + '>' + label + '</span> ' + value + '</div>';
    }).join('');
  }
  function renderNewsList(news){
    if (!Array.isArray(news) || !news.length) return '<div class="ai-news-item">近期未抓到可用新聞。</div>';
    return news.slice(0, 6).map(function(it){
      var title = (it && it.title) ? String(it.title) : '新聞';
      var link = (it && it.link) ? String(it.link) : '';
      return '<a class="ai-news-item" href="' + link + '" target="_blank" rel="noopener noreferrer">' + title + '</a>';
    }).join('');
  }
  function patchRenderAIReportForETF(){
    var __origRenderAIReport = (typeof renderAIReport === 'function') ? renderAIReport : null;
    if (!__origRenderAIReport || __origRenderAIReport.__v391patched) return;
    renderAIReport = function(report){
      __origRenderAIReport(report);
      if (!report || !report.symbol || !(typeof isETF === 'function' && isETF(report.symbol))) return;
      var f = report.fundamental || {};
      hotfixText('aiFundScore', (f.score != null ? f.score : 55) + '／100');
      hotfixText('aiFundSummary', f.summary || 'ETF 不適用 EPS / 月營收評分，改以殖利率與市場資訊中性呈現。');
      hotfixHtml('aiFundMetrics', renderFundMetrics(f.metrics));
      hotfixText('aiNewsSummary', f.newsSummary || '可搭配折溢價、成分股與配息政策一起判讀。');
      hotfixHtml('aiNewsList', renderNewsList(f.news));
    };
    renderAIReport.__v391patched = true;
  }

  if (__origAnalyzeAIFundamentals && !__origAnalyzeAIFundamentals.__v391patched) {
    analyzeAIFundamentals = async function(symbol, name){
      symbol = typeof normalizeSymbol === 'function' ? normalizeSymbol(symbol) : symbol;
      if (typeof isETF === 'function' && isETF(symbol)) {
        var bw = null, newsRows = [];
        try { bw = await fetchAIBWIBBU(symbol); } catch(e) {}
        try { newsRows = await fetchAINews(symbol, name || (typeof getStockName === 'function' ? getStockName(symbol) : symbol) || symbol); } catch(e) {}
        var score = 55;
        return {
          score: score,
          label: (typeof calcFundLabel === 'function') ? calcFundLabel(score) : '中性',
          summary: 'ETF 不適用個股 EPS 與月營收模型，因此改以 ETF 身分中性呈現，避免被錯誤扣分。',
          metrics: [
            { label: '資產類型', value: 'ETF', tone: 'neutral' },
            { label: 'EPS', value: '不適用', tone: 'neutral' },
            { label: '月營收', value: '不適用', tone: 'neutral' },
            { label: '殖利率', value: (bw && bw.dividendYield != null) ? (Number(bw.dividendYield).toFixed(2) + '%') : '—', tone: 'neutral' },
            { label: '本益比', value: (bw && bw.per != null) ? Number(bw.per).toFixed(2) : '—', tone: 'neutral' },
            { label: '股價淨值比', value: (bw && bw.pbr != null) ? Number(bw.pbr).toFixed(2) : '—', tone: 'neutral' }
          ],
          newsSummary: (Array.isArray(newsRows) && newsRows.length)
            ? '已抓到 ETF 相關新聞，建議搭配成分、折溢價與配息政策一起看。'
            : '近期未抓到代表性 ETF 新聞，可自行搭配成分股與折溢價觀察。',
          news: Array.isArray(newsRows) ? newsRows : []
        };
      }
      return __origAnalyzeAIFundamentals(symbol, name);
    };
    analyzeAIFundamentals.__v391patched = true;
  }

  runScreener = async function(){
    var status = document.getElementById('screenRunStatus');
    var summary = document.getElementById('screenResultSummary');
    var empty = document.getElementById('screenResultEmpty');
    if (screenScanJob.running) {
      if (typeof notifyScreenIssue === 'function') return notifyScreenIssue('pending', '');
      return;
    }
    var criteria = getScreenerCriteria();
    if (criteria.universe === 'allStocks' && typeof canUseAllStocks === 'function' && !canUseAllStocks()) {
      if (typeof notifyScreenIssue === 'function') notifyScreenIssue('adminOnly', '');
      return;
    }
    var symbols = await getScreenerUniverse(criteria);
    if (!symbols.length) {
      if (status) status.textContent = '沒有可掃描的股票池';
      if (summary) summary.textContent = '';
      var body = document.getElementById('screenResultBody');
      if (body) body.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (symbols.length > SCREENSCANHARDLIMIT) {
      if (typeof notifyScreenIssue === 'function') notifyScreenIssue('hardLimit', '');
      return;
    }
    if (symbols.length > SCREENSCANSOFTLIMIT && typeof canUseWideRange === 'function' && !canUseWideRange()) {
      if (typeof notifyScreenIssue === 'function') notifyScreenIssue('generalLimit', '');
      return;
    }
    if (symbols.length > SCREENSCANSOFTLIMIT && typeof canUseWideRange === 'function' && canUseWideRange()) {
      if (!confirm((typeof getScreenMessage === 'function' ? getScreenMessage('adminLargeConfirm') : '確認大範圍掃描？'))) {
        if (status) status.textContent = '已取消大範圍掃描';
        if (summary) summary.textContent = '';
        return;
      }
    }

    screenScanJob.running = true;
    screenScanJob.cancelled = false;
    setScreenerRunning(true);
    if (status) status.textContent = '掃描中：' + symbols.length + ' 檔';
    if (summary) summary.innerHTML = '<span class="screen-result-chip">股票池 ' + symbols.length + '</span><span class="screen-result-chip">每批 ' + SCREENBATCHSIZE + ' 檔，間隔 ' + SCREENBATCHDELAY + 'ms</span>';
    var body2 = document.getElementById('screenResultBody');
    if (body2) body2.innerHTML = '';
    if (empty) empty.style.display = 'none';

    var rows = [];
    var okCount = 0, failCount = 0, skipCount = 0;
    try {
      for (var i = 0; i < symbols.length; i++) {
        if (screenScanJob.cancelled) break;
        var symbol = (typeof normalizeSymbol === 'function') ? normalizeSymbol(symbols[i]) : symbols[i];
        if (status) status.textContent = '掃描中 ' + (i + 1) + '/' + symbols.length + '：' + symbol + '，成功 ' + okCount + '／失敗 ' + failCount + '／略過 ' + skipCount;
        try {
          var priceRows = await fetchAIReportData(symbol);
          if (!priceRows || priceRows.length < 30) { skipCount++; continue; }
          var tech = analyzeAIData(symbol, priceRows);
          var fund = await analyzeAIFundamentals(symbol, tech.name || (typeof getStockName === 'function' ? getStockName(symbol) : symbol));
          var closes = priceRows.map(function(r){ return r.close; });
          var vols = priceRows.map(function(r){ return num(r.volume || 0); });
          var last = priceRows[priceRows.length - 1];
          var avg5v = vols.slice(-6, -1).reduce(function(a, b){ return a + b; }, 0) / Math.max(1, Math.min(5, vols.length - 1));
          var volRatio = avg5v > 0 ? num(last.volume || 0) / avg5v : null;
          var rsi = calcRSI(closes, 14);
          var totalScore = Math.round((num(tech.comprehensiveScore) || 0) * 0.6 + (num(fund.score) || 0) * 0.4);
          var item = {
            symbol: symbol,
            name: tech.name || (typeof getStockName === 'function' ? getStockName(symbol) : symbol),
            price: num(last.close),
            ma20: num(tech.m20),
            techScore: num(tech.comprehensiveScore) || 0,
            fundScore: num(fund.score) || 0,
            totalScore: totalScore,
            rsi: rsi,
            volRatio: volRatio,
            revYoY: extractMetricValue(fund.metrics, '月營收 YoY') || extractMetricValue(fund.metrics, '營收 YoY'),
            ttmEPS: extractMetricValue(fund.metrics, 'TTM EPS') || extractMetricValue(fund.metrics, 'EPS'),
            tech: tech,
            fund: fund
          };
          okCount++;
          if (evaluateScreenResult(item, criteria)) rows.push(item);
        } catch (e) {
          failCount++;
          var msg = e && e.message ? String(e.message) : String(e);
          if (/429|rate limit|quota|too many/i.test(msg)) {
            screenScanJob.cancelled = true;
            break;
          }
        }
        if ((i + 1) % SCREENBATCHSIZE === 0 && i < symbols.length - 1) await sleep(SCREENBATCHDELAY);
      }

      var stats = { total: symbols.length, ok: okCount, failed: failCount, skipped: skipCount };
      renderScreenResults(rows, criteria, stats);
      screenLastResult = { rows: rows.slice(), criteria: criteria, stats: stats, generatedAt: new Date().toISOString() };
      if (screenScanJob.cancelled) {
        if (status) status.textContent = '掃描已停止，成功 ' + okCount + '／失敗 ' + failCount + '／略過 ' + skipCount + '／總數 ' + symbols.length;
        if (failCount > 0 && okCount === 0 && typeof getScreenMessage === 'function') alert(getScreenMessage('rateLimited'));
        else if (typeof getScreenMessage === 'function') alert(getScreenMessage('stopped'));
      } else {
        if (status) status.textContent = '掃描完成：股票池 ' + symbols.length + '，命中 ' + rows.length + '，成功 ' + okCount + '，失敗 ' + failCount + '，略過 ' + skipCount;
        if (failCount > 0 && typeof getScreenMessage === 'function') alert(getScreenMessage('partial'));
      }
      state.screenHistory = [{
        time: new Date().toLocaleString('zh-TW'),
        poolLabel: (typeof poolLabelByValue === 'function') ? poolLabelByValue(criteria.universe) : criteria.universe,
        count: rows.length,
        filters: formatScreenCriteria(criteria)
      }].concat(state.screenHistory || []).slice(0, 20);
      saveState(state);
      renderScreenerHistory();
    } finally {
      screenScanJob.running = false;
      setScreenerRunning(false);
    }
  };

  bindScreenerUI = function(){
    document.querySelectorAll('[data-screen-filter]').forEach(function(card){
      card = cloneRebind(card);
      card.addEventListener('click', function(){ card.classList.toggle('active'); });
    });

    var universe = document.getElementById('screenUniverse');
    if (universe) {
      universe = cloneRebind(universe);
      universe.addEventListener('change', setScreenPoolHint);
    }
    var catType = document.getElementById('screenCategoryType');
    if (catType) {
      catType = cloneRebind(catType);
      catType.addEventListener('change', populateScreenCategoryOptions);
    }
    var custom = document.getElementById('screenCustomList');
    if (custom) {
      custom = cloneRebind(custom);
      custom.addEventListener('input', function(){ state.screenCustomList = this.value; saveState(state); });
      if (state.screenCustomList && !custom.value) custom.value = state.screenCustomList;
    }

    bindClickById('btnRunScreener', function(){ runScreener(); });
    bindClickById('btnStopScreener', function(){ if (!screenScanJob.running) return; screenScanJob.cancelled = true; hotfixText('screenRunStatus', '停止中…'); });
    bindClickById('btnExportScreenPdf', function(){ exportScreenerPdf(); });
    bindClickById('btnClearScreener', function(){ clearScreenerInputs(); });
    bindClickById('btnClearScreenHistory', function(){ state.screenHistory = []; saveState(state); renderScreenerHistory(); });
    bindClickById('btnToggleScreenAdv', function(){ var p = document.getElementById('screenAdvPanel'); if (!p) return; var show = !p.classList.contains('show'); p.classList.toggle('show', show); this.textContent = show ? '收合進階條件' : '展開進階條件'; });
    bindClickById('screenAdminEntry', function(){ openScreenAdminModal(); });
    bindClickById('btnScreenAdminCancel', function(){ closeScreenAdminModal(); });
    bindClickById('btnScreenAdminSubmit', function(){ submitScreenAdminUnlock(); });

    var pwd = document.getElementById('screenAdminPassword');
    if (pwd) {
      pwd = cloneRebind(pwd);
      pwd.addEventListener('keydown', function(e){ if (e.key === 'Enter') submitScreenAdminUnlock(); });
    }
    var modal = document.getElementById('screenAdminModal');
    if (modal) {
      modal = cloneRebind(modal);
      modal.addEventListener('click', function(e){ if (e.target === modal) closeScreenAdminModal(); });
    }
    document.querySelectorAll('[data-admin-act]').forEach(function(btn){
      btn = cloneRebind(btn);
      btn.addEventListener('click', function(){ handleScreenAdminAction(btn.dataset.adminAct); });
    });

    setScreenPoolHint();
    populateScreenCategoryOptions();
    renderScreenerHistory();
    updateScreenAdminUI();
    setScreenerRunning(false);
  };

  function applyHotfix(){
    if (__hotfixApplied) return;
    __hotfixApplied = true;
    patchRenderAIReportForETF();
    hotfixText('appVersion', HOTFIX_VER);
    if (typeof document !== 'undefined') document.title = HOTFIX_VER;
    if (typeof bindScreenerUI === 'function') bindScreenerUI();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyHotfix, { once: true });
  } else {
    setTimeout(applyHotfix, 0);
  }
  window.__applyV391Hotfix = applyHotfix;
})();


/* v3.9.3 wizard + screener start fix */
(function(){
  var HOTFIX_VER = 'v3.9.3';
  function byId(id){ return document.getElementById(id); }
  function setText(id, txt){ var el=byId(id); if(el) el.textContent = txt; }
  function cloneBind(id, evt, fn){
    var el = byId(id); if(!el || !el.parentNode) return null;
    var clone = el.cloneNode(true); el.parentNode.replaceChild(clone, el);
    clone.addEventListener(evt, fn); return clone;
  }
  function setActive(btns, key, value){
    btns.forEach(function(btn){ btn.classList.toggle('active', btn.dataset[key] === value); });
  }
  function clearActiveFilters(){
    document.querySelectorAll('[data-screen-filter].active').forEach(function(el){ el.classList.remove('active'); });
  }
  function setFilterActive(key, on){
    var el = document.querySelector('[data-screen-filter="'+key+'"]');
    if(el) el.classList.toggle('active', !!on);
  }
  function setInputValue(id, value){ var el=byId(id); if(el) el.value = value == null ? '' : String(value); }
  function currentWizardState(){
    var s = window.__screenWizardState || { universe:'watchlist', preset:'entry', risk:'balanced' };
    window.__screenWizardState = s;
    return s;
  }
  function applyWizardToInputs(){
    var s = currentWizardState();
    setInputValue('screenUniverse', s.universe || 'watchlist');
    clearActiveFilters();
    ['screenMinTotal','screenMinFund','screenMaxRsi','screenMinVolRatio','screenMinRevYoY','screenMinEPS'].forEach(function(id){ setInputValue(id,''); });
    setInputValue('screenSortBy', 'totalDesc');
    setInputValue('screenLimit', s.risk === 'aggressive' ? 30 : s.risk === 'conservative' ? 15 : 20);

    var presets = {
      entry: {
        filters:['buyFit'], minTotal:{conservative:72,balanced:65,aggressive:58}, minFund:{conservative:65,balanced:58,aggressive:50}, minRevYoY:{conservative:12,balanced:8,aggressive:5}, minEPS:{conservative:8,balanced:5,aggressive:3}, maxRsi:{conservative:68,balanced:75,aggressive:82}, sortBy:'totalDesc'
      },
      breakout: {
        filters:['buyFit','volumeSpike'], minTotal:{conservative:70,balanced:62,aggressive:55}, minFund:{conservative:55,balanced:48,aggressive:40}, minVolRatio:{conservative:1.8,balanced:1.5,aggressive:1.2}, maxRsi:{conservative:72,balanced:80,aggressive:88}, sortBy:'volDesc'
      },
      rebound: {
        filters:['oversold'], minTotal:{conservative:58,balanced:50,aggressive:42}, minFund:{conservative:45,balanced:35,aggressive:25}, maxRsi:{conservative:28,balanced:32,aggressive:38}, minRevYoY:{conservative:0,balanced:-5,aggressive:''}, sortBy:'rsiAsc'
      },
      exit: {
        filters:['sellWatch'], minTotal:{conservative:'',balanced:'',aggressive:''}, minFund:{conservative:'',balanced:'',aggressive:''}, maxRsi:{conservative:'',balanced:'',aggressive:''}, minVolRatio:{conservative:'',balanced:'',aggressive:''}, sortBy:'totalDesc'
      }
    };
    var p = presets[s.preset] || presets.entry;
    (p.filters || []).forEach(function(k){ setFilterActive(k, true); });
    if (p.minTotal) setInputValue('screenMinTotal', p.minTotal[s.risk]);
    if (p.minFund) setInputValue('screenMinFund', p.minFund[s.risk]);
    if (p.maxRsi) setInputValue('screenMaxRsi', p.maxRsi[s.risk]);
    if (p.minVolRatio) setInputValue('screenMinVolRatio', p.minVolRatio[s.risk]);
    if (p.minRevYoY) setInputValue('screenMinRevYoY', p.minRevYoY[s.risk]);
    if (p.minEPS) setInputValue('screenMinEPS', p.minEPS[s.risk]);
    setInputValue('screenSortBy', p.sortBy || 'totalDesc');
    if (typeof setScreenPoolHint === 'function') setScreenPoolHint();
    updateWizardSummary();
  }
  function updateWizardSummary(){
    var s = currentWizardState();
    var uMap = { watchlist:'追蹤清單', holdings:'持股庫存', union:'追蹤 + 持股', custom:'自訂清單' };
    var pMap = { entry:'找偏多進場', breakout:'找放量突破', rebound:'找超賣反彈', exit:'檢查賣出觀察' };
    var rMap = { conservative:'保守', balanced:'平衡', aggressive:'積極' };
    setText('wizardSummaryText', '目前設定：從' + (uMap[s.universe] || s.universe) + (pMap[s.preset] || s.preset) + '，使用' + (rMap[s.risk] || s.risk) + '條件。');
  }
  function bindWizardButtons(){
    document.querySelectorAll('[data-wiz-universe]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = currentWizardState(); s.universe = btn.dataset.wizUniverse; setActive([].slice.call(document.querySelectorAll('[data-wiz-universe]')), 'wizUniverse', s.universe); applyWizardToInputs();
      });
    });
    document.querySelectorAll('[data-wiz-preset]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = currentWizardState(); s.preset = btn.dataset.wizPreset; setActive([].slice.call(document.querySelectorAll('[data-wiz-preset]')), 'wizPreset', s.preset); applyWizardToInputs();
      });
    });
    document.querySelectorAll('[data-wiz-risk]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var s = currentWizardState(); s.risk = btn.dataset.wizRisk; setActive([].slice.call(document.querySelectorAll('[data-wiz-risk]')), 'wizRisk', s.risk); applyWizardToInputs();
      });
    });
    cloneBind('btnRunScreenerWizard', 'click', function(){
      try {
        applyWizardToInputs();
        setText('screenRunStatus', '已套用步驟化條件，準備開始篩選…');
        var adv = byId('screenAdvPanel');
        if (adv) adv.classList.remove('show');
        if (typeof runScreener === 'function') runScreener();
      } catch (e) {
        setText('screenRunStatus', '開始篩選失敗：' + (e && e.message ? e.message : e));
        alert('開始篩選失敗：' + (e && e.message ? e.message : e));
      }
    });
    cloneBind('btnWizardMore', 'click', function(){
      var adv = byId('screenAdvPanel');
      if (!adv) return;
      var show = !adv.classList.contains('show');
      adv.classList.toggle('show', show);
      this.textContent = show ? '先回到簡單模式' : '我想微調細節';
    });
  }
  function reinforceStartButton(){
    cloneBind('btnRunScreener', 'click', function(){
      try {
        setText('screenRunStatus', '開始篩選中…');
        if (typeof runScreener === 'function') runScreener();
      } catch (e) {
        setText('screenRunStatus', '開始篩選失敗：' + (e && e.message ? e.message : e));
        alert('開始篩選失敗：' + (e && e.message ? e.message : e));
      }
    });
  }
  function hideOverwhelmingBlocks(){
    var modeCard = document.querySelector('#page-screener .screen-mode-grid');
    if (modeCard && modeCard.parentNode && modeCard.parentNode.classList) modeCard.parentNode.classList.add('screen-quick-hidden');
  }
  function applyV392(){
    setText('appVersion', HOTFIX_VER);
    document.title = HOTFIX_VER;
    currentWizardState();
    reinforceStartButton();
    bindWizardButtons();
    hideOverwhelmingBlocks();
    applyWizardToInputs();
    setText('screenRunStatus', '請先依步驟選股票池、目的與風格，再按「開始篩選」。');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyV392, { once:true });
  else setTimeout(applyV392, 0);
  window.__applyV392 = applyV392;
})();


window.TWO_STAGE = window.TWO_STAGE || undefined;
/* ===== v3.9.3 two-stage screener patch ===== */
(function () {
  window.TWO_STAGE = window.TWO_STAGE || {

    lightRows: [],
    deepRows: [],
    lightCriteria: null,
    lightStats: null,
    mode: 'idle',
    originalRun: null,
    mounted: false
  };
  const TWO_STAGE = window.TWO_STAGE;

  function tsClone(v) {
    try { return JSON.parse(JSON.stringify(v || null)); } catch (e) { return Array.isArray(v) ? v.slice() : v; }
  }

  function tsUniverseLabel(v) {
    return ({
      watchlist: '自選清單',
      holdings: '持股範圍',
      union: '自選 + 持股',
      custom: '指定清單',
      allStocks: '全台股',
      range: '指定代號區間'
    })[v] || v || '未指定';
  }

  function tsGetCriteriaSafe() {
    try {
      if (typeof getScreenerCriteria === 'function') return getScreenerCriteria();
    } catch (e) {}
    return { universe: document.getElementById('screenUniverse')?.value || 'watchlist', limit: 20, sortBy: 'totalDesc' };
  }

  function tsScopeMeta(criteria) {
    const c = criteria || tsGetCriteriaSafe();
    const universe = c.universe || 'watchlist';
    const isAll = universe === 'allStocks';
    return {
      universe,
      label: tsUniverseLabel(universe),
      note: isAll ? '全台股：建議固定採用先輕篩再深篩' : '指定範圍：可依情境彈性決定是否深篩',
      badge: isAll ? '全台股必備' : '指定範圍彈性'
    };
  }

  function tsSetText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function tsEnsureUI() {
    const resultCard = document.getElementById('screenResultCard');
    if (resultCard && !document.getElementById('screenStageHint')) {
      const box = document.createElement('div');
      box.className = 'card';
      box.id = 'screenStageHint';
      box.style.marginBottom = '12px';
      box.style.background = 'linear-gradient(180deg,rgba(29,78,216,.16),rgba(17,24,39,.35))';
      box.style.border = '1px solid rgba(96,165,250,.22)';
      box.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;"><div><div class="sec-title" style="margin-bottom:6px;color:#dbeafe;">兩階段掃描架構</div><div id="screenStageHintText" class="screen-inline-note" style="font-size:.82rem;color:#dbeafe;line-height:1.7;">先做輕篩，再對結果做深篩；全台股是必備流程，指定範圍是彈性使用。</div></div><div id="screenStageBadge" class="screen-result-chip" style="margin:0;background:rgba(96,165,250,.14);color:#dbeafe;border-color:rgba(96,165,250,.28);">讀取中</div></div>';
      resultCard.parentNode.insertBefore(box, resultCard);
    }
    const runBtn = document.getElementById('btnRunScreener');
    if (runBtn) runBtn.textContent = '⚡ 先做輕篩';
    if (runBtn && !document.getElementById('btnRunDeepScreener')) {
      const deepBtn = document.createElement('button');
      deepBtn.className = 'btn btn-ghost';
      deepBtn.id = 'btnRunDeepScreener';
      deepBtn.style.padding = '12px 22px';
      deepBtn.style.display = 'none';
      deepBtn.style.border = '1px solid rgba(96,165,250,.28)';
      deepBtn.style.color = 'var(--blue)';
      deepBtn.textContent = '🧠 對結果做深篩';
      runBtn.insertAdjacentElement('afterend', deepBtn);
    }
  }

  function tsSyncHint(criteria) {
    const meta = tsScopeMeta(criteria);
    tsSetText('screenStageHintText', '先做輕篩，再對結果做深篩；全台股是必備流程，指定範圍是彈性使用。當前母體：' + meta.note + '。');
    tsSetText('screenStageBadge', meta.badge + '｜' + meta.label);
  }

  function tsSetDeepButtonState() {
    const btn = document.getElementById('btnRunDeepScreener');
    if (!btn) return;
    if (!TWO_STAGE.lightRows.length) {
      btn.style.display = 'none';
      btn.disabled = true;
      btn.textContent = '🧠 對結果做深篩';
      return;
    }
    btn.style.display = 'inline-flex';
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.textContent = '🧠 對結果做深篩';
  }

  function tsDecorateSummary(stage, rows) {
    const summary = document.getElementById('screenResultSummary');
    if (!summary) return;
    const meta = tsScopeMeta(TWO_STAGE.lightCriteria || tsGetCriteriaSafe());
    const label = stage === 'deep' ? '深篩完成' : '輕篩完成';
    const extra = [
      '<span class="screen-result-chip" style="background:rgba(96,165,250,.14);color:#dbeafe;border-color:rgba(96,165,250,.25);">' + label + '</span>',
      '<span class="screen-result-chip">母體：' + meta.label + '</span>',
      '<span class="screen-result-chip">定位：' + meta.badge + '</span>',
      rows && rows.length ? '<span class="screen-result-chip positive">結果：' + rows.length + ' 檔</span>' : ''
    ].join('');
    summary.innerHTML = extra + summary.innerHTML;
  }

  function tsRenderDeepBadges(rows) {
    const tbody = document.getElementById('screenResultBody');
    if (!tbody || !rows || !rows.length) return;
    Array.from(tbody.querySelectorAll('tr')).forEach(function (tr, idx) {
      const row = rows[idx];
      if (!row || !row.deepMeta) return;
      const first = tr.children[0];
      const action = tr.children[5];
      if (first && !first.querySelector('.ts-deep-badge')) {
        const badge = document.createElement('div');
        badge.className = 'ts-deep-badge';
        badge.style.marginTop = '6px';
        badge.style.display = 'inline-flex';
        badge.style.alignItems = 'center';
        badge.style.padding = '3px 8px';
        badge.style.borderRadius = '999px';
        badge.style.fontSize = '.68rem';
        badge.style.fontWeight = '800';
        badge.style.background = 'rgba(96,165,250,.14)';
        badge.style.color = '#dbeafe';
        badge.style.border = '1px solid rgba(96,165,250,.26)';
        badge.textContent = '深篩 ' + row.deepMeta.tier + ' 級｜' + row.totalScore + ' 分';
        first.appendChild(badge);
      }
      if (action && !action.querySelector('.ts-deep-reasons')) {
        const note = document.createElement('div');
        note.className = 'ts-deep-reasons';
        note.style.marginTop = '6px';
        note.style.fontSize = '.72rem';
        note.style.lineHeight = '1.55';
        note.style.color = '#9fb4d2';
        note.textContent = (row.deepMeta.reasons || []).join('／');
        action.appendChild(note);
      }
    });
  }

  function tsDeepScore(row) {
    const item = tsClone(row) || {};
    const reasons = [];
    let score = Number(item.totalScore || 0);
    const tech = Number(item.techScore || 0);
    const fund = Number(item.fundScore || 0);
    const price = Number(item.price || 0);
    const ma20 = Number(item.ma20 || 0);
    const rsi = Number(item.rsi || 0);
    const vol = Number(item.volRatio || 0);
    const rev = Number(item.revYoY || 0);
    const eps = Number(item.ttmEPS || 0);

    score = Math.round(score * 0.45 + tech * 0.30 + fund * 0.25);
    if (price > 0 && ma20 > 0 && price >= ma20) { score += 8; reasons.push('站上 MA20'); }
    else if (price > 0 && ma20 > 0) { score -= 6; }
    if (vol >= 1.5) { score += 6; reasons.push('量能放大'); }
    else if (vol < 0.8) { score -= 3; }
    if (rsi >= 40 && rsi <= 68) { score += 5; reasons.push('RSI 結構健康'); }
    else if (rsi > 0 && rsi < 30) { score += 3; reasons.push('低檔反彈候選'); }
    else if (rsi > 78) { score -= 4; }
    if (rev >= 10) { score += 6; reasons.push('營收年增佳'); }
    else if (rev <= -10) { score -= 6; }
    if (eps > 0) { score += 4; reasons.push('EPS 為正'); }
    else if (eps < 0) { score -= 8; }

    score = Math.max(0, Math.min(100, Math.round(score)));
    item.lightTotalScore = Number(row.totalScore || 0);
    item.totalScore = score;
    item.deepMeta = {
      score: score,
      tier: score >= 82 ? 'A' : score >= 68 ? 'B' : score >= 55 ? 'C' : 'D',
      reasons: reasons.slice(0, 3)
    };
    return item;
  }

  function tsCaptureLightResults() {
    if (typeof screenLastResult === 'undefined' || !screenLastResult) return;
    TWO_STAGE.lightRows = tsClone(screenLastResult.rows || []);
    TWO_STAGE.lightCriteria = tsClone(screenLastResult.criteria || tsGetCriteriaSafe());
    TWO_STAGE.lightStats = tsClone(screenLastResult.stats || null);
    TWO_STAGE.mode = 'light';
    TWO_STAGE.deepRows = [];
    tsSetDeepButtonState();
    tsSyncHint(TWO_STAGE.lightCriteria);
    if (TWO_STAGE.lightRows.length) {
      tsDecorateSummary('light', TWO_STAGE.lightRows);
      tsSetText('screenRunStatus', '輕篩完成：' + TWO_STAGE.lightRows.length + ' 檔，接著可對結果做深篩。');
      if (typeof window.refreshScreenerWizard === 'function') window.refreshScreenerWizard();
    }
  }

  function tsRunDeepScan() {
    if (!TWO_STAGE.lightRows.length) {
      alert('請先完成輕篩，再進行深篩。');
      return;
    }
    const criteria = tsClone(TWO_STAGE.lightCriteria || tsGetCriteriaSafe());
    const meta = tsScopeMeta(criteria);
    let rows = (TWO_STAGE.lightRows || []).map(tsDeepScore).sort(function (a, b) {
      return (b.totalScore || 0) - (a.totalScore || 0) || (b.techScore || 0) - (a.techScore || 0) || (b.fundScore || 0) - (a.fundScore || 0);
    });
    const rawLimit = Number(criteria.limit || 20) || 20;
    const limit = criteria.universe === 'allStocks' ? Math.min(Math.max(10, rawLimit), 15) : Math.min(Math.max(5, rawLimit), rows.length || rawLimit);
    rows = rows.slice(0, Math.min(limit, rows.length));
    TWO_STAGE.deepRows = tsClone(rows);
    TWO_STAGE.mode = 'deep';
    const deepCriteria = Object.assign({}, criteria, { sortBy: 'totalDesc', __twoStage: 'deep' });
    const stats = { total: TWO_STAGE.lightRows.length, ok: rows.length, failed: 0, skipped: Math.max(0, TWO_STAGE.lightRows.length - rows.length) };
    if (typeof renderScreenResults === 'function') renderScreenResults(rows, deepCriteria, stats);
    if (typeof screenLastResult !== 'undefined') {
      screenLastResult = { rows: tsClone(rows), criteria: tsClone(deepCriteria), stats: tsClone(stats), generatedAt: new Date().toISOString(), stage: 'deep' };
    }
    tsDecorateSummary('deep', rows);
    tsRenderDeepBadges(rows);
    tsSetText('screenRunStatus', '深篩完成：' + rows.length + ' 檔；' + meta.badge + '。');
    const btn = document.getElementById('btnRunDeepScreener');
    if (btn) btn.textContent = '🧠 已完成深篩（' + rows.length + '）';
    if (typeof window.refreshScreenerWizard === 'function') window.refreshScreenerWizard();
  }

  async function tsLightWrapper() {
    tsEnsureUI();
    tsSyncHint(tsGetCriteriaSafe());
    TWO_STAGE.lightRows = [];
    TWO_STAGE.deepRows = [];
    TWO_STAGE.mode = 'running-light';
    tsSetDeepButtonState();
    if (typeof screenLastResult !== 'undefined') {
      screenLastResult = { rows: [], criteria: tsGetCriteriaSafe(), stats: null, generatedAt: new Date().toISOString() };
    }
    if (!TWO_STAGE.originalRun && typeof runScreener === 'function') TWO_STAGE.originalRun = runScreener;
    if (typeof TWO_STAGE.originalRun !== 'function') return;
    await TWO_STAGE.originalRun();
    setTimeout(tsCaptureLightResults, 0);
  }

  function tsRebindRunButton() {
    const oldBtn = document.getElementById('btnRunScreener');
    if (!oldBtn || oldBtn.dataset.twoStageBound === '1') return;
    const newBtn = oldBtn.cloneNode(true);
    newBtn.id = 'btnRunScreener';
    newBtn.textContent = '⚡ 先做輕篩';
    newBtn.dataset.twoStageBound = '1';
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);
    newBtn.addEventListener('click', function () { tsLightWrapper(); });
  }

  function tsBindDeepButton() {
    const btn = document.getElementById('btnRunDeepScreener');
    if (!btn || btn.dataset.twoStageBound === '1') return;
    btn.dataset.twoStageBound = '1';
    btn.addEventListener('click', tsRunDeepScan);
  }

  function tsBindAssistiveEvents() {
    const universe = document.getElementById('screenUniverse');
    const custom = document.getElementById('screenCustomList');
    const rs = document.getElementById('screenRangeStart');
    const re = document.getElementById('screenRangeEnd');
    const clearBtn = document.getElementById('btnClearScreener');
    const cards = document.querySelectorAll('[data-screen-filter]');
    if (universe && universe.dataset.twoStageBound !== '1') {
      universe.dataset.twoStageBound = '1';
      universe.addEventListener('change', function () { setTimeout(function(){ tsSyncHint(tsGetCriteriaSafe()); }, 0); });
    }
    [custom, rs, re].forEach(function (el) {
      if (el && el.dataset.twoStageBound !== '1') {
        el.dataset.twoStageBound = '1';
        el.addEventListener('input', function () { setTimeout(function(){ tsSyncHint(tsGetCriteriaSafe()); }, 0); });
      }
    });
    if (clearBtn && clearBtn.dataset.twoStageBound !== '1') {
      clearBtn.dataset.twoStageBound = '1';
      clearBtn.addEventListener('click', function () {
        TWO_STAGE.lightRows = [];
        TWO_STAGE.deepRows = [];
        TWO_STAGE.mode = 'idle';
        tsSetDeepButtonState();
        tsSyncHint(tsGetCriteriaSafe());
        if (typeof window.refreshScreenerWizard === 'function') window.refreshScreenerWizard();
      });
    }
    cards.forEach(function (card) {
      if (card.dataset.twoStageHintBound === '1') return;
      card.dataset.twoStageHintBound = '1';
      card.addEventListener('click', function () { setTimeout(function(){ tsSyncHint(tsGetCriteriaSafe()); }, 0); });
    });
  }

  function tsMount() {
    tsEnsureUI();
    tsRebindRunButton();
    tsBindDeepButton();
    tsBindAssistiveEvents();
    tsSyncHint(tsGetCriteriaSafe());
    tsSetDeepButtonState();
    if (typeof window.refreshScreenerWizard === 'function') window.refreshScreenerWizard();
    TWO_STAGE.mounted = true;
  }

  if (typeof runScreener === 'function') {
    TWO_STAGE.originalRun = runScreener;
    runScreener = tsLightWrapper;
  }

  document.addEventListener('DOMContentLoaded', function () {
    tsMount();
    setTimeout(tsMount, 500);
    setTimeout(tsMount, 1500);
  });
})();


/* ===== v3.9.4 screener wizard patch ===== */
(function(){
  function wizText(id, text){ var el=document.getElementById(id); if(el) el.textContent=text; }
  function wizStep(id, state){
    var el=document.getElementById(id); if(!el) return;
    el.classList.remove('done','active','pending');
    el.classList.add(state||'pending');
  }
  function wizUniverseLabel(v){
    return ({watchlist:'自選清單',holdings:'持股範圍',union:'自選 + 持股',custom:'指定清單',allStocks:'全台股',range:'指定代號區間'})[v] || v || '未指定';
  }
  function wizActiveFilterCount(){
    var cards=document.querySelectorAll('[data-screen-filter].active');
    var count=cards?cards.length:0;
    var adv=['screenMinTotal','screenMinFund','screenMaxRsi','screenMinVolRatio','screenMinRevYoY','screenMinEPS'].map(function(id){
      var el=document.getElementById(id); return el && String(el.value||'').trim()!=='';
    }).filter(Boolean).length;
    return count + adv;
  }
  function wizGetStage(){
    if(typeof TWO_STAGE!=='undefined' && TWO_STAGE && TWO_STAGE.mode) return TWO_STAGE.mode;
    return 'idle';
  }
  function wizGetLightCount(){
    if(typeof TWO_STAGE!=='undefined' && TWO_STAGE && Array.isArray(TWO_STAGE.lightRows)) return TWO_STAGE.lightRows.length;
    return 0;
  }
  function wizGetDeepCount(){
    if(typeof TWO_STAGE!=='undefined' && TWO_STAGE && Array.isArray(TWO_STAGE.deepRows)) return TWO_STAGE.deepRows.length;
    return 0;
  }
  function refreshScreenerWizard(){
    var universe=document.getElementById('screenUniverse');
    var u=universe?universe.value:'watchlist';
    var label=wizUniverseLabel(u);
    var filterCount=wizActiveFilterCount();
    var stage=wizGetStage();
    var lightCount=wizGetLightCount();
    var deepCount=wizGetDeepCount();

    wizText('wizardStep1Note', '目前母體：' + label + '；' + (u==='allStocks' ? '此模式建議固定先輕篩再深篩。' : '此模式可依情境彈性決定是否深篩。'));
    wizText('wizardStep2Note', filterCount ? ('已設定 ' + filterCount + ' 個條件，可開始輕篩。') : '目前尚未勾選任何條件，但仍可先做母體掃描。');
    wizText('wizardStep3Note', lightCount ? ('輕篩已完成，共取得 ' + lightCount + ' 檔候選。') : '尚未執行輕篩。');
    wizText('wizardStep4Note', deepCount ? ('深篩已完成，目前保留 ' + deepCount + ' 檔聚焦名單。') : (lightCount ? '已可執行深篩。' : '等待輕篩結果後啟用。'));

    wizStep('wizardStep1', 'done');
    wizStep('wizardStep2', filterCount ? 'done' : 'active');
    wizStep('wizardStep3', lightCount ? 'done' : (filterCount ? 'active' : 'pending'));
    wizStep('wizardStep4', deepCount ? 'done' : (lightCount ? 'active' : 'pending'));
  }

  window.refreshScreenerWizard = refreshScreenerWizard;
  document.addEventListener('DOMContentLoaded', function(){
    refreshScreenerWizard();
    ['screenUniverse','screenCustomList','screenRangeStart','screenRangeEnd','screenMinTotal','screenMinFund','screenMaxRsi','screenMinVolRatio','screenMinRevYoY','screenMinEPS'].forEach(function(id){
      var el=document.getElementById(id);
      if(!el || el.dataset.wizardBound==='1') return;
      el.dataset.wizardBound='1';
      el.addEventListener('change', function(){ setTimeout(refreshScreenerWizard, 0); });
      el.addEventListener('input', function(){ setTimeout(refreshScreenerWizard, 0); });
    });
    document.querySelectorAll('[data-screen-filter]').forEach(function(el){
      if(el.dataset.wizardBound==='1') return;
      el.dataset.wizardBound='1';
      el.addEventListener('click', function(){ setTimeout(refreshScreenerWizard, 0); });
    });
    ['btnRunScreener','btnRunDeepScreener','btnClearScreener'].forEach(function(id){
      var el=document.getElementById(id);
      if(!el || el.dataset.wizardActionBound==='1') return;
      el.dataset.wizardActionBound='1';
      el.addEventListener('click', function(){ setTimeout(refreshScreenerWizard, 120); setTimeout(refreshScreenerWizard, 800); });
    });
    setTimeout(refreshScreenerWizard, 400);
    setTimeout(refreshScreenerWizard, 1200);
  });
})();

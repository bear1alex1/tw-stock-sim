// ════════════════════════════════════════════
//  台股虛擬操盤系統 v1.4  —  app.js
// ════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v1';
const LOT_SIZE     = 1000;
const CACHE_TTL    = 90_000;

let state       = loadState();
const quoteCache = {};
let twseDataMap = null, twseDataTs = 0;
let tpexDataMap = null, tpexDataTs = 0;

// ── Utilities ─────────────────────────────────
function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g,'').replace(/＋/g,'+').trim();
  if (!s || /^[-–]+$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function normalizeSymbol(s) {
  return String(s||'').trim().toUpperCase().replace(/\.TWO?$/i,'');
}
function formatMoney(v) {
  return Math.round(Number(v)||0).toLocaleString('zh-TW');
}
function formatPrice(v) {
  const n = num(v);
  return (n !== null && n > 0) ? n.toFixed(2) : '—';
}

// ── State ─────────────────────────────────────
function getEmptyState() {
  return { cash: INITIAL_CASH, holdings:{}, history:[], watchlist:[], realizedPnL:0, savedAt:null };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEmptyState();
    const p = JSON.parse(raw);
    return {
      cash:        num(p.cash) ?? INITIAL_CASH,
      holdings:    (p.holdings && typeof p.holdings==='object') ? p.holdings : {},
      history:     Array.isArray(p.history)   ? p.history   : [],
      watchlist:   Array.isArray(p.watchlist) ? [...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))] : [],
      realizedPnL: num(p.realizedPnL) ?? 0,
      savedAt:     p.savedAt || null
    };
  } catch { return getEmptyState(); }
}
function saveState(s) {
  s.savedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  const el = document.getElementById('lastSaved');
  if (el) el.textContent = '最後儲存：' + new Date(s.savedAt).toLocaleString('zh-TW');
}
function updateLastSavedLabel() {
  const el = document.getElementById('lastSaved');
  if (el) el.textContent = state.savedAt
    ? '最後儲存：' + new Date(state.savedAt).toLocaleString('zh-TW')
    : '最後儲存：—';
}

// ── Fee ───────────────────────────────────────
function calcFee(price, lots, side) {
  const amount = price * lots * LOT_SIZE;
  const broker = Math.max(Math.round(amount * 0.001425), 20);
  const tax    = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return { amount, broker, tax, total: broker + tax };
}

// ── Data Sources ──────────────────────────────

async function loadTwseAll() {
  if (twseDataMap && Date.now() - twseDataTs < CACHE_TTL) return twseDataMap;
  const urls = [
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache:'no-store' });
      if (!r.ok) continue;
      const arr = await r.json();
      if (!Array.isArray(arr) || !arr.length) continue;

      // 印出第一筆除錯用（可在 Console 確認欄位名稱）
      console.log('[TWSE sample]', arr[0]);

      const map = {};
      for (const item of arr) {
        const code = String(
          item.Code ?? item['股票代號'] ?? item['證券代號'] ?? ''
        ).trim();
        const close = num(item.ClosingPrice)
          ?? num(item['收盤價'])
          ?? num(item.close)
          ?? null;
        if (code && close && close > 0) map[code] = close;
      }
      if (Object.keys(map).length > 100) {
        twseDataMap = map;
        twseDataTs  = Date.now();
        console.log('[TWSE] loaded', Object.keys(map).length, 'stocks from', url);
        return map;
      }
    } catch(e) { console.warn('[TWSE]', e.message); }
  }
  return null;
}

async function loadTpexAll() {
  if (tpexDataMap && Date.now() - tpexDataTs < CACHE_TTL) return tpexDataMap;
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { cache:'no-store' });
    if (!r.ok) throw new Error('tpex http ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    console.log('[TPEx sample]', arr[0]);
    const map = {};
    for (const item of arr) {
      const code = String(item.SecuritiesCompanyCode ?? item['代號'] ?? '').trim();
      const close = num(item.Close) ?? num(item['收盤']) ?? num(item['收盤價']) ?? null;
      if (code && close && close > 0) map[code] = close;
    }
    tpexDataMap = map;
    tpexDataTs  = Date.now();
    console.log('[TPEx] loaded', Object.keys(map).length, 'stocks');
    return map;
  } catch(e) { console.warn('[TPEx]', e.message); return null; }
}

async function fetchYahoo(symbol) {
  const hosts   = ['query1.finance.yahoo.com','query2.finance.yahoo.com'];
  const suffixes = ['.TW','.TWO'];
  for (const host of hosts) {
    for (const sfx of suffixes) {
      try {
        const url = `https://${host}/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
        const r   = await fetch(url, { cache:'no-store' });
        if (!r.ok) continue;
        const json   = await r.json();
        const result = json?.chart?.result?.[0];
        if (!result) continue;
        const meta   = result.meta;
        const closes = (result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
        const mState = String(meta?.marketState||'CLOSED').toUpperCase();
        const regPx  = num(meta?.regularMarketPrice);
        const prev   = num(meta?.regularMarketPreviousClose) ?? num(meta?.previousClose);
        const last   = closes.length ? closes[closes.length-1] : null;
        const price  = mState==='REGULAR' ? (regPx??last) : (last??regPx);
        if (!price || price<=0) continue;
        const base    = prev ?? (closes.length>=2 ? closes[closes.length-2] : null);
        return { price, previousClose:base, change:base!=null?price-base:null, changePct:base?((price-base)/base)*100:null, marketState:mState };
      } catch(_) {}
    }
  }
  return null;
}

async function fetchYahooProxy(symbol) {
  for (const sfx of ['.TW','.TWO']) {
    try {
      const target   = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
      const r = await fetch(proxyUrl, { cache:'no-store' });
      if (!r.ok) continue;
      const json   = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const meta   = result.meta;
      const closes = (result?.indicators?.quote?.[0]?.close||[]).map(num).filter(v=>v&&v>0);
      const mState = String(meta?.marketState||'CLOSED').toUpperCase();
      const regPx  = num(meta?.regularMarketPrice);
      const prev   = num(meta?.regularMarketPreviousClose) ?? num(meta?.previousClose);
      const last   = closes.length ? closes[closes.length-1] : null;
      const price  = mState==='REGULAR' ? (regPx??last) : (last??regPx);
      if (!price || price<=0) continue;
      const base = prev ?? (closes.length>=2 ? closes[closes.length-2] : null);
      return { price, previousClose:base, change:base!=null?price-base:null, changePct:base?((price-base)/base)*100:null, marketState:mState };
    } catch(_) {}
  }
  return null;
}

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;
  const cached = quoteCache[symbol];
  if (cached && Date.now()-cached.ts < CACHE_TTL) return cached.data;

  let price=null, previousClose=null, change=null, changePct=null, marketState='CLOSED';

  // Layer 1 & 2 – TWSE
  const twse = await loadTwseAll();
  if (twse?.[symbol]) price = twse[symbol];

  // Layer 3 – TPEx
  if (!price) {
    const tpex = await loadTpexAll();
    if (tpex?.[symbol]) price = tpex[symbol];
  }

  // Layer 4 – Yahoo direct
  if (!price) {
    const y = await fetchYahoo(symbol);
    if (y?.price) { price=y.price; previousClose=y.previousClose; change=y.change; changePct=y.changePct; marketState=y.marketState; }
  }

  // Layer 5 – Yahoo proxy
  if (!price) {
    const y = await fetchYahooProxy(symbol);
    if (y?.price) { price=y.price; previousClose=y.previousClose; change=y.change; changePct=y.changePct; marketState=y.marketState; }
  }

  if (!price || price<=0) return null;

  const data = { symbol, price, previousClose, change, changePct, marketState };
  quoteCache[symbol] = { data, ts:Date.now() };
  return data;
}

// ── Watchlist ─────────────────────────────────

function addToWatchlist() {
  const input  = document.getElementById('searchInput');
  const symbol = normalizeSymbol(input.value);
  if (!symbol) return;
  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);
    saveState(state);
  }
  input.value = '';
  renderWatchlist();
}

function removeFromWatchlist(symbol) {
  symbol = normalizeSymbol(symbol);
  state.watchlist = state.watchlist.filter(s=>s!==symbol);
  delete quoteCache[symbol];
  saveState(state);
  renderWatchlist();
}

async function renderWatchlist() {
  const tbody = document.getElementById('watchlistBody');
  tbody.innerHTML = '';
  for (const symbol of state.watchlist) {
    const q     = await fetchQuote(symbol);
    const price = q?.price ?? null;
    const chg   = q?.change ?? null;
    const pct   = q?.changePct ?? null;
    const label = !q ? '離線' : q.marketState==='REGULAR' ? '盤中' : '收盤';
    const bcls  = !q ? '' : (chg??0)>=0 ? 'badge-up' : 'badge-down';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${formatPrice(price)}</td>
      <td>
        ${chg!==null&&pct!==null
          ? `<div class="${chg>=0?'text-up':'text-down'}">${chg>=0?'+':''}${chg.toFixed(2)} (${pct>=0?'+':''}${pct.toFixed(2)}%)</div>`
          : '<div>—</div>'}
        <div class="mt-1"><span class="badge ${bcls}">${label}</span></div>
      </td>
      <td>
        <button class="text-xs text-blue-400 hover:underline mr-2"
          data-trade="${symbol}">操盤</button>
        <button class="text-xs text-red-500 hover:underline"
          data-remove="${symbol}">移除</button>
      </td>`;
    tbody.appendChild(tr);
  }

  // 事件委派（避免 onclick 字串問題）
  tbody.querySelectorAll('[data-trade]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('tradeSymbol').value = btn.dataset.trade;
    });
  });
  tbody.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => removeFromWatchlist(btn.dataset.remove));
  });
}

// ── Trade ─────────────────────────────────────

async function executeTrade(side) {
  const symbol = normalizeSymbol(document.getElementById('tradeSymbol').value);
  const lots   = parseInt(document.getElementById('tradeQty').value, 10);
  const pInput = document.getElementById('tradePrice').value.trim();
  const msg    = document.getElementById('tradeMsg');

  if (!symbol || !lots || lots < 1) { msg.textContent='❌ 請填寫股票代號與股數'; return; }

  let price = num(pInput);
  if (!price || price <= 0) {
    const q = await fetchQuote(symbol);
    price = q?.price ?? null;
    if (!price || price <= 0) { msg.textContent='❌ 無法取得報價，請手動輸入成交價'; return; }
  }

  const fee = calcFee(price, lots, side);

  if (side === 'buy') {
    const total = fee.amount + fee.total;
    if (total > state.cash) { msg.textContent=`❌ 現金不足（需 ${formatMoney(total)} 元）`; return; }
    state.cash -= total;
    if (!state.holdings[symbol]) state.holdings[symbol] = { shares:0, avgPrice:0 };
    const h = state.holdings[symbol];
    const ns = h.shares + lots;
    h.avgPrice = ((h.avgPrice*h.shares*LOT_SIZE) + (price*lots*LOT_SIZE)) / (ns*LOT_SIZE);
    h.shares   = ns;
    showToast(`✅ 買入 ${symbol} ${lots} 張，花費 ${formatMoney(total)} 元`);
  } else {
    const h = state.holdings[symbol];
    if (!h || h.shares < lots) { msg.textContent='❌ 持股不足'; return; }
    const proceeds = fee.amount - fee.total;
    state.realizedPnL += proceeds - h.avgPrice * lots * LOT_SIZE;
    state.cash += proceeds;
    h.shares -= lots;
    if (h.shares === 0) delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${lots} 張，入帳 ${formatMoney(proceeds)} 元`);
  }

  state.history.unshift({
    time: new Date().toLocaleString('zh-TW'),
    symbol, side, shares:lots, price, amount:fee.amount, fee:fee.total
  });
  if (!state.watchlist.includes(symbol)) {
    state.watchlist.unshift(symbol);
    state.watchlist = [...new Set(state.watchlist)];
  }

  saveState(state);
  msg.textContent = '';
  document.getElementById('tradePrice').value = '';
  await renderAll();
}

// ── Holdings ──────────────────────────────────

async function renderHoldings() {
  const tbody = document.getElementById('holdingsBody');
  const empty = document.getElementById('holdingsEmpty');
  tbody.innerHTML = '';
  const symbols = Object.keys(state.holdings);
  if (!symbols.length) {
    empty.style.display = '';
    document.getElementById('holdingsValue').textContent = '$ 0';
    return 0;
  }
  empty.style.display = 'none';
  let total = 0;
  for (const symbol of symbols) {
    const h     = state.holdings[symbol];
    const q     = await fetchQuote(symbol);
    const price = (q?.price > 0) ? q.price : h.avgPrice;
    const mkt   = price * h.shares * LOT_SIZE;
    const pnl   = mkt - h.avgPrice * h.shares * LOT_SIZE;
    total += mkt;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${h.shares} 張</td>
      <td>${formatPrice(h.avgPrice)}</td>
      <td>
        ${formatPrice(price)}
        <span class="text-xs ${q?.marketState==='REGULAR'?'text-green-400':'text-gray-400'}">
          ${q?(q.marketState==='REGULAR'?'盤中':'收盤'):''}
        </span>
      </td>
      <td class="${pnl>=0?'text-up':'text-down'}">${pnl>=0?'+':''}${formatMoney(pnl)}</td>
      <td><button class="text-xs text-blue-400 hover:underline" data-sell="${symbol}">快速賣出</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-sell]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('tradeSymbol').value = btn.dataset.sell;
    });
  });
  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(total);
  return total;
}

// ── History ───────────────────────────────────

function renderHistory() {
  const tbody = document.getElementById('tradeHistoryBody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';
  if (!state.history.length) { empty.style.display=''; return; }
  empty.style.display = 'none';
  state.history.slice(0,50).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-xs text-gray-500">${r.time}</td>
      <td class="font-mono font-bold">${r.symbol}</td>
      <td><span class="badge ${r.side==='buy'?'badge-up':'badge-down'}">${r.side==='buy'?'買入':'賣出'}</span></td>
      <td>${r.shares} 張</td>
      <td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(r.fee)}</td>`;
    tbody.appendChild(tr);
  });
}

// ── Dashboard ─────────────────────────────────

function renderDashboard(hv=0) {
  document.getElementById('cashDisplay').textContent  = '$ '+formatMoney(state.cash);
  document.getElementById('holdingsValue').textContent = '$ '+formatMoney(hv);
  document.getElementById('totalAsset').textContent   = '$ '+formatMoney(state.cash+hv);
  const pnl = num(state.realizedPnL)??0;
  const el  = document.getElementById('totalPnL');
  el.textContent = `${pnl>=0?'+':''}${formatMoney(pnl)} 元`;
  el.className   = `text-xl font-bold ${pnl>=0?'text-up':'text-down'}`;
}

async function renderAll() {
  updateLastSavedLabel();
  const hv = await renderHoldings();
  renderDashboard(hv);
  renderHistory();
  await renderWatchlist();
}

// ── Backup / Restore ──────────────────────────

function exportDataToJson() {
  const payload = { exportedAt:new Date().toISOString(), version:'1.4', data:loadState() };
  const blob    = new Blob([JSON.stringify(payload,null,2)], { type:'application/json;charset=utf-8' });
  const url     = URL.createObjectURL(blob);
  const today   = new Date().toISOString().slice(0,10).replace(/-/g,'');
  const a = document.createElement('a');
  a.href=url; a.download=`stock_backup_${today}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  showToast(`💾 備份已下載：stock_backup_${today}.json`);
}

function importDataFromJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed   = JSON.parse(e.target.result);
      const imported = parsed.data || parsed;
      if (!imported||typeof imported.cash==='undefined'||!Array.isArray(imported.watchlist)) {
        alert('❌ 無效的備份檔案格式'); return;
      }
      imported.watchlist = [...new Set(imported.watchlist.map(normalizeSymbol).filter(Boolean))];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
      showToast('✅ 備份載入成功！正在重新整理…');
      setTimeout(()=>location.reload(),1000);
    } catch(err) {
      alert('❌ JSON 解析失敗：'+err.message);
    } finally { event.target.value=''; }
  };
  reader.readAsText(file,'utf-8');
}

function resetAllData() {
  if (!confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ── Toast ─────────────────────────────────────

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.style.display='block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>{ el.style.display='none'; },3000);
}

// ══════════════════════════════════════════════
//  Init — 用 addEventListener 取代 onclick 字串
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  updateLastSavedLabel();

  // 追蹤按鈕
  document.getElementById('btnAddWatch')
    .addEventListener('click', addToWatchlist);

  // 搜尋框 Enter
  document.getElementById('searchInput')
    .addEventListener('keydown', e => { if(e.key==='Enter') addToWatchlist(); });

  // 買入
  document.getElementById('btnBuy')
    .addEventListener('click', () => executeTrade('buy'));

  // 賣出
  document.getElementById('btnSell')
    .addEventListener('click', () => executeTrade('sell'));

  // 代號輸入框 blur 自動正規化
  document.getElementById('tradeSymbol')
    .addEventListener('blur', () => {
      document.getElementById('tradeSymbol').value =
        normalizeSymbol(document.getElementById('tradeSymbol').value);
    });

  // 股數 Enter 快捷買入
  document.getElementById('tradeQty')
    .addEventListener('keydown', e => { if(e.key==='Enter') executeTrade('buy'); });

  // header 按鈕（仍用 onclick，但這裡也掛一次保險）
  document.getElementById('importFile')
    .addEventListener('change', importDataFromJson);

  await renderAll();

  // 每 90 秒清快取刷新
  setInterval(async () => {
    twseDataMap=null; twseDataTs=0;
    tpexDataMap=null; tpexDataTs=0;
    Object.keys(quoteCache).forEach(k=>delete quoteCache[k]);
    await renderAll();
  }, 90_000);
});

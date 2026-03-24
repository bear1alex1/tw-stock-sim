// ════════════════════════════════════════════════
//  台股虛擬操盤系統 v1.5  —  app.js
//  零股模式（1股=1股）、即時回應 UI、5層報價 fallback
// ════════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v1';
const CACHE_TTL    = 90_000;

let state = loadState();
const quoteCache = {};

// 市場資料預載入（background，不阻塞 UI）
let _twseMap = null, _twseTs = 0;
let _tpexMap = null, _tpexTs = 0;
let _twsePromise = null;
let _tpexPromise = null;

// ════════════════════════════════════════════════
//  Utilities
// ════════════════════════════════════════════════

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').replace(/＋/g, '+').trim();
  if (!s || /^[-–]+$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function normalizeSymbol(s) {
  return String(s || '').trim().toUpperCase().replace(/\.TWO?$/i, '');
}

function formatMoney(v) {
  return Math.round(Number(v) || 0).toLocaleString('zh-TW');
}

function formatPrice(v) {
  const n = num(v);
  return (n !== null && n > 0) ? n.toFixed(2) : '—';
}

// ════════════════════════════════════════════════
//  State
// ════════════════════════════════════════════════

function getEmptyState() {
  return { cash: INITIAL_CASH, holdings: {}, history: [], watchlist: [], realizedPnL: 0, savedAt: null };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEmptyState();
    const p = JSON.parse(raw);
    return {
      cash:        num(p.cash) ?? INITIAL_CASH,
      holdings:    (p.holdings && typeof p.holdings === 'object') ? p.holdings : {},
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

// ════════════════════════════════════════════════
//  零股手續費計算（1股=1股）
//  買入：手續費 0.1425%，最低 20 元
//  賣出：同上 + 證交稅 0.3%
// ════════════════════════════════════════════════

function calcFee(price, shares, side) {
  const amount = price * shares;                                   // 零股：直接用股數
  const broker = Math.max(Math.round(amount * 0.001425), 20);     // 最低 20 元
  const tax    = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return { amount, broker, tax, total: broker + tax };
}

// ════════════════════════════════════════════════
//  Data Source 1：TWSE OpenAPI（上市）
//  用 CSV open_data 版，欄位更穩定
//  https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data
// ════════════════════════════════════════════════

async function _doLoadTwse() {
  const urls = [
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL',
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length < 10) continue;

      // 印出第一筆，方便 F12 確認欄位名稱
      console.log(`[TWSE] sample from ${url}:`, JSON.stringify(arr[0]));

      const map = {};
      for (const item of arr) {
        const code = String(
          item.Code ?? item['股票代號'] ?? item['證券代號'] ?? ''
        ).trim();

        // 嘗試所有可能的收盤欄位（英文、中文）
        const close =
          num(item.ClosingPrice) ??
          num(item['收盤價']) ??
          num(item.close) ??
          num(item.Close) ??
          null;

        const prevClose =
          num(item['漲跌價差']) !== null
            ? (close !== null ? close - num(item['漲跌價差']) : null)
            : null;

        if (code && close && close > 0) {
          map[code] = { close, prevClose };
        }
      }

      const count = Object.keys(map).length;
      if (count > 50) {
        console.log(`[TWSE] ✅ loaded ${count} stocks`);
        return map;
      }
    } catch (e) {
      console.warn('[TWSE]', e.message);
    }
  }
  return null;
}

function loadTwse() {
  if (_twseMap && Date.now() - _twseTs < CACHE_TTL) return Promise.resolve(_twseMap);
  if (!_twsePromise) {
    _twsePromise = _doLoadTwse().then(map => {
      if (map) { _twseMap = map; _twseTs = Date.now(); }
      _twsePromise = null;
      return _twseMap;
    });
  }
  return _twsePromise;
}

// ════════════════════════════════════════════════
//  Data Source 2：TPEx OpenAPI（上櫃）
// ════════════════════════════════════════════════

async function _doLoadTpex() {
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { cache: 'no-store' });
    if (!r.ok) throw new Error('status ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length < 10) throw new Error('empty');

    console.log('[TPEx] sample:', JSON.stringify(arr[0]));

    const map = {};
    for (const item of arr) {
      const code = String(item.SecuritiesCompanyCode ?? item['代號'] ?? '').trim();
      const close =
        num(item.Close) ??
        num(item['收盤']) ??
        num(item['收盤價']) ??
        null;
      if (code && close && close > 0) map[code] = { close, prevClose: null };
    }
    console.log('[TPEx] ✅ loaded', Object.keys(map).length, 'stocks');
    return map;
  } catch (e) {
    console.warn('[TPEx]', e.message);
    return null;
  }
}

function loadTpex() {
  if (_tpexMap && Date.now() - _tpexTs < CACHE_TTL) return Promise.resolve(_tpexMap);
  if (!_tpexPromise) {
    _tpexPromise = _doLoadTpex().then(map => {
      if (map) { _tpexMap = map; _tpexTs = Date.now(); }
      _tpexPromise = null;
      return _tpexMap;
    });
  }
  return _tpexPromise;
}

// ════════════════════════════════════════════════
//  Data Source 3 & 4：Yahoo Finance
// ════════════════════════════════════════════════

async function _yahooFetch(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('http ' + r.status);
  const json = await r.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('no result');

  const meta   = result.meta;
  const closes = (result?.indicators?.quote?.[0]?.close || []).map(num).filter(v => v && v > 0);
  const mState = String(meta?.marketState || 'CLOSED').toUpperCase();
  const regPx  = num(meta?.regularMarketPrice);
  const prev   = num(meta?.regularMarketPreviousClose) ?? num(meta?.previousClose);
  const last   = closes.length ? closes[closes.length - 1] : null;
  const price  = mState === 'REGULAR' ? (regPx ?? last) : (last ?? regPx);
  if (!price || price <= 0) throw new Error('no price');

  const base = prev ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
  return {
    price,
    previousClose: base,
    change:    base !== null ? price - base : null,
    changePct: base ? ((price - base) / base) * 100 : null,
    marketState: mState
  };
}

async function fetchYahoo(symbol) {
  const hosts   = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const suffixes = ['.TW', '.TWO'];
  for (const host of hosts) {
    for (const sfx of suffixes) {
      try {
        return await _yahooFetch(`https://${host}/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`);
      } catch (_) {}
    }
  }
  return null;
}

async function fetchYahooProxy(symbol) {
  for (const sfx of ['.TW', '.TWO']) {
    try {
      const target = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
      return await _yahooFetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`);
    } catch (_) {}
  }
  return null;
}

// ════════════════════════════════════════════════
//  主報價函數（5層 fallback，TWSE/TPEx 平行抓取）
// ════════════════════════════════════════════════

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;

  const cached = quoteCache[symbol];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  let price = null, previousClose = null, change = null, changePct = null, marketState = 'CLOSED';

  // 平行抓取所有來源
  const [twseResult, tpexResult, yahooResult, proxyResult] = await Promise.allSettled([
    loadTwse(),
    loadTpex(),
    fetchYahoo(symbol),
    fetchYahooProxy(symbol)
  ]);

  // 依優先順序取結果
  const twse = twseResult.status === 'fulfilled' ? twseResult.value : null;
  const tpex = tpexResult.status === 'fulfilled' ? tpexResult.value : null;
  const yahoo = yahooResult.status === 'fulfilled' ? yahooResult.value : null;
  const proxy = proxyResult.status === 'fulfilled' ? proxyResult.value : null;

  if (twse?.[symbol]) {
    price = twse[symbol].close;
    previousClose = twse[symbol].prevClose;
    change = previousClose !== null ? price - previousClose : null;
    changePct = previousClose ? (change / previousClose) * 100 : null;
  } else if (tpex?.[symbol]) {
    price = tpex[symbol].close;
    previousClose = tpex[symbol].prevClose;
  } else if (yahoo?.price > 0) {
    ({ price, previousClose, change, changePct, marketState } = yahoo);
  } else if (proxy?.price > 0) {
    ({ price, previousClose, change, changePct, marketState } = proxy);
  }

  if (!price || price <= 0) return null;

  const data = { symbol, price, previousClose, change, changePct, marketState };
  quoteCache[symbol] = { data, ts: Date.now() };
  return data;
}

// ════════════════════════════════════════════════
//  Watchlist（即時顯示 → 背景更新價格）
// ════════════════════════════════════════════════

function buildWatchRow(symbol, q) {
  const price = q?.price ?? null;
  const chg   = q?.change ?? null;
  const pct   = q?.changePct ?? null;
  const label = !q ? '讀取中' : q.marketState === 'REGULAR' ? '盤中' : '收盤';
  const bcls  = !q ? 'badge-wait' : (chg ?? 0) >= 0 ? 'badge-up' : 'badge-down';
  return `
    <td class="font-mono font-bold">${symbol}</td>
    <td>${formatPrice(price)}</td>
    <td>
      ${chg !== null && pct !== null
        ? `<div class="${chg >= 0 ? 'text-up' : 'text-down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</div>`
        : '<div>—</div>'}
      <div class="mt-1"><span class="badge ${bcls}">${label}</span></div>
    </td>
    <td>
      <button class="text-xs text-blue-400 hover:underline mr-2" data-trade="${symbol}">操盤</button>
      <button class="text-xs text-red-500 hover:underline" data-remove="${symbol}">移除</button>
    </td>`;
}

function bindWatchlistEvents() {
  const tbody = document.getElementById('watchlistBody');
  tbody.querySelectorAll('[data-trade]').forEach(btn => {
    btn.onclick = () => { document.getElementById('tradeSymbol').value = btn.dataset.trade; };
  });
  tbody.querySelectorAll('[data-remove]').forEach(btn => {
    btn.onclick = () => removeFromWatchlist(btn.dataset.remove);
  });
}

function renderWatchlistImmediate() {
  const tbody = document.getElementById('watchlistBody');
  tbody.innerHTML = '';
  for (const symbol of state.watchlist) {
    const cached = quoteCache[symbol]?.data ?? null;
    const tr = document.createElement('tr');
    tr.dataset.symbol = symbol;
    tr.innerHTML = buildWatchRow(symbol, cached);
    tbody.appendChild(tr);
  }
  bindWatchlistEvents();
}

async function refreshWatchlistPrices() {
  const tbody = document.getElementById('watchlistBody');
  for (const symbol of state.watchlist) {
    const q  = await fetchQuote(symbol);
    const tr = tbody.querySelector(`[data-symbol="${symbol}"]`);
    if (tr) {
      tr.innerHTML = buildWatchRow(symbol, q);
      bindWatchlistEvents();
    }
  }
}

function addToWatchlist() {
  const input  = document.getElementById('searchInput');
  const symbol = normalizeSymbol(input.value);
  if (!symbol) return;
  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);
    saveState(state);
    showToast(`✅ 已加入追蹤：${symbol}，正在取得報價…`);
  }
  input.value = '';
  renderWatchlistImmediate();   // 立即顯示（不等報價）
  refreshWatchlistPrices();     // 背景抓價格（非阻塞）
}

function removeFromWatchlist(symbol) {
  symbol = normalizeSymbol(symbol);
  state.watchlist = state.watchlist.filter(s => s !== symbol);
  delete quoteCache[symbol];
  saveState(state);
  renderWatchlistImmediate();
}

// ════════════════════════════════════════════════
//  Trade（零股：1股=1股）
// ════════════════════════════════════════════════

async function executeTrade(side) {
  const symbol = normalizeSymbol(document.getElementById('tradeSymbol').value);
  const shares = parseInt(document.getElementById('tradeQty').value, 10);
  const pInput = document.getElementById('tradePrice').value.trim();
  const msg    = document.getElementById('tradeMsg');

  if (!symbol || !shares || shares < 1) {
    msg.textContent = '❌ 請填寫股票代號與股數';
    return;
  }

  // 立即顯示 loading 狀態
  msg.textContent = '⏳ 正在取得報價…';
  document.getElementById('btnBuy').disabled  = true;
  document.getElementById('btnSell').disabled = true;

  let price = num(pInput);
  if (!price || price <= 0) {
    const q = await fetchQuote(symbol);
    price = q?.price ?? null;
  }

  document.getElementById('btnBuy').disabled  = false;
  document.getElementById('btnSell').disabled = false;

  if (!price || price <= 0) {
    msg.textContent = '❌ 無法取得報價，請手動輸入成交價';
    return;
  }

  const fee = calcFee(price, shares, side);

  if (side === 'buy') {
    const total = fee.amount + fee.total;
    if (total > state.cash) {
      msg.textContent = `❌ 現金不足（需 ${formatMoney(total)} 元）`;
      return;
    }
    state.cash -= total;
    if (!state.holdings[symbol]) state.holdings[symbol] = { shares: 0, avgPrice: 0 };
    const h  = state.holdings[symbol];
    const ns = h.shares + shares;
    h.avgPrice = ((h.avgPrice * h.shares) + (price * shares)) / ns;
    h.shares   = ns;
    showToast(`✅ 買入 ${symbol} ${shares} 股，花費 ${formatMoney(total)} 元`);
  } else {
    const h = state.holdings[symbol];
    if (!h || h.shares < shares) { msg.textContent = '❌ 持股不足'; return; }
    const proceeds = fee.amount - fee.total;
    state.realizedPnL += proceeds - h.avgPrice * shares;
    state.cash += proceeds;
    h.shares  -= shares;
    if (h.shares === 0) delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${shares} 股，入帳 ${formatMoney(proceeds)} 元`);
  }

  state.history.unshift({
    time: new Date().toLocaleString('zh-TW'),
    symbol, side, shares, price, amount: fee.amount, fee: fee.total
  });

  if (!state.watchlist.includes(symbol)) {
    state.watchlist.unshift(symbol);
    state.watchlist = [...new Set(state.watchlist)];
  }

  saveState(state);
  msg.textContent = '';
  document.getElementById('tradePrice').value = '';

  renderDashboardQuick();
  renderHistory();
  renderWatchlistImmediate();
  renderHoldingsImmediate();
  refreshWatchlistPrices();
  refreshHoldingsPrices();
}

// ════════════════════════════════════════════════
//  Holdings（即時顯示 → 背景更新價格）
// ════════════════════════════════════════════════

function buildHoldingRow(symbol, h, q) {
  const price  = (q?.price > 0) ? q.price : h.avgPrice;
  const mkt    = price * h.shares;
  const cost   = h.avgPrice * h.shares;
  const pnl    = mkt - cost;
  const stateLabel = q ? (q.marketState === 'REGULAR' ? '盤中' : '收盤') : '';
  const stateClass = q?.marketState === 'REGULAR' ? 'text-green-400' : 'text-gray-400';
  return `
    <td class="font-mono font-bold">${symbol}</td>
    <td>${h.shares} 股</td>
    <td>${formatPrice(h.avgPrice)}</td>
    <td>${formatPrice(price)}<span class="text-xs ${stateClass} ml-1">${stateLabel}</span></td>
    <td class="${pnl >= 0 ? 'text-up' : 'text-down'}">${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}</td>
    <td><button class="text-xs text-blue-400 hover:underline" data-sell="${symbol}">快速賣出</button></td>`;
}

function renderHoldingsImmediate() {
  const tbody = document.getElementById('holdingsBody');
  const empty = document.getElementById('holdingsEmpty');
  tbody.innerHTML = '';
  const symbols = Object.keys(state.holdings);
  if (!symbols.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';

  let total = 0;
  for (const symbol of symbols) {
    const h = state.holdings[symbol];
    const q = quoteCache[symbol]?.data ?? null;
    const price = (q?.price > 0) ? q.price : h.avgPrice;
    total += price * h.shares;
    const tr = document.createElement('tr');
    tr.dataset.hsymbol = symbol;
    tr.innerHTML = buildHoldingRow(symbol, h, q);
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-sell]').forEach(btn => {
    btn.onclick = () => { document.getElementById('tradeSymbol').value = btn.dataset.sell; };
  });

  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(total);
  return total;
}

async function refreshHoldingsPrices() {
  const tbody = document.getElementById('holdingsBody');
  let total = 0;
  for (const symbol of Object.keys(state.holdings)) {
    const h = state.holdings[symbol];
    const q = await fetchQuote(symbol);
    const tr = tbody.querySelector(`[data-hsymbol="${symbol}"]`);
    if (tr) {
      tr.innerHTML = buildHoldingRow(symbol, h, q);
      tbody.querySelectorAll('[data-sell]').forEach(btn => {
        btn.onclick = () => { document.getElementById('tradeSymbol').value = btn.dataset.sell; };
      });
    }
    const price = (q?.price > 0) ? q.price : h.avgPrice;
    total += price * h.shares;
  }
  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(total);
  renderDashboardQuick(total);
}

// ════════════════════════════════════════════════
//  History
// ════════════════════════════════════════════════

function renderHistory() {
  const tbody = document.getElementById('tradeHistoryBody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';
  if (!state.history.length) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.history.slice(0, 50).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-xs text-gray-500">${r.time}</td>
      <td class="font-mono font-bold">${r.symbol}</td>
      <td><span class="badge ${r.side === 'buy' ? 'badge-up' : 'badge-down'}">${r.side === 'buy' ? '買入' : '賣出'}</span></td>
      <td>${r.shares} 股</td>
      <td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(r.fee)}</td>`;
    tbody.appendChild(tr);
  });
}

// ════════════════════════════════════════════════
//  Dashboard
// ════════════════════════════════════════════════

function renderDashboardQuick(hv) {
  if (hv === undefined) {
    const hvText = document.getElementById('holdingsValue').textContent.replace(/[^\d]/g, '');
    hv = parseInt(hvText, 10) || 0;
  }
  document.getElementById('cashDisplay').textContent  = '$ ' + formatMoney(state.cash);
  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(hv);
  document.getElementById('totalAsset').textContent   = '$ ' + formatMoney(state.cash + hv);
  const pnl = num(state.realizedPnL) ?? 0;
  const el  = document.getElementById('totalPnL');
  el.textContent = `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)} 元`;
  el.className   = `text-xl font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`;
}

// ════════════════════════════════════════════════
//  Backup / Restore
// ════════════════════════════════════════════════

function exportDataToJson() {
  const payload = { exportedAt: new Date().toISOString(), version: '1.5', data: loadState() };
  const blob    = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url     = URL.createObjectURL(blob);
  const today   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const a = document.createElement('a');
  a.href = url; a.download = `stock_backup_${today}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`💾 備份已下載：stock_backup_${today}.json`);
}

function importDataFromJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const imported = parsed.data || parsed;
      if (!imported || typeof imported.cash === 'undefined' || !Array.isArray(imported.watchlist)) {
        alert('❌ 無效的備份檔案格式'); return;
      }
      imported.watchlist = [...new Set(imported.watchlist.map(normalizeSymbol).filter(Boolean))];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
      showToast('✅ 備份載入成功！正在重新整理…');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      alert('❌ JSON 解析失敗：' + err.message);
    } finally { event.target.value = ''; }
  };
  reader.readAsText(file, 'utf-8');
}

function resetAllData() {
  if (!confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ════════════════════════════════════════════════
//  Toast
// ════════════════════════════════════════════════

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ════════════════════════════════════════════════
//  Init
// ════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  updateLastSavedLabel();

  // 立刻在背景預載市場資料（不等待）
  loadTwse();
  loadTpex();

  // 綁定按鈕（全部用 addEventListener，不用 onclick 字串）
  document.getElementById('btnAddWatch').addEventListener('click', addToWatchlist);
  document.getElementById('btnBuy').addEventListener('click', () => executeTrade('buy'));
  document.getElementById('btnSell').addEventListener('click', () => executeTrade('sell'));
  document.getElementById('btnExport').addEventListener('click', exportDataToJson);
  document.getElementById('btnReset').addEventListener('click', resetAllData);
  document.getElementById('importFile').addEventListener('change', importDataFromJson);

  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') addToWatchlist();
  });
  document.getElementById('tradeSymbol').addEventListener('blur', () => {
    document.getElementById('tradeSymbol').value = normalizeSymbol(document.getElementById('tradeSymbol').value);
  });
  document.getElementById('tradeQty').addEventListener('keydown', e => {
    if (e.key === 'Enter') executeTrade('buy');
  });

  // 立即渲染（用快取資料，不等報價）
  renderDashboardQuick(0);
  renderHoldingsImmediate();
  renderHistory();
  renderWatchlistImmediate();

  // 背景更新所有價格
  refreshWatchlistPrices();
  refreshHoldingsPrices();

  // 每 90 秒自動刷新
  setInterval(() => {
    _twseMap = null; _twseTs = 0;
    _tpexMap = null; _tpexTs = 0;
    Object.keys(quoteCache).forEach(k => delete quoteCache[k]);
    refreshWatchlistPrices();
    refreshHoldingsPrices();
  }, 90_000);
});

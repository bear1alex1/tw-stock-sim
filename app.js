const INITIAL_CASH = 1_000_000;
const STORAGE_KEY = 'twStock_v1';
const LOT_SIZE = 1000;
const CACHE_TTL = 90_000;

let state = loadState();
const quoteCache = {};   // per-symbol cache
let twseDataMap = null;
let twseDataTs = 0;
let tpexDataMap = null;
let tpexDataTs = 0;

// ══════════════════════════════════════════════
//  Utilities
// ══════════════════════════════════════════════

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').replace(/＋/g, '+').trim();
  if (!s || /^[-–]+$/.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function normalizeSymbol(s) {
  return String(s || '').trim().toUpperCase().replace(/\.TW[O]?$/i, '');
}

function formatMoney(v) {
  return Math.round(Number(v) || 0).toLocaleString('zh-TW');
}

function formatPrice(v) {
  const n = num(v);
  return (n !== null && n > 0) ? n.toFixed(2) : '—';
}

// ══════════════════════════════════════════════
//  LocalStorage State
// ══════════════════════════════════════════════

function getEmptyState() {
  return { cash: INITIAL_CASH, holdings: {}, history: [], watchlist: [], realizedPnL: 0, savedAt: null };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEmptyState();
    const p = JSON.parse(raw);
    return {
      cash: num(p.cash) ?? INITIAL_CASH,
      holdings: (p.holdings && typeof p.holdings === 'object') ? p.holdings : {},
      history: Array.isArray(p.history) ? p.history : [],
      watchlist: Array.isArray(p.watchlist) ? [...new Set(p.watchlist.map(normalizeSymbol).filter(Boolean))] : [],
      realizedPnL: num(p.realizedPnL) ?? 0,
      savedAt: p.savedAt || null
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
  if (el) el.textContent = state.savedAt ? '最後儲存：' + new Date(state.savedAt).toLocaleString('zh-TW') : '最後儲存：—';
}

// ══════════════════════════════════════════════
//  Fee Calculation
// ══════════════════════════════════════════════

function calcFee(price, lots, side) {
  const amount = price * lots * LOT_SIZE;
  const broker = Math.max(Math.round(amount * 0.001425), 20);
  const tax = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return { amount, broker, tax, total: broker + tax };
}

// ══════════════════════════════════════════════
//  Data Sources
// ══════════════════════════════════════════════

// ── Source 1: TWSE OpenAPI STOCK_DAY_AVG_ALL ──
// 正確欄位：Code / StockName / ClosingPrice / MonthlyAveragePrice
// 這個 endpoint 回傳當月每日個股收盤 + 月均，CORS 原生支援
async function loadTwseMap() {
  if (twseDataMap && Date.now() - twseDataTs < CACHE_TTL) return twseDataMap;
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_AVG_ALL', { cache: 'no-store' });
    if (!r.ok) throw new Error('twse http ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('twse empty');
    const map = {};
    for (const item of arr) {
      const code = String(item.Code || item['股票代號'] || '').trim();
      // 欄位名稱可能是英文或中文
      const close =
        num(item.ClosingPrice) ??
        num(item['收盤價']) ??
        null;
      if (code && close && close > 0) map[code] = close;
    }
    twseDataMap = map;
    twseDataTs = Date.now();
    return map;
  } catch (e) {
    console.warn('[TWSE]', e.message);
    return null;
  }
}

// ── Source 2: TWSE STOCK_DAY_ALL ──
// 備用；欄位含中文鍵名
async function loadTwseDayAll() {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', { cache: 'no-store' });
    if (!r.ok) throw new Error('twse_day http ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    const map = {};
    for (const item of arr) {
      const code = String(item.Code || item['證券代號'] || item['股票代號'] || '').trim();
      // 嘗試所有可能的收盤欄位名稱
      const close =
        num(item.ClosingPrice) ??
        num(item['收盤價']) ??
        num(item.close) ??
        null;
      if (code && close && close > 0) map[code] = close;
    }
    if (Object.keys(map).length) {
      twseDataMap = map;
      twseDataTs = Date.now();
    }
    return map;
  } catch (e) {
    console.warn('[TWSE_DAY_ALL]', e.message);
    return null;
  }
}

// ── Source 3: TPEx OpenAPI ──
async function loadTpexMap() {
  if (tpexDataMap && Date.now() - tpexDataTs < CACHE_TTL) return tpexDataMap;
  try {
    const r = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', { cache: 'no-store' });
    if (!r.ok) throw new Error('tpex http ' + r.status);
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    const map = {};
    for (const item of arr) {
      const code = String(
        item.SecuritiesCompanyCode ||
        item['SecuritiesCompanyCode'] ||
        item['代號'] || ''
      ).trim();
      const close =
        num(item.Close) ??
        num(item['收盤']) ??
        num(item['收盤價']) ??
        null;
      if (code && close && close > 0) map[code] = close;
    }
    tpexDataMap = map;
    tpexDataTs = Date.now();
    return map;
  } catch (e) {
    console.warn('[TPEx]', e.message);
    return null;
  }
}

// ── Source 4: Yahoo Finance chart API（多個 subdomain 輪試）──
async function fetchYahooClose(symbol) {
  const hosts = [
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com'
  ];
  const suffixes = ['.TW', '.TWO'];

  for (const host of hosts) {
    for (const sfx of suffixes) {
      try {
        const url = `https://${host}/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d&includePrePost=false`;
        const r = await fetch(url, { cache: 'no-store', mode: 'cors' });
        if (!r.ok) continue;
        const json = await r.json();
        const result = json?.chart?.result?.[0];
        if (!result) continue;

        const meta = result.meta;
        const closes = (result?.indicators?.quote?.[0]?.close || [])
          .map(v => num(v))
          .filter(v => v !== null && v > 0);

        const marketState = String(meta?.marketState || 'CLOSED').toUpperCase();
        const regularPrice = num(meta?.regularMarketPrice);
        const prevClose = num(meta?.regularMarketPreviousClose) ?? num(meta?.previousClose);
        const lastClose = closes.length ? closes[closes.length - 1] : null;

        const price = (marketState === 'REGULAR')
          ? (regularPrice ?? lastClose)
          : (lastClose ?? regularPrice);

        if (!price || price <= 0) continue;

        const base = prevClose ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
        return {
          price,
          previousClose: base,
          change: base !== null ? price - base : null,
          changePct: base ? ((price - base) / base) * 100 : null,
          marketState
        };
      } catch (_) {}
    }
  }
  return null;
}

// ── Source 5: allorigins CORS proxy for Yahoo ──
async function fetchYahooViaProxy(symbol) {
  const suffixes = ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    try {
      const target = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`;
      const r = await fetch(proxyUrl, { cache: 'no-store' });
      if (!r.ok) continue;
      const json = await r.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta;
      const closes = (result?.indicators?.quote?.[0]?.close || [])
        .map(v => num(v)).filter(v => v !== null && v > 0);

      const marketState = String(meta?.marketState || 'CLOSED').toUpperCase();
      const regularPrice = num(meta?.regularMarketPrice);
      const prevClose = num(meta?.regularMarketPreviousClose) ?? num(meta?.previousClose);
      const lastClose = closes.length ? closes[closes.length - 1] : null;
      const price = (marketState === 'REGULAR') ? (regularPrice ?? lastClose) : (lastClose ?? regularPrice);
      if (!price || price <= 0) continue;

      const base = prevClose ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
      return {
        price,
        previousClose: base,
        change: base !== null ? price - base : null,
        changePct: base ? ((price - base) / base) * 100 : null,
        marketState
      };
    } catch (_) {}
  }
  return null;
}

// ══════════════════════════════════════════════
//  Main fetchQuote（5 層 fallback）
// ══════════════════════════════════════════════

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;

  const cached = quoteCache[symbol];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  let price = null;
  let previousClose = null;
  let change = null;
  let changePct = null;
  let marketState = 'CLOSED';

  // Layer 1 – TWSE AVG_ALL
  const twseAvg = await loadTwseMap();
  if (twseAvg?.[symbol]) {
    price = twseAvg[symbol];
  }

  // Layer 2 – TWSE DAY_ALL（若 AVG_ALL 沒有或為 0）
  if (!price) {
    const twseDay = await loadTwseDayAll();
    if (twseDay?.[symbol]) price = twseDay[symbol];
  }

  // Layer 3 – TPEx
  if (!price) {
    const tpex = await loadTpexMap();
    if (tpex?.[symbol]) price = tpex[symbol];
  }

  // Layer 4 – Yahoo Finance 直連
  if (!price) {
    const y = await fetchYahooClose(symbol);
    if (y?.price) {
      price = y.price;
      previousClose = y.previousClose;
      change = y.change;
      changePct = y.changePct;
      marketState = y.marketState;
    }
  }

  // Layer 5 – Yahoo via allorigins proxy
  if (!price) {
    const y = await fetchYahooViaProxy(symbol);
    if (y?.price) {
      price = y.price;
      previousClose = y.previousClose;
      change = y.change;
      changePct = y.changePct;
      marketState = y.marketState;
    }
  }

  if (!price || price <= 0) return null;

  const data = { symbol, price, previousClose, change, changePct, marketState };
  quoteCache[symbol] = { data, ts: Date.now() };
  return data;
}

// ══════════════════════════════════════════════
//  Watchlist
// ══════════════════════════════════════════════

function addToWatchlist() {
  const input = document.getElementById('searchInput');
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
  state.watchlist = state.watchlist.filter(s => s !== symbol);
  delete quoteCache[symbol];
  saveState(state);
  renderWatchlist();
}

async function renderWatchlist() {
  const tbody = document.getElementById('watchlistBody');
  tbody.innerHTML = '';

  for (const symbol of state.watchlist) {
    const q = await fetchQuote(symbol);
    const price = q?.price ?? null;
    const change = q?.change ?? null;
    const changePct = q?.changePct ?? null;
    const stateLabel = !q ? '離線' : q.marketState === 'REGULAR' ? '盤中' : '收盤';
    const badgeClass = !q ? '' : (change ?? 0) >= 0 ? 'badge-up' : 'badge-down';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${formatPrice(price)}</td>
      <td>
        ${change !== null && changePct !== null
          ? `<div class="${change >= 0 ? 'text-up' : 'text-down'}">${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)</div>`
          : '<div>—</div>'}
        <div class="mt-1"><span class="badge ${badgeClass}">${stateLabel}</span></div>
      </td>
      <td>
        <button class="text-xs text-blue-400 hover:underline mr-2"
          onclick="document.getElementById('tradeSymbol').value='${symbol}'">操盤</button>
        <button class="text-xs text-red-500 hover:underline"
          onclick="removeFromWatchlist('${symbol}')">移除</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

// ══════════════════════════════════════════════
//  Trade
// ══════════════════════════════════════════════

async function executeTrade(side) {
  const symbol = normalizeSymbol(document.getElementById('tradeSymbol').value);
  const lots = parseInt(document.getElementById('tradeQty').value, 10);
  const priceInput = document.getElementById('tradePrice').value.trim();
  const msg = document.getElementById('tradeMsg');

  if (!symbol || !lots || lots < 1) { msg.textContent = '❌ 請填寫股票代號與股數'; return; }

  let price = num(priceInput);
  if (!price || price <= 0) {
    const q = await fetchQuote(symbol);
    price = q?.price ?? null;
    if (!price || price <= 0) { msg.textContent = '❌ 無法取得報價，請手動輸入成交價'; return; }
  }

  const fee = calcFee(price, lots, side);

  if (side === 'buy') {
    const total = fee.amount + fee.total;
    if (total > state.cash) { msg.textContent = `❌ 現金不足（需 ${formatMoney(total)} 元）`; return; }
    state.cash -= total;
    if (!state.holdings[symbol]) state.holdings[symbol] = { shares: 0, avgPrice: 0 };
    const h = state.holdings[symbol];
    const newShares = h.shares + lots;
    h.avgPrice = ((h.avgPrice * h.shares * LOT_SIZE) + (price * lots * LOT_SIZE)) / (newShares * LOT_SIZE);
    h.shares = newShares;
    showToast(`✅ 買入 ${symbol} ${lots} 張，花費 ${formatMoney(total)} 元`);
  } else {
    const h = state.holdings[symbol];
    if (!h || h.shares < lots) { msg.textContent = '❌ 持股不足'; return; }
    const proceeds = fee.amount - fee.total;
    state.realizedPnL += proceeds - h.avgPrice * lots * LOT_SIZE;
    state.cash += proceeds;
    h.shares -= lots;
    if (h.shares === 0) delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${lots} 張，入帳 ${formatMoney(proceeds)} 元`);
  }

  state.history.unshift({
    time: new Date().toLocaleString('zh-TW'),
    symbol, side, shares: lots, price, amount: fee.amount, fee: fee.total
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

// ══════════════════════════════════════════════
//  Holdings
// ══════════════════════════════════════════════

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
    const h = state.holdings[symbol];
    const q = await fetchQuote(symbol);
    const price = (q?.price > 0) ? q.price : h.avgPrice;
    const mktVal = price * h.shares * LOT_SIZE;
    const pnl = mktVal - h.avgPrice * h.shares * LOT_SIZE;
    total += mktVal;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${h.shares} 張</td>
      <td>${formatPrice(h.avgPrice)}</td>
      <td>
        ${formatPrice(price)}
        <span class="text-xs ${q?.marketState === 'REGULAR' ? 'text-green-400' : 'text-gray-400'}">
          ${q ? (q.marketState === 'REGULAR' ? '盤中' : '收盤') : ''}
        </span>
      </td>
      <td class="${pnl >= 0 ? 'text-up' : 'text-down'}">${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}</td>
      <td><button class="text-xs text-blue-400 hover:underline"
        onclick="document.getElementById('tradeSymbol').value='${symbol}'">快速賣出</button></td>`;
    tbody.appendChild(tr);
  }

  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(total);
  return total;
}

// ══════════════════════════════════════════════
//  History
// ══════════════════════════════════════════════

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
      <td>${r.shares} 張</td>
      <td>${formatPrice(r.price)}</td>
      <td>${formatMoney(r.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(r.fee)}</td>`;
    tbody.appendChild(tr);
  });
}

// ══════════════════════════════════════════════
//  Dashboard
// ══════════════════════════════════════════════

function renderDashboard(holdingsValue = 0) {
  document.getElementById('cashDisplay').textContent = '$ ' + formatMoney(state.cash);
  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(holdingsValue);
  document.getElementById('totalAsset').textContent = '$ ' + formatMoney(state.cash + holdingsValue);
  const pnl = num(state.realizedPnL) ?? 0;
  const el = document.getElementById('totalPnL');
  el.textContent = `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)} 元`;
  el.className = `text-xl font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`;
}

async function renderAll() {
  updateLastSavedLabel();
  const hv = await renderHoldings();
  renderDashboard(hv);
  renderHistory();
  await renderWatchlist();
}

// ══════════════════════════════════════════════
//  Backup / Restore
// ══════════════════════════════════════════════

function exportDataToJson() {
  const payload = { exportedAt: new Date().toISOString(), version: '1.4', data: loadState() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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

// ══════════════════════════════════════════════
//  Toast
// ══════════════════════════════════════════════

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg; el.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ══════════════════════════════════════════════
//  Init
// ══════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  updateLastSavedLabel();

  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') addToWatchlist(); });

  const tradeSymbol = document.getElementById('tradeSymbol');
  if (tradeSymbol) tradeSymbol.addEventListener('blur', () => { tradeSymbol.value = normalizeSymbol(tradeSymbol.value); });

  const tradeQty = document.getElementById('tradeQty');
  if (tradeQty) tradeQty.addEventListener('keydown', e => { if (e.key === 'Enter') executeTrade('buy'); });

  await renderAll();

  // 每 90 秒強制刷新所有快取
  setInterval(async () => {
    twseDataMap = null; twseDataTs = 0;
    tpexDataMap = null; tpexDataTs = 0;
    Object.keys(quoteCache).forEach(k => delete quoteCache[k]);
    await renderAll();
  }, 90_000);
});

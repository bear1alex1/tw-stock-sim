const INITIAL_CASH = 1_000_000;
const STORAGE_KEY = 'twStock_v1';
const LOT_SIZE = 1000;
const PRICE_CACHE_TTL = 90_000;

let state = loadState();
const priceCache = {};
let twseAllCache = { data: null, ts: 0 };
let tpexAllCache = { data: null, ts: 0 };

// ── Utils ──────────────────────────────────────

function num(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, '').replace(/＋/g, '+').trim();
  if (!cleaned || /^[-–]{2,}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/\.TW$|\.TWO$/i, '');
}

function formatMoney(value) {
  return Math.round(Number(value) || 0).toLocaleString('zh-TW');
}

function formatPrice(value) {
  const n = num(value);
  if (n === null || n <= 0) return '—';
  return n.toFixed(2);
}

// ── State ──────────────────────────────────────

function getEmptyState() {
  return {
    cash: INITIAL_CASH,
    holdings: {},
    history: [],
    watchlist: [],
    realizedPnL: 0,
    savedAt: new Date().toISOString()
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return getEmptyState();
    const parsed = JSON.parse(raw);
    return {
      cash: num(parsed.cash) ?? INITIAL_CASH,
      holdings: parsed.holdings && typeof parsed.holdings === 'object' ? parsed.holdings : {},
      history: Array.isArray(parsed.history) ? parsed.history : [],
      watchlist: Array.isArray(parsed.watchlist)
        ? [...new Set(parsed.watchlist.map(normalizeSymbol).filter(Boolean))]
        : [],
      realizedPnL: num(parsed.realizedPnL) ?? 0,
      savedAt: parsed.savedAt || new Date().toISOString()
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
  if (!el) return;
  el.textContent = state.savedAt
    ? '最後儲存：' + new Date(state.savedAt).toLocaleString('zh-TW')
    : '最後儲存：—';
}

// ── 稅費計算 ───────────────────────────────────

function calcFee(price, lots, side) {
  const amount = price * lots * LOT_SIZE;
  const broker = Math.max(Math.round(amount * 0.001425), 20);
  const tax = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return { amount, broker, tax, total: broker + tax };
}

// ── TWSE OpenAPI（上市，原生支援 CORS）─────────
// https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL
// 每次回傳當日（或最近交易日）所有上市股票收盤行情

async function fetchTwseAll() {
  if (twseAllCache.data && Date.now() - twseAllCache.ts < PRICE_CACHE_TTL) {
    return twseAllCache.data;
  }
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('TWSE status ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) throw new Error('TWSE empty');
    const map = {};
    for (const item of json) {
      const code = String(item.Code || '').trim();
      const close = num(item.ClosingPrice);
      const open = num(item.OpeningPrice);
      const prev = num(item.LastBestAskPrice) ?? num(item.HighestPrice);
      if (code && close && close > 0) {
        map[code] = { close, open, prev };
      }
    }
    twseAllCache = { data: map, ts: Date.now() };
    return map;
  } catch (e) {
    console.warn('[TWSE OpenAPI]', e.message);
    return null;
  }
}

// ── TPEx OpenAPI（上櫃，原生支援 CORS）─────────
// https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes

async function fetchTpexAll() {
  if (tpexAllCache.data && Date.now() - tpexAllCache.ts < PRICE_CACHE_TTL) {
    return tpexAllCache.data;
  }
  try {
    const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('TPEx status ' + res.status);
    const json = await res.json();
    if (!Array.isArray(json) || !json.length) throw new Error('TPEx empty');
    const map = {};
    for (const item of json) {
      const code = String(item.SecuritiesCompanyCode || '').trim();
      const close = num(item.Close);
      if (code && close && close > 0) {
        map[code] = { close };
      }
    }
    tpexAllCache = { data: map, ts: Date.now() };
    return map;
  } catch (e) {
    console.warn('[TPEx OpenAPI]', e.message);
    return null;
  }
}

// ── Yahoo Finance via allorigins CORS proxy ─────

async function fetchYahooViaProxy(symbol) {
  const suffixes = ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    try {
      const target = encodeURIComponent(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?range=5d&interval=1d`
      );
      const res = await fetch(`https://api.allorigins.win/raw?url=${target}`, {
        cache: 'no-store'
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      const quoteArr = result?.indicators?.quote?.[0];
      if (!result || !meta || !quoteArr) continue;

      const closes = Array.isArray(quoteArr.close)
        ? quoteArr.close.map(v => num(v)).filter(v => v !== null && v > 0)
        : [];

      const marketState = String(meta.marketState || 'CLOSED').toUpperCase();
      const regularPrice = num(meta.regularMarketPrice);
      const prevClose =
        num(meta.regularMarketPreviousClose) ??
        num(meta.previousClose) ??
        num(meta.chartPreviousClose);

      const lastClose = closes.length ? closes[closes.length - 1] : null;
      const price = marketState === 'REGULAR'
        ? (regularPrice ?? lastClose ?? prevClose)
        : (lastClose ?? regularPrice ?? prevClose);

      if (!price || price <= 0) continue;

      const base = prevClose ?? (closes.length >= 2 ? closes[closes.length - 2] : null);
      const change = base !== null ? price - base : null;
      const changePct = base ? (change / base) * 100 : null;

      return { price, previousClose: base, change, changePct, marketState };
    } catch (_) {}
  }
  return null;
}

// ── 主要報價入口 ───────────────────────────────
// 優先順序：TWSE OpenAPI → TPEx OpenAPI → Yahoo Proxy

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;

  const cached = priceCache[symbol];
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) return cached.data;

  let price = null;
  let previousClose = null;
  let change = null;
  let changePct = null;
  let marketState = 'CLOSED';
  let source = null;

  // 1. 嘗試 TWSE OpenAPI
  const twseMap = await fetchTwseAll();
  if (twseMap && twseMap[symbol]) {
    const item = twseMap[symbol];
    price = item.close;
    previousClose = item.prev ?? null;
    change = previousClose !== null ? price - previousClose : null;
    changePct = previousClose ? (change / previousClose) * 100 : null;
    source = 'twse';
  }

  // 2. 嘗試 TPEx OpenAPI
  if (!price) {
    const tpexMap = await fetchTpexAll();
    if (tpexMap && tpexMap[symbol]) {
      price = tpexMap[symbol].close;
      source = 'tpex';
    }
  }

  // 3. 嘗試 Yahoo Finance（透過 CORS proxy）
  if (!price) {
    const yahoo = await fetchYahooViaProxy(symbol);
    if (yahoo && yahoo.price > 0) {
      price = yahoo.price;
      previousClose = yahoo.previousClose;
      change = yahoo.change;
      changePct = yahoo.changePct;
      marketState = yahoo.marketState;
      source = 'yahoo';
    }
  }

  if (!price || price <= 0) return null;

  const data = { symbol, price, previousClose, change, changePct, marketState, source };
  priceCache[symbol] = { data, ts: Date.now() };
  return data;
}

// ── Watchlist ──────────────────────────────────

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
  delete priceCache[symbol];
  saveState(state);
  renderWatchlist();
}

async function renderWatchlist() {
  const tbody = document.getElementById('watchlistBody');
  tbody.innerHTML = '';

  for (const symbol of state.watchlist) {
    const quote = await fetchQuote(symbol);
    const price = quote?.price ?? null;
    const change = quote?.change ?? null;
    const changePct = quote?.changePct ?? null;
    const stateText = !quote ? '離線' : quote.marketState === 'REGULAR' ? '盤中' : '收盤';
    const badgeClass = !quote ? '' : (change ?? 0) >= 0 ? 'badge-up' : 'badge-down';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${formatPrice(price)}</td>
      <td>
        ${change !== null && changePct !== null
          ? `<div class="${change >= 0 ? 'text-up' : 'text-down'}">
               ${change >= 0 ? '+' : ''}${change.toFixed(2)}
               (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)
             </div>`
          : '<div>—</div>'}
        <div class="mt-1"><span class="badge ${badgeClass}">${stateText}</span></div>
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

// ── 虛擬交易 ───────────────────────────────────

async function executeTrade(side) {
  const symbol = normalizeSymbol(document.getElementById('tradeSymbol').value);
  const lots = parseInt(document.getElementById('tradeQty').value, 10);
  const priceInput = document.getElementById('tradePrice').value.trim();
  const msg = document.getElementById('tradeMsg');

  if (!symbol || !lots || lots < 1) {
    msg.textContent = '❌ 請填寫股票代號與股數';
    return;
  }

  let price = num(priceInput);
  if (!price || price <= 0) {
    const quote = await fetchQuote(symbol);
    price = quote?.price ?? null;
    if (!price || price <= 0) {
      msg.textContent = '❌ 無法取得報價，請手動輸入成交價';
      return;
    }
  }

  const fee = calcFee(price, lots, side);

  if (side === 'buy') {
    const totalCost = fee.amount + fee.total;
    if (totalCost > state.cash) {
      msg.textContent = `❌ 現金不足（需 ${formatMoney(totalCost)} 元）`;
      return;
    }
    state.cash -= totalCost;
    if (!state.holdings[symbol]) state.holdings[symbol] = { shares: 0, avgPrice: 0 };
    const h = state.holdings[symbol];
    const oldAmt = h.avgPrice * h.shares * LOT_SIZE;
    const newAmt = price * lots * LOT_SIZE;
    const newShares = h.shares + lots;
    h.avgPrice = (oldAmt + newAmt) / (newShares * LOT_SIZE);
    h.shares = newShares;
    showToast(`✅ 買入 ${symbol} ${lots} 張，花費 ${formatMoney(totalCost)} 元`);
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
    symbol, side, shares: lots, price,
    amount: fee.amount, fee: fee.total
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

// ── 持股庫存 ───────────────────────────────────

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
    const quote = await fetchQuote(symbol);
    const price = quote?.price > 0 ? quote.price : h.avgPrice;
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
        <span class="text-xs ${quote?.marketState === 'REGULAR' ? 'text-green-400' : 'text-gray-400'}">
          ${quote ? (quote.marketState === 'REGULAR' ? '盤中' : '收盤') : ''}
        </span>
      </td>
      <td class="${pnl >= 0 ? 'text-up' : 'text-down'}">
        ${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}
      </td>
      <td>
        <button class="text-xs text-blue-400 hover:underline"
          onclick="document.getElementById('tradeSymbol').value='${symbol}'">快速賣出</button>
      </td>`;
    tbody.appendChild(tr);
  }

  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(total);
  return total;
}

// ── 交易紀錄 ───────────────────────────────────

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

// ── 儀表板 ─────────────────────────────────────

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
  const holdingsValue = await renderHoldings();
  renderDashboard(holdingsValue);
  renderHistory();
  await renderWatchlist();
}

// ── JSON 備份 / 還原 ───────────────────────────

function exportDataToJson() {
  const payload = { exportedAt: new Date().toISOString(), version: '1.3', data: loadState() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const a = document.createElement('a');
  a.href = url;
  a.download = `stock_backup_${today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
        alert('❌ 無效的備份檔案格式');
        return;
      }
      imported.watchlist = [...new Set(imported.watchlist.map(normalizeSymbol).filter(Boolean))];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
      showToast('✅ 備份載入成功！正在重新整理…');
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      alert('❌ JSON 解析失敗：' + err.message);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
}

function resetAllData() {
  if (!confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ── Toast ──────────────────────────────────────

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── 啟動 ───────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  updateLastSavedLabel();

  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') addToWatchlist(); });
  }

  const tradeSymbol = document.getElementById('tradeSymbol');
  if (tradeSymbol) {
    tradeSymbol.addEventListener('blur', () => {
      tradeSymbol.value = normalizeSymbol(tradeSymbol.value);
    });
  }

  const tradeQty = document.getElementById('tradeQty');
  if (tradeQty) {
    tradeQty.addEventListener('keydown', e => { if (e.key === 'Enter') executeTrade('buy'); });
  }

  await renderAll();

  // 每 90 秒強制清快取並刷新一次
  setInterval(async () => {
    twseAllCache = { data: null, ts: 0 };
    tpexAllCache = { data: null, ts: 0 };
    Object.keys(priceCache).forEach(k => delete priceCache[k]);
    await renderAll();
  }, 90_000);
});

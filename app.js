const INITIAL_CASH = 1_000_000;
const STORAGE_KEY = 'twStock_v1';
const LOT_SIZE = 1000;
const PRICE_CACHE_TTL = 60_000;

let state = loadState();
const priceCache = {};

function num(value) {
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\.TW$|\.TWO$/i, '');
}

function formatMoney(value) {
  const n = Math.round(Number(value) || 0);
  return n.toLocaleString('zh-TW');
}

function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n.toFixed(2);
}

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
  } catch {
    return getEmptyState();
  }
}

function saveState(currentState) {
  currentState.savedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));

  const el = document.getElementById('lastSaved');
  if (el) {
    el.textContent = '最後儲存：' + new Date(currentState.savedAt).toLocaleString('zh-TW');
  }
}

function updateLastSavedLabel() {
  const el = document.getElementById('lastSaved');
  if (!el) return;
  el.textContent = state.savedAt
    ? '最後儲存：' + new Date(state.savedAt).toLocaleString('zh-TW')
    : '最後儲存：—';
}

function calcFee(price, lots, side) {
  const amount = price * lots * LOT_SIZE;
  const broker = Math.max(Math.round(amount * 0.001425), 20);
  const tax = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return {
    amount,
    broker,
    tax,
    total: broker + tax
  };
}

function parseTwseNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/,/g, '').trim();
  if (!cleaned || cleaned === '--' || cleaned === '---' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function monthKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}${m}01`;
}

async function fetchTwseRecentClose(symbol) {
  if (!/^\d{4,6}$/.test(symbol)) return null;

  const months = [
    new Date(),
    new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
  ];

  for (const d of months) {
    try {
      const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${monthKey(d)}&stockNo=${symbol}&_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;

      const json = await res.json();
      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) continue;

      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const close = parseTwseNumber(row?.[6]);
        const diff = parseTwseNumber(String(row?.[7] || '').replace(/[^\d.-]/g, ''));
        if (close && close > 0) {
          const previousClose = diff !== null ? close - diff : null;
          const change = previousClose !== null ? close - previousClose : null;
          const changePct = previousClose ? (change / previousClose) * 100 : null;

          return {
            symbol,
            source: 'twse_close',
            price: close,
            previousClose,
            change,
            changePct,
            marketState: 'CLOSED',
            isClosePrice: true
          };
        }
      }
    } catch (_) {}
  }

  return null;
}

async function fetchYahooQuote(symbol) {
  const suffixes = ['.TW', '.TWO'];

  for (const suffix of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?range=5d&interval=1d&includePrePost=false&corsDomain=finance.yahoo.com`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      const quote = result?.indicators?.quote?.[0];
      if (!result || !meta || !quote) continue;

      const closes = Array.isArray(quote.close)
        ? quote.close.map(v => num(v)).filter(v => v !== null && v > 0)
        : [];

      const regularMarketPrice = num(meta.regularMarketPrice);
      const previousClose =
        num(meta.regularMarketPreviousClose) ??
        num(meta.previousClose) ??
        num(meta.chartPreviousClose);

      const lastClose = closes.length ? closes[closes.length - 1] : null;
      const prevCloseFromSeries = closes.length >= 2 ? closes[closes.length - 2] : previousClose;
      const marketState = String(meta.marketState || 'CLOSED').toUpperCase();

      let price = null;
      if (marketState === 'REGULAR' && regularMarketPrice && regularMarketPrice > 0) {
        price = regularMarketPrice;
      } else {
        price = lastClose ?? regularMarketPrice ?? previousClose;
      }

      if (!price || price <= 0) continue;

      const compareBase = previousClose ?? prevCloseFromSeries ?? null;
      const change = compareBase !== null ? price - compareBase : null;
      const changePct = compareBase ? (change / compareBase) * 100 : null;

      return {
        symbol,
        source: 'yahoo',
        price,
        previousClose: compareBase,
        change,
        changePct,
        marketState,
        isClosePrice: marketState !== 'REGULAR'
      };
    } catch (_) {}
  }

  return null;
}

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;

  const cached = priceCache[symbol];
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) {
    return cached.data;
  }

  let yahoo = null;
  let twseClose = null;

  try {
    yahoo = await fetchYahooQuote(symbol);
  } catch (_) {}

  if (yahoo && yahoo.marketState === 'REGULAR' && yahoo.price > 0) {
    priceCache[symbol] = { data: yahoo, ts: Date.now() };
    return yahoo;
  }

  try {
    twseClose = await fetchTwseRecentClose(symbol);
  } catch (_) {}

  const finalQuote = twseClose || yahoo || null;

  if (finalQuote && finalQuote.price > 0) {
    priceCache[symbol] = { data: finalQuote, ts: Date.now() };
    return finalQuote;
  }

  return null;
}

function getMarketStateLabel(quote) {
  if (!quote) return '離線';
  return quote.marketState === 'REGULAR' ? '盤中' : '收盤';
}

function getMarketStateClass(quote) {
  if (!quote) return '';
  if (quote.marketState === 'REGULAR') {
    return (quote.change ?? 0) >= 0 ? 'badge-up' : 'badge-down';
  }
  return 'badge-up';
}

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
    const stateText = getMarketStateLabel(quote);
    const stateClass = getMarketStateClass(quote);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${formatPrice(price)}</td>
      <td>
        ${
          change !== null && changePct !== null
            ? `<div class="${change >= 0 ? 'text-up' : 'text-down'}">
                 ${change >= 0 ? '+' : ''}${change.toFixed(2)}
                 (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)
               </div>`
            : '—'
        }
        <div class="mt-1">
          <span class="badge ${stateClass}">${stateText}</span>
        </div>
      </td>
      <td>
        <button class="text-xs text-blue-400 hover:underline mr-2"
          onclick="document.getElementById('tradeSymbol').value='${symbol}'">操盤</button>
        <button class="text-xs text-red-500 hover:underline"
          onclick="removeFromWatchlist('${symbol}')">移除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

async function executeTrade(side) {
  const symbol = normalizeSymbol(document.getElementById('tradeSymbol').value);
  const lots = parseInt(document.getElementById('tradeQty').value, 10);
  const tradePriceInput = document.getElementById('tradePrice').value.trim();
  const msg = document.getElementById('tradeMsg');

  if (!symbol || !lots || lots < 1) {
    msg.textContent = '❌ 請填寫股票代號與股數';
    return;
  }

  let price = num(tradePriceInput);
  if (price === null || price <= 0) {
    const quote = await fetchQuote(symbol);
    price = quote?.price ?? null;
    if (price === null || price <= 0) {
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

    if (!state.holdings[symbol]) {
      state.holdings[symbol] = { shares: 0, avgPrice: 0 };
    }

    const holding = state.holdings[symbol];
    const oldAmount = holding.avgPrice * holding.shares * LOT_SIZE;
    const newAmount = price * lots * LOT_SIZE;
    const newShares = holding.shares + lots;

    holding.avgPrice = (oldAmount + newAmount) / (newShares * LOT_SIZE);
    holding.shares = newShares;

    showToast(`✅ 買入 ${symbol} ${lots} 張，花費 ${formatMoney(totalCost)} 元`);
  } else {
    const holding = state.holdings[symbol];

    if (!holding || holding.shares < lots) {
      msg.textContent = '❌ 持股不足';
      return;
    }

    const proceeds = fee.amount - fee.total;
    const costBasis = holding.avgPrice * lots * LOT_SIZE;
    const realized = proceeds - costBasis;

    state.realizedPnL += realized;
    state.cash += proceeds;
    holding.shares -= lots;

    if (holding.shares === 0) {
      delete state.holdings[symbol];
    }

    showToast(`✅ 賣出 ${symbol} ${lots} 張，入帳 ${formatMoney(proceeds)} 元`);
  }

  state.history.unshift({
    time: new Date().toLocaleString('zh-TW'),
    symbol,
    side,
    shares: lots,
    price,
    amount: fee.amount,
    fee: fee.total
  });

  if (!state.watchlist.includes(symbol)) {
    state.watchlist.unshift(symbol);
    state.watchlist = [...new Set(state.watchlist)];
  }

  saveState(state);
  msg.textContent = '';
  await renderAll();

  document.getElementById('tradePrice').value = '';
}

async function renderHoldings() {
  const tbody = document.getElementById('holdingsBody');
  const empty = document.getElementById('holdingsEmpty');
  tbody.innerHTML = '';

  const symbols = Object.keys(state.holdings);
  if (symbols.length === 0) {
    empty.style.display = '';
    document.getElementById('holdingsValue').textContent = '$ 0';
    return 0;
  }

  empty.style.display = 'none';
  let totalHoldVal = 0;

  for (const symbol of symbols) {
    const holding = state.holdings[symbol];
    const quote = await fetchQuote(symbol);
    const price = quote?.price && quote.price > 0 ? quote.price : holding.avgPrice;
    const marketValue = price * holding.shares * LOT_SIZE;
    const costValue = holding.avgPrice * holding.shares * LOT_SIZE;
    const pnl = marketValue - costValue;

    totalHoldVal += marketValue;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${holding.shares} 張</td>
      <td>${formatPrice(holding.avgPrice)}</td>
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
      </td>
    `;
    tbody.appendChild(tr);
  }

  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(totalHoldVal);
  return totalHoldVal;
}

function renderHistory() {
  const tbody = document.getElementById('tradeHistoryBody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';

  if (state.history.length === 0) {
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';

  state.history.slice(0, 50).forEach(record => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-xs text-gray-500">${record.time}</td>
      <td class="font-mono font-bold">${record.symbol}</td>
      <td>
        <span class="badge ${record.side === 'buy' ? 'badge-up' : 'badge-down'}">
          ${record.side === 'buy' ? '買入' : '賣出'}
        </span>
      </td>
      <td>${record.shares} 張</td>
      <td>${formatPrice(record.price)}</td>
      <td>${formatMoney(record.amount)}</td>
      <td class="text-gray-500 text-xs">${formatMoney(record.fee)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDashboard(holdingsValue = 0) {
  document.getElementById('cashDisplay').textContent = '$ ' + formatMoney(state.cash);
  document.getElementById('holdingsValue').textContent = '$ ' + formatMoney(holdingsValue);

  const totalAsset = state.cash + holdingsValue;
  document.getElementById('totalAsset').textContent = '$ ' + formatMoney(totalAsset);

  const pnlEl = document.getElementById('totalPnL');
  const pnl = num(state.realizedPnL) ?? 0;
  pnlEl.textContent = `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)} 元`;
  pnlEl.className = `text-xl font-bold ${pnl >= 0 ? 'text-up' : 'text-down'}`;
}

async function renderAll() {
  updateLastSavedLabel();
  const holdingsValue = await renderHoldings();
  renderDashboard(holdingsValue);
  renderHistory();
  await renderWatchlist();
}

function exportDataToJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: '1.2',
    data: loadState()
  };

  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
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

function isValidImportedState(data) {
  return data &&
    typeof data === 'object' &&
    typeof data.cash !== 'undefined' &&
    typeof data.holdings === 'object' &&
    Array.isArray(data.history) &&
    Array.isArray(data.watchlist);
}

function importDataFromJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const imported = parsed.data || parsed;

      if (!isValidImportedState(imported)) {
        alert('❌ 無效的備份檔案格式，請確認是否為本系統匯出的 JSON。');
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
  const ok = confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？');
  if (!ok) return;

  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = message;
  el.style.display = 'block';

  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.style.display = 'none';
  }, 3000);
}

async function refreshQuotes() {
  Object.keys(priceCache).forEach(key => delete priceCache[key]);
  await renderAll();
}

document.addEventListener('DOMContentLoaded', async () => {
  updateLastSavedLabel();

  const searchInput = document.getElementById('searchInput');
  const tradeSymbol = document.getElementById('tradeSymbol');
  const tradeQty = document.getElementById('tradeQty');

  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addToWatchlist();
    });
  }

  if (tradeSymbol) {
    tradeSymbol.addEventListener('blur', () => {
      tradeSymbol.value = normalizeSymbol(tradeSymbol.value);
    });
  }

  if (tradeQty) {
    tradeQty.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') executeTrade('buy');
    });
  }

  await renderAll();
  setInterval(refreshQuotes, 60_000);
});

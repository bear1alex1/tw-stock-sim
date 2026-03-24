const INITIAL_CASH = 1_000_000;
const STORAGE_KEY = 'twStock_v1';
const LOT_SIZE = 1000;
const PRICE_CACHE_TTL = 60_000;

let state = loadState();
const priceCache = {};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSymbol(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\.TW$|\.TWO$/i, '');
}

function formatMoney(value) {
  return Math.round(value || 0).toLocaleString('zh-TW');
}

function formatPrice(value) {
  const n = num(value);
  return n === null ? '—' : n.toFixed(2);
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
      watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist.map(normalizeSymbol) : [],
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

async function fetchQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  if (!symbol) return null;

  const cached = priceCache[symbol];
  if (cached && Date.now() - cached.ts < PRICE_CACHE_TTL) {
    return cached.data;
  }

  const suffixes = ['.TW', '.TWO'];

  for (const suffix of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?interval=1d&range=5d`;
      const res = await fetch(url);
      if (!res.ok) continue;

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      const quote = result?.indicators?.quote?.[0];
      if (!result || !meta || !quote) continue;

      const closes = Array.isArray(quote.close)
        ? quote.close.filter(v => typeof v === 'number' && !Number.isNaN(v))
        : [];

      const regularMarketPrice = num(meta.regularMarketPrice);
      const previousClose =
        num(meta.regularMarketPreviousClose) ??
        num(meta.previousClose) ??
        num(meta.chartPreviousClose);

      const lastClose = closes.length ? closes[closes.length - 1] : null;
      const prevCloseFromSeries = closes.length >= 2 ? closes[closes.length - 2] : null;
      const marketState = String(meta.marketState || 'CLOSED').toUpperCase();

      let displayPrice = null;
      if (marketState === 'REGULAR') {
        displayPrice = regularMarketPrice ?? lastClose ?? previousClose;
      } else {
        displayPrice = lastClose ?? regularMarketPrice ?? previousClose;
      }

      if (displayPrice === null) continue;

      const compareBase = previousClose ?? prevCloseFromSeries;
      const change = compareBase !== null ? displayPrice - compareBase : null;
      const changePct = compareBase ? (change / compareBase) * 100 : null;

      const data = {
        symbol,
        suffix,
        price: displayPrice,
        previousClose: compareBase,
        rawPreviousClose: previousClose,
        marketState,
        isClosePrice: marketState !== 'REGULAR',
        change,
        changePct
      };

      priceCache[symbol] = { data, ts: Date.now() };
      return data;
    } catch (_) {}
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
    if ((quote.change ?? 0) < 0) return 'badge-down';
    return 'badge-up';
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
  if (price === null) {
    const quote = await fetchQuote(symbol);
    price = quote?.price ?? null;
    if (price === null) {
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
    const newAmount = fee.amount;
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
    return 0;
  }

  empty.style.display = 'none';
  let totalHoldVal = 0;

  for (const symbol of symbols) {
    const holding = state.holdings[symbol];
    const quote = await fetchQuote(symbol);
    const price = quote?.price ?? holding.avgPrice;
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
    version: '1.1',
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

      imported.watchlist = imported.watchlist.map(normalizeSymbol);
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

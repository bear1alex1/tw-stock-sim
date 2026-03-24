// ═══════════════════════════════════════════════
//  台股虛擬操盤系統 — app.js
//  功能：追蹤清單、即時報價、虛擬買賣、JSON 備份/還原
// ═══════════════════════════════════════════════

const INITIAL_CASH = 1_000_000;
const STORAGE_KEY  = 'twStock_v1';

// ── 台股稅費計算 ────────────────────────────────
// 買入：手續費 0.1425%（最低 20 元）
// 賣出：手續費 0.1425% + 證交稅 0.3%
function calcFee(price, shares, side) {
  const amount  = price * shares * 1000; // 1 張 = 1000 股
  const broker  = Math.max(Math.round(amount * 0.001425), 20);
  const tax     = side === 'sell' ? Math.round(amount * 0.003) : 0;
  return { amount, broker, tax, total: broker + tax };
}

// ── 讀取 / 寫入 localStorage ────────────────────
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  return {
    cash: INITIAL_CASH,
    holdings: {},    // { '2330': { shares, avgPrice } }
    history:  [],    // [ { time, symbol, side, shares, price, amount, fee } ]
    watchlist: [],   // [ '2330', '0050', ... ]
    realizedPnL: 0
  };
}

function saveState(state) {
  state.savedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  document.getElementById('lastSaved').textContent =
    '最後儲存：' + new Date().toLocaleTimeString('zh-TW');
}

let state = loadState();
const priceCache = {}; // 暫存報價，避免頻繁 API 呼叫

// ── Yahoo Finance 代理取得台股現價 ─────────────
// 上市股票加 .TW，上櫃加 .TWO（先試 .TW，失敗再試 .TWO）
async function fetchPrice(symbol) {
  if (priceCache[symbol] && Date.now() - priceCache[symbol].ts < 60_000)
    return priceCache[symbol].price;

  const suffixes = ['.TW', '.TWO'];
  for (const sfx of suffixes) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${sfx}?interval=1d&range=1d`;
      const res  = await fetch(url);
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) {
        priceCache[symbol] = { price, ts: Date.now() };
        return price;
      }
    } catch (_) {}
  }
  return null;
}

// ── 追蹤清單 ────────────────────────────────────
function addToWatchlist() {
  const symbol = document.getElementById('searchInput').value.trim().toUpperCase();
  if (!symbol) return;
  if (!state.watchlist.includes(symbol)) {
    state.watchlist.push(symbol);
    saveState(state);
  }
  document.getElementById('searchInput').value = '';
  renderWatchlist();
}

function removeFromWatchlist(symbol) {
  state.watchlist = state.watchlist.filter(s => s !== symbol);
  saveState(state);
  renderWatchlist();
}

async function renderWatchlist() {
  const tbody = document.getElementById('watchlistBody');
  tbody.innerHTML = '';
  for (const symbol of state.watchlist) {
    const price = await fetchPrice(symbol);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${price ? price.toFixed(2) : '—'}</td>
      <td><span class="badge ${price ? 'badge-up' : ''}">${price ? '▲' : '離線'}</span></td>
      <td>
        <button class="text-xs text-blue-400 hover:underline mr-2"
          onclick="document.getElementById('tradeSymbol').value='${symbol}'">操盤</button>
        <button class="text-xs text-red-500 hover:underline"
          onclick="removeFromWatchlist('${symbol}')">移除</button>
      </td>`;
    tbody.appendChild(tr);
  }
}

// ── 虛擬交易 ────────────────────────────────────
async function executeTrade(side) {
  const symbol = document.getElementById('tradeSymbol').value.trim().toUpperCase();
  const shares = parseInt(document.getElementById('tradeQty').value, 10);
  let   price  = parseFloat(document.getElementById('tradePrice').value);
  const msg    = document.getElementById('tradeMsg');

  if (!symbol || !shares || shares < 1) {
    msg.textContent = '❌ 請填寫股票代號與股數'; return;
  }
  if (!price) {
    price = await fetchPrice(symbol);
    if (!price) { msg.textContent = '❌ 無法取得報價，請手動輸入價格'; return; }
  }

  const fee = calcFee(price, shares, side);

  if (side === 'buy') {
    const totalCost = fee.amount + fee.total;
    if (totalCost > state.cash) {
      msg.textContent = `❌ 現金不足（需 ${totalCost.toLocaleString()} 元）`; return;
    }
    state.cash -= totalCost;
    if (!state.holdings[symbol]) state.holdings[symbol] = { shares: 0, avgPrice: 0 };
    const h = state.holdings[symbol];
    const newShares = h.shares + shares;
    h.avgPrice = ((h.shares * h.avgPrice) + fee.amount) / newShares;
    h.shares   = newShares;
    showToast(`✅ 買入 ${symbol} ${shares} 張，花費 ${totalCost.toLocaleString()} 元`);
  } else {
    const h = state.holdings[symbol];
    if (!h || h.shares < shares) {
      msg.textContent = `❌ 持股不足`; return;
    }
    const proceeds = fee.amount - fee.total;
    const costBasis = h.avgPrice * shares * 1000;
    state.realizedPnL += (fee.amount - costBasis - fee.total);
    state.cash += proceeds;
    h.shares -= shares;
    if (h.shares === 0) delete state.holdings[symbol];
    showToast(`✅ 賣出 ${symbol} ${shares} 張，入帳 ${proceeds.toLocaleString()} 元`);
  }

  state.history.unshift({
    time: new Date().toLocaleString('zh-TW'),
    symbol, side, shares, price,
    amount: fee.amount,
    fee: fee.total
  });

  saveState(state);
  renderAll();
  msg.textContent = '';
}

// ── 持股庫存渲染 ────────────────────────────────
async function renderHoldings() {
  const tbody  = document.getElementById('holdingsBody');
  const empty  = document.getElementById('holdingsEmpty');
  tbody.innerHTML = '';
  const symbols = Object.keys(state.holdings);
  if (symbols.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  let totalHoldVal = 0;

  for (const symbol of symbols) {
    const h     = state.holdings[symbol];
    const price = await fetchPrice(symbol) || h.avgPrice;
    const mktVal = price * h.shares * 1000;
    const pnl    = mktVal - h.avgPrice * h.shares * 1000;
    totalHoldVal += mktVal;
    const pnlClass = pnl >= 0 ? 'text-up' : 'text-down';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono font-bold">${symbol}</td>
      <td>${h.shares} 張</td>
      <td>${h.avgPrice.toFixed(2)}</td>
      <td>${price.toFixed(2)}</td>
      <td class="${pnlClass}">${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}</td>
      <td>
        <button class="text-xs text-blue-400 hover:underline"
          onclick="document.getElementById('tradeSymbol').value='${symbol}'">快速賣出</button>
      </td>`;
    tbody.appendChild(tr);
  }
  document.getElementById('holdingsValue').textContent =
    '$ ' + Math.round(totalHoldVal).toLocaleString();
}

// ── 交易紀錄渲染 ────────────────────────────────
function renderHistory() {
  const tbody = document.getElementById('tradeHistoryBody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';
  if (state.history.length === 0) { empty.style.display = ''; return; }
  empty.style.display = 'none';
  state.history.slice(0, 50).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="text-xs text-gray-500">${r.time}</td>
      <td class="font-mono font-bold">${r.symbol}</td>
      <td><span class="badge ${r.side === 'buy' ? 'badge-up' : 'badge-down'}">${r.side === 'buy' ? '買入' : '賣出'}</span></td>
      <td>${r.shares} 張</td>
      <td>${r.price.toFixed(2)}</td>
      <td>${r.amount.toLocaleString()}</td>
      <td class="text-gray-500 text-xs">${r.fee.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
}

// ── 儀表板數字更新 ──────────────────────────────
function renderDashboard() {
  document.getElementById('cashDisplay').textContent =
    '$ ' + Math.round(state.cash).toLocaleString();
  const pnl = Math.round(state.realizedPnL || 0);
  const pnlEl = document.getElementById('totalPnL');
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toLocaleString() + ' 元';
  pnlEl.className   = 'text-xl font-bold ' + (pnl >= 0 ? 'text-up' : 'text-down');
}

async function renderAll() {
  renderDashboard();
  await renderHoldings();
  renderHistory();
  const hValText = document.getElementById('holdingsValue').textContent;
  const hVal     = parseInt(hValText.replace(/[^\d]/g, '')) || 0;
  const total    = Math.round(state.cash) + hVal;
  document.getElementById('totalAsset').textContent = '$ ' + total.toLocaleString();
}

// ═══════════════════════════════════════════════
//  ★ 核心函數：JSON 匯出 / 匯入
// ═══════════════════════════════════════════════

/** 匯出：將所有資料打包成 stock_backup_YYYYMMDD.json 下載 */
function exportDataToJson() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: '1.0',
    data: loadState()
  };
  const json  = JSON.stringify(payload, null, 2);
  const blob  = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url   = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `stock_backup_${today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('💾 備份已下載：stock_backup_' + today + '.json');
}

/** 匯入：讀取 .json 檔並覆蓋 localStorage，刷新頁面 */
function importDataFromJson(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      // 支援兩種格式：直接的 state 物件，或包裹在 { data: ... } 的備份格式
      const importedData = parsed.data || parsed;
      // 基本欄位驗證
      if (typeof importedData.cash === 'undefined') {
        alert('❌ 無效的備份檔案格式，請確認是否為本系統匯出的 JSON。');
        return;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(importedData));
      showToast('✅ 備份載入成功！正在重新整理…');
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      alert('❌ JSON 解析失敗：' + err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
  // 清除 input 以允許重複匯入同一檔案
  event.target.value = '';
}

// ── 重置資料 ────────────────────────────────────
function resetAllData() {
  if (!confirm('⚠️ 確定要清除所有資料並重置為初始 100 萬嗎？')) return;
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
}

// ── Toast 通知 ──────────────────────────────────
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

// ── 自動刷新報價（每 60 秒） ────────────────────
setInterval(() => renderWatchlist(), 60_000);

// ── 初始化 ──────────────────────────────────────
(async () => {
  await renderAll();
  await renderWatchlist();
})();

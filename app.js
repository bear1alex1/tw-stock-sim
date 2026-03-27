(function(){
  'use strict';

  const HOTFIX_VERSION = 'v3.9.1-hotfix';
  const ADMIN_HASH = '0912d4684c7301ab4f8e436d0dab16d0979e5e96082e552ce1590f917ecf0f76';
  const ADMIN_PEPPER = 'twstock.screen.admin|S390';
  const ADMIN_FLAG = 'screen_admin_hotfix_unlock';
  const ETF_FLAG = 'skip_non_company_instruments';
  const NON_COMPANY_KEYWORDS = ['ETF','指數股票型','槓桿','反向','ETN','權證','牛熊證','存託憑證'];

  function $(sel, root){ return (root || document).querySelector(sel); }
  function $all(sel, root){ return Array.from((root || document).querySelectorAll(sel)); }
  function byId(id){ return document.getElementById(id); }
  function text(v){ return String(v == null ? '' : v).trim(); }
  function normalizeSymbol(v){ return text(v).toUpperCase().replace(/\.TW|\.TWO/ig,''); }
  function safeAlert(msg){ try{ alert(msg); }catch(_e){} }
  function getNameFromCaches(symbol){
    try{
      if (typeof getStockName === 'function') return text(getStockName(symbol));
    }catch(_e){}
    try{
      if (window.stockNameCache && window.stockNameCache[symbol]) return text(window.stockNameCache[symbol]);
    }catch(_e){}
    try{
      if (window.stockMetaCache && window.stockMetaCache[symbol]) return text(window.stockMetaCache[symbol].stock_name || window.stockMetaCache[symbol].name);
    }catch(_e){}
    return '';
  }
  function getMeta(symbol){
    try{
      if (typeof getStockMeta === 'function') return getStockMeta(symbol) || {};
    }catch(_e){}
    try{
      return (window.stockMetaCache && window.stockMetaCache[symbol]) || {};
    }catch(_e){}
    return {};
  }
  function isNonCompanyInstrument(symbol, name){
    symbol = normalizeSymbol(symbol);
    const meta = getMeta(symbol);
    const joined = [symbol, name || '', getNameFromCaches(symbol), meta.stock_name, meta.name, meta.industry_category, meta.market, meta.type].map(text).join('|');
    return NON_COMPANY_KEYWORDS.some(function(k){ return joined.indexOf(k) >= 0; });
  }
  function getNADesc(symbol, name){
    return (name || getNameFromCaches(symbol) || symbol) + ' 屬於 ETF / ETN / 權證 / 槓反等非公司型標的，基本面評分不適用。';
  }
  function ensureAdminModal(){
    if (byId('screenAdminModal')) return;
    const div = document.createElement('div');
    div.id = 'screenAdminModal';
    div.className = 'screen-modal-backdrop';
    div.setAttribute('aria-hidden','true');
    div.innerHTML = ''
      + '<div class="screen-modal" role="dialog" aria-modal="true" aria-labelledby="screenAdminModalTitle">'
      + '  <div id="screenAdminModalTitle" class="screen-modal-title">🛡️ 管理員驗證</div>'
      + '  <div class="screen-modal-sub">輸入管理員密碼後，系統會以 SHA-256 雜湊比對驗證，通過後才會顯示管理員控制項。</div>'
      + '  <input id="screenAdminPassword" class="inp" type="password" placeholder="請輸入管理員密碼" autocomplete="current-password" />'
      + '  <div id="screenAdminModalMsg" class="screen-modal-msg"></div>'
      + '  <div class="screen-modal-actions">'
      + '    <button class="btn" type="button" id="btnScreenAdminCancel">取消</button>'
      + '    <button class="btn btn-blue" type="button" id="btnScreenAdminSubmit">驗證並解鎖</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(div);
  }
  function ensureAdminButton(){
    if (byId('screenAdminEntry')) return;
    const titleRow = $('#page-screener .sec-title');
    if (!titleRow) return;
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '10px';
    wrap.innerHTML = '<div id="screenAdminStatus" class="screen-admin-status">一般模式｜全掃已鎖定</div><button class="screen-admin-btn" id="screenAdminEntry" type="button" aria-label="管理員">🛡️</button>';
    const parent = titleRow.parentElement;
    if (parent) parent.appendChild(wrap);
  }
  function ensureAdminTools(){
    if (byId('screenAdminTools')) return;
    const host = $('#page-screener .card');
    if (!host) return;
    const div = document.createElement('div');
    div.id = 'screenAdminTools';
    div.className = 'screen-admin-tools';
    div.innerHTML = ''
      + '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
      + '  <div><div style="font-size:.88rem;font-weight:900;color:#fff;">管理員工具</div><div class="screen-pdf-note">解鎖後才顯示；執行時仍會再次驗權。</div></div>'
      + '  <div><span class="screen-admin-chip">管理模式</span></div>'
      + '</div>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">'
      + '  <button class="btn btn-blue" type="button" data-admin-act="fullscan">🔓 開啟全掃選項</button>'
      + '  <button class="btn" type="button" data-admin-act="widerange">📈 允許大範圍掃描</button>'
      + '  <button class="btn" type="button" data-admin-act="lockback">🔒 鎖回一般模式</button>'
      + '</div>';
    host.insertBefore(div, host.children[1] || null);
  }
  async function sha256Hex(input){
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  function openAdminModal(){
    ensureAdminModal();
    const modal = byId('screenAdminModal');
    const input = byId('screenAdminPassword');
    const msg = byId('screenAdminModalMsg');
    if (msg) msg.textContent = '';
    if (input) input.value = '';
    if (modal){
      modal.classList.add('show');
      modal.setAttribute('aria-hidden','false');
      setTimeout(function(){ try{ input && input.focus(); }catch(_e){} }, 20);
    }
  }
  function closeAdminModal(){
    const modal = byId('screenAdminModal');
    if (modal){
      modal.classList.remove('show');
      modal.setAttribute('aria-hidden','true');
    }
  }
  function getUnlockState(){
    try{
      return JSON.parse(sessionStorage.getItem(ADMIN_FLAG) || '{}') || {};
    }catch(_e){
      return {};
    }
  }
  function setUnlockState(next){
    sessionStorage.setItem(ADMIN_FLAG, JSON.stringify(next || {}));
    updateAdminUi();
  }
  async function submitAdminUnlock(){
    const pwd = text(byId('screenAdminPassword') && byId('screenAdminPassword').value);
    const msg = byId('screenAdminModalMsg');
    if (!pwd){ if (msg) msg.textContent = '請先輸入密碼'; return; }
    try{
      const digest = await sha256Hex(ADMIN_PEPPER + '|' + pwd + '|unlock');
      if (digest === ADMIN_HASH){
        setUnlockState({ unlocked:true, fullscan:true, widerange:true, at:Date.now() });
        if (msg) msg.textContent = '管理員模式已解鎖';
        setTimeout(closeAdminModal, 180);
        return;
      }
      if (msg) msg.textContent = '密碼驗證失敗，請重新輸入';
    }catch(e){
      if (msg) msg.textContent = '驗證失敗：' + (e && e.message ? e.message : e);
    }
  }
  function updateAdminUi(){
    const state = getUnlockState();
    const status = byId('screenAdminStatus');
    const tools = byId('screenAdminTools');
    const allOpt = $('#screenUniverse option[value="allStocks"]');
    if (status){
      status.textContent = state.unlocked ? '管理模式｜全掃已開啟｜大範圍已開啟' : '一般模式｜全掃已鎖定';
      status.classList.toggle('ok', !!state.unlocked);
    }
    if (tools) tools.classList.toggle('show', !!state.unlocked);
    if (allOpt){
      allOpt.hidden = !state.unlocked;
      allOpt.disabled = !state.unlocked;
      if (!state.unlocked && byId('screenUniverse') && byId('screenUniverse').value === 'allStocks') byId('screenUniverse').value = 'watchlist';
    }
  }
  function bindHotfixEvents(){
    document.addEventListener('click', function(e){
      const adminBtn = e.target.closest('#screenAdminEntry');
      if (adminBtn){ e.preventDefault(); openAdminModal(); return; }
      const cancelBtn = e.target.closest('#btnScreenAdminCancel');
      if (cancelBtn){ e.preventDefault(); closeAdminModal(); return; }
      const submitBtn = e.target.closest('#btnScreenAdminSubmit');
      if (submitBtn){ e.preventDefault(); submitAdminUnlock(); return; }
      const toolBtn = e.target.closest('[data-admin-act]');
      if (toolBtn){
        e.preventDefault();
        if (toolBtn.dataset.adminAct === 'lockback'){
          setUnlockState({ unlocked:false, fullscan:false, widerange:false, at:Date.now() });
          safeAlert('已返回一般模式');
        }
        if (toolBtn.dataset.adminAct === 'fullscan'){
          const state = getUnlockState();
          state.unlocked = true; state.fullscan = true; setUnlockState(state); safeAlert('已開啟全掃選項');
        }
        if (toolBtn.dataset.adminAct === 'widerange'){
          const state = getUnlockState();
          state.unlocked = true; state.widerange = true; setUnlockState(state); safeAlert('已開啟大範圍掃描');
        }
        return;
      }
      if (e.target === byId('screenAdminModal')) closeAdminModal();
    }, true);
    document.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && e.target && e.target.id === 'screenAdminPassword') submitAdminUnlock();
    }, true);
  }
  function patchScreenerSkip(){
    if (typeof window.getScreenerUniverse === 'function' && !window.getScreenerUniverse.__hotfix391){
      const orig = window.getScreenerUniverse;
      window.getScreenerUniverse = async function(criteria){
        const arr = await orig.apply(this, arguments);
        const out = (arr || []).filter(function(symbol){
          const skip = isNonCompanyInstrument(symbol);
          return !skip;
        });
        return out;
      };
      window.getScreenerUniverse.__hotfix391 = true;
    }
  }
  function patchFundamentalAnalyzer(){
    if (typeof window.analyzeAIFundamental === 'function' && !window.analyzeAIFundamental.__hotfix391){
      const orig = window.analyzeAIFundamental;
      window.analyzeAIFundamental = async function(symbol, name){
        symbol = normalizeSymbol(symbol);
        if (isNonCompanyInstrument(symbol, name)){
          return {
            score: null,
            skipped: true,
            notApplicable: true,
            reason: getNADesc(symbol, name),
            metrics: [
              { label:'基本面', value:'不適用' },
              { label:'EPS', value:'不適用' },
              { label:'體質', value:'不適用' }
            ]
          };
        }
        const res = await orig.apply(this, arguments);
        const noValue = !res || (!Array.isArray(res.metrics) && (res.score == null));
        if (noValue){
          return {
            score: null,
            skipped: true,
            notApplicable: true,
            reason: (name || symbol) + ' 缺少可參考的公司型基本面資料，已略過。',
            metrics: [
              { label:'基本面', value:'不適用' },
              { label:'EPS', value:'不適用' },
              { label:'體質', value:'不適用' }
            ]
          };
        }
        return res;
      };
      window.analyzeAIFundamental.__hotfix391 = true;
    }
  }
  function patchAiReportUi(){
    const obs = new MutationObserver(function(){
      const page = byId('page-aiReport');
      if (!page || page.dataset.hotfix391Rendered === '1') return;
      const symbol = text((byId('aiReportTitle') && byId('aiReportTitle').textContent).match(/\d{4,6}/)?.[0]);
      if (!symbol || !isNonCompanyInstrument(symbol)) return;
      const boxes = $all('#page-aiReport .card, #page-aiReport .ai-card, #page-aiReport .score-box');
      boxes.forEach(function(box){
        const tx = text(box.textContent);
        if (/EPS|體質|基本面|Fund|fund/i.test(tx)){
          box.dataset.hotfix391 = '1';
          const note = document.createElement('div');
          note.style.cssText = 'margin-top:8px;padding:10px;border-radius:10px;background:rgba(56,139,253,.08);border:1px dashed rgba(96,165,250,.24);font-size:.82rem;color:#dbeafe;line-height:1.7;';
          note.textContent = '此標的屬於 ETF / ETN / 權證 / 槓反等非公司型商品，EPS、體質與公司型基本面評分不適用。';
          if (!box.querySelector('[data-hotfix391-note]')){
            note.setAttribute('data-hotfix391-note','1');
            box.appendChild(note);
          }
        }
      });
      page.dataset.hotfix391Rendered = '1';
    });
    obs.observe(document.documentElement, { childList:true, subtree:true });
  }
  function patchRunGuard(){
    if (typeof window.runScreener === 'function' && !window.runScreener.__hotfix391){
      const orig = window.runScreener;
      window.runScreener = async function(){
        updateAdminUi();
        return await orig.apply(this, arguments);
      };
      window.runScreener.__hotfix391 = true;
    }
  }
  function injectStyle(){
    if (byId('hotfix391Style')) return;
    const style = document.createElement('style');
    style.id = 'hotfix391Style';
    style.textContent = ''
      + '.screen-admin-btn{display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border-radius:999px;border:1px solid rgba(96,165,250,.26);background:linear-gradient(180deg,#172334,#111a27);color:#b9d7ff;cursor:pointer;transition:all .18s;}'
      + '.screen-admin-status{font-size:.75rem;color:#8fb3e8;}'
      + '.screen-admin-status.ok{color:#ffb3b3;}'
      + '.screen-admin-tools{display:none;margin-top:12px;padding:12px;border:1px dashed rgba(239,68,68,.24);border-radius:12px;background:linear-gradient(180deg,rgba(74,14,14,.18),rgba(31,14,14,.08));}'
      + '.screen-admin-tools.show{display:block;}'
      + '.screen-admin-chip{display:inline-flex;align-items:center;padding:5px 10px;border-radius:999px;font-size:.72rem;font-weight:900;background:rgba(239,68,68,.14);color:#ffb1b1;border:1px solid rgba(239,68,68,.24);}'
      + '.screen-pdf-note{font-size:.74rem;color:#9fb4d2;margin-top:6px;line-height:1.55;}'
      + '.screen-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.54);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px;}'
      + '.screen-modal-backdrop.show{display:flex;}'
      + '.screen-modal{width:min(460px,100%);background:#121a26;border:1px solid rgba(96,165,250,.18);border-radius:16px;padding:18px;box-shadow:0 26px 60px rgba(0,0,0,.35);}'
      + '.screen-modal-title{font-size:1rem;font-weight:900;color:#fff;margin-bottom:10px;}'
      + '.screen-modal-sub{font-size:.8rem;color:#9fb4d2;line-height:1.65;margin-bottom:12px;}'
      + '.screen-modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;}'
      + '.screen-modal-msg{font-size:.76rem;color:#8fb3e8;margin-top:8px;min-height:18px;}';
    document.head.appendChild(style);
  }
  function boot(){
    injectStyle();
    ensureAdminButton();
    ensureAdminTools();
    ensureAdminModal();
    bindHotfixEvents();
    patchRunGuard();
    patchScreenerSkip();
    patchFundamentalAnalyzer();
    patchAiReportUi();
    updateAdminUi();
    console.log('[Hotfix]', HOTFIX_VERSION, 'loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once:true });
  } else {
    boot();
  }
  setTimeout(boot, 600);
  setTimeout(boot, 1800);
})();

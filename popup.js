const $ = id => document.getElementById(id);
let running  = false;
let refMode  = 'upload';
let modeTab  = 'image'; // 'image' | 'video'
let uploadImg = null; // { base64, type, name }

const SEL = {
  GENERATE_BTN: "//button[.//i[text()='arrow_forward']] | //button[.//i[normalize-space(text())='arrow_forward']]",
  SPINNER:      "//i[contains(text(),'progress_activity')]",
  FILE_INPUT:   "//input[@type='file']",
  // Video frame buttons — multilingual text candidates + position fallback
  VIDEO_START_TEXTS: ['Bắt đầu', 'Start', '開始', '시작'],
  VIDEO_END_TEXTS:   ['Kết thúc', 'End', '終了', '끝'],
};

// ─── Page-side helpers for download tracking (world: MAIN) ───────────────────
function snapshotMediaInPage() {
  const imgs = document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]');
  const items = [];
  const seen = new Set();
  imgs.forEach(img => {
    if (img.naturalWidth && img.naturalWidth < 200) return; // skip thumbnails
    const m = img.src.match(/name=([a-f0-9-]+)/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); items.push({ uuid: m[1], url: img.src }); }
  });
  return items;
}

async function waitForNewMediaInPage(knownUuids, timeoutMs) {
  const known = new Set(knownUuids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const imgs = document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]');
    for (const img of imgs) {
      // Skip tiny thumbnails (40x40 in dropdown). Only count main canvas images (>200px).
      if (img.naturalWidth && img.naturalWidth < 200) continue;
      const m = img.src.match(/name=([a-f0-9-]+)/);
      if (m && !known.has(m[1])) return { uuid: m[1], url: img.src };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ─── Fetch storyboard frames from Flow dropdown (world: MAIN) ────────────────
// buttonInfo: { type:'addIcon' } for + button, or { type:'frameText', texts, fallbackPos } for Bắt đầu/Start
async function fetchStoryboardInPage(buttonInfo) {
  function xpathOne(expr) {
    try { return document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
    catch (_) { return null; }
  }
  function findFrameButton(texts, fallbackPos) {
    // Try by known text first
    const cond = texts.map(t => `normalize-space(text())='${t}'`).join(' or ');
    const byText = xpathOne(`//div[@aria-haspopup='dialog' and (${cond})]`);
    if (byText) return byText;
    // Fallback: dialog triggers with text label (not icon-only like + button)
    const all = document.querySelectorAll('div[aria-haspopup="dialog"]');
    const textBtns = Array.from(all).filter(el => {
      const t = (el.textContent || '').trim();
      return t.length > 0 && t.length < 30 && !el.querySelector('i');
    });
    return textBtns[fallbackPos] || null;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width/2, clientY: r.top + r.height/2,
      button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }
  function findPopup() {
    const candidates = [
      ...document.querySelectorAll('[role="dialog"]'),
      ...document.querySelectorAll('[data-radix-popper-content-wrapper]'),
      ...document.querySelectorAll('[role="menu"]'),
    ];
    for (const c of candidates) {
      const items = c.querySelectorAll('[data-index][data-item-index]');
      for (const it of items) {
        const sz = parseInt(it.getAttribute('data-known-size') || '0');
        if (sz > 0 && sz < 150) return c;
      }
    }
    for (const c of candidates) {
      if (c.querySelector('[data-testid="virtuoso-item-list"]')) return c;
    }
    return null;
  }

  let btn;
  if (buttonInfo.type === 'addIcon') {
    btn = xpathOne("//button[@aria-haspopup='dialog' and .//i[normalize-space(text())='add_2']]");
  } else {
    btn = findFrameButton(buttonInfo.texts, buttonInfo.fallbackPos);
  }
  if (!btn) return { ok: false, error: 'Trigger button not found.' };
  realClick(btn);
  await sleep(1000);

  let popup = null;
  for (let i = 0; i < 20; i++) { popup = findPopup(); if (popup) break; await sleep(200); }
  if (!popup) return { ok: false, error: 'Popup not found.' };

  // Try to scroll virtuoso list to load all items
  const list = popup.querySelector('[data-testid="virtuoso-item-list"]');
  let scroller = list?.parentElement;
  while (scroller && scroller !== popup && getComputedStyle(scroller).overflowY !== 'auto' && getComputedStyle(scroller).overflowY !== 'scroll') {
    scroller = scroller.parentElement;
  }
  if (scroller) {
    let lastCount = 0, stable = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(250);
      const c = popup.querySelectorAll('[data-index][data-item-index]').length;
      if (c === lastCount) { stable++; if (stable >= 3) break; }
      else { stable = 0; lastCount = c; }
    }
    scroller.scrollTop = 0;
    await sleep(300);
  }

  // Collect items in dropdown order (use data-index sorted)
  const itemNodes = Array.from(popup.querySelectorAll('[data-index][data-item-index]'))
    .filter(el => el.querySelector('img[alt]'))
    .sort((a, b) => parseInt(a.getAttribute('data-index')) - parseInt(b.getAttribute('data-index')));

  const items = [];
  itemNodes.forEach((node, k) => {
    const img = node.querySelector('img[alt]');
    const m = img?.src.match(/name=([a-f0-9-]+)/);
    items.push({
      dropdownIdx: k + 1,                  // 1-based position in dropdown
      uuid: m ? m[1] : null,
      url: img?.src || '',
      alt: img?.alt || '(unnamed)',
    });
  });

  // Close dropdown
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  document.body.click();
  await sleep(300);

  return { ok: true, items };
}

// ─── Video mode page function (world: MAIN) ──────────────────────────────────
// startRef / endRef = { uuid, index } | null  (null = skip = text-to-video)
async function submitVideoPromptInPage(prompt, sel, startRef, endRef) {
  function xpathOne(expr) {
    try { return document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
    catch (_) { return null; }
  }
  function findFrameButton(texts, fallbackPos) {
    const cond = texts.map(t => `normalize-space(text())='${t}'`).join(' or ');
    const byText = xpathOne(`//div[@aria-haspopup='dialog' and (${cond})]`);
    if (byText) return byText;
    const all = document.querySelectorAll('div[aria-haspopup="dialog"]');
    const textBtns = Array.from(all).filter(el => {
      const t = (el.textContent || '').trim();
      return t.length > 0 && t.length < 30 && !el.querySelector('i');
    });
    return textBtns[fallbackPos] || null;
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }
  function findPopup() {
    const candidates = [
      ...document.querySelectorAll('[role="dialog"]'),
      ...document.querySelectorAll('[data-radix-popper-content-wrapper]'),
      ...document.querySelectorAll('[role="menu"]'),
    ];
    for (const c of candidates) {
      const items = c.querySelectorAll('[data-index][data-item-index]');
      for (const it of items) {
        const sz = parseInt(it.getAttribute('data-known-size') || '0');
        if (sz > 0 && sz < 150) return c;
      }
    }
    for (const c of candidates) {
      if (c.querySelector('[data-testid="virtuoso-item-list"]')) return c;
    }
    return null;
  }

  async function attachFrame(texts, fallbackPos, frameRef, label) {
    const btn = findFrameButton(texts, fallbackPos);
    if (!btn) return { ok: false, error: `${label} button not found (multilingual).` };
    realClick(btn);
    await sleep(1000);

    let popup = null;
    for (let i = 0; i < 20; i++) { popup = findPopup(); if (popup) break; await sleep(200); }
    if (!popup) return { ok: false, error: `${label} popup not found.` };

    const targetUuid = frameRef?.uuid;
    const targetIdx  = frameRef?.index;
    function findItem() {
      const items = popup.querySelectorAll('[data-index][data-item-index]');
      const imgItems = Array.from(items).filter(el => el.querySelector('img[alt]'));
      if (targetUuid) {
        for (const it of imgItems) {
          const im = it.querySelector('img[alt]');
          const m = im?.src.match(/name=([a-f0-9-]+)/);
          if (m && m[1] === targetUuid) return it;
        }
        return null;
      }
      return imgItems[(targetIdx || 1) - 1] || null;
    }

    let item = null;
    for (let i = 0; i < 10; i++) { item = findItem(); if (item) break; await sleep(200); }

    // Lazy scroll-load if uuid not in current viewport
    if (!item && targetUuid) {
      const list = popup.querySelector('[data-testid="virtuoso-item-list"]');
      let scroller = list?.parentElement;
      while (scroller && scroller !== popup &&
             getComputedStyle(scroller).overflowY !== 'auto' &&
             getComputedStyle(scroller).overflowY !== 'scroll') {
        scroller = scroller.parentElement;
      }
      if (scroller) {
        let lastH = 0, stable = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(200);
          item = findItem();
          if (item) break;
          const h = scroller.scrollHeight;
          if (h === lastH) { stable++; if (stable >= 3) break; }
          else { stable = 0; lastH = h; }
        }
      }
    }

    if (!item) {
      const tag = targetUuid ? `uuid ${targetUuid.slice(0, 8)}` : `#${targetIdx}`;
      return { ok: false, error: `${label}: ${tag} not found.` };
    }

    const img = item.querySelector('img');
    const card = img?.parentElement || item.firstElementChild || item;
    card.scrollIntoView({ block: 'center' });
    await sleep(150);
    realClick(card);
    await sleep(800);
    return { ok: true };
  }

  // Start frame (optional — null means text-to-video, no reference)
  if (startRef && (startRef.uuid || startRef.index)) {
    const sr = await attachFrame(sel.VIDEO_START_TEXTS, 0, startRef, 'Start frame');
    if (!sr.ok) return { success: false, error: sr.error };
  }

  // End frame (optional)
  if (endRef && (endRef.uuid || endRef.index)) {
    const er = await attachFrame(sel.VIDEO_END_TEXTS, 1, endRef, 'End frame');
    if (!er.ok) return { success: false, error: er.error };
  }

  // Inject prompt text
  const el = document.querySelector('[data-slate-editor="true"]')
    || document.querySelector('[contenteditable="true"][data-slate-node="value"]');
  if (!el) return { success: false, error: 'Slate editor not found.' };

  el.click(); await sleep(200);
  const range = document.createRange();
  range.selectNodeContents(el);
  const domSel = window.getSelection();
  domSel.removeAllRanges(); domSel.addRange(range);
  await sleep(100);

  el.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: prompt,
    bubbles: true, cancelable: true, composed: true,
  }));
  await sleep(400);

  if (!el.textContent.replace(/﻿/g, '').trim()) {
    el.focus(); document.execCommand('selectAll');
    await sleep(50); document.execCommand('insertText', false, prompt);
    await sleep(300);
  }

  // Click Generate
  for (let i = 0; i < 30; i++) {
    const btn = xpathOne(sel.GENERATE_BTN);
    if (btn && !btn.disabled) { btn.click(); return { success: true }; }
    await sleep(200);
  }
  return { success: false, error: 'Generate button stayed disabled.' };
}

// ─── Page function (world: MAIN) ─────────────────────────────────────────────
async function submitPromptInPage(prompt, sel, imgConfig) {
  function xpathOne(expr) {
    try { return document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; }
    catch (_) { return null; }
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }

  // ── A. Attach reference image ──────────────────────────────────────────────
  if (imgConfig) {
    // Click + (add_2) button to open dropdown
    const addBtn = xpathOne("//button[@aria-haspopup='dialog' and .//i[normalize-space(text())='add_2']]");
    if (!addBtn) return { success: false, error: '+ button not found.' };
    addBtn.click();
    await sleep(1000);

    // Find the popup dropdown container (Radix portal) — scope all queries inside it
    // so we don't match items in Flow's persistent sidebar media library.
    function findPopup() {
      // Radix portals: role="dialog" or [data-radix-popper-content-wrapper], opened most recently
      const candidates = [
        ...document.querySelectorAll('[role="dialog"]'),
        ...document.querySelectorAll('[data-radix-popper-content-wrapper]'),
        ...document.querySelectorAll('[role="menu"]'),
      ];
      // Pick the one containing a virtuoso list with small items (size 56 = dropdown)
      for (const c of candidates) {
        const items = c.querySelectorAll('[data-index][data-item-index]');
        for (const it of items) {
          const sz = parseInt(it.getAttribute('data-known-size') || '0');
          // Small items (40-100px) = the dropdown we want; large (200+) = full browser
          if (sz > 0 && sz < 150) return c;
        }
      }
      // Fallback: any popup with the virtuoso list and "Tải hình ảnh lên" text
      for (const c of candidates) {
        if (c.querySelector('[data-testid="virtuoso-item-list"]')) return c;
      }
      return null;
    }

    let popup = null;
    for (let i = 0; i < 20; i++) {
      popup = findPopup();
      if (popup) break;
      await sleep(200);
    }
    if (!popup) return { success: false, error: 'Dropdown popup not found (Radix portal missing).' };

    if (imgConfig.mode === 'gallery') {
      // Find item by UUID first (resilient to insertions); fallback to index
      const targetUuid = imgConfig.uuid;
      const targetIdx  = imgConfig.index;
      function findItem() {
        const items = popup.querySelectorAll('[data-index][data-item-index]');
        const imgItems = Array.from(items).filter(el => el.querySelector('img[alt]'));
        if (targetUuid) {
          for (const it of imgItems) {
            const im = it.querySelector('img[alt]');
            const m = im?.src.match(/name=([a-f0-9-]+)/);
            if (m && m[1] === targetUuid) return it;
          }
          return null;
        }
        return imgItems[(targetIdx || 1) - 1] || null;
      }

      let item = null;
      for (let i = 0; i < 10; i++) { item = findItem(); if (item) break; await sleep(200); }

      // Lazy scroll-load if uuid not in current viewport
      if (!item && targetUuid) {
        const list = popup.querySelector('[data-testid="virtuoso-item-list"]');
        let scroller = list?.parentElement;
        while (scroller && scroller !== popup &&
               getComputedStyle(scroller).overflowY !== 'auto' &&
               getComputedStyle(scroller).overflowY !== 'scroll') {
          scroller = scroller.parentElement;
        }
        if (scroller) {
          let lastH = 0, stable = 0;
          for (let attempt = 0; attempt < 40; attempt++) {
            scroller.scrollTop = scroller.scrollHeight;
            await sleep(200);
            item = findItem();
            if (item) break;
            const h = scroller.scrollHeight;
            if (h === lastH) { stable++; if (stable >= 3) break; }
            else { stable = 0; lastH = h; }
          }
        }
      }

      if (!item) {
        const tag = targetUuid ? `uuid ${targetUuid.slice(0, 8)}` : `#${targetIdx}`;
        return { success: false, error: `Image ${tag} not found in dropdown.` };
      }

      const img = item.querySelector('img');
      const card = img?.parentElement;
      const target = card || img || item;
      target.scrollIntoView({ block: 'center' });
      await sleep(200);
      realClick(target);
      await sleep(800);

    } else if (imgConfig.mode === 'upload') {
      // Upload button is inside popup, NOT a virtuoso item — find by text
      let uploadBtn = null;
      for (let i = 0; i < 15; i++) {
        // Find button/element with "Tải hình ảnh lên" or "Upload" text inside popup
        const candidates = popup.querySelectorAll('button, [role="button"], div');
        uploadBtn = Array.from(candidates).find(el => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t === 'tải hình ảnh lên' || t === 'upload image' || t === 'upload';
        });
        if (uploadBtn) break;
        await sleep(200);
      }
      let fileInput = xpathOne(sel.FILE_INPUT);
      if (!fileInput && uploadBtn) { realClick(uploadBtn); await sleep(800); }
      for (let i = 0; i < 15; i++) {
        fileInput = xpathOne(sel.FILE_INPUT); if (fileInput) break; await sleep(200);
      }
      if (!fileInput) return { success: false, error: 'File input not found.' };

      const bytes = atob(imgConfig.base64);
      const arr = new Uint8Array(bytes.length);
      for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
      const file = new File([arr], imgConfig.name, { type: imgConfig.type });
      const dt = new DataTransfer(); dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(2000);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { if (!xpathOne(sel.SPINNER)) break; await sleep(500); }
      await sleep(1000);

      // Click the first image item inside popup (newly uploaded appears first)
      const popupNow = findPopup() || popup;
      const items = popupNow.querySelectorAll('[data-index][data-item-index]');
      const first = Array.from(items).find(el => el.querySelector('img[alt]'));
      if (first) {
        const target = first.querySelector('img')?.parentElement || first.firstElementChild || first;
        target.scrollIntoView({ block: 'center' });
        await sleep(150);
        realClick(target);
        await sleep(800);
      }
    }
  }

  // ── B. Inject prompt text ─────────────────────────────────────────────────
  const el = document.querySelector('[data-slate-editor="true"]')
    || document.querySelector('[contenteditable="true"][data-slate-node="value"]');
  if (!el) return { success: false, error: 'Slate editor not found.' };

  el.click(); await sleep(200);
  const range = document.createRange();
  range.selectNodeContents(el);
  const domSel = window.getSelection();
  domSel.removeAllRanges(); domSel.addRange(range);
  await sleep(100);

  el.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: prompt,
    bubbles: true, cancelable: true, composed: true,
  }));
  await sleep(400);

  if (!el.textContent.replace(/﻿/g, '').trim()) {
    el.focus(); document.execCommand('selectAll');
    await sleep(50); document.execCommand('insertText', false, prompt);
    await sleep(300);
  }

  // ── C. Click Generate ────────────────────────────────────────────────────
  for (let i = 0; i < 30; i++) {
    const btn = xpathOne(sel.GENERATE_BTN);
    if (btn && !btn.disabled) { btn.click(); return { success: true }; }
    await sleep(200);
  }
  return { success: false, error: `Generate button stayed disabled.` };
}

// ─── Upload mode ──────────────────────────────────────────────────────────────
$('btn-pick-img').addEventListener('click', () => $('file-input-hidden').click());
$('file-input-hidden').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const b64 = await fileToBase64(file);
  uploadImg = { base64: b64, type: file.type, name: file.name };
  $('img-name').textContent = file.name; $('img-name').className = 'loaded';
});
$('btn-clear-img').addEventListener('click', () => {
  uploadImg = null; $('file-input-hidden').value = '';
  $('img-name').textContent = 'No file selected'; $('img-name').className = '';
});
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej; r.readAsDataURL(file);
  });
}

// ─── Download toggle ──────────────────────────────────────────────────────────
$('dl-enable').addEventListener('change', () => {
  $('dl-fields').style.display = $('dl-enable').checked ? 'block' : 'none';
});

// ─── Storyboard picker (used by both image gallery + video tabs) ─────────────
const SB = {
  image: {
    items: [], selection: [],
    gridId: 'image-storyboard-grid', statusId: 'image-storyboard-status', mappingId: 'image-storyboard-mapping',
    loadBtnId: 'btn-load-image-storyboard', clearBtnId: 'btn-clear-image-storyboard',
    buttonInfo: { type: 'addIcon' },
  },
  video: {
    items: [], selection: [],
    gridId: 'storyboard-grid', statusId: 'storyboard-status', mappingId: 'storyboard-mapping',
    loadBtnId: 'btn-load-storyboard', clearBtnId: 'btn-clear-storyboard',
    buttonInfo: { type: 'frameText', texts: SEL.VIDEO_START_TEXTS, fallbackPos: 0 },
  },
};

function setupStoryboardTab(modeKey) {
  const cfg = SB[modeKey];

  $(cfg.loadBtnId).addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !((tab.url || '').includes('labs.google') && tab.url.includes('flow'))) {
      log('Active tab is not a Flow page.', 'err'); return;
    }
    $(cfg.loadBtnId).disabled = true;
    $(cfg.loadBtnId).textContent = '⟳ Loading...';
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, func: fetchStoryboardInPage,
        args: [cfg.buttonInfo], world: 'MAIN',
      });
      const res = r?.[0]?.result;
      if (!res?.ok) { log(`Load failed: ${res?.error || '?'}`, 'err'); return; }
      cfg.items = res.items;
      cfg.selection = [];
      renderStoryboardGrid(modeKey);
      log(`[${modeKey}] Loaded ${cfg.items.length} frame(s) from Flow.`, 'info');
    } catch (err) { log(`Load error: ${err.message}`, 'err'); }
    finally {
      $(cfg.loadBtnId).disabled = false;
      $(cfg.loadBtnId).textContent = '⟳ Load from Flow';
    }
  });

  $(cfg.clearBtnId).addEventListener('click', () => {
    cfg.selection = [];
    updateStoryboardSelectionUI(modeKey);
  });
}

setupStoryboardTab('image');
setupStoryboardTab('video');

function renderStoryboardGrid(modeKey) {
  const cfg = SB[modeKey];
  const grid = $(cfg.gridId);
  grid.innerHTML = '';
  if (cfg.items.length === 0) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:#555;font-size:11px;padding:20px;">No frames loaded.</div>';
    updateStoryboardSelectionUI(modeKey);
    return;
  }
  cfg.items.forEach(item => {
    const cell = document.createElement('div');
    cell.className = 'frame-cell';
    cell.dataset.idx = item.dropdownIdx;
    cell.title = `#${item.dropdownIdx} ${item.alt}`;
    cell.innerHTML = `
      <img src="${item.url}" alt="${item.alt}" loading="lazy" />
      <div class="order-badge"></div>
      <div class="pos-num">#${item.dropdownIdx}</div>
    `;
    cell.addEventListener('click', () => toggleFrameSelect(modeKey, item.dropdownIdx));
    grid.appendChild(cell);
  });
  updateStoryboardSelectionUI(modeKey);
}

function toggleFrameSelect(modeKey, idx) {
  const cfg = SB[modeKey];
  const pos = cfg.selection.indexOf(idx);
  if (pos >= 0) cfg.selection.splice(pos, 1);
  else cfg.selection.push(idx);
  updateStoryboardSelectionUI(modeKey);
}

function updateStoryboardSelectionUI(modeKey) {
  // If called without modeKey (e.g., from prompts input), refresh whichever is active
  if (!modeKey) {
    updateStoryboardSelectionUI('image');
    updateStoryboardSelectionUI('video');
    return;
  }
  const cfg = SB[modeKey];
  const storyboardItems = cfg.items;
  const storyboardSelection = cfg.selection;
  const promptList = parsePrompts();
  const promptCount = promptList.length;
  const sel = storyboardSelection.length;

  // Build map: dropdownIdx -> [prompt indices using it]
  const usedBy = new Map();
  if (sel > 0 && promptCount > 0) {
    for (let i = 0; i < promptCount; i++) {
      const fIdx = storyboardSelection[i % sel];
      if (!usedBy.has(fIdx)) usedBy.set(fIdx, []);
      usedBy.get(fIdx).push(i + 1);
    }
  }

  // Update cells: show prompt indices that use this frame (instead of just selection order)
  $(cfg.gridId).querySelectorAll('.frame-cell').forEach(cell => {
    const idx = parseInt(cell.dataset.idx);
    const order = storyboardSelection.indexOf(idx);
    cell.classList.toggle('selected', order >= 0);
    const badge = cell.querySelector('.order-badge');
    if (order >= 0) {
      const prompts = usedBy.get(idx) || [];
      // Badge shows prompt indices using this frame, e.g. "1" or "1,4"
      badge.textContent = prompts.length > 0 ? '#' + prompts.join(',') : (order + 1).toString();
    } else {
      badge.textContent = '';
    }
  });

  // Status
  let status;
  if (storyboardItems.length === 0 && sel === 0) status = 'No frames loaded — text-to-video mode (no reference).';
  else if (sel === 0) status = `${storyboardItems.length} loaded — click to select, or leave empty for text-to-video.`;
  else if (sel === promptCount) status = `✓ ${sel} selected = ${promptCount} prompts (1:1).`;
  else if (sel < promptCount) status = `${sel} selected, ${promptCount} prompts → will cycle.`;
  else status = `${sel} selected > ${promptCount} prompts → only first ${promptCount} used.`;
  $(cfg.statusId).textContent = status;

  // Mapping list: prompt → frame
  const mapEl = $(cfg.mappingId);
  if (sel > 0 && promptCount > 0) {
    const rows = [];
    for (let i = 0; i < promptCount; i++) {
      const fIdx = storyboardSelection[i % sel];
      const item = storyboardItems.find(x => x.dropdownIdx === fIdx);
      const altShort = (item?.alt || '?').slice(0, 24);
      const promptShort = promptList[i].slice(0, 30);
      const promptFull = promptList[i].replace(/"/g, '&quot;');
      const altFull = (item?.alt || '').replace(/"/g, '&quot;');
      rows.push(
        `<div style="display:flex;gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid #1a1a1a;">
          <span style="color:#60a5fa;font-weight:700;min-width:22px;">#${i + 1}</span>
          <span style="flex:1;color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${promptFull}">${promptShort}${promptList[i].length > 30 ? '…' : ''}</span>
          <span style="color:#555;">→</span>
          <span style="color:#4ade80;font-family:monospace;" title="${altFull}">#${fIdx} ${altShort}${(item?.alt || '').length > 24 ? '…' : ''}</span>
        </div>`
      );
    }
    mapEl.innerHTML = `<div style="color:#888;font-weight:600;margin-bottom:4px;">Prompt → Frame:</div>${rows.join('')}`;
  } else {
    mapEl.innerHTML = '';
  }
}

// Re-render status when prompts change
$('prompts').addEventListener('input', updateStoryboardSelectionUI);

// ─── Mode tab toggle (image vs video) ─────────────────────────────────────────
$('tab-image').addEventListener('click', () => setModeTab('image'));
$('tab-video').addEventListener('click', () => setModeTab('video'));
function setModeTab(m) {
  modeTab = m;
  $('tab-image').className = 'ref-mode-btn' + (m === 'image' ? ' active' : '');
  $('tab-video').className = 'ref-mode-btn' + (m === 'video' ? ' active' : '');
  $('ref-image-section').style.display = m === 'image' ? 'block' : 'none';
  $('ref-video-section').style.display = m === 'video' ? 'block' : 'none';
}

// ─── Mode toggle ──────────────────────────────────────────────────────────────
$('mode-upload').addEventListener('click', () => setMode('upload'));
$('mode-gallery').addEventListener('click', () => setMode('gallery'));
function setMode(m) {
  refMode = m;
  $('mode-upload').className  = 'ref-mode-btn' + (m === 'upload'  ? ' active' : '');
  $('mode-gallery').className = 'ref-mode-btn' + (m === 'gallery' ? ' active' : '');
  $('panel-upload').className  = 'ref-upload'  + (m === 'upload'  ? ' visible' : '');
  $('panel-gallery').className = 'ref-gallery' + (m === 'gallery' ? ' visible' : '');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
$('prompts').addEventListener('input', updateCount);
function updateCount() {
  const n = parsePrompts().length;
  $('prompt-count').textContent = `${n} prompt${n !== 1 ? 's' : ''}`;
}
function parsePrompts() {
  return $('prompts').value.split('\n').map(l => l.trim()).filter(Boolean);
}
function log(msg, type = '') {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const el = document.createElement('div');
  el.className = `entry ${type}`; el.textContent = `[${ts}] ${msg}`;
  $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight;
}
function setProgress(cur, tot) {
  $('progress-bar').style.width = (tot > 0 ? Math.round(cur / tot * 100) : 0) + '%';
  $('count-text').textContent = `${cur} / ${tot}`;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Video frames resolver (Option D hybrid) ──────────────────────────────────
function parseFrameLine(line) {
  const parts = line.split(',').map(p => p.trim());
  const startIdx = parseInt(parts[0]);
  const endIdx   = parts[1] !== undefined ? parseInt(parts[1]) : 0;
  if (!Number.isFinite(startIdx) || startIdx < 1) {
    throw new Error(`Invalid frame line: "${line}" (start must be ≥1)`);
  }
  return { startIdx, endIdx: Number.isFinite(endIdx) && endIdx >= 0 ? endIdx : 0 };
}
function resolveVideoFrames(promptCount, framesText, autoStart) {
  const lines = (framesText || '').split('\n').map(l => l.trim()).filter(Boolean);

  // Empty → auto-increment
  if (lines.length === 0) {
    return Array.from({ length: promptCount }, (_, i) => ({ startIdx: autoStart + i, endIdx: 0 }));
  }
  // Single line → broadcast
  if (lines.length === 1) {
    const f = parseFrameLine(lines[0]);
    return Array.from({ length: promptCount }, () => ({ ...f }));
  }
  // Per-prompt — must match
  if (lines.length !== promptCount) {
    throw new Error(`Frame lines (${lines.length}) ≠ prompt count (${promptCount}). Use 1 line for broadcast, ${promptCount} lines for per-prompt, or empty for auto-increment.`);
  }
  return lines.map(parseFrameLine);
}
function fmtFrame(f) { return f.endIdx > 0 ? `${f.startIdx},${f.endIdx}` : `${f.startIdx}`; }

// ─── Main runner ──────────────────────────────────────────────────────────────
$('btn-start').addEventListener('click', async () => {
  const prompts = parsePrompts();
  if (!prompts.length) { log('No prompts.', 'err'); return; }

  const delay   = Math.max(5, parseInt($('delay').value)   || 30);
  const threads = Math.max(1, parseInt($('threads').value) ||  1);

  // Single tab — pipeline mode (multiple in-flight generations on one Flow tab)
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = activeTab;
  if (!tab || !((tab.url || '').includes('labs.google') && tab.url.includes('flow'))) {
    // Fall back: find any Flow tab in any window
    const allTabs = await chrome.tabs.query({});
    tab = allTabs.find(t => (t.url || '').includes('labs.google') && t.url.includes('flow'));
  }
  if (!tab) { log('No Flow tab found.', 'err'); return; }
  log(`Using Flow tab ${tab.id} (window ${tab.windowId}).`, 'info');

  // Image mode config
  let imgConfig = null;             // single config for upload mode (shared across prompts)
  let imageGallerySel = null;       // array of dropdownIdx for gallery mode (round-robin per prompt)
  if (modeTab === 'image') {
    if (refMode === 'gallery') {
      imageGallerySel = SB.image.selection.slice();
      if (imageGallerySel.length === 0) {
        log('Image gallery mode: no frames selected → text-to-image (no reference).', 'info');
      } else {
        log(`Image gallery: ${imageGallerySel.length} frame(s) → ${prompts.length} prompts (round-robin).`, 'info');
      }
    } else if (refMode === 'upload' && uploadImg) {
      imgConfig = { mode: 'upload', ...uploadImg };
      log(`Ref: ${uploadImg.name}`, 'info');
    }
  }

  // Video mode config — distribute storyboard selection (or skip if none = text-to-video)
  let videoConfig = null;
  if (modeTab === 'video') {
    const videoSel = SB.video.selection;
    const frames = prompts.map((_, i) => {
      if (videoSel.length === 0) return { startRef: null, endRef: null };
      const selIdx = videoSel[i % videoSel.length];
      const item = SB.video.items.find(x => x.dropdownIdx === selIdx);
      return {
        startRef: item ? { uuid: item.uuid, index: item.dropdownIdx } : { index: selIdx },
        endRef: null,
      };
    });
    videoConfig = { frames };
    if (videoSel.length === 0) {
      log(`Video: text-to-video mode (no reference frames) × ${frames.length} prompts`, 'info');
    } else {
      const fmt = arr => arr.map(f => f.startRef?.index || '?').join(',');
      const summary = frames.length > 6
        ? `${fmt(frames.slice(0, 4))}...${fmt(frames.slice(-1))}`
        : fmt(frames);
      log(`Video: ${videoSel.length} frame(s) → ${frames.length} prompts [${summary}] (UUID-resolved)`, 'info');
    }
  }

  // Download config — extension depends on mode
  let dlConfig = null;
  if ($('dl-enable').checked) {
    const folder = ($('dl-folder').value || 'flow-auto').trim().replace(/^[/\\]+|[/\\]+$/g, '');
    const prefix = ($('dl-prefix').value || 'scene').trim().replace(/[^\w\-]/g, '_');
    if (!folder) { log('Download folder required.', 'err'); return; }
    const ext = modeTab === 'video' ? 'mp4' : 'png';
    dlConfig = { folder, prefix, ext, timeoutMs: 180000 }; // longer for video
    log(`Auto-download: Downloads/${folder}/${prefix}_NNN.${ext}`, 'info');
  }

  running = true;
  $('btn-start').disabled = true; $('btn-stop').disabled = false; $('prompts').disabled = true;
  $('log').innerHTML = ''; setProgress(0, prompts.length);
  $('status-text').textContent = 'Running...';
  log(`${prompts.length} prompts — pipeline cap=${threads} — ${delay}s submit gap`, 'info');

  // Helper to call page functions on the tab
  async function execInTab(func, args = []) {
    const r = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func, args, world: 'MAIN',
    });
    return r?.[0]?.result;
  }

  // Init known UUIDs (so we don't claim pre-existing images as new)
  const initial = (await execInTab(snapshotMediaInPage)) || [];
  const knownUuids = new Set(initial.map(x => x.uuid));
  log(`Initial gallery: ${knownUuids.size} existing image(s).`, 'info');

  // FIFO queue of pending submissions awaiting completion
  // Each entry: { idx, resolve, ts }
  const pending = [];
  let submitDone = false;
  let doneCount = 0;

  // Background watcher: poll DOM, match new UUIDs to oldest pending submission
  const watcher = (async () => {
    while (running && (pending.length > 0 || !submitDone)) {
      try {
        const items = (await execInTab(snapshotMediaInPage)) || [];
        for (const it of items) {
          if (knownUuids.has(it.uuid)) continue;
          knownUuids.add(it.uuid);
          if (pending.length > 0) {
            const w = pending.shift();
            w.resolve(it);
          }
        }
      } catch (_) {}
      await sleep(1500);
    }
  })();

  // Submit phase — serial submits, cap in-flight = threads
  for (let i = 0; i < prompts.length; i++) {
    if (!running) break;

    // Wait for slot
    while (pending.length >= threads && running) {
      log(`#${i + 1} waiting for slot (in-flight: ${pending.length}/${threads})...`);
      await sleep(1000);
    }
    if (!running) break;

    log(`#${i + 1} submitting (in-flight before: ${pending.length})...`);
    const tsub = Date.now();
    let submitOk = false;
    try {
      let r;
      if (modeTab === 'video') {
        const f = videoConfig.frames[i];
        r = await execInTab(submitVideoPromptInPage, [prompts[i], SEL, f.startRef, f.endRef]);
      } else {
        // Image: per-prompt cfg if gallery selection exists, else shared imgConfig (upload or null)
        let cfg = imgConfig;
        if (imageGallerySel && imageGallerySel.length > 0) {
          const selIdx = imageGallerySel[i % imageGallerySel.length];
          const item = SB.image.items.find(x => x.dropdownIdx === selIdx);
          cfg = {
            mode: 'gallery',
            uuid: item?.uuid,         // primary key — UUID-resolved
            index: selIdx,            // fallback if uuid missing
          };
        }
        r = await execInTab(submitPromptInPage, [prompts[i], SEL, cfg]);
      }
      if (r?.success) { submitOk = true; log(`#${i + 1} submitted in ${((Date.now() - tsub) / 1000).toFixed(1)}s`, 'ok'); }
      else log(`#${i + 1} submit ERR: ${r?.error || '?'}`, 'err');
    } catch (err) {
      log(`#${i + 1} submit FAILED: ${err.message}`, 'err');
    }

    if (!submitOk) { doneCount++; setProgress(doneCount, prompts.length); continue; }

    // Register in pending queue + spawn completion handler
    const idx = i;
    const completion = new Promise(resolve => pending.push({ idx, resolve, ts: Date.now() }));
    completion.then(async (img) => {
      const elapsed = ((Date.now() - tsub) / 1000).toFixed(1);
      log(`#${idx + 1} image ready (gen ${elapsed}s) -> uuid ${img.uuid.slice(0, 8)}...`, 'ok');
      if (dlConfig) {
        const filename = `${dlConfig.folder}/${dlConfig.prefix}_${String(idx + 1).padStart(3, '0')}.${dlConfig.ext}`;
        try {
          await chrome.downloads.download({
            url: img.url, filename, saveAs: false, conflictAction: 'uniquify',
          });
          log(`#${idx + 1} downloaded -> ${filename}`, 'ok');
        } catch (err) { log(`#${idx + 1} download FAILED: ${err.message}`, 'err'); }
      }
      doneCount++;
      setProgress(doneCount, prompts.length);
      $('status-text').textContent = `${doneCount} / ${prompts.length}`;
    });

    // Inter-submit delay (gives Slate time to reset; also paces submissions)
    if (i < prompts.length - 1) await sleep(delay * 1000);
  }

  submitDone = true;
  log(`All prompts submitted. Waiting for ${pending.length} remaining image(s)...`, 'info');
  await watcher;

  if (running) { $('status-text').textContent = 'All done!'; log(`Finished ${doneCount} prompts.`, 'ok'); }
  else         { log('Stopped.', 'warn'); }
  running = false;
  $('btn-start').disabled = false; $('btn-stop').disabled = true; $('prompts').disabled = false;
});

$('btn-stop').addEventListener('click', () => {
  running = false; $('status-text').textContent = 'Stopping...';
  log('Stop requested.', 'warn'); $('btn-stop').disabled = true;
});

$('btn-close').addEventListener('click', () => window.close());

updateCount();

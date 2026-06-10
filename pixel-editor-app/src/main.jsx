import { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Home, Save, Loader2, Monitor, Smartphone, ExternalLink,
  Undo2, Redo2, MousePointer, Pencil, Layers, Upload,
  X, AlignLeft, AlignCenter, AlignRight, Italic, Bold,
  ChevronUp, ChevronDown
} from 'lucide-react';

const params = new URLSearchParams(window.location.search);
const JOB_ID = params.get('job') || localStorage.getItem('killerwork:lastJobId') || '';

async function loadAuth() {
  if (!window.KillerWorkAuth) await import(/* @vite-ignore */ '/auth.js?v=20260603-ads-base2');
  return window.KillerWorkAuth;
}
async function api(url, opts = {}) {
  const auth = await loadAuth();
  const token = await auth.requireToken();
  const headers = new Headers(opts.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function rgbToHex(rgb) {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '';
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return '';
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}
function pageLabel(path) {
  if (path === 'index.html') return 'Home';
  if (path === 'about.html') return 'About me';
  return path.replace(/\/?index\.html?$/, '').split('/').pop()
    .replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || path;
}

const INJECT_STYLES = `
  #kw-sel-box { box-sizing:border-box; pointer-events:all; cursor:move; outline:2px solid #ff5200; }
  .kw-handle { pointer-events:all !important; }
  .kw-hover-candidate:hover { outline:2px dashed rgba(255,82,0,.45) !important; cursor:pointer !important; }
  [contenteditable] { outline:2px dashed rgba(74,144,217,.5) !important; min-height:1em; }
  [contenteditable]:focus { outline:2px solid #4a90d9 !important; }
`;

// Intentionally excludes raw section/article — those grab huge layout containers and swamp text blocks
const SELECTABLE = 'img, video, figure, picture, .work-card, .project-card, [class*="card"], [class*="item"], [class*="thumb"], [class*="media"], [class*="banner"]';

// ─────────────────────────────────────────────────────────────────────────────
// Iframe injection helpers
// ─────────────────────────────────────────────────────────────────────────────

function injectStyles(doc) {
  if (doc.getElementById('kw-s')) return;
  const s = doc.createElement('style');
  s.id = 'kw-s';
  s.textContent = INJECT_STYLES;
  doc.head.appendChild(s);
}

function removeAllInjection(doc) {
  if (!doc) return;
  doc.getElementById('kw-s')?.remove();
  doc.getElementById('kw-overlay')?.remove();
  doc.querySelectorAll('.kw-hover-candidate').forEach(el => el.classList.remove('kw-hover-candidate'));
  doc.querySelectorAll('[contenteditable]').forEach(el => {
    el.removeAttribute('contenteditable');
    el.classList.remove('kw-text-active');
  });
}

// ── Select mode ───────────────────────────────────────────────────────────────

function setupSelectMode(frame, { onSelect, onDeselect, onDirty }) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;

  injectStyles(doc);
  doc.querySelectorAll(SELECTABLE).forEach(el => el.classList.add('kw-hover-candidate'));

  let overlay = doc.createElement('div');
  overlay.id = 'kw-overlay';
  overlay.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
  if (getComputedStyle(doc.body).position === 'static') doc.body.style.position = 'relative';
  doc.body.appendChild(overlay);

  let selEl = null;
  let selBox = null;
  win._kwSel = null;
  let scrollHandler = null;

  function placeOverlay(el) {
    selEl = el;
    win._kwSel = el;
    overlay.innerHTML = '';

    const rect = el.getBoundingClientRect();
    const scrollX = win.scrollX || win.pageXOffset || 0;
    const scrollY = win.scrollY || win.pageYOffset || 0;
    const top = rect.top + scrollY;
    const left = rect.left + scrollX;
    const w = rect.width;
    const h = rect.height;

    selBox = doc.createElement('div');
    selBox.id = 'kw-sel-box';
    selBox.style.cssText = `position:absolute;top:${top - 2}px;left:${left - 2}px;width:${w + 4}px;height:${h + 4}px;`;
    overlay.appendChild(selBox);

    const bar = doc.createElement('div');
    bar.style.cssText = `position:absolute;top:${top - 36}px;left:${left}px;display:flex;gap:4px;pointer-events:all;z-index:1;flex-wrap:wrap;`;

    function barBtn(label, bg, action) {
      const b = doc.createElement('button');
      b.textContent = label;
      b.style.cssText = `background:${bg};color:#fff;border:none;padding:4px 10px;border-radius:5px;font-size:11px;font-family:Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;pointer-events:all;`;
      b.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); action(); });
      return b;
    }

    bar.appendChild(barBtn('✕ Delete', '#e74c3c', () => {
      selEl.remove();
      overlay.innerHTML = '';
      selEl = null;
      onDeselect();
      onDirty();
    }));

    const prevSib = el.previousElementSibling;
    if (prevSib) {
      bar.appendChild(barBtn('↑ Move up', '#555', () => {
        el.parentNode.insertBefore(el, prevSib);
        onDirty();
        setTimeout(() => placeOverlay(el), 0);
      }));
    }
    const nextSib = el.nextElementSibling;
    if (nextSib) {
      bar.appendChild(barBtn('↓ Move down', '#555', () => {
        el.parentNode.insertBefore(nextSib, el);
        onDirty();
        setTimeout(() => placeOverlay(el), 0);
      }));
    }

    // Z-index controls
    bar.appendChild(barBtn('↑ Layer', '#3a3a50', () => {
      const z = parseInt(win.getComputedStyle(el).zIndex) || 0;
      el.style.zIndex = z + 1;
      onDirty();
    }));
    bar.appendChild(barBtn('↓ Layer', '#3a3a50', () => {
      const z = parseInt(win.getComputedStyle(el).zIndex) || 0;
      el.style.zIndex = Math.max(0, z - 1);
      onDirty();
    }));

    overlay.appendChild(bar);

    // Resize handles
    [
      ['nw', '-5px', 'auto', 'auto', '-5px', 'nw-resize'],
      ['ne', '-5px', '-5px', 'auto', 'auto', 'ne-resize'],
      ['sw', 'auto', 'auto', '-5px', '-5px', 'sw-resize'],
      ['se', 'auto', '-5px', '-5px', 'auto', 'se-resize'],
      ['n',  '-5px', 'auto', 'auto', '50%',  'n-resize'],
      ['s',  'auto', 'auto', '-5px', '50%',  's-resize'],
      ['e',  '50%',  '-5px', 'auto', 'auto', 'e-resize'],
      ['w',  '50%',  'auto', 'auto', '-5px', 'w-resize'],
    ].forEach(([dir, t, r, b, l, cur]) => {
      const h = doc.createElement('div');
      h.className = 'kw-handle';
      h.style.cssText = `position:absolute;width:10px;height:10px;background:#ff5200;border:2px solid #fff;border-radius:2px;pointer-events:all;
        top:${t};right:${r};bottom:${b};left:${l};
        ${(l === '50%' || r === 'auto' && l === '50%') ? 'transform:translateX(-50%)' : ''};
        ${(t === '50%') ? 'transform:translateY(-50%)' : ''};
        cursor:${cur};z-index:2;`;
      h.addEventListener('mousedown', e => startResize(e, dir));
      selBox.appendChild(h);
    });

    // ── Drag to move with snap guides ────────────────────────────────────────
    selBox.addEventListener('mousedown', (e) => {
      if (e.target.dataset.kwHandle) return;
      e.preventDefault();
      e.stopPropagation();

      const curTransform = el.style.transform || '';
      const tm = curTransform.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\s*\)/);
      const baseTx = tm ? parseFloat(tm[1]) : 0;
      const baseTy = tm ? parseFloat(tm[2]) : 0;
      const baseNoTranslate = curTransform.replace(/translate\([^)]+\)/g, '').trim();
      const startX = e.clientX, startY = e.clientY;
      let moved = false;

      // Alignment guides (fixed within iframe viewport)
      const guideV = doc.createElement('div');
      guideV.style.cssText = 'position:fixed;top:0;bottom:0;width:1px;background:rgba(255,82,0,.7);pointer-events:none;display:none;z-index:2147483645;';
      const guideH = doc.createElement('div');
      guideH.style.cssText = 'position:fixed;left:0;right:0;height:1px;background:rgba(255,82,0,.7);pointer-events:none;display:none;z-index:2147483645;';
      doc.body.appendChild(guideV);
      doc.body.appendChild(guideH);

      const SNAP = 8;

      function onDragMove(me) {
        const dx = me.clientX - startX, dy = me.clientY - startY;
        if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
        moved = true;
        let tx = baseTx + dx, ty = baseTy + dy;

        el.style.transform = (baseNoTranslate ? baseNoTranslate + ' ' : '') + `translate(${tx}px, ${ty}px)`;

        const r = el.getBoundingClientRect();
        const vpW = win.innerWidth, vpH = win.innerHeight;
        const elMidX = r.left + r.width / 2;
        const elMidY = r.top + r.height / 2;

        // Snap to viewport center X
        if (Math.abs(elMidX - vpW / 2) < SNAP) {
          tx += (vpW / 2 - elMidX);
          el.style.transform = (baseNoTranslate ? baseNoTranslate + ' ' : '') + `translate(${tx}px, ${ty}px)`;
          guideV.style.left = (vpW / 2) + 'px';
          guideV.style.display = 'block';
        } else {
          guideV.style.display = 'none';
        }

        // Snap to viewport center Y
        const r2 = el.getBoundingClientRect();
        const elMidY2 = r2.top + r2.height / 2;
        if (Math.abs(elMidY2 - vpH / 2) < SNAP) {
          ty += (vpH / 2 - elMidY2);
          el.style.transform = (baseNoTranslate ? baseNoTranslate + ' ' : '') + `translate(${tx}px, ${ty}px)`;
          guideH.style.top = (vpH / 2) + 'px';
          guideH.style.display = 'block';
        } else {
          guideH.style.display = 'none';
        }

        const r3 = el.getBoundingClientRect();
        const sx = win.scrollX || 0, sy = win.scrollY || 0;
        selBox.style.top  = (r3.top  + sy - 2) + 'px';
        selBox.style.left = (r3.left + sx - 2) + 'px';
        bar.style.top  = (r3.top  + sy - 36) + 'px';
        bar.style.left = (r3.left + sx) + 'px';
      }
      function onDragUp() {
        doc.removeEventListener('mousemove', onDragMove);
        doc.removeEventListener('mouseup', onDragUp);
        guideV.remove();
        guideH.remove();
        if (moved) onDirty();
      }
      doc.addEventListener('mousemove', onDragMove);
      doc.addEventListener('mouseup', onDragUp);
    });

    if (scrollHandler) win.removeEventListener('scroll', scrollHandler);
    scrollHandler = () => {
      if (!selEl) return;
      const r = selEl.getBoundingClientRect();
      const sx = win.scrollX || 0, sy = win.scrollY || 0;
      if (selBox) {
        selBox.style.top = (r.top + sy - 2) + 'px';
        selBox.style.left = (r.left + sx - 2) + 'px';
        selBox.style.width = (r.width + 4) + 'px';
        selBox.style.height = (r.height + 4) + 'px';
      }
      bar.style.top = (r.top + sy - 36) + 'px';
      bar.style.left = (r.left + sx) + 'px';
    };
    win.addEventListener('scroll', scrollHandler, { passive: true });

    const computed = win.getComputedStyle(el);
    const isImg = el.tagName === 'IMG';
    onSelect({
      type: isImg ? 'image' : 'section',
      tagName: el.tagName.toLowerCase(),
      src: isImg ? el.src : null,
      styles: {
        backgroundColor: rgbToHex(computed.backgroundColor),
        color: rgbToHex(computed.color),
        fontSize: parseInt(computed.fontSize) || 16,
        fontWeight: computed.fontWeight,
        textAlign: computed.textAlign,
      }
    });
  }

  function startResize(e, dir) {
    e.stopPropagation();
    e.preventDefault();
    if (!selEl) return;
    const startX = e.clientX, startY = e.clientY;
    const startW = selEl.offsetWidth, startH = selEl.offsetHeight;

    function onMove(me) {
      const dx = me.clientX - startX, dy = me.clientY - startY;
      if (dir.includes('e')) {
        const nw = Math.max(40, startW + dx);
        selEl.style.width = nw + 'px';
        selEl.style.maxWidth = nw + 'px';
      }
      if (dir.includes('w')) {
        selEl.style.width = Math.max(40, startW - dx) + 'px';
      }
      if (dir.includes('s')) {
        selEl.style.height = Math.max(20, startH + dy) + 'px';
      }
      if (dir.includes('n')) {
        selEl.style.height = Math.max(20, startH - dy) + 'px';
      }
      if (selBox) {
        const r = selEl.getBoundingClientRect();
        const sx = win.scrollX || 0, sy = win.scrollY || 0;
        selBox.style.width = (r.width + 4) + 'px';
        selBox.style.height = (r.height + 4) + 'px';
        selBox.style.top = (r.top + sy - 2) + 'px';
        selBox.style.left = (r.left + sx - 2) + 'px';
      }
    }
    function onUp() {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      onDirty();
      setTimeout(() => placeOverlay(selEl), 0);
    }
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  }

  function clickHandler(e) {
    if (e.target.closest('#kw-overlay')) return;
    const el = e.target.closest(SELECTABLE);
    if (!el) {
      overlay.innerHTML = '';
      selEl = null;
      onDeselect();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    placeOverlay(el);
  }

  function keyHandler(e) {
    if (!selEl) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.isContentEditable) {
      e.preventDefault();
      selEl.remove();
      overlay.innerHTML = '';
      selEl = null;
      onDeselect();
      onDirty();
    }
    if (e.key === 'Escape') {
      overlay.innerHTML = '';
      selEl = null;
      onDeselect();
    }
    // Arrow key nudge (1px, or 10px with Shift)
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && !e.target.isContentEditable) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const cur = selEl.style.transform || '';
      const tm = cur.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\s*\)/);
      const tx = (tm ? parseFloat(tm[1]) : 0) + dx;
      const ty = (tm ? parseFloat(tm[2]) : 0) + dy;
      const base = cur.replace(/translate\([^)]+\)/g, '').trim();
      selEl.style.transform = (base ? base + ' ' : '') + `translate(${tx}px, ${ty}px)`;
      setTimeout(() => placeOverlay(selEl), 0);
      onDirty();
    }
  }

  doc.addEventListener('click', clickHandler, true);
  doc.addEventListener('keydown', keyHandler);

  return () => {
    doc.removeEventListener('click', clickHandler, true);
    doc.removeEventListener('keydown', keyHandler);
    if (scrollHandler) win.removeEventListener('scroll', scrollHandler);
    overlay.remove();
    doc.querySelectorAll('.kw-hover-candidate').forEach(el => el.classList.remove('kw-hover-candidate'));
    doc.getElementById('kw-s')?.remove();
  };
}

// ── Text mode ─────────────────────────────────────────────────────────────────

function setupTextMode(frame, { onSelect, onDeselect, onDirty }) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;

  injectStyles(doc);

  const made = new Set();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim()) continue;
    let el = node.parentElement;
    while (el && el !== doc.body) {
      const tag = el.tagName.toLowerCase();
      const skip = ['html','body','head','script','style','noscript','nav','header','footer','main','section','article','div'];
      if (!skip.includes(tag)) break;
      if (tag === 'div') {
        const children = [...el.childNodes].filter(n => n.nodeType === 1).length;
        if (children <= 2) break;
      }
      el = el.parentElement;
    }
    if (!el || el === doc.body || made.has(el)) continue;
    const hasComplexChildren = [...el.children].some(c =>
      ['img','video','iframe','figure','picture'].includes(c.tagName.toLowerCase())
    );
    if (hasComplexChildren) continue;
    made.add(el);
    el.setAttribute('contenteditable', 'plaintext-only');
    el.classList.add('kw-text-active');
  }

  const textTags = 'h1,h2,h3,h4,h5,h6,p,li,td,th,blockquote,figcaption,label,span,a,strong,em,b,i,small,cite,q,pre,code';
  doc.querySelectorAll(textTags).forEach(el => {
    if (made.has(el)) return;
    if (!el.textContent.trim()) return;
    if (['img','video'].some(t => el.querySelector(t))) return;
    made.add(el);
    el.setAttribute('contenteditable', 'plaintext-only');
    el.classList.add('kw-text-active');
  });

  if (getComputedStyle(doc.body).position === 'static') doc.body.style.position = 'relative';

  // ── Floating drag handle ─────────────────────────────────────────────────
  const moveHandle = doc.createElement('div');
  moveHandle.id = 'kw-text-move';
  moveHandle.style.cssText = 'display:none;position:absolute;background:#ff5200;color:#fff;border-radius:5px;padding:3px 8px;font-size:11px;font-family:Inter,system-ui,sans-serif;cursor:move;pointer-events:all;z-index:2147483647;user-select:none;white-space:nowrap;line-height:1.6;';
  moveHandle.textContent = '⊹ drag';
  doc.body.appendChild(moveHandle);

  // ── Floating format toolbar ──────────────────────────────────────────────
  const fmtBar = doc.createElement('div');
  fmtBar.id = 'kw-fmt-bar';
  fmtBar.style.cssText = 'position:absolute;background:#1c1c22;border:1px solid #333;border-radius:8px;padding:3px 5px;display:none;gap:1px;align-items:center;z-index:2147483647;pointer-events:all;box-shadow:0 4px 20px rgba(0,0,0,.7);';
  doc.body.appendChild(fmtBar);

  let activeFormatEl = null;

  function fmtBtn(html, title, action) {
    const b = doc.createElement('button');
    b.innerHTML = html;
    b.title = title;
    b.style.cssText = 'background:none;border:none;color:#bbb;cursor:pointer;padding:4px 8px;border-radius:5px;font-size:12px;font-family:Inter,system-ui,sans-serif;white-space:nowrap;pointer-events:all;line-height:1.4;min-width:28px;';
    b.addEventListener('mouseover', () => { b.style.background = '#2a2a36'; b.style.color = '#fff'; });
    b.addEventListener('mouseout', () => { b.style.background = 'none'; b.style.color = '#bbb'; });
    b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); action(b); });
    return b;
  }

  function fmtSep() {
    const d = doc.createElement('div');
    d.style.cssText = 'width:1px;height:16px;background:#2e2e38;margin:0 2px;flex-shrink:0;';
    return d;
  }

  // Bold
  fmtBar.appendChild(fmtBtn('<b style="font-size:13px">B</b>', 'Bold', () => {
    if (!activeFormatEl) return;
    const w = parseInt(win.getComputedStyle(activeFormatEl).fontWeight) || 400;
    activeFormatEl.style.fontWeight = w >= 600 ? '400' : '700';
    onDirty();
  }));

  // Italic
  fmtBar.appendChild(fmtBtn('<i style="font-size:13px">I</i>', 'Italic', () => {
    if (!activeFormatEl) return;
    const s = win.getComputedStyle(activeFormatEl).fontStyle;
    activeFormatEl.style.fontStyle = s === 'italic' ? 'normal' : 'italic';
    onDirty();
  }));

  fmtBar.appendChild(fmtSep());

  // Size down
  fmtBar.appendChild(fmtBtn('A<sup style="font-size:8px">−</sup>', 'Smaller', () => {
    if (!activeFormatEl) return;
    const cur = parseInt(win.getComputedStyle(activeFormatEl).fontSize) || 16;
    activeFormatEl.style.fontSize = Math.max(8, cur - 2) + 'px';
    onDirty();
  }));

  // Size up
  fmtBar.appendChild(fmtBtn('A<sup style="font-size:8px">+</sup>', 'Larger', () => {
    if (!activeFormatEl) return;
    const cur = parseInt(win.getComputedStyle(activeFormatEl).fontSize) || 16;
    activeFormatEl.style.fontSize = (cur + 2) + 'px';
    onDirty();
  }));

  fmtBar.appendChild(fmtSep());

  // Align buttons
  ['left','center','right'].forEach(align => {
    const icons = { left:'≡', center:'≡', right:'≡' };
    const b = fmtBtn(`<span style="font-size:10px;letter-spacing:${align==='left'?'normal':align==='center'?'1px':'-1px'}">${align==='left'?'⬛⬛⬛':align==='center'?'⬜⬛⬜':'⬜⬜⬛'}</span>`, `Align ${align}`, () => {
      if (!activeFormatEl) return;
      activeFormatEl.style.textAlign = align;
      onDirty();
    });
    // Simple text labels instead
    b.innerHTML = align === 'left' ? '⟵' : align === 'center' ? '⟺' : '⟶';
    b.style.fontSize = '14px';
    fmtBar.appendChild(b);
  });

  fmtBar.appendChild(fmtSep());

  // Color swatch
  const colorWrap = doc.createElement('label');
  colorWrap.title = 'Text color';
  colorWrap.style.cssText = 'display:flex;align-items:center;cursor:pointer;padding:3px 6px;border-radius:5px;gap:0;position:relative;';
  const colorSwatch = doc.createElement('span');
  colorSwatch.style.cssText = 'width:16px;height:16px;border-radius:3px;border:2px solid #444;background:#fff;display:inline-block;';
  const colorInput = doc.createElement('input');
  colorInput.type = 'color';
  colorInput.style.cssText = 'position:absolute;opacity:0;width:1px;height:1px;pointer-events:none;';
  colorInput.addEventListener('input', () => {
    if (!activeFormatEl) return;
    activeFormatEl.style.color = colorInput.value;
    colorSwatch.style.background = colorInput.value;
    onDirty();
  });
  colorWrap.appendChild(colorSwatch);
  colorWrap.appendChild(colorInput);
  colorWrap.addEventListener('mouseover', () => { colorWrap.style.background = '#2a2a36'; });
  colorWrap.addEventListener('mouseout', () => { colorWrap.style.background = 'none'; });
  fmtBar.appendChild(colorWrap);

  function showFmtBar(el) {
    activeFormatEl = el;
    const r = el.getBoundingClientRect();
    const sy = win.scrollY || 0, sx = win.scrollX || 0;
    fmtBar.style.display = 'flex';
    // If element is near top, place bar below it instead of above
    const above = r.top + sy - 44;
    fmtBar.style.top = (above > sy + 2 ? above : r.top + sy + r.height + 6) + 'px';
    fmtBar.style.left = Math.max(4, r.left + sx) + 'px';
    const hex = rgbToHex(win.getComputedStyle(el).color);
    if (hex) { colorSwatch.style.background = hex; colorInput.value = hex; }
  }

  function hideFmtBar() {
    fmtBar.style.display = 'none';
    activeFormatEl = null;
  }

  let hoverTarget = null;

  function positionMoveHandle(el) {
    const r = el.getBoundingClientRect();
    const sy = win.scrollY || 0, sx = win.scrollX || 0;
    // If element is near top, show handle inside at top-left instead of above
    const above = r.top + sy - 28;
    moveHandle.style.top  = (above > sy + 2 ? above : r.top + sy + 4) + 'px';
    moveHandle.style.left = (r.left + sx) + 'px';
    moveHandle.style.display = 'block';
  }

  function mouseoverHandler(e) {
    const el = e.target.closest('[contenteditable]');
    if (!el) return;
    hoverTarget = el;
    positionMoveHandle(el);
  }

  function mouseoutHandler(e) {
    const to = e.relatedTarget;
    if (to && (to === moveHandle || moveHandle.contains(to) || to.closest('[contenteditable]'))) return;
    moveHandle.style.display = 'none';
    hoverTarget = null;
  }

  moveHandle.addEventListener('mousedown', (e) => {
    const el = hoverTarget;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();

    const curTransform = el.style.transform || '';
    const tm = curTransform.match(/translate\(\s*([-\d.]+)px,\s*([-\d.]+)px\s*\)/);
    const baseTx = tm ? parseFloat(tm[1]) : 0;
    const baseTy = tm ? parseFloat(tm[2]) : 0;
    const baseNoTranslate = curTransform.replace(/translate\([^)]+\)/g, '').trim();
    const startX = e.clientX, startY = e.clientY;
    let moved = false;

    function onDragMove(me) {
      const dx = me.clientX - startX, dy = me.clientY - startY;
      if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      moved = true;
      const tx = baseTx + dx, ty = baseTy + dy;
      el.style.transform = (baseNoTranslate ? baseNoTranslate + ' ' : '') + `translate(${tx}px, ${ty}px)`;
      positionMoveHandle(el);
    }
    function onDragUp() {
      doc.removeEventListener('mousemove', onDragMove);
      doc.removeEventListener('mouseup', onDragUp);
      if (moved) onDirty();
    }
    doc.addEventListener('mousemove', onDragMove);
    doc.addEventListener('mouseup', onDragUp);
  });

  doc.addEventListener('mouseover', mouseoverHandler);
  doc.addEventListener('mouseout', mouseoutHandler);

  let activeEl = null;

  function clickHandler(e) {
    if (e.target === moveHandle || fmtBar.contains(e.target) || colorWrap.contains(e.target)) return;
    const el = e.target.closest('[contenteditable]');
    if (!el) {
      hideFmtBar();
      activeEl = null;
      onDeselect();
      return;
    }
    if (activeEl === el) return;
    activeEl = el;
    showFmtBar(el);
    const computed = win.getComputedStyle(el);
    onSelect({
      type: 'text',
      tagName: el.tagName.toLowerCase(),
      styles: {
        fontSize: parseInt(computed.fontSize) || 16,
        fontWeight: computed.fontWeight,
        fontStyle: computed.fontStyle,
        textAlign: computed.textAlign,
        color: rgbToHex(computed.color),
        fontFamily: computed.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      }
    });
  }

  function inputHandler() { onDirty(); }
  function keyHandler(e) {
    if (e.key === 'Escape') { e.target.blur(); hideFmtBar(); activeEl = null; onDeselect(); }
  }

  doc.addEventListener('click', clickHandler, true);
  doc.addEventListener('input', inputHandler, true);
  doc.addEventListener('keydown', keyHandler);

  return () => {
    doc.removeEventListener('click', clickHandler, true);
    doc.removeEventListener('input', inputHandler, true);
    doc.removeEventListener('keydown', keyHandler);
    doc.removeEventListener('mouseover', mouseoverHandler);
    doc.removeEventListener('mouseout', mouseoutHandler);
    moveHandle.remove();
    fmtBar.remove();
    made.forEach(el => {
      el.removeAttribute('contenteditable');
      el.classList.remove('kw-text-active');
    });
    doc.getElementById('kw-s')?.remove();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

function VisualEditor() {
  const [site, setSite] = useState(null);
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState('index.html');
  const [previewKey, setPreviewKey] = useState(0);
  const [device, setDevice] = useState('desktop');
  const [mode, setMode] = useState('browse');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [history, setHistory] = useState({ undoCount: 0, redoCount: 0 });
  const [selInfo, setSelInfo] = useState(null);
  const [uploadingImg, setUploadingImg] = useState(false);

  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);
  const cleanupRef = useRef(null);
  const selElRef = useRef(null);
  const snapshotRef = useRef(null);

  useEffect(() => {
    if (!JOB_ID) { setLoading(false); setStatus('Missing portfolio id.'); return; }
    loadSite();
  }, []);

  // Auto-clear non-error status messages after 3 s
  useEffect(() => {
    if (!status || status === 'Saving…' || status.toLowerCase().includes('loading')) return;
    const t = setTimeout(() => setStatus(''), 3500);
    return () => clearTimeout(t);
  }, [status]);

  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z keyboard shortcuts
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); snapshotRef.current?.('undo'); }
      else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); snapshotRef.current?.('redo'); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  async function loadSite() {
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/site`);
      setSite(data);
      const pg = (data.pages || []).filter(p => p.path !== 'import-review.html');
      setPages(pg.length ? pg : [{ path: 'index.html', title: 'Home' }]);
      setHistory(data.history || { undoCount: 0, redoCount: 0 });
      setLoading(false);
      setStatus('Select or Text mode to start editing.');
    } catch (err) { setLoading(false); setStatus(err.message); }
  }

  function activateMode(newMode) {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    setSelInfo(null); selElRef.current = null;
    setMode(newMode);

    const frame = iframeRef.current;
    if (!frame?.contentDocument || newMode === 'browse') return;

    const callbacks = {
      onSelect: (info) => setSelInfo(info),
      onDeselect: () => { setSelInfo(null); selElRef.current = null; },
      onDirty: () => setIsDirty(true),
    };

    const wrappedOnSelect = (info) => {
      const doc = frame.contentDocument;
      if (info.type === 'image') {
        selElRef.current = doc.querySelector('.kw-hover-candidate.kw-sel') ||
          [...doc.querySelectorAll(SELECTABLE)].find(el => el.src === info.src) || null;
      }
      setSelInfo(info);
    };

    if (newMode === 'select') {
      cleanupRef.current = setupSelectMode(frame, { ...callbacks, onSelect: wrappedOnSelect });
    } else if (newMode === 'text') {
      cleanupRef.current = setupTextMode(frame, callbacks);
    }
  }

  function handleIframeLoad() {
    if (mode !== 'browse') {
      setTimeout(() => activateMode(mode), 100);
    }
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const headings = [...doc.querySelectorAll('h1,h2,h3')].slice(0, 8)
          .map(h => ({ text: h.textContent.trim().slice(0, 45), tag: h.tagName.toLowerCase() }));
        setSite(s => s ? { ...s, outline: headings } : s);
      }
    } catch {}
  }

  function findElFromSelBox(doc) {
    const win = iframeRef.current?.contentWindow;
    return win?._kwSel || null;
  }

  async function savePage() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }

    const clone = doc.documentElement.cloneNode(true);
    clone.querySelector('#kw-s')?.remove();
    clone.querySelector('#kw-overlay')?.remove();
    clone.querySelector('#kw-text-move')?.remove();
    clone.querySelector('#kw-fmt-bar')?.remove();
    clone.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
    clone.querySelectorAll('.kw-hover-candidate,.kw-text-active').forEach(el => {
      el.classList.remove('kw-hover-candidate', 'kw-text-active');
      if (!el.className) el.removeAttribute('class');
    });

    const html = `<!doctype html>\n${clone.outerHTML}`;
    setSaving(true); setStatus('Saving…');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: selectedPage, content: html })
      });
      setHistory(data.history || history);
      setIsDirty(false);
      setStatus('Saved!');
    } catch (err) { setStatus('Save failed: ' + err.message); }
    finally {
      setSaving(false);
      setTimeout(() => activateMode(mode), 100);
    }
  }

  async function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingImg(true);
    try {
      const body = new FormData();
      body.append('files', file);
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/upload`, { method: 'POST', body });
      const uploaded = data.uploaded?.[0];
      if (uploaded) {
        const frame = iframeRef.current;
        const img = frame?.contentWindow?._kwSel?.tagName === 'IMG' ? frame.contentWindow._kwSel
          : [...(frame?.contentDocument?.querySelectorAll('img') || [])].find(i => selInfo?.src && i.src === selInfo.src);
        if (img) {
          img.src = `/generated/${JOB_ID}/site/${uploaded.path}`;
          setIsDirty(true);
          setSelInfo(p => p ? { ...p, src: img.src } : p);
          setStatus('Image replaced. Save to keep.');
        } else {
          setStatus('Image uploaded. Click the image to replace it.');
        }
      }
    } catch (err) { setStatus('Upload failed: ' + err.message); }
    finally { setUploadingImg(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  async function snapshotAction(action) {
    setSaving(true);
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/${action}`, { method: 'POST' });
      setHistory({ undoCount: data.undoCount || 0, redoCount: data.redoCount || 0 });
      setPreviewKey(k => k + 1);
      setSelInfo(null);
      setStatus(action === 'undo' ? 'Undone.' : 'Redone.');
    } catch (err) { setStatus(err.message); }
    finally { setSaving(false); }
  }

  // Keep ref in sync so the keyboard shortcut always calls the latest version
  snapshotRef.current = snapshotAction;

  function openPage(path) {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    setSelInfo(null); selElRef.current = null;
    setSelectedPage(path);
    setPreviewKey(k => k + 1);
    setMode('browse');
  }

  const iframeSrc = JOB_ID ? `/generated/${encodeURIComponent(JOB_ID)}/site/${selectedPage}?v=${previewKey}` : '';

  if (loading) return (
    <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16, background:'#111', color:'#888', fontFamily:'Inter,sans-serif' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <Loader2 size={32} style={{ animation:'spin 1s linear infinite' }} />
      <p style={{ fontSize:14 }}>Loading your portfolio…</p>
    </div>
  );

  const statusColor = status.toLowerCase().includes('fail') || status.toLowerCase().includes('error') ? '#e74c3c'
    : status === 'Saved!' || status === 'Undone.' || status === 'Redone.' ? '#2ecc71'
    : '#555';

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#0f0f11', fontFamily:'Inter,system-ui,sans-serif', color:'#e0e0e0', userSelect:'none' }}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        .kw-btn:hover{opacity:1!important;background:#2a2a2e!important}
        .kw-page-btn:hover{background:#1e2028!important;color:#ccc!important}
        .kw-status-toast{animation:fadeIn .2s ease;}
      `}</style>

      {/* ── Topbar ── */}
      <div style={{ display:'flex', alignItems:'center', height:50, background:'#18181c', borderBottom:'1px solid #222', padding:'0 10px', gap:6, flexShrink:0, zIndex:100 }}>
        <a href="/manage.html" title="Manage" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:32, height:32, borderRadius:6, color:'#666', textDecoration:'none', background:'transparent' }}><Home size={15}/></a>
        <div style={{ width:1, height:22, background:'#222' }} />
        <div style={{ display:'flex', alignItems:'center', gap:7 }}>
          <img src="/logos/killa-work-logo.png" alt="KillaWork" style={{ height:22, width:'auto', objectFit:'contain' }} />
          <div style={{ lineHeight:1.2 }}>
            <div style={{ fontSize:11, fontWeight:600, color:'#e0e0e0' }}>{site?.siteTitle || 'Portfolio'}</div>
            <div style={{ fontSize:10, color:'#666' }}>Visual Editor</div>
          </div>
        </div>
        <div style={{ width:1, height:22, background:'#222' }} />

        {/* Mode switcher */}
        <div style={{ display:'flex', background:'#111', borderRadius:8, padding:2, gap:1 }}>
          {[
            { id:'browse', icon:<MousePointer size={12}/>, label:'Browse' },
            { id:'select', icon:<Layers size={12}/>, label:'Select' },
            { id:'text', icon:<Pencil size={12}/>, label:'Text edit' },
          ].map(m => (
            <button key={m.id} onClick={() => activateMode(m.id)}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:6, border:'none', cursor:'pointer', fontSize:11, fontWeight:500,
                background: mode === m.id ? '#ff5200' : 'transparent',
                color: mode === m.id ? '#fff' : '#666',
              }}>
              {m.icon} <span>{m.label}</span>
            </button>
          ))}
        </div>

        {mode === 'select' && <span style={{ fontSize:11, color:'#888', padding:'3px 8px', background:'#1a1a1e', borderRadius:5 }}>Click · Drag · Resize · Arrow keys · Delete</span>}
        {mode === 'text' && <span style={{ fontSize:11, color:'#888', padding:'3px 8px', background:'#1a1a1e', borderRadius:5 }}>Click text to edit · Toolbar appears above · Hover for drag</span>}

        <div style={{ flex:1 }} />

        {/* Device toggle */}
        <div style={{ display:'flex', background:'#111', borderRadius:7, padding:2, gap:1 }}>
          {[['desktop', <Monitor size={13}/>], ['mobile', <Smartphone size={13}/>]].map(([id, icon]) => (
            <button key={id} onClick={() => setDevice(id)} title={id}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', width:26, height:26, borderRadius:5, border:'none', cursor:'pointer',
                background: device === id ? '#2a2a2e' : 'transparent', color: device === id ? '#fff' : '#555' }}>
              {icon}
            </button>
          ))}
        </div>

        {/* Undo / Redo */}
        <button onClick={() => snapshotAction('undo')} disabled={!history.undoCount || saving} title="Undo (⌘Z)"
          style={{ display:'flex', alignItems:'center', justifyContent:'center', width:30, height:30, borderRadius:6, border:'none', cursor: history.undoCount ? 'pointer' : 'default', background:'transparent', color: history.undoCount ? '#777' : '#333' }}>
          <Undo2 size={13}/>
        </button>
        <button onClick={() => snapshotAction('redo')} disabled={!history.redoCount || saving} title="Redo (⌘⇧Z)"
          style={{ display:'flex', alignItems:'center', justifyContent:'center', width:30, height:30, borderRadius:6, border:'none', cursor: history.redoCount ? 'pointer' : 'default', background:'transparent', color: history.redoCount ? '#777' : '#333' }}>
          <Redo2 size={13}/>
        </button>

        <div style={{ width:1, height:22, background:'#222' }} />

        {/* Status */}
        <span key={status} className={status ? 'kw-status-toast' : ''} style={{ fontSize:11, color: statusColor, minWidth:64 }}>
          {saving ? <Loader2 size={12} style={{ animation:'spin 1s linear infinite', display:'inline-block' }}/> : status}
        </span>

        <button onClick={savePage} disabled={saving}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 14px', borderRadius:7, border:'none', cursor: saving ? 'default' : 'pointer', fontSize:12, fontWeight:600,
            background: isDirty ? 'linear-gradient(135deg,#ff5200,#ff7a00)' : '#1e1e22',
            color: isDirty ? '#fff' : '#555',
            boxShadow: isDirty ? '0 0 14px rgba(255,82,0,.4)' : 'none',
            transition:'all .25s' }}>
          <Save size={12}/> {isDirty ? 'Save changes' : 'Saved'}
        </button>

        <a href={`/generated/${JOB_ID}/site/${selectedPage}`} target="_blank" rel="noreferrer"
          style={{ display:'flex', alignItems:'center', gap:4, padding:'6px 10px', borderRadius:7, background:'#1e1e22', color:'#777', fontSize:11, textDecoration:'none' }}>
          <ExternalLink size={11}/> Preview
        </a>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* ── Left panel ── */}
        <div style={{ width:220, background:'#111116', borderRight:'1px solid #1f1f26', display:'flex', flexDirection:'column', flexShrink:0, overflowY:'auto' }}>

          {/* Page thumbnails */}
          <div style={{ padding:'10px 10px 6px', borderBottom:'1px solid #1f1f26' }}>
            <p style={{ fontSize:10, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:1.4, margin:'0 0 8px' }}>Pages</p>
            {pages.map(pg => (
              <PageCard key={pg.path} pg={pg} active={selectedPage === pg.path} onClick={() => openPage(pg.path)} />
            ))}
          </div>

          {/* Properties panel */}
          <div style={{ flex:1, padding:10, overflowY:'auto' }}>
            {!selInfo ? (
              <div>
                <p style={{ fontSize:10, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:1.4, margin:'0 0 12px' }}>Properties</p>
                <div style={{ background:'#18181e', borderRadius:9, padding:'12px 12px', fontSize:12, color:'#888', lineHeight:1.7 }}>
                  <p style={{ margin:'0 0 7px', color:'#bbb', fontWeight:500 }}>How to edit</p>
                  <p style={{ margin:'0 0 5px' }}><span style={{ color:'#ff6a20', fontWeight:600 }}>Select mode</span> — click anything to move, resize, or delete it</p>
                  <p style={{ margin:'0 0 5px' }}><span style={{ color:'#5aa3f0', fontWeight:600 }}>Text edit</span> — click text to edit · toolbar for formatting</p>
                  <p style={{ margin:'0 0 5px', color:'#666' }}>Arrow keys nudge selection · Shift+Arrow = 10px</p>
                  <p style={{ margin:0, color:'#666' }}>⌘Z / ⌘⇧Z to undo / redo</p>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <div>
                    <p style={{ fontSize:10, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:1.4, margin:'0 0 2px' }}>
                      {selInfo.type === 'image' ? 'Image' : selInfo.type === 'text' ? 'Text' : 'Element'}
                    </p>
                    <code style={{ fontSize:10, color:'#666' }}>&lt;{selInfo.tagName}&gt;</code>
                  </div>
                  <button onClick={() => setSelInfo(null)} style={{ background:'none', border:'none', color:'#555', cursor:'pointer', padding:4 }}><X size={13}/></button>
                </div>

                {selInfo.type === 'text' && (
                  <>
                    <Sec label="Typography">
                      <Row label="Size">
                        <div style={{ display:'flex', gap:5 }}>
                          <input type="number" defaultValue={selInfo.styles?.fontSize || 16} min={6} max={240}
                            onChange={e => {
                              const doc = iframeRef.current?.contentDocument;
                              const el = doc?.activeElement?.closest('[contenteditable]') || doc?.querySelector('[contenteditable]:focus');
                              if (el) { el.style.fontSize = e.target.value + 'px'; setIsDirty(true); }
                            }} style={numStyle} />
                          <span style={{ fontSize:11, color:'#666', alignSelf:'center' }}>px</span>
                        </div>
                      </Row>
                      <Row label="Weight">
                        <select defaultValue={selInfo.styles?.fontWeight || '400'}
                          onChange={e => {
                            const doc = iframeRef.current?.contentDocument;
                            const el = doc?.activeElement?.closest('[contenteditable]') || doc?.querySelector('[contenteditable]:focus');
                            if (el) { el.style.fontWeight = e.target.value; setIsDirty(true); }
                          }} style={selStyle}>
                          {['100','200','300','400','500','600','700','800','900'].map(w => <option key={w}>{w}</option>)}
                        </select>
                      </Row>
                      <Row label="Align">
                        <div style={{ display:'flex', gap:4 }}>
                          {[['left',<AlignLeft size={12}/>],['center',<AlignCenter size={12}/>],['right',<AlignRight size={12}/>]].map(([v, icon]) => (
                            <button key={v} onClick={() => {
                              const doc = iframeRef.current?.contentDocument;
                              const el = doc?.activeElement?.closest('[contenteditable]') || doc?.querySelector('[contenteditable]:focus');
                              if (el) { el.style.textAlign = v; setIsDirty(true); setSelInfo(p => p ? {...p, styles:{...p.styles, textAlign:v}} : p); }
                            }} style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'5px 0', borderRadius:5, border:'none', cursor:'pointer',
                              background: selInfo.styles?.textAlign === v ? '#ff5200' : '#1e1e26', color: selInfo.styles?.textAlign === v ? '#fff' : '#888' }}>
                              {icon}
                            </button>
                          ))}
                          <button onClick={() => {
                            const doc = iframeRef.current?.contentDocument;
                            const el = doc?.activeElement?.closest('[contenteditable]') || doc?.querySelector('[contenteditable]:focus');
                            if (el) { el.style.fontStyle = el.style.fontStyle === 'italic' ? 'normal' : 'italic'; setIsDirty(true); }
                          }} style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'5px 0', borderRadius:5, border:'none', cursor:'pointer', background:'#1e1e26', color:'#888' }}>
                            <Italic size={12}/>
                          </button>
                        </div>
                      </Row>
                    </Sec>
                    <Sec label="Color">
                      <ColorPick label="Text" value={selInfo.styles?.color || '#000000'} onChange={v => {
                        const doc = iframeRef.current?.contentDocument;
                        const el = doc?.activeElement?.closest('[contenteditable]') || doc?.querySelector('[contenteditable]:focus');
                        if (el) { el.style.color = v; setIsDirty(true); setSelInfo(p => p ? {...p, styles:{...p.styles, color:v}} : p); }
                      }} />
                    </Sec>
                  </>
                )}

                {selInfo.type === 'image' && (
                  <Sec label="Image">
                    {selInfo.src && (
                      <div style={{ borderRadius:7, overflow:'hidden', marginBottom:10, background:'#0a0a0e', border:'1px solid #1f1f26' }}>
                        <img src={selInfo.src} alt="" style={{ width:'100%', height:100, objectFit:'cover', display:'block' }} />
                      </div>
                    )}
                    <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display:'none' }} />
                    <button onClick={() => fileInputRef.current?.click()} disabled={uploadingImg}
                      style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:7, padding:'9px', borderRadius:7, border:'1px dashed #2a2a36', background:'#18181e', color:'#999', cursor:'pointer', fontSize:12 }}>
                      {uploadingImg ? <Loader2 size={13} style={{ animation:'spin 1s linear infinite' }}/> : <Upload size={13}/>}
                      {uploadingImg ? 'Uploading…' : 'Replace image'}
                    </button>
                  </Sec>
                )}

                {selInfo.type === 'section' && (
                  <Sec label="Background">
                    <ColorPick label="BG" value={selInfo.styles?.backgroundColor || '#ffffff'} onChange={v => {
                      const doc = iframeRef.current?.contentDocument;
                      const el = findElFromSelBox(doc);
                      if (el) { el.style.backgroundColor = v; setIsDirty(true); setSelInfo(p => p ? {...p, styles:{...p.styles, backgroundColor:v}} : p); }
                    }} />
                    {selInfo.styles?.color && (
                      <ColorPick label="Text" value={selInfo.styles.color} onChange={v => {
                        const doc = iframeRef.current?.contentDocument;
                        const el = findElFromSelBox(doc);
                        if (el) { el.style.color = v; setIsDirty(true); setSelInfo(p => p ? {...p, styles:{...p.styles, color:v}} : p); }
                      }} />
                    )}
                  </Sec>
                )}

                {isDirty && (
                  <button onClick={savePage} style={{ width:'100%', marginTop:8, padding:'9px', background:'linear-gradient(135deg,#ff5200,#ff7a00)', border:'none', borderRadius:7, color:'#fff', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                    Save changes
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Iframe ── */}
        <div style={{ flex:1, background:'#0a0a0c', display:'flex', flexDirection:'column', alignItems:'center', overflow:'auto' }}>
          <div style={{ flex:1, width:'100%', display:'flex', justifyContent:'center', alignItems:'flex-start',
            padding: device === 'mobile' ? '20px 0' : 0 }}>
            <div style={{
              width: device === 'mobile' ? 390 : '100%',
              height: device === 'mobile' ? 844 : '100%',
              flex: device !== 'mobile' ? 1 : undefined,
              ...(device === 'mobile' ? { boxShadow:'0 0 0 10px #1e1e22, 0 20px 60px rgba(0,0,0,.8)', borderRadius:36, overflow:'hidden' } : {})
            }}>
              <iframe ref={iframeRef} src={iframeSrc} title="Portfolio preview" onLoad={handleIframeLoad}
                style={{ width:'100%', height:'100%', border:'none', display:'block' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PageCard({ pg, active, onClick }) {
  const title = pg.title || pageLabel(pg.path);
  const isSpecial = pg.path === 'index.html' || pg.path === 'about.html';
  return (
    <button onClick={onClick} style={{
      display:'block', width:'100%', padding:0, border:'none', cursor:'pointer',
      borderRadius:7, overflow:'hidden', marginBottom:5,
      outline: active ? '2px solid #ff5200' : '2px solid transparent',
      background: active ? '#1c1c26' : '#17171e',
      transition:'outline .12s, background .12s',
    }}>
      <div style={{ width:'100%', aspectRatio: isSpecial ? '16/7' : '16/9', background:'#0a0a0e', overflow:'hidden', position:'relative' }}>
        {pg.thumbnail
          ? <img src={pg.thumbnail} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} onError={e => { e.target.style.display='none'; }} />
          : <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, opacity:.25 }}>
              {pg.path === 'index.html' ? '🏠' : pg.path === 'about.html' ? '👤' : '📄'}
            </div>
        }
        {/* Home / About: title overlaid on the thumbnail */}
        {isSpecial && (
          <div style={{ position:'absolute', bottom:0, left:0, right:0, padding:'10px 10px 7px', background:'linear-gradient(transparent, rgba(0,0,0,.72))' }}>
            <span style={{ fontSize:13, fontWeight:700, color:'#fff', textShadow:'0 1px 4px rgba(0,0,0,.9)', display:'block', letterSpacing:.1 }}>{title}</span>
          </div>
        )}
      </div>
      {/* Project pages: title below thumbnail */}
      {!isSpecial && (
        <div style={{ padding:'4px 7px', textAlign:'left' }}>
          <span style={{ fontSize:10, color: active ? '#ff8040' : '#bbb', fontWeight: active ? 600 : 400, display:'block', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', lineHeight:1.3 }}>
            {title}
          </span>
        </div>
      )}
    </button>
  );
}

function Sec({ label, children }) {
  return (
    <div style={{ marginBottom:16 }}>
      <p style={{ fontSize:9, fontWeight:700, color:'#777', textTransform:'uppercase', letterSpacing:1.3, margin:'0 0 8px' }}>{label}</p>
      {children}
    </div>
  );
}
function Row({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', marginBottom:7, gap:8 }}>
      <span style={{ fontSize:11, color:'#888', width:48, flexShrink:0 }}>{label}</span>
      <div style={{ flex:1 }}>{children}</div>
    </div>
  );
}
function ColorPick({ label, value, onChange }) {
  return (
    <Row label={label}>
      <div style={{ display:'flex', gap:7, alignItems:'center' }}>
        <div style={{ width:26, height:26, borderRadius:5, background:value||'#fff', border:'1px solid #2a2a36', position:'relative', overflow:'hidden', flexShrink:0 }}>
          <input type="color" value={value||'#ffffff'} onChange={e => onChange(e.target.value)}
            style={{ position:'absolute', inset:0, width:'200%', height:'200%', opacity:0, cursor:'pointer' }} />
        </div>
        <input type="text" value={value||''} onChange={e => onChange(e.target.value)} placeholder="#000000"
          style={{ flex:1, background:'#1e1e26', border:'1px solid #2a2a36', borderRadius:5, color:'#ccc', padding:'3px 7px', fontSize:11, outline:'none', fontFamily:'monospace' }} />
      </div>
    </Row>
  );
}

const numStyle = { width:'100%', background:'#1e1e26', border:'1px solid #2a2a36', borderRadius:5, color:'#ddd', padding:'3px 7px', fontSize:12, outline:'none', boxSizing:'border-box' };
const selStyle = { width:'100%', background:'#1e1e26', border:'1px solid #2a2a36', borderRadius:5, color:'#ddd', padding:'3px 7px', fontSize:12, outline:'none' };

async function bootstrap() {
  try { await loadAuth(); } catch {}
  createRoot(document.getElementById('root')).render(<VisualEditor />);
}
bootstrap();

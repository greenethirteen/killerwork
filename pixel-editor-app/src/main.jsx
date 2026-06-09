import { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Home, Save, Loader2, Monitor, Smartphone, ExternalLink,
  Undo2, Redo2, Check, MousePointer, Pencil, Image as ImageIcon,
  Upload, X, Wand2, ChevronRight, Layers, Palette, AlignLeft,
  AlignCenter, AlignRight, Bold, Italic
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
  if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
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

// ─── Editor styles injected into iframe ──────────────────────────────────────
const EDITOR_STYLES = `
  .kw-el { cursor: pointer !important; }
  .kw-el:hover { outline: 2px dashed rgba(255,82,0,.5) !important; outline-offset: 1px !important; }
  .kw-sel { outline: 2px solid #ff5200 !important; outline-offset: 1px !important; box-shadow: 0 0 0 5px rgba(255,82,0,.12) !important; }
  .kw-editable { cursor: text !important; }
  .kw-editable:hover { outline: 2px dashed rgba(74,144,217,.6) !important; outline-offset: 1px !important; }
  .kw-text-sel { outline: 2px solid #4a90d9 !important; outline-offset: 1px !important; }
  a[href].kw-el, a[href].kw-editable { pointer-events: auto; }
`;

const EDITABLE_TEXT_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,blockquote,figcaption,li,td,th,label,span:not(:has(*)),a:not(:has(img))';
const SELECTABLE_SELECTOR = 'img,section,article,header,footer,main,.work-card,.project-card,.hero,[class*="section"],[class*="card"],[class*="hero"],[class*="banner"]';

// ─── Main component ───────────────────────────────────────────────────────────
function VisualEditor() {
  const [site, setSite] = useState(null);
  const [pages, setPages] = useState([{ path: 'index.html', title: 'Home' }]);
  const [selectedPage, setSelectedPage] = useState('index.html');
  const [previewKey, setPreviewKey] = useState(0);
  const [device, setDevice] = useState('desktop');
  const [mode, setMode] = useState('browse'); // 'browse' | 'select' | 'text'
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [history, setHistory] = useState({ undoCount: 0, redoCount: 0 });
  const [selInfo, setSelInfo] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const iframeRef = useRef(null);
  const fileInputRef = useRef(null);
  const modeRef = useRef('browse');
  const selElRef = useRef(null);
  const cleanupRef = useRef(null);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!JOB_ID) { setLoading(false); setStatus('Missing portfolio id.'); return; }
    loadSite();
  }, []);

  async function loadSite() {
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/site`);
      setSite(data);
      const sitePages = (data.pages || []).filter(p => p.path !== 'import-review.html');
      setPages(sitePages.length ? sitePages : [{ path: 'index.html', title: 'Home', preview: '' }]);
      setHistory(data.history || { undoCount: 0, redoCount: 0 });
      setLoading(false);
      setStatus('Click Edit to start changing your site.');
    } catch (err) {
      setLoading(false);
      setStatus(err.message || 'Could not load site.');
    }
  }

  // ── Mode switching ─────────────────────────────────────────────────────────
  function switchMode(newMode) {
    cleanupIframe();
    setSelInfo(null);
    selElRef.current = null;
    setMode(newMode);
    // Re-inject after state settles
    setTimeout(() => applyModeToIframe(newMode), 50);
  }

  function cleanupIframe() {
    if (cleanupRef.current) { cleanupRef.current(); cleanupRef.current = null; }
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    doc.getElementById('kw-editor-style')?.remove();
    doc.querySelectorAll('.kw-el,.kw-sel,.kw-editable,.kw-text-sel').forEach(el => {
      el.classList.remove('kw-el', 'kw-sel', 'kw-editable', 'kw-text-sel');
      el.removeAttribute('contenteditable');
    });
    selElRef.current?.classList?.remove('kw-sel', 'kw-text-sel');
  }

  function applyModeToIframe(m) {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    if (!doc || doc.readyState === 'loading') return;

    // Inject base styles
    if (!doc.getElementById('kw-editor-style')) {
      const s = doc.createElement('style');
      s.id = 'kw-editor-style';
      s.textContent = EDITOR_STYLES;
      doc.head.appendChild(s);
    }

    if (m === 'select') {
      const els = doc.querySelectorAll(SELECTABLE_SELECTOR);
      els.forEach(el => el.classList.add('kw-el'));

      const handler = (e) => {
        if (modeRef.current !== 'select') return;
        const el = e.target.closest(SELECTABLE_SELECTOR);
        if (!el) { deselect(doc); return; }
        e.preventDefault(); e.stopPropagation();
        selectElement(el, frame);
      };
      doc.addEventListener('click', handler, true);
      cleanupRef.current = () => doc.removeEventListener('click', handler, true);

    } else if (m === 'text') {
      const textEls = doc.querySelectorAll(EDITABLE_TEXT_SELECTOR);
      textEls.forEach(el => {
        if (!el.textContent.trim()) return;
        if ([...el.children].some(c => c.matches(EDITABLE_TEXT_SELECTOR) && c.textContent.trim())) return;
        el.setAttribute('contenteditable', 'plaintext-only');
        el.classList.add('kw-editable');
      });

      const clickHandler = (e) => {
        if (modeRef.current !== 'text') return;
        const el = e.target.closest('[contenteditable]');
        if (!el) return;
        doc.querySelectorAll('.kw-text-sel').forEach(x => x.classList.remove('kw-text-sel'));
        el.classList.add('kw-text-sel');
        selElRef.current = el;
        const computed = frame.contentWindow.getComputedStyle(el);
        setSelInfo({
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
      };
      doc.addEventListener('click', clickHandler, true);
      cleanupRef.current = () => {
        doc.removeEventListener('click', clickHandler, true);
      };
    }
  }

  function selectElement(el, frame) {
    const doc = frame.contentDocument;
    doc.querySelectorAll('.kw-sel').forEach(x => x.classList.remove('kw-sel'));
    el.classList.add('kw-sel');
    selElRef.current = el;

    const computed = frame.contentWindow.getComputedStyle(el);
    const isImg = el.tagName.toLowerCase() === 'img';
    setSelInfo({
      type: isImg ? 'image' : 'section',
      tagName: el.tagName.toLowerCase(),
      src: isImg ? el.src : null,
      styles: {
        backgroundColor: rgbToHex(computed.backgroundColor),
        color: rgbToHex(computed.color),
        padding: computed.padding,
        fontSize: parseInt(computed.fontSize) || 16,
        fontFamily: computed.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
      }
    });
  }

  function deselect(doc) {
    doc.querySelectorAll('.kw-sel').forEach(x => x.classList.remove('kw-sel'));
    selElRef.current = null;
    setSelInfo(null);
  }

  // ── Iframe load ────────────────────────────────────────────────────────────
  function handleIframeLoad() {
    if (mode !== 'browse') applyModeToIframe(mode);
    // Extract page structure for sidebar
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const headings = [...doc.querySelectorAll('h1,h2,h3')].slice(0, 8).map(h => ({
          text: h.textContent.trim().slice(0, 40),
          tag: h.tagName.toLowerCase()
        }));
        setSite(s => s ? { ...s, outline: headings } : s);
      }
    } catch {}
  }

  // ── Style apply ───────────────────────────────────────────────────────────
  function applyStyle(prop, value) {
    const el = selElRef.current;
    if (!el) return;
    el.style[prop] = value;
    setIsDirty(true);
    setSelInfo(prev => prev ? { ...prev, styles: { ...prev.styles, [prop.replace(/([A-Z])/g, c => c.toLowerCase())]: value } } : prev);
  }

  function applyTextStyle(prop, value) {
    const el = selElRef.current;
    if (!el) return;
    el.style[prop] = value;
    setIsDirty(true);
    setSelInfo(prev => prev ? { ...prev, styles: { ...prev.styles } } : prev);
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  async function savePage() {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    // Clean clone
    const clone = doc.documentElement.cloneNode(true);
    clone.querySelector('#kw-editor-style')?.remove();
    clone.querySelectorAll('.kw-el,.kw-sel,.kw-editable,.kw-text-sel').forEach(el => {
      el.classList.remove('kw-el', 'kw-sel', 'kw-editable', 'kw-text-sel');
      if (!el.className) el.removeAttribute('class');
      el.removeAttribute('contenteditable');
    });

    const html = `<!doctype html>\n${clone.outerHTML}`;
    setSaving(true);
    setStatus('Saving...');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: selectedPage, content: html })
      });
      setHistory(data.history || history);
      setIsDirty(false);
      setStatus('Saved!');
    } catch (err) {
      setStatus('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Image replacement ─────────────────────────────────────────────────────
  async function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !selElRef.current) return;
    setUploadingImage(true);
    try {
      const body = new FormData();
      body.append('files', file);
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/upload`, { method: 'POST', body });
      const uploaded = data.uploaded?.[0];
      if (uploaded && selElRef.current.tagName.toLowerCase() === 'img') {
        selElRef.current.src = `/generated/${JOB_ID}/site/${uploaded.path}`;
        setIsDirty(true);
        setSelInfo(prev => prev ? { ...prev, src: selElRef.current.src } : prev);
        setStatus('Image replaced! Save to keep changes.');
      }
    } catch (err) {
      setStatus('Upload failed: ' + err.message);
    } finally {
      setUploadingImage(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  async function snapshotAction(action) {
    setSaving(true);
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(JOB_ID)}/${action}`, { method: 'POST' });
      setHistory({ undoCount: data.undoCount || 0, redoCount: data.redoCount || 0 });
      setPreviewKey(k => k + 1);
      setSelInfo(null);
      setStatus(action === 'undo' ? 'Undo complete.' : 'Redo complete.');
    } catch (err) {
      setStatus(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Page change ───────────────────────────────────────────────────────────
  function openPage(path) {
    cleanupIframe();
    setSelInfo(null);
    selElRef.current = null;
    setSelectedPage(path);
    setPreviewKey(k => k + 1);
    setMode('browse');
  }

  const iframeSrc = JOB_ID ? `/generated/${encodeURIComponent(JOB_ID)}/site/${selectedPage}?v=${previewKey}` : '';

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16, background:'#111', color:'#888', fontFamily:'Inter,sans-serif' }}>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <Loader2 size={32} style={{ animation:'spin 1s linear infinite' }} />
        <p style={{ fontSize:14 }}>Loading your portfolio…</p>
      </div>
    );
  }

  const deviceWidth = device === 'mobile' ? 390 : device === 'tablet' ? 768 : '100%';

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#0f0f11', fontFamily:'Inter,system-ui,sans-serif', color:'#e0e0e0', userSelect:'none' }}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
        .kw-tab-btn:hover{background:#2a2a2e!important}
        .kw-icon-btn:hover{background:#2a2a2e!important;color:#fff!important}
        .kw-mode-btn{transition:all .15s}
        .kw-mode-btn:hover{opacity:1!important}
      `}</style>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', height:50, background:'#1a1a1e', borderBottom:'1px solid #2a2a2e', padding:'0 12px', gap:8, flexShrink:0, zIndex:100 }}>
        <a href="/manage.html" className="kw-icon-btn" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:32, height:32, borderRadius:6, color:'#888', textDecoration:'none', transition:'all .15s' }} title="Manage projects">
          <Home size={15} />
        </a>

        <div style={{ width:1, height:24, background:'#2a2a2e' }} />

        {/* Logo + title */}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ width:24, height:24, background:'linear-gradient(135deg,#ff5200,#ff8c00)', borderRadius:4, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:'#fff', letterSpacing:-.5 }}>K</div>
          <div style={{ lineHeight:1.2 }}>
            <div style={{ fontSize:12, fontWeight:600, color:'#e0e0e0' }}>{site?.siteTitle || 'Portfolio'}</div>
            <div style={{ fontSize:10, color:'#555' }}>Visual Editor</div>
          </div>
        </div>

        <div style={{ width:1, height:24, background:'#2a2a2e', marginLeft:4 }} />

        {/* Mode switcher */}
        <div style={{ display:'flex', background:'#111', borderRadius:8, padding:3, gap:1 }}>
          {[
            { id:'browse', icon:<MousePointer size={13}/>, label:'Browse' },
            { id:'select', icon:<Layers size={13}/>, label:'Select' },
            { id:'text', icon:<Pencil size={13}/>, label:'Text' },
          ].map(m => (
            <button key={m.id} onClick={() => switchMode(m.id)}
              className="kw-mode-btn"
              title={m.label}
              style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', borderRadius:6, border:'none', cursor:'pointer', fontSize:11, fontWeight:500, transition:'all .15s',
                background: mode === m.id ? '#ff5200' : 'transparent',
                color: mode === m.id ? '#fff' : '#666',
                opacity: mode === m.id ? 1 : 0.8,
              }}>
              {m.icon}
              <span>{m.label}</span>
            </button>
          ))}
        </div>

        {mode !== 'browse' && (
          <div style={{ fontSize:11, color:'#666', background:'#1e1e22', padding:'4px 10px', borderRadius:6 }}>
            {mode === 'select' ? 'Click any element to select' : 'Click text to edit inline'}
          </div>
        )}

        <div style={{ flex:1 }} />

        {/* Device preview */}
        <div style={{ display:'flex', background:'#111', borderRadius:8, padding:3, gap:1, marginRight:4 }}>
          {[
            { id:'desktop', icon:<Monitor size={13}/> },
            { id:'mobile', icon:<Smartphone size={13}/> },
          ].map(d => (
            <button key={d.id} onClick={() => setDevice(d.id)} title={d.id}
              style={{ display:'flex', alignItems:'center', justifyContent:'center', width:28, height:28, borderRadius:6, border:'none', cursor:'pointer',
                background: device === d.id ? '#2a2a2e' : 'transparent',
                color: device === d.id ? '#fff' : '#555',
              }}>
              {d.icon}
            </button>
          ))}
        </div>

        {/* Undo / Redo */}
        <button onClick={() => snapshotAction('undo')} disabled={!history.undoCount || saving} title="Undo" className="kw-icon-btn"
          style={{ display:'flex', alignItems:'center', justifyContent:'center', width:32, height:32, borderRadius:6, border:'none', cursor: history.undoCount ? 'pointer' : 'default', background:'transparent', color: history.undoCount ? '#888' : '#333', transition:'all .15s' }}>
          <Undo2 size={14} />
        </button>
        <button onClick={() => snapshotAction('redo')} disabled={!history.redoCount || saving} title="Redo" className="kw-icon-btn"
          style={{ display:'flex', alignItems:'center', justifyContent:'center', width:32, height:32, borderRadius:6, border:'none', cursor: history.redoCount ? 'pointer' : 'default', background:'transparent', color: history.redoCount ? '#888' : '#333', transition:'all .15s' }}>
          <Redo2 size={14} />
        </button>

        <div style={{ width:1, height:24, background:'#2a2a2e' }} />

        {/* Status */}
        <span style={{ fontSize:11, color: status.includes('failed') ? '#e74c3c' : status === 'Saved!' ? '#2ecc71' : '#555', minWidth:60, textAlign:'center' }}>
          {saving ? <Loader2 size={13} style={{ animation:'spin 1s linear infinite', display:'inline-block' }} /> : status}
        </span>

        {/* Save */}
        <button onClick={savePage} disabled={saving}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 16px', borderRadius:7, border:'none', cursor: saving ? 'default' : 'pointer', fontSize:12, fontWeight:600,
            background: isDirty ? 'linear-gradient(135deg,#ff5200,#ff7a00)' : '#2a2a2e',
            color: isDirty ? '#fff' : '#666',
            boxShadow: isDirty ? '0 0 12px rgba(255,82,0,.4)' : 'none',
            transition:'all .3s',
          }}>
          <Save size={13} />
          {isDirty ? 'Save changes' : 'Saved'}
        </button>

        {/* Preview */}
        <a href={`/generated/${JOB_ID}/site/${selectedPage}`} target="_blank" rel="noreferrer"
          style={{ display:'flex', alignItems:'center', gap:5, padding:'7px 12px', borderRadius:7, background:'#2a2a2e', color:'#888', fontSize:12, textDecoration:'none' }}>
          <ExternalLink size={12} /> Preview
        </a>
      </div>

      {/* ── Main area ───────────────────────────────────────────────────── */}
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* ── Left sidebar ─────────────────────────────────────────────── */}
        <div style={{ width:220, background:'#131316', borderRight:'1px solid #1e1e22', display:'flex', flexDirection:'column', flexShrink:0, overflowY:'auto' }}>
          {/* Pages */}
          <div style={{ padding:'12px 12px 6px', borderBottom:'1px solid #1e1e22' }}>
            <p style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:1.2, margin:'0 0 8px' }}>Pages</p>
            {pages.map(page => (
              <button key={page.path} onClick={() => openPage(page.path)} className="kw-tab-btn"
                style={{ display:'flex', alignItems:'center', width:'100%', gap:8, padding:'7px 10px', borderRadius:6, border:'none', cursor:'pointer', textAlign:'left', marginBottom:2, transition:'background .1s',
                  background: selectedPage === page.path ? '#1e2a3a' : 'transparent',
                  color: selectedPage === page.path ? '#4a90d9' : '#888',
                  fontWeight: selectedPage === page.path ? 600 : 400, fontSize:12,
                }}>
                <ChevronRight size={12} style={{ flexShrink:0, opacity: selectedPage === page.path ? 1 : 0.3 }} />
                <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{pageLabel(page.path)}</span>
              </button>
            ))}
          </div>

          {/* Page outline */}
          {site?.outline?.length > 0 && (
            <div style={{ padding:'10px 12px', borderBottom:'1px solid #1e1e22' }}>
              <p style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:1.2, margin:'0 0 8px' }}>On this page</p>
              {site.outline.map((h, i) => (
                <div key={i} style={{ display:'flex', alignItems:'baseline', gap:6, padding:'3px 6px', borderRadius:4, marginBottom:1 }}>
                  <span style={{ fontSize:9, color:'#333', fontWeight:700, textTransform:'uppercase', flexShrink:0, minWidth:18 }}>{h.tag}</span>
                  <span style={{ fontSize:11, color:'#666', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{h.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* Tips */}
          <div style={{ padding:12, marginTop:'auto' }}>
            <div style={{ background:'#1a1a1e', borderRadius:8, padding:12, fontSize:11, color:'#555', lineHeight:1.6 }}>
              <strong style={{ color:'#777', display:'block', marginBottom:6 }}>How to edit</strong>
              <p style={{ margin:'0 0 4px' }}>↑ Use <span style={{ color:'#ff5200' }}>Select</span> to pick elements and change colors/styles</p>
              <p style={{ margin:'0 0 4px' }}>↑ Use <span style={{ color:'#4a90d9' }}>Text</span> to edit any text directly</p>
              <p style={{ margin:0 }}>↑ <span style={{ color:'#ff5200' }}>Save</span> writes your changes to the live site</p>
            </div>
          </div>
        </div>

        {/* ── Canvas ────────────────────────────────────────────────────── */}
        <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', background:'#0a0a0c', overflow:'hidden', position:'relative' }}>
          {/* Device wrapper */}
          <div style={{ flex:1, width:'100%', display:'flex', justifyContent:'center', alignItems:'flex-start', overflowY:'auto', padding: device === 'desktop' ? 0 : '20px 0 0' }}>
            <div style={{
              width: typeof deviceWidth === 'number' ? deviceWidth + 'px' : deviceWidth,
              maxWidth: '100%',
              height: device === 'desktop' ? '100%' : undefined,
              flex: device === 'desktop' ? 1 : undefined,
              position: 'relative',
              ...(device !== 'desktop' ? {
                boxShadow: '0 0 0 10px #222, 0 0 0 11px #333, 0 20px 60px rgba(0,0,0,.8)',
                borderRadius: device === 'mobile' ? 36 : 12,
                overflow: 'hidden',
              } : {})
            }}>
              <iframe
                ref={iframeRef}
                src={iframeSrc}
                title="Portfolio preview"
                onLoad={handleIframeLoad}
                style={{
                  width:'100%',
                  height: device === 'desktop' ? '100%' : (device === 'mobile' ? 844 : 1024) + 'px',
                  border:'none', display:'block',
                }}
              />
            </div>
          </div>

          {/* Mode hint overlay */}
          {mode === 'browse' && (
            <div style={{ position:'absolute', bottom:20, left:'50%', transform:'translateX(-50%)', background:'rgba(20,20,22,.95)', border:'1px solid #2a2a2e', borderRadius:10, padding:'10px 20px', display:'flex', gap:16, alignItems:'center', pointerEvents:'none', backdropFilter:'blur(8px)' }}>
              <span style={{ fontSize:12, color:'#888' }}>Switch to</span>
              <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:'#ff5200', fontWeight:600 }}><Layers size={12}/> Select</span>
              <span style={{ fontSize:12, color:'#666' }}>or</span>
              <span style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, color:'#4a90d9', fontWeight:600 }}><Pencil size={12}/> Text</span>
              <span style={{ fontSize:12, color:'#888' }}>to edit</span>
            </div>
          )}
        </div>

        {/* ── Right panel ───────────────────────────────────────────────── */}
        <div style={{ width:260, background:'#131316', borderLeft:'1px solid #1e1e22', display:'flex', flexDirection:'column', flexShrink:0, overflowY:'auto' }}>
          {!selInfo ? (
            <div style={{ padding:20, textAlign:'center', marginTop:40, color:'#444' }}>
              <Layers size={32} style={{ margin:'0 auto 12px', display:'block', opacity:.4 }} />
              <p style={{ fontSize:12, lineHeight:1.6 }}>
                {mode === 'browse'
                  ? 'Use Select or Text mode to edit your portfolio'
                  : mode === 'select'
                  ? 'Click any element on the page to see its properties'
                  : 'Click any text on the page to edit it'}
              </p>
            </div>
          ) : (
            <div style={{ padding:16 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
                <div>
                  <p style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:1.2, margin:'0 0 2px' }}>
                    {selInfo.type === 'image' ? 'Image' : selInfo.type === 'text' ? 'Text element' : 'Section'}
                  </p>
                  <p style={{ fontSize:12, color:'#888', margin:0 }}>{selInfo.tagName?.toUpperCase()}</p>
                </div>
                <button onClick={() => { deselect(iframeRef.current?.contentDocument); setSelInfo(null); }}
                  style={{ background:'none', border:'none', color:'#555', cursor:'pointer', padding:4 }}>
                  <X size={14} />
                </button>
              </div>

              {/* ── Text properties ── */}
              {selInfo.type === 'text' && selInfo.styles && (
                <>
                  <Section label="Typography">
                    <Row label="Size">
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <input type="number" value={selInfo.styles.fontSize} min={6} max={200}
                          onChange={e => applyTextStyle('fontSize', e.target.value + 'px')}
                          style={numInputStyle} />
                        <span style={{ fontSize:11, color:'#555' }}>px</span>
                      </div>
                    </Row>
                    <Row label="Weight">
                      <select value={String(selInfo.styles.fontWeight).includes('bold') ? '700' : selInfo.styles.fontWeight}
                        onChange={e => applyTextStyle('fontWeight', e.target.value)}
                        style={selectInputStyle}>
                        {['300','400','500','600','700','800','900'].map(w => <option key={w}>{w}</option>)}
                      </select>
                    </Row>
                    <Row label="Align">
                      <div style={{ display:'flex', gap:4 }}>
                        {[['left',<AlignLeft size={13}/>],['center',<AlignCenter size={13}/>],['right',<AlignRight size={13}/>]].map(([v, icon]) => (
                          <button key={v} onClick={() => applyTextStyle('textAlign', v)}
                            style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'5px 0', borderRadius:5, border:'none', cursor:'pointer', background: selInfo.styles.textAlign === v ? '#ff5200' : '#1e1e22', color: selInfo.styles.textAlign === v ? '#fff' : '#888' }}>
                            {icon}
                          </button>
                        ))}
                      </div>
                    </Row>
                    <Row label="Style">
                      <div style={{ display:'flex', gap:4 }}>
                        <button onClick={() => applyTextStyle('fontStyle', selInfo.styles.fontStyle === 'italic' ? 'normal' : 'italic')}
                          style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', padding:'5px 0', borderRadius:5, border:'none', cursor:'pointer', background: selInfo.styles.fontStyle === 'italic' ? '#ff5200' : '#1e1e22', color: selInfo.styles.fontStyle === 'italic' ? '#fff' : '#888' }}>
                          <Italic size={13}/>
                        </button>
                      </div>
                    </Row>
                  </Section>

                  <Section label="Color">
                    <Row label="Text">
                      <ColorPicker value={selInfo.styles.color} onChange={v => { applyTextStyle('color', v); setSelInfo(p => p ? {...p, styles:{...p.styles,color:v}} : p); }} />
                    </Row>
                  </Section>
                </>
              )}

              {/* ── Image properties ── */}
              {selInfo.type === 'image' && (
                <Section label="Image">
                  {selInfo.src && (
                    <div style={{ borderRadius:8, overflow:'hidden', marginBottom:12, background:'#0a0a0c' }}>
                      <img src={selInfo.src} alt="" style={{ width:'100%', height:120, objectFit:'cover', display:'block' }} />
                    </div>
                  )}
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageUpload} style={{ display:'none' }} />
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploadingImage}
                    style={{ width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:8, padding:'9px 0', borderRadius:7, border:'1px dashed #333', background:'#1a1a1e', color:'#888', cursor:'pointer', fontSize:12, transition:'all .15s' }}>
                    {uploadingImage ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <Upload size={14}/>}
                    {uploadingImage ? 'Uploading…' : 'Replace image'}
                  </button>
                </Section>
              )}

              {/* ── Section properties ── */}
              {selInfo.type === 'section' && selInfo.styles && (
                <Section label="Style">
                  <Row label="BG color">
                    <ColorPicker value={selInfo.styles.backgroundColor || '#ffffff'}
                      onChange={v => { applyStyle('backgroundColor', v); setSelInfo(p => p ? {...p, styles:{...p.styles,backgroundColor:v}} : p); }} />
                  </Row>
                  {selInfo.styles.color && (
                    <Row label="Text color">
                      <ColorPicker value={selInfo.styles.color}
                        onChange={v => { applyStyle('color', v); setSelInfo(p => p ? {...p, styles:{...p.styles,color:v}} : p); }} />
                    </Row>
                  )}
                </Section>
              )}

              {/* Save reminder */}
              {isDirty && (
                <div style={{ marginTop:12, padding:'10px 12px', background:'rgba(255,82,0,.08)', border:'1px solid rgba(255,82,0,.2)', borderRadius:8, fontSize:11, color:'#ff8c4a', textAlign:'center' }}>
                  You have unsaved changes
                  <button onClick={savePage} style={{ display:'block', width:'100%', marginTop:8, padding:'6px 0', background:'#ff5200', border:'none', borderRadius:5, color:'#fff', fontSize:11, fontWeight:600, cursor:'pointer' }}>Save now</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Utility components ────────────────────────────────────────────────────────
function Section({ label, children }) {
  return (
    <div style={{ marginBottom:20 }}>
      <p style={{ fontSize:10, color:'#444', textTransform:'uppercase', letterSpacing:1.2, margin:'0 0 10px' }}>{label}</p>
      {children}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', marginBottom:8, gap:8 }}>
      <span style={{ fontSize:11, color:'#666', width:60, flexShrink:0 }}>{label}</span>
      <div style={{ flex:1 }}>{children}</div>
    </div>
  );
}

function ColorPicker({ value, onChange }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ width:28, height:28, borderRadius:5, background: value || '#fff', border:'1px solid #2a2a2e', flexShrink:0, position:'relative', overflow:'hidden' }}>
        <input type="color" value={value || '#ffffff'} onChange={e => onChange(e.target.value)}
          style={{ position:'absolute', inset:0, width:'200%', height:'200%', opacity:0, cursor:'pointer' }} />
      </div>
      <input type="text" value={value || ''} onChange={e => onChange(e.target.value)} placeholder="#000000"
        style={{ flex:1, background:'#1e1e22', border:'1px solid #2a2a2e', borderRadius:5, color:'#ccc', padding:'4px 8px', fontSize:11, outline:'none', fontFamily:'monospace' }} />
    </div>
  );
}

const numInputStyle = { width:'100%', background:'#1e1e22', border:'1px solid #2a2a2e', borderRadius:5, color:'#ccc', padding:'4px 8px', fontSize:12, outline:'none', boxSizing:'border-box' };
const selectInputStyle = { width:'100%', background:'#1e1e22', border:'1px solid #2a2a2e', borderRadius:5, color:'#ccc', padding:'4px 8px', fontSize:12, outline:'none' };

async function bootstrap() {
  try { await loadAuth(); } catch {}
  createRoot(document.getElementById('root')).render(<VisualEditor />);
}

bootstrap();

import { useState, useRef, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Undo2, Redo2, Trash2, Home, Save, Loader2, ExternalLink, Check,
  Type, Square, Circle, Minus, Image as ImageIcon, Layers,
  AlignLeft, AlignCenter, AlignRight, Italic, Bold,
  ArrowUp, ArrowDown, ChevronsUp, ChevronsDown,
  MousePointer, Upload
} from 'lucide-react';

const SNAP = 8;
const snap = v => Math.round(v / SNAP) * SNAP;
const PAGE_W = 800;
const PAGE_H = 1100;

const FONTS = ['Inter', 'Georgia', 'Playfair Display', 'Montserrat', 'Bebas Neue', 'Courier New'];
const COLORS = [
  '#000000','#1a1a1a','#333333','#666666','#999999','#cccccc','#ffffff',
  '#1a1a2e','#c9b49a','#e8e0d5','#ff5200','#4a90d9','#e74c3c','#2ecc71','#f39c12','#9b59b6'
];

let _counter = 1;
const uid = () => `el_${_counter++}`;

const params = new URLSearchParams(window.location.search);
const JOB_ID = params.get('job') || localStorage.getItem('killerwork:lastJobId') || '';

async function loadAuth() {
  if (!window.KillerWorkAuth) await import(/* @vite-ignore */ '/auth.js?v=20260603-ads-base2');
  return window.KillerWorkAuth;
}

async function apiRequest(url, options = {}) {
  const auth = await loadAuth();
  const token = await auth.requireToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CanvasElement({ el, selected, onMouseDown, onDoubleClick, isEditing, onEditDone, onContentChange }) {
  const base = {
    position: 'absolute',
    left: el.x, top: el.y,
    width: el.w, height: el.h,
    opacity: el.opacity,
    zIndex: el.zIndex,
    boxSizing: 'border-box',
    userSelect: isEditing ? 'text' : 'none',
    cursor: 'move',
    ...(selected ? { outline: '2px solid #4a90d9', outlineOffset: '1px' } : {})
  };

  if (el.type === 'text') {
    return (
      <div
        style={{ ...base, fontSize: el.fontSize, fontFamily: el.fontFamily, color: el.color,
          fontWeight: el.fontWeight, fontStyle: el.fontStyle, textAlign: el.textAlign,
          letterSpacing: (el.letterSpacing ?? 0) + 'px', lineHeight: 1.2,
          overflow: 'hidden', whiteSpace: 'pre-wrap' }}
        onMouseDown={e => { if (!isEditing) onMouseDown(e); }}
        onDoubleClick={onDoubleClick}
      >
        {isEditing ? (
          <textarea
            autoFocus
            value={el.content}
            onChange={e => onContentChange(e.target.value)}
            onBlur={onEditDone}
            onKeyDown={e => { if (e.key === 'Escape') onEditDone(); }}
            style={{ width: '100%', height: '100%', border: 'none', background: 'transparent',
              font: 'inherit', color: 'inherit', resize: 'none', outline: 'none',
              letterSpacing: 'inherit', lineHeight: 'inherit', textAlign: 'inherit',
              cursor: 'text', padding: 0 }}
          />
        ) : el.content}
      </div>
    );
  }

  if (el.type === 'rect') {
    return <div style={{ ...base, background: el.color, borderRadius: (el.borderRadius ?? 0) + 'px' }} onMouseDown={onMouseDown} />;
  }

  if (el.type === 'image') {
    return (
      <div style={{ ...base, overflow: 'hidden', borderRadius: (el.borderRadius ?? 0) + 'px' }} onMouseDown={onMouseDown}>
        <img src={el.src} draggable={false} alt=""
          style={{ width: '100%', height: '100%', objectFit: el.objectFit ?? 'cover', display: 'block' }} />
      </div>
    );
  }

  if (el.type === 'circle') {
    return <div style={{ ...base, background: el.color, borderRadius: '50%' }} onMouseDown={onMouseDown} />;
  }

  if (el.type === 'line') {
    return (
      <div style={{ ...base, display: 'flex', alignItems: 'center' }} onMouseDown={onMouseDown}>
        <div style={{ width: '100%', height: (el.thickness ?? 2) + 'px', background: el.color, borderRadius: 2 }} />
      </div>
    );
  }
  return null;
}

const HANDLE_POSITIONS = ['nw','n','ne','w','e','sw','s','se'];
const HANDLE_CURSORS = { nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize' };
const HANDLE_POS = {
  nw:{top:-5,left:-5}, n:{top:-5,left:'50%',transform:'translateX(-50%)'},
  ne:{top:-5,right:-5}, w:{top:'50%',left:-5,transform:'translateY(-50%)'},
  e:{top:'50%',right:-5,transform:'translateY(-50%)'}, sw:{bottom:-5,left:-5},
  s:{bottom:-5,left:'50%',transform:'translateX(-50%)'}, se:{bottom:-5,right:-5}
};

function ResizeHandle({ pos, onMouseDown }) {
  return (
    <div
      onMouseDown={e => { e.stopPropagation(); onMouseDown(e, pos); }}
      style={{ position:'absolute', width:10, height:10, background:'#fff',
        border:'2px solid #4a90d9', borderRadius:2, cursor:HANDLE_CURSORS[pos],
        zIndex:9999, ...HANDLE_POS[pos] }}
    />
  );
}

function PropSection({ label, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <p style={{ fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: 1, margin: '0 0 8px' }}>{label}</p>
      {children}
    </div>
  );
}

function PropRow({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', marginBottom: 7, gap: 8 }}>
      <span style={{ fontSize: 11, color: '#888', width: 52, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

function NumInput({ value, onChange, min = -9999, max = 9999 }) {
  return (
    <input type="number" value={Math.round(value)} min={min} max={max}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width:'100%', background:'#2e2e32', border:'1px solid #3a3a3e', borderRadius:4,
        color:'#ccc', padding:'3px 6px', fontSize:12, outline:'none', boxSizing:'border-box' }} />
  );
}

const selectStyle = { width:'100%', background:'#2e2e32', border:'1px solid #3a3a3e', borderRadius:4, color:'#ccc', padding:'4px 6px', fontSize:12, outline:'none' };
const labelStyle = { display:'block', fontSize:11, color:'#888', marginBottom:4 };
const iconBtn = (active) => ({
  flex: 1, background: active ? '#4a90d9' : '#2e2e32', border: 'none',
  borderRadius: 4, color: active ? '#fff' : '#ccc', cursor: 'pointer', padding: 5,
  display:'flex', alignItems:'center', justifyContent:'center'
});

// ─── Main Editor ──────────────────────────────────────────────────────────────

function PortfolioEditor() {
  const [elements, setElements] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [leftTab, setLeftTab] = useState('elements');
  const [history, setHistory] = useState([[]]);
  const [histIdx, setHistIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [showGrid, setShowGrid] = useState(false);
  const [guides, setGuides] = useState({ x: null, y: null });
  const [canvasColor, setCanvasColor] = useState('#f8f7f4');
  // API / status state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Loading...');
  const [site, setSite] = useState(null);
  const [portfolioImages, setPortfolioImages] = useState([]);

  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);

  // Load state on mount
  useEffect(() => {
    if (!JOB_ID) {
      setLoading(false);
      setStatusMsg('Missing portfolio id — open from Manage projects.');
      return;
    }
    loadState();
  }, []);

  async function loadState() {
    try {
      const data = await apiRequest(`/api/pixel-editor/${encodeURIComponent(JOB_ID)}/state`);
      setSite(data);
      setPortfolioImages(data.images || []);
      const els = data.elements || [];
      setElements(els);
      setHistory([els]);
      setHistIdx(0);
      if (data.canvasColor) setCanvasColor(data.canvasColor);
      setLoading(false);
      setStatusMsg('Ready.');
    } catch (err) {
      setLoading(false);
      setStatusMsg(err.message || 'Could not load portfolio.');
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatusMsg('Saving...');
    try {
      await apiRequest(`/api/pixel-editor/${encodeURIComponent(JOB_ID)}/state`, {
        method: 'PUT',
        body: JSON.stringify({ elements, canvasColor })
      });
      setStatusMsg('Saved.');
    } catch (err) {
      setStatusMsg('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish() {
    if (!confirm('This replaces your portfolio home page with this canvas design. Continue?')) return;
    setSaving(true);
    setStatusMsg('Publishing...');
    try {
      await apiRequest(`/api/pixel-editor/${encodeURIComponent(JOB_ID)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ elements, canvasColor })
      });
      setStatusMsg('Published! Home page updated.');
    } catch (err) {
      setStatusMsg('Publish failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── History ───────────────────────────────────────────────────────────────

  const pushHistory = useCallback((els) => {
    setHistory(h => [...h.slice(0, histIdx + 1), els]);
    setHistIdx(i => i + 1);
  }, [histIdx]);

  function undo() {
    if (histIdx > 0) {
      setHistIdx(i => i - 1);
      setElements(history[histIdx - 1]);
      setSelected(null);
    }
  }

  function redo() {
    if (histIdx < history.length - 1) {
      setHistIdx(i => i + 1);
      setElements(history[histIdx + 1]);
    }
  }

  // ─── Element operations ────────────────────────────────────────────────────

  const updateEl = useCallback((id, patch) => {
    setElements(els => els.map(e => e.id === id ? { ...e, ...patch } : e));
  }, []);

  const commitUpdate = useCallback((id, patch) => {
    setElements(els => {
      const next = els.map(e => e.id === id ? { ...e, ...patch } : e);
      pushHistory(next);
      return next;
    });
  }, [pushHistory]);

  function addElement(type) {
    const maxZ = elements.length ? Math.max(...elements.map(e => e.zIndex)) : 0;
    const x = 80 + Math.floor(Math.random() * 60);
    const y = 80 + Math.floor(Math.random() * 60);
    let el = { id: uid(), type, x, y, opacity: 1, zIndex: maxZ + 1 };
    if (type === 'text') el = { ...el, w: 300, h: 50, content: 'New text', fontSize: 20, fontFamily: 'Inter', color: '#1a1a1a', fontWeight: '400', fontStyle: 'normal', textAlign: 'left', letterSpacing: 0 };
    if (type === 'rect') el = { ...el, w: 200, h: 120, color: '#c9b49a', borderRadius: 0 };
    if (type === 'circle') el = { ...el, w: 120, h: 120, color: '#4a90d9' };
    if (type === 'line') el = { ...el, w: 300, h: 20, color: '#1a1a1a', thickness: 2 };
    if (type === 'image') el = { ...el, w: 280, h: 200, src: portfolioImages[0]?.src || '', objectFit: 'cover', borderRadius: 4 };
    const next = [...elements, el];
    setElements(next);
    pushHistory(next);
    setSelected(el.id);
  }

  function addImageElement(src, label) {
    const maxZ = elements.length ? Math.max(...elements.map(e => e.zIndex)) : 0;
    const el = { id: uid(), type: 'image', x: 80, y: 80, w: 280, h: 200, src, opacity: 1, zIndex: maxZ + 1, objectFit: 'cover', borderRadius: 4 };
    const next = [...elements, el];
    setElements(next);
    pushHistory(next);
    setSelected(el.id);
  }

  function deleteSelected() {
    if (!selected) return;
    const next = elements.filter(e => e.id !== selected);
    setElements(next);
    pushHistory(next);
    setSelected(null);
  }

  const selEl = elements.find(e => e.id === selected);

  // ─── Drag ──────────────────────────────────────────────────────────────────

  const onElMouseDown = useCallback((e, id) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(id);
    const el = elements.find(e2 => e2.id === id);
    dragRef.current = { id, startX: e.clientX, startY: e.clientY, elX: el.x, elY: el.y };
  }, [elements]);

  const onResizeMouseDown = useCallback((e, handle) => {
    e.preventDefault();
    const el = elements.find(e2 => e2.id === selected);
    resizeRef.current = { handle, startX: e.clientX, startY: e.clientY, ...el };
  }, [elements, selected]);

  useEffect(() => {
    const onMove = (e) => {
      if (dragRef.current) {
        const dx = (e.clientX - dragRef.current.startX) / zoom;
        const dy = (e.clientY - dragRef.current.startY) / zoom;
        const nx = snap(Math.max(0, dragRef.current.elX + dx));
        const ny = snap(Math.max(0, dragRef.current.elY + dy));
        setGuides({ x: nx, y: ny });
        updateEl(dragRef.current.id, { x: nx, y: ny });
      }
      if (resizeRef.current) {
        const r = resizeRef.current;
        const dx = (e.clientX - r.startX) / zoom;
        const dy = (e.clientY - r.startY) / zoom;
        let { x, y, w, h } = r;
        if (r.handle.includes('e')) w = snap(Math.max(40, r.w + dx));
        if (r.handle.includes('s')) h = snap(Math.max(20, r.h + dy));
        if (r.handle.includes('w')) { x = snap(r.x + dx); w = snap(Math.max(40, r.w - dx)); }
        if (r.handle.includes('n')) { y = snap(r.y + dy); h = snap(Math.max(20, r.h - dy)); }
        updateEl(r.id, { x, y, w, h });
      }
    };
    const onUp = () => {
      if (dragRef.current) { commitUpdate(dragRef.current.id, {}); dragRef.current = null; setGuides({ x: null, y: null }); }
      if (resizeRef.current) { commitUpdate(resizeRef.current.id, {}); resizeRef.current = null; }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [zoom, updateEl, commitUpdate]);

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e) => {
      if (editingId) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); deleteSelected(); }
      if (e.key === 'Escape') { setSelected(null); setEditingId(null); }
      if (selected) {
        const d = e.shiftKey ? 10 : 1;
        const el = elements.find(x => x.id === selected);
        if (!el) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); updateEl(selected, { x: el.x - d }); }
        if (e.key === 'ArrowRight') { e.preventDefault(); updateEl(selected, { x: el.x + d }); }
        if (e.key === 'ArrowUp') { e.preventDefault(); updateEl(selected, { y: el.y - d }); }
        if (e.key === 'ArrowDown') { e.preventDefault(); updateEl(selected, { y: el.y + d }); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, editingId, elements, histIdx]);

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={{ height: '100vh', background: '#1c1c1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: '#888', fontFamily: 'Inter,sans-serif' }}>
        <Loader2 size={32} style={{ animation: 'spin 1s linear infinite' }} />
        <p style={{ fontSize: 14 }}>{statusMsg}</p>
        <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  if (!JOB_ID) {
    return (
      <div style={{ height: '100vh', background: '#1c1c1e', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, color: '#888', fontFamily: 'Inter,sans-serif' }}>
        <MousePointer size={32} />
        <p style={{ fontSize: 14 }}>Open the visual editor from Manage projects.</p>
        <a href="/manage.html" style={{ color: '#4a90d9', fontSize: 13 }}>Go to Manage projects</a>
      </div>
    );
  }

  const sorted = [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const canUndoEl = histIdx > 0;
  const canRedoEl = histIdx < history.length - 1;

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', fontFamily:'Inter,system-ui,sans-serif', background:'#1c1c1e', color:'#e0e0e0', userSelect:'none' }}>

      {/* ── Top bar ── */}
      <div style={{ display:'flex', alignItems:'center', height:52, background:'#2a2a2e', borderBottom:'1px solid #3a3a3e', padding:'0 12px', gap:8, flexShrink:0 }}>
        <a href="/manage.html" style={{ display:'flex', alignItems:'center', justifyContent:'center', width:32, height:32, background:'#333', borderRadius:6, color:'#ccc', textDecoration:'none' }} title="Back to Manage">
          <Home size={16} />
        </a>
        <div style={{ display:'flex', alignItems:'center', gap:4, marginRight:4 }}>
          <div style={{ width:26, height:26, background:'linear-gradient(135deg,#ff5200,#ff8c00)', borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'#fff' }}>K</div>
          <div style={{ lineHeight:1.2 }}>
            <div style={{ fontSize:11, color:'#888' }}>Visual Editor</div>
            <div style={{ fontSize:12, fontWeight:600, color:'#fff' }}>{site?.siteTitle || 'Portfolio'}</div>
          </div>
        </div>

        <div style={{ width:1, height:28, background:'#3a3a3e' }} />

        <button onClick={undo} disabled={!canUndoEl} title="Undo (⌘Z)"
          style={{ background:'none', border:'none', color: canUndoEl ? '#ccc' : '#444', cursor: canUndoEl ? 'pointer' : 'default', padding:'4px 6px', borderRadius:4, display:'flex', alignItems:'center' }}>
          <Undo2 size={16} />
        </button>
        <button onClick={redo} disabled={!canRedoEl} title="Redo"
          style={{ background:'none', border:'none', color: canRedoEl ? '#ccc' : '#444', cursor: canRedoEl ? 'pointer' : 'default', padding:'4px 6px', borderRadius:4, display:'flex', alignItems:'center' }}>
          <Redo2 size={16} />
        </button>

        <div style={{ width:1, height:28, background:'#3a3a3e' }} />

        <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'#aaa', cursor:'pointer' }}>
          <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} style={{ accentColor:'#4a90d9' }} />
          Grid
        </label>

        <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'#aaa' }}>
          BG
          <input type="color" value={canvasColor} onChange={e => setCanvasColor(e.target.value)}
            style={{ width:24, height:20, border:'none', background:'none', cursor:'pointer', borderRadius:3 }} />
        </label>

        <div style={{ flex:1 }} />

        <div style={{ display:'flex', alignItems:'center', gap:4, marginRight:4 }}>
          <span style={{ fontSize:11, color:'#888' }}>Zoom</span>
          <button onClick={() => setZoom(z => Math.max(0.25, +(z - 0.1).toFixed(2)))}
            style={{ background:'#3a3a3e', border:'none', color:'#ccc', cursor:'pointer', borderRadius:4, width:22, height:22, fontSize:14, lineHeight:'22px' }}>−</button>
          <span style={{ fontSize:12, color:'#ccc', minWidth:34, textAlign:'center' }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(3, +(z + 0.1).toFixed(2)))}
            style={{ background:'#3a3a3e', border:'none', color:'#ccc', cursor:'pointer', borderRadius:4, width:22, height:22, fontSize:14, lineHeight:'22px' }}>+</button>
          <button onClick={() => setZoom(1)} style={{ background:'#3a3a3e', border:'none', color:'#ccc', cursor:'pointer', borderRadius:4, padding:'0 6px', height:22, fontSize:11 }}>Reset</button>
        </div>

        <button onClick={deleteSelected} disabled={!selected}
          style={{ display:'flex', alignItems:'center', gap:5, background: selected ? '#c0392b22' : 'none', border:`1px solid ${selected ? '#c0392b' : '#444'}`, color: selected ? '#e74c3c' : '#555', cursor: selected ? 'pointer' : 'default', borderRadius:5, padding:'5px 10px', fontSize:12 }}>
          <Trash2 size={14} />
          Delete
        </button>

        <button onClick={handleSave} disabled={saving}
          style={{ display:'flex', alignItems:'center', gap:5, background:'#2e3d52', border:'1px solid #4a90d9', color:'#7ab8f5', cursor: saving ? 'default' : 'pointer', borderRadius:5, padding:'5px 12px', fontSize:12, fontWeight:500 }}>
          {saving ? <Loader2 size={14} style={{ animation:'spin 1s linear infinite' }} /> : <Save size={14} />}
          Save
        </button>

        <button onClick={handlePublish} disabled={saving}
          style={{ display:'flex', alignItems:'center', gap:5, background:'linear-gradient(135deg,#ff5200,#ff8c00)', border:'none', color:'#fff', cursor: saving ? 'default' : 'pointer', borderRadius:5, padding:'5px 12px', fontSize:12, fontWeight:600 }}>
          <Upload size={14} />
          Publish to Site
        </button>

        {site?.preview && (
          <a href={site.preview} target="_blank" rel="noreferrer"
            style={{ display:'flex', alignItems:'center', gap:4, background:'#2e2e32', border:'1px solid #3a3a3e', color:'#aaa', borderRadius:5, padding:'5px 10px', fontSize:12, textDecoration:'none' }}>
            <ExternalLink size={14} />
            Preview
          </a>
        )}

        <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
      </div>

      {/* ── Main area ── */}
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        {/* ── Left panel ── */}
        <div style={{ width:220, background:'#222226', borderRight:'1px solid #333', display:'flex', flexDirection:'column', flexShrink:0 }}>
          <div style={{ display:'flex', borderBottom:'1px solid #333' }}>
            {[
              { id:'elements', icon:<Layers size={16}/>, label:'Elements' },
              { id:'photos', icon:<ImageIcon size={16}/>, label:'Photos' },
              { id:'text', icon:<Type size={16}/>, label:'Text' },
            ].map(tab => (
              <button key={tab.id} onClick={() => setLeftTab(tab.id)} style={{
                flex:1, padding:'8px 4px', background: leftTab === tab.id ? '#2e2e32' : 'none',
                border:'none', borderBottom: leftTab === tab.id ? '2px solid #4a90d9' : '2px solid transparent',
                color: leftTab === tab.id ? '#fff' : '#777', cursor:'pointer', fontSize:10,
                display:'flex', flexDirection:'column', alignItems:'center', gap:3
              }}>
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:12 }}>

            {/* Elements tab */}
            {leftTab === 'elements' && (
              <div>
                <p style={{ fontSize:10, color:'#555', margin:'0 0 10px', textTransform:'uppercase', letterSpacing:1 }}>Add to Canvas</p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:20 }}>
                  {[
                    { type:'text', icon:<Type size={20}/>, label:'Text' },
                    { type:'rect', icon:<Square size={20}/>, label:'Box' },
                    { type:'circle', icon:<Circle size={20}/>, label:'Circle' },
                    { type:'line', icon:<Minus size={20}/>, label:'Line' },
                    { type:'image', icon:<ImageIcon size={20}/>, label:'Image' },
                  ].map(item => (
                    <button key={item.type} onClick={() => addElement(item.type)}
                      style={{ background:'#2e2e32', border:'1px solid #3a3a3e', borderRadius:8, padding:'12px 8px',
                        color:'#ccc', cursor:'pointer', fontSize:11, textAlign:'center', display:'flex',
                        flexDirection:'column', alignItems:'center', gap:6 }}
                      onMouseEnter={e => e.currentTarget.style.borderColor='#4a90d9'}
                      onMouseLeave={e => e.currentTarget.style.borderColor='#3a3a3e'}>
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>

                <p style={{ fontSize:10, color:'#555', margin:'0 0 8px', textTransform:'uppercase', letterSpacing:1 }}>Layers</p>
                {[...elements].reverse().map(el => (
                  <div key={el.id} onClick={() => setSelected(el.id)}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', borderRadius:6,
                      cursor:'pointer', marginBottom:3,
                      background: selected === el.id ? '#2e3d52' : 'transparent',
                      border:`1px solid ${selected === el.id ? '#4a90d9' : 'transparent'}` }}>
                    <span style={{ fontSize:11, color:'#888', flexShrink:0 }}>
                      {el.type === 'text' ? <Type size={11}/> : el.type === 'image' ? <ImageIcon size={11}/> : el.type === 'rect' ? <Square size={11}/> : el.type === 'circle' ? <Circle size={11}/> : <Minus size={11}/>}
                    </span>
                    <span style={{ fontSize:11, color:'#bbb', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {el.type === 'text' ? el.content.slice(0, 20) : el.type}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Photos tab */}
            {leftTab === 'photos' && (
              <div>
                <p style={{ fontSize:10, color:'#555', margin:'0 0 10px', textTransform:'uppercase', letterSpacing:1 }}>
                  {portfolioImages.length ? 'Portfolio Images' : 'No images found'}
                </p>
                {portfolioImages.length > 0 ? (
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                    {portfolioImages.map((img, i) => (
                      <div key={i} onClick={() => addImageElement(img.src, img.label)}
                        style={{ cursor:'pointer', borderRadius:6, overflow:'hidden', border:'2px solid #333' }}
                        onMouseEnter={e => e.currentTarget.style.borderColor='#4a90d9'}
                        onMouseLeave={e => e.currentTarget.style.borderColor='#333'}>
                        <img src={img.src} alt={img.label}
                          style={{ width:'100%', height:68, objectFit:'cover', display:'block' }} />
                        <div style={{ fontSize:10, padding:'3px 5px', color:'#888', background:'#1e1e22' }}>{img.label}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ fontSize:12, color:'#555', lineHeight:1.5 }}>Build a portfolio with project images first, then they will appear here.</p>
                )}
              </div>
            )}

            {/* Text tab */}
            {leftTab === 'text' && (
              <div>
                <p style={{ fontSize:10, color:'#555', margin:'0 0 10px', textTransform:'uppercase', letterSpacing:1 }}>Text Styles</p>
                {[
                  { label:'Heading', fontSize:42, fontWeight:'700', fontFamily:'Playfair Display', content:'Heading' },
                  { label:'Subheading', fontSize:22, fontWeight:'600', fontFamily:'Inter', content:'Subheading' },
                  { label:'Body', fontSize:16, fontWeight:'400', fontFamily:'Inter', content:'Body text block' },
                  { label:'Caption', fontSize:12, fontWeight:'400', fontFamily:'Inter', content:'Caption text', color:'#888' },
                  { label:'Quote', fontSize:20, fontWeight:'400', fontStyle:'italic', fontFamily:'Georgia', content:'A standout quote or line' },
                  { label:'All Caps', fontSize:11, fontWeight:'600', fontFamily:'Inter', content:'ALL CAPS LABEL', letterSpacing:3 },
                ].map(preset => {
                  const maxZ = elements.length ? Math.max(...elements.map(e => e.zIndex)) : 0;
                  return (
                    <button key={preset.label} onClick={() => {
                      const el = { id: uid(), type:'text', x:80, y:80, w:320, h:60, opacity:1, zIndex:maxZ+1, textAlign:'left', letterSpacing:0, color:'#1a1a1a', fontStyle:'normal', ...preset };
                      const next = [...elements, el];
                      setElements(next);
                      pushHistory(next);
                      setSelected(el.id);
                    }}
                      style={{ display:'block', width:'100%', background:'#2e2e32', border:'1px solid #3a3a3e', borderRadius:8, padding:'9px 12px', marginBottom:8, cursor:'pointer', textAlign:'left', color:'#ccc' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor='#4a90d9'}
                      onMouseLeave={e => e.currentTarget.style.borderColor='#3a3a3e'}>
                      <div style={{ fontSize:9, color:'#555', marginBottom:3, textTransform:'uppercase', letterSpacing:1 }}>{preset.label}</div>
                      <div style={{ fontSize:Math.min(preset.fontSize, 20), fontFamily:preset.fontFamily, fontWeight:preset.fontWeight, fontStyle:preset.fontStyle ?? 'normal', color:'#ddd' }}>{preset.content}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Canvas ── */}
        <div ref={canvasRef} style={{ flex:1, overflow:'auto', background:'#141416', display:'flex', justifyContent:'center', alignItems:'flex-start', padding:40 }}
          onClick={e => { if (e.target === canvasRef.current || e.currentTarget === e.target) { setSelected(null); setEditingId(null); } }}>
          <div style={{ position:'relative', width:PAGE_W * zoom, height:PAGE_H * zoom, flexShrink:0 }}>
            {/* Page background */}
            <div
              style={{
                position:'absolute', inset:0,
                background: canvasColor,
                boxShadow:'0 8px 60px rgba(0,0,0,.6)',
                borderRadius:2,
                backgroundImage: showGrid
                  ? `linear-gradient(rgba(0,0,0,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.06) 1px,transparent 1px)`
                  : 'none',
                backgroundSize: showGrid ? `${SNAP * zoom}px ${SNAP * zoom}px` : 'auto',
                cursor:'default'
              }}
              onClick={() => { setSelected(null); setEditingId(null); }}
            />

            {/* Snap guides */}
            {guides.x !== null && <div style={{ position:'absolute', left:guides.x * zoom, top:0, width:1, height:'100%', background:'#4a90d9', opacity:.5, pointerEvents:'none', zIndex:10000 }} />}
            {guides.y !== null && <div style={{ position:'absolute', top:guides.y * zoom, left:0, height:1, width:'100%', background:'#4a90d9', opacity:.5, pointerEvents:'none', zIndex:10000 }} />}

            {/* Elements */}
            <div style={{ position:'absolute', inset:0, transform:`scale(${zoom})`, transformOrigin:'top left' }}>
              {sorted.map(el => (
                <div key={el.id} style={{ position:'absolute', left:0, top:0, width:PAGE_W, height:PAGE_H, pointerEvents:'none' }}>
                  <div style={{ position:'absolute', left:el.x, top:el.y, width:el.w, height:el.h, pointerEvents:'all' }}>
                    <CanvasElement
                      el={el}
                      selected={selected === el.id}
                      isEditing={editingId === el.id}
                      onMouseDown={e => onElMouseDown(e, el.id)}
                      onDoubleClick={() => { if (el.type === 'text') setEditingId(el.id); }}
                      onEditDone={() => { setEditingId(null); pushHistory([...elements]); }}
                      onContentChange={val => updateEl(el.id, { content: val })}
                    />
                    {selected === el.id && !editingId && HANDLE_POSITIONS.map(pos => (
                      <ResizeHandle key={pos} pos={pos} onMouseDown={onResizeMouseDown} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right panel ── */}
        <div style={{ width:240, background:'#222226', borderLeft:'1px solid #333', overflowY:'auto', flexShrink:0, padding:16 }}>
          {!selEl ? (
            <div style={{ color:'#444', fontSize:12, textAlign:'center', marginTop:40, lineHeight:1.6 }}>
              <MousePointer size={28} style={{ margin:'0 auto 12px', display:'block' }} />
              Click an element to edit its properties
            </div>
          ) : (
            <div>
              <p style={{ fontSize:10, color:'#666', margin:'0 0 14px', textTransform:'uppercase', letterSpacing:1 }}>{selEl.type} Properties</p>

              <PropSection label="Position & Size">
                <PropRow label="X"><NumInput value={selEl.x} onChange={v => commitUpdate(selEl.id, { x: v })} /></PropRow>
                <PropRow label="Y"><NumInput value={selEl.y} onChange={v => commitUpdate(selEl.id, { y: v })} /></PropRow>
                <PropRow label="W"><NumInput value={selEl.w} onChange={v => commitUpdate(selEl.id, { w: v })} min={10} /></PropRow>
                <PropRow label="H"><NumInput value={selEl.h} onChange={v => commitUpdate(selEl.id, { h: v })} min={10} /></PropRow>
                <PropRow label="Opacity">
                  <input type="range" min={0} max={1} step={0.01} value={selEl.opacity}
                    onChange={e => commitUpdate(selEl.id, { opacity: parseFloat(e.target.value) })}
                    style={{ width:'100%', accentColor:'#4a90d9' }} />
                </PropRow>
                <PropRow label="Z-Index"><NumInput value={selEl.zIndex} onChange={v => commitUpdate(selEl.id, { zIndex: v })} min={1} /></PropRow>
              </PropSection>

              {selEl.type === 'text' && (
                <PropSection label="Typography">
                  <div style={{ marginBottom:8 }}>
                    <label style={labelStyle}>Font Family</label>
                    <select value={selEl.fontFamily} onChange={e => commitUpdate(selEl.id, { fontFamily: e.target.value })} style={selectStyle}>
                      {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                  <PropRow label="Size"><NumInput value={selEl.fontSize} onChange={v => commitUpdate(selEl.id, { fontSize: v })} min={6} max={200} /></PropRow>
                  <PropRow label="Tracking"><NumInput value={selEl.letterSpacing ?? 0} onChange={v => commitUpdate(selEl.id, { letterSpacing: v })} min={-10} max={40} /></PropRow>
                  <div style={{ marginBottom:8 }}>
                    <label style={labelStyle}>Weight</label>
                    <select value={selEl.fontWeight} onChange={e => commitUpdate(selEl.id, { fontWeight: e.target.value })} style={selectStyle}>
                      {['100','200','300','400','500','600','700','800','900'].map(w => <option key={w} value={w}>{w}</option>)}
                    </select>
                  </div>
                  <div style={{ display:'flex', gap:5, marginBottom:8 }}>
                    <button onClick={() => commitUpdate(selEl.id, { textAlign:'left' })} style={iconBtn(selEl.textAlign==='left')}><AlignLeft size={14}/></button>
                    <button onClick={() => commitUpdate(selEl.id, { textAlign:'center' })} style={iconBtn(selEl.textAlign==='center')}><AlignCenter size={14}/></button>
                    <button onClick={() => commitUpdate(selEl.id, { textAlign:'right' })} style={iconBtn(selEl.textAlign==='right')}><AlignRight size={14}/></button>
                    <button onClick={() => commitUpdate(selEl.id, { fontStyle: selEl.fontStyle === 'italic' ? 'normal' : 'italic' })} style={iconBtn(selEl.fontStyle==='italic')}><Italic size={14}/></button>
                    <button onClick={() => commitUpdate(selEl.id, { fontWeight: ['700','800','900'].includes(String(selEl.fontWeight)) ? '400' : '700' })} style={iconBtn(['700','800','900'].includes(String(selEl.fontWeight)))}><Bold size={14}/></button>
                  </div>
                  <div>
                    <label style={labelStyle}>Color</label>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                      {COLORS.map(c => (
                        <div key={c} onClick={() => commitUpdate(selEl.id, { color: c })}
                          style={{ width:20, height:20, background:c, borderRadius:3, cursor:'pointer',
                            border: selEl.color === c ? '2px solid #4a90d9' : '1px solid #444',
                            outline: c === '#ffffff' ? '1px solid #555' : 'none' }} />
                      ))}
                    </div>
                    <input type="color" value={selEl.color} onChange={e => commitUpdate(selEl.id, { color: e.target.value })}
                      style={{ width:'100%', height:28, border:'none', background:'none', cursor:'pointer', borderRadius:4 }} />
                  </div>
                </PropSection>
              )}

              {(selEl.type === 'rect' || selEl.type === 'circle' || selEl.type === 'line') && (
                <PropSection label="Fill">
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:6 }}>
                    {COLORS.map(c => (
                      <div key={c} onClick={() => commitUpdate(selEl.id, { color: c })}
                        style={{ width:20, height:20, background:c, borderRadius:3, cursor:'pointer',
                          border: selEl.color === c ? '2px solid #4a90d9' : '1px solid #444',
                          outline: c === '#ffffff' ? '1px solid #555' : 'none' }} />
                    ))}
                  </div>
                  <input type="color" value={selEl.color} onChange={e => commitUpdate(selEl.id, { color: e.target.value })}
                    style={{ width:'100%', height:28, border:'none', background:'none', cursor:'pointer', borderRadius:4 }} />
                  {selEl.type === 'rect' && (
                    <PropRow label="Radius"><NumInput value={selEl.borderRadius ?? 0} onChange={v => commitUpdate(selEl.id, { borderRadius: v })} min={0} max={200} /></PropRow>
                  )}
                  {selEl.type === 'line' && (
                    <PropRow label="Thickness"><NumInput value={selEl.thickness ?? 2} onChange={v => commitUpdate(selEl.id, { thickness: v })} min={1} max={40} /></PropRow>
                  )}
                </PropSection>
              )}

              {selEl.type === 'image' && (
                <PropSection label="Image">
                  <div style={{ marginBottom:8 }}>
                    <label style={labelStyle}>Object Fit</label>
                    <select value={selEl.objectFit ?? 'cover'} onChange={e => commitUpdate(selEl.id, { objectFit: e.target.value })} style={selectStyle}>
                      {['cover','contain','fill','none'].map(v => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </div>
                  <PropRow label="Radius"><NumInput value={selEl.borderRadius ?? 0} onChange={v => commitUpdate(selEl.id, { borderRadius: v })} min={0} max={400} /></PropRow>
                  {portfolioImages.length > 0 && (
                    <div>
                      <label style={{ ...labelStyle, marginTop:8 }}>Replace image</label>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
                        {portfolioImages.map((img, i) => (
                          <div key={i} onClick={() => commitUpdate(selEl.id, { src: img.src })}
                            style={{ borderRadius:4, overflow:'hidden', cursor:'pointer',
                              border: selEl.src === img.src ? '2px solid #4a90d9' : '2px solid transparent' }}>
                            <img src={img.src} alt="" style={{ width:'100%', height:48, objectFit:'cover', display:'block' }} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </PropSection>
              )}

              <PropSection label="Layer Order">
                <div style={{ display:'flex', gap:5 }}>
                  {[
                    { icon:<ArrowUp size={12}/>, label:'Fwd', action: () => commitUpdate(selEl.id, { zIndex: selEl.zIndex + 1 }) },
                    { icon:<ArrowDown size={12}/>, label:'Back', action: () => commitUpdate(selEl.id, { zIndex: Math.max(1, selEl.zIndex - 1) }) },
                    { icon:<ChevronsUp size={12}/>, label:'Top', action: () => commitUpdate(selEl.id, { zIndex: (elements.length ? Math.max(...elements.map(e => e.zIndex)) : 0) + 1 }) },
                    { icon:<ChevronsDown size={12}/>, label:'Bot', action: () => commitUpdate(selEl.id, { zIndex: 0 }) },
                  ].map(b => (
                    <button key={b.label} onClick={b.action} style={{ flex:1, background:'#2e2e32', border:'1px solid #3a3a3e', color:'#bbb', cursor:'pointer', borderRadius:5, padding:'5px 2px', fontSize:10, display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
                      {b.icon}
                      <span>{b.label}</span>
                    </button>
                  ))}
                </div>
              </PropSection>

              <button onClick={deleteSelected}
                style={{ width:'100%', background:'#2a1215', border:'1px solid #c0392b', color:'#e74c3c', cursor:'pointer', borderRadius:6, padding:'8px', fontSize:13, marginTop:4, display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
                <Trash2 size={14} />
                Delete Element
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Status bar ── */}
      <div style={{ height:26, background:'#1a1a1e', borderTop:'1px solid #2e2e32', display:'flex', alignItems:'center', padding:'0 16px', gap:20, fontSize:11, color:'#555', flexShrink:0 }}>
        <span>{elements.length} element{elements.length !== 1 ? 's' : ''}</span>
        {selEl && <span>{selEl.type} · {Math.round(selEl.x)},{Math.round(selEl.y)} · {Math.round(selEl.w)}×{Math.round(selEl.h)}</span>}
        <span style={{ color: statusMsg.includes('failed') || statusMsg.includes('error') ? '#e74c3c' : statusMsg.includes('Published') || statusMsg.includes('Saved') ? '#2ecc71' : '#555' }}>
          {statusMsg}
        </span>
        <span style={{ marginLeft:'auto' }}>Double-click text to edit · Arrow keys to nudge · Del to remove · ⌘Z undo</span>
      </div>
    </div>
  );
}

async function bootstrap() {
  try {
    await loadAuth();
  } catch {}
  createRoot(document.getElementById('root')).render(<PortfolioEditor />);
}

bootstrap();

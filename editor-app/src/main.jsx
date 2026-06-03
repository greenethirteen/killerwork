import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Check,
  ExternalLink,
  Home,
  Italic,
  Loader2,
  Paperclip,
  Redo2,
  Save,
  Undo2,
  Wand2,
  X
} from 'lucide-react';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const initialJobId = params.get('job') || localStorage.getItem('killerwork:lastJobId') || '';
const initialPagePath = params.get('path') || '';

function previewUrl(jobId, path = 'index.html') {
  return `/generated/${encodeURIComponent(jobId)}/site/${path}?v=${Date.now()}`;
}

function publicPreviewUrl(jobId, path = 'index.html') {
  return `/generated/${encodeURIComponent(jobId)}/site/${path}`;
}

async function loadAuth() {
  if (!window.KillerWorkAuth) await import(/* @vite-ignore */ '/auth.js?v=20260602-gtm');
  return window.KillerWorkAuth;
}

async function api(path, options = {}) {
  const auth = await loadAuth();
  let token = await auth.currentToken();
  if (!token && options.interactiveAuth) token = await auth.requireToken();
  if (!token) throw new Error('Sign in to edit this portfolio.');
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 402 && data.code === 'subscription_required') {
    const checkoutRes = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const checkout = await checkoutRes.json().catch(() => ({}));
    if (checkoutRes.ok && checkout.url) window.location.assign(checkout.url);
    throw new Error(checkout.error || data.error || 'Subscribe to publish your portfolio.');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function fileLabel(path) {
  if (path === 'index.html') return 'Home';
  if (path === 'about.html') return 'About';
  return path
    .replace(/\/index\.html?$/i, '')
    .split('/')
    .pop()
    .replace(/^behance[-_ ]+\d+[-_ ]*/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function pageLabel(page) {
  const title = String(page?.title || '').replace(/^behance[-_ ]+\d+[-_ ]*/i, '').trim();
  const label = title || fileLabel(page.path);
  if (/[A-Z]/.test(label)) return label;
  return label.replace(/\b\w/g, letter => letter.toUpperCase());
}

function aiResultMessage(data = {}) {
  const lines = [data.message || 'Done.'];
  if (Array.isArray(data.details) && data.details.length) {
    lines.push('', ...data.details.map(detail => `- ${detail}`));
  } else if (data.changedFiles?.length) {
    lines.push('', `Changed: ${data.changedFiles.join(', ')}`);
  }
  const validation = data.validationSummary;
  if (validation && !data.details?.some?.(detail => String(detail).includes('validation'))) {
    lines.push(validation.ok
      ? 'Validation: passed.'
      : `Validation: ${validation.errorCount || 0} issue${validation.errorCount === 1 ? '' : 's'} found.`);
  }
  if (validation?.errors?.length) {
    lines.push(...validation.errors.slice(0, 3).map(item => `  ${item.file || 'site'}: ${item.error}${item.ref ? ` (${item.ref})` : ''}`));
  }
  return lines.join('\n');
}

function App() {
  const [jobId] = React.useState(initialJobId);
  const [site, setSite] = React.useState(null);
  const [pages, setPages] = React.useState([]);
  const [files, setFiles] = React.useState([]);
  const [selectedPage, setSelectedPage] = React.useState(initialPagePath || 'index.html');
  const [selectedFile, setSelectedFile] = React.useState(initialPagePath || 'index.html');
  const [fileContent, setFileContent] = React.useState('');
  const [previewSrc, setPreviewSrc] = React.useState('');
  const [prompt, setPrompt] = React.useState('');
  const [attachments, setAttachments] = React.useState([]);
  const [messages, setMessages] = React.useState([]);
  const [busy, setBusy] = React.useState('Loading editor...');
  const [status, setStatus] = React.useState('');
  const [previewRefreshing, setPreviewRefreshing] = React.useState(false);
  const [history, setHistory] = React.useState({ undoCount: 0, redoCount: 0 });
  const [textEditMode, setTextEditMode] = React.useState(false);
  const [textTarget, setTextTarget] = React.useState(null);
  const [textSize, setTextSize] = React.useState(16);
  const [textFont, setTextFont] = React.useState('Inter');
  const [textAlign, setTextAlign] = React.useState('left');
  const [textBold, setTextBold] = React.useState(false);
  const [textItalic, setTextItalic] = React.useState(false);
  const [toolbarPosition, setToolbarPosition] = React.useState({ left: 16, top: 70 });
  const fileInputRef = React.useRef(null);
  const chatRef = React.useRef(null);
  const previewRef = React.useRef(null);
  const toolbarRef = React.useRef(null);
  const textEditModeRef = React.useRef(false);

  const pageOptions = (pages.length ? pages : [{ path: 'index.html', title: 'Home', preview: publicPreviewUrl(jobId) }])
    .filter(page => page.path !== 'import-review.html')
    .map(page => ({ ...page, title: pageLabel(page) }));

  React.useEffect(() => {
    if (!jobId) {
      setBusy('');
      setStatus('Missing portfolio id. Open this from Manage projects.');
      return;
    }
    loadSite();
  }, [jobId]);

  React.useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function loadSite(nextFile = selectedFile) {
    setBusy('Loading site files...');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/site`);
      setSite(data);
      setFiles(data.files || []);
      setPages(data.pages || []);
      setHistory(data.history || { undoCount: 0, redoCount: 0 });
      const page = initialPagePath || nextFile || data.pages?.[0]?.path || 'index.html';
      await openFile(page, data.pages || []);
      setBusy('');
      setStatus('Ready.');
    } catch (err) {
      setBusy('');
      setStatus(err.message || 'Could not load editor.');
    }
  }

  async function openFile(path, knownPages = pages) {
    const cleanPath = path || 'index.html';
    setTextTarget(null);
    setSelectedFile(cleanPath);
    const matchingPage = knownPages.find(page => page.path === cleanPath);
    if (matchingPage) setSelectedPage(cleanPath);
    setPreviewSrc(previewUrl(jobId, matchingPage?.path || selectedPage || cleanPath));
    if (!/\.(html?|css|js|mjs|json|txt|md|svg|xml|webmanifest)$/i.test(cleanPath)) {
      setFileContent('Binary asset preview. Ask AI to use this file, or open a text file to edit code.');
      return;
    }
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(cleanPath)}`);
      setFileContent(data.content || '');
    } catch (err) {
      setFileContent(`/* ${err.message || 'Could not open file.'} */`);
    }
  }

  function refreshPreview(path = selectedPage) {
    setPreviewRefreshing(true);
    setPreviewSrc(previewUrl(jobId, path || 'index.html'));
  }

  function syncPageFromPreview(frame) {
    try {
      const pathname = frame.contentWindow?.location?.pathname || '';
      const marker = `/generated/${jobId}/site/`;
      const index = pathname.indexOf(marker);
      if (index < 0) return;
      const path = decodeURIComponent(pathname.slice(index + marker.length)) || 'index.html';
      const normalized = path.endsWith('/') ? `${path}index.html` : path;
      const match = pageOptions.find(page => page.path === normalized);
      if (!match || match.path === selectedPage) return;
      setSelectedPage(match.path);
      setSelectedFile(match.path);
      void openFile(match.path, pageOptions);
      const url = new URL(window.location.href);
      url.searchParams.set('job', jobId);
      url.searchParams.set('path', match.path);
      window.history.replaceState(null, '', url);
    } catch {}
  }

  async function saveFile() {
    setBusy('Saving file...');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: selectedFile, content: fileContent })
      });
      setHistory(data.history || history);
      refreshPreview();
      addMessage('ai', `Saved ${selectedFile}.`);
      setStatus('Saved.');
    } catch (err) {
      setStatus(err.message || 'Save failed.');
    } finally {
      setBusy('');
    }
  }

  function addMessage(role, text) {
    setMessages(current => [...current, { role, text }]);
  }

  async function runAiEdit(event) {
    event?.preventDefault();
    if (!prompt.trim() && !attachments.length) {
      setStatus('Write a prompt or attach files first.');
      return;
    }
    const userText = prompt.trim() || 'Use the uploaded files on this page.';
    addMessage('user', attachments.length ? `${userText}\n\nAttached: ${attachments.length} file${attachments.length === 1 ? '' : 's'}.` : userText);
    setPrompt('');
    setBusy('KillaWork AI is editing files...');
    setStatus('Applying code-level edit...');
    try {
      const body = new FormData();
      body.append('prompt', userText);
      body.append('pagePath', selectedPage || 'index.html');
      body.append('contextPaths', JSON.stringify([selectedFile, selectedPage, 'styles.css', 'portfolio.css', 'portfolio.js'].filter(Boolean)));
      attachments.forEach(file => body.append('files', file));
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/ai-edit`, { method: 'POST', body });
      setFiles(data.files || files);
      setPages(data.pages || pages);
      setHistory(data.history || history);
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      addMessage('ai', aiResultMessage(data));
      const createdPage = data.operations?.find(operation => operation?.op === 'createFile' && /\.html?$/i.test(operation.path || ''))?.path;
      const changedPage = createdPage || data.changedFiles?.find(path => /\.html?$/i.test(path));
      const nextFile = data.changedFiles?.find(path => path === selectedFile) || changedPage || selectedFile;
      await openFile(nextFile, data.pages || pages);
      refreshPreview(changedPage || selectedPage);
      setStatus(data.validationSummary?.ok === false ? 'Edit applied. Validation found issues.' : 'Edit applied and validated.');
    } catch (err) {
      addMessage('ai', err.message || 'AI edit failed.');
      setStatus(err.message || 'AI edit failed.');
    } finally {
      setBusy('');
    }
  }

  async function snapshotAction(action) {
    setBusy(action === 'undo' ? 'Undoing...' : 'Redoing...');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/${action}`, { method: 'POST' });
      setFiles(data.files || files);
      setPages(data.pages || pages);
      setHistory({ undoCount: data.undoCount || 0, redoCount: data.redoCount || 0 });
      await openFile(selectedFile, data.pages || pages);
      refreshPreview(selectedPage);
      addMessage('ai', action === 'undo' ? 'Undid the last file edit.' : 'Redid the file edit.');
      setStatus(action === 'undo' ? 'Undo complete.' : 'Redo complete.');
    } catch (err) {
      setStatus(err.message || `${action} failed.`);
    } finally {
      setBusy('');
    }
  }

  function choosePage(path) {
    setSelectedPage(path);
    openFile(path);
    const url = new URL(window.location.href);
    url.searchParams.set('job', jobId);
    url.searchParams.set('path', path);
    window.history.replaceState(null, '', url);
  }

  function editableTextNodes(doc) {
    const selector = 'h1,h2,h3,h4,h5,h6,p,span,li,a,figcaption,small,strong,em,b,i,div,td,th,blockquote';
    return [...doc.querySelectorAll(selector)].filter(node => {
      if (!node.textContent.trim()) return false;
      const linkedMedia = node.closest('a[href], [data-url]');
      if (linkedMedia?.querySelector('img, picture, video')) return false;
      if (node.closest('.work-card')) return false;
      return ![...node.children].some(child => child.matches(selector) && child.textContent.trim());
    });
  }

  function applyTextEditingState(enabled) {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    let styleTag = doc.getElementById('kw-inline-edit-style');
    if (!styleTag) {
      styleTag = doc.createElement('style');
      styleTag.id = 'kw-inline-edit-style';
      styleTag.textContent = '.kw-inline-editable{outline:1px dashed rgba(123,223,242,.45);outline-offset:2px;cursor:text} .kw-inline-editable:focus,.kw-inline-text-selected{outline:2px solid rgba(255,209,102,.82);outline-offset:3px}';
      doc.head.appendChild(styleTag);
    }
    editableTextNodes(doc).forEach(node => {
      if (enabled) {
        node.setAttribute('contenteditable', 'plaintext-only');
        node.classList.add('kw-inline-editable');
      } else {
        node.removeAttribute('contenteditable');
        node.classList.remove('kw-inline-editable');
        node.classList.remove('kw-inline-text-selected');
      }
    });
  }

  React.useEffect(() => {
    textEditModeRef.current = textEditMode;
    applyTextEditingState(textEditMode);
    if (!textEditMode) setTextTarget(null);
  }, [textEditMode, previewSrc]);

  React.useEffect(() => {
    const exitOnEscape = event => {
      if (event.key === 'Escape') exitTextEditing();
    };
    window.addEventListener('keydown', exitOnEscape);
    return () => window.removeEventListener('keydown', exitOnEscape);
  }, []);

  React.useEffect(() => {
    if (!textTarget) return;
    const computed = window.getComputedStyle(textTarget);
    const size = parseInt(computed.fontSize, 10);
    if (Number.isFinite(size)) setTextSize(size);
    setTextFont((computed.fontFamily || 'Inter').split(',')[0].replace(/["']/g, '').trim() || 'Inter');
    setTextAlign(computed.textAlign || 'left');
    setTextBold(Number.parseInt(computed.fontWeight, 10) >= 600);
    setTextItalic(computed.fontStyle === 'italic');
    requestAnimationFrame(() => positionToolbar(textTarget));
  }, [textTarget]);

  function positionToolbar(target) {
    const frame = previewRef.current;
    const workspace = frame?.parentElement;
    if (!frame || !workspace || !target) return;
    const frameRect = frame.getBoundingClientRect();
    const workspaceRect = workspace.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const toolbarWidth = toolbarRef.current?.offsetWidth || 470;
    const toolbarHeight = toolbarRef.current?.offsetHeight || 56;
    const left = Math.max(12, Math.min(
      frameRect.left - workspaceRect.left + targetRect.left,
      workspaceRect.width - toolbarWidth - 12
    ));
    const belowTarget = frameRect.top - workspaceRect.top + targetRect.bottom + 10;
    const aboveTarget = frameRect.top - workspaceRect.top + targetRect.top - toolbarHeight - 10;
    const top = belowTarget + toolbarHeight > workspaceRect.height - 12
      ? Math.max(70, aboveTarget)
      : Math.max(70, belowTarget);
    setToolbarPosition({ left, top });
  }

  function handlePreviewClick(event) {
    if (!textEditModeRef.current) return;
    const target = event.target;
    if (!target || target.nodeType !== 1 || !target.matches('.kw-inline-editable')) return;
    event.preventDefault();
    event.stopPropagation();
    textTarget?.classList.remove('kw-inline-text-selected');
    target.classList.add('kw-inline-text-selected');
    setTextTarget(target);
    positionToolbar(target);
  }

  function handlePreviewKeyDown(event) {
    if (event.key === 'Escape') exitTextEditing();
  }

  function exitTextEditing() {
    textTarget?.classList.remove('kw-inline-text-selected');
    setTextTarget(null);
    setTextEditMode(false);
  }

  function applyTextStyle(style, value) {
    if (!textTarget) return;
    textTarget.style[style] = value;
  }

  function toggleBold() {
    const next = !textBold;
    setTextBold(next);
    applyTextStyle('fontWeight', next ? '700' : '400');
  }

  function toggleItalic() {
    const next = !textItalic;
    setTextItalic(next);
    applyTextStyle('fontStyle', next ? 'italic' : 'normal');
  }

  function applyTextAlignment(alignment) {
    setTextAlign(alignment);
    applyTextStyle('textAlign', alignment);
  }

  async function saveInlineTextEdits() {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    const cleanRoot = doc.documentElement.cloneNode(true);
    cleanRoot.querySelector('#kw-inline-edit-style')?.remove();
    cleanRoot.querySelectorAll('.kw-inline-editable').forEach(node => {
      node.classList.remove('kw-inline-editable');
      node.classList.remove('kw-inline-text-selected');
      node.removeAttribute('contenteditable');
      if (!node.className) node.removeAttribute('class');
    });
    const html = `<!doctype html>\n${cleanRoot.outerHTML}`;
    setFileContent(html);
    setBusy('Saving inline text edits...');
    try {
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path: selectedPage || 'index.html', content: html })
      });
      setHistory(data.history || history);
      setStatus('Inline text edits saved.');
      addMessage('ai', `Saved inline text edits to ${selectedPage}.`);
    } catch (err) {
      setStatus(err.message || 'Could not save inline text edits.');
    } finally {
      setBusy('');
      refreshPreview(selectedPage);
    }
  }

  if (!jobId) {
    return (
      <main className="empty-state">
        <h1>KillaWork™ AI Editor</h1>
        <p>Missing portfolio id. Open the editor from Manage projects.</p>
        <a href="/manage.html">Manage projects</a>
      </main>
    );
  }

  return (
    <main className="kw-editor">
      <aside className="sidebar">
        <header className="brand-row">
          <a className="home-button" href="/manage.html" title="Manage projects"><Home size={22} /></a>
          <div>
            <span>KillaWork™ AI</span>
            <strong>Code editor</strong>
          </div>
        </header>

        <section className="page-picker">
          <label>Page</label>
          <select value={selectedPage} onChange={event => choosePage(event.target.value)}>
            {pageOptions.map(page => (
              <option key={page.path} value={page.path}>{page.title}</option>
            ))}
          </select>
        </section>

        <div className="action-grid">
          <button type="button" onClick={() => snapshotAction('undo')} disabled={!history.undoCount || !!busy} title="Undo"><Undo2 size={18} /></button>
          <button type="button" onClick={() => snapshotAction('redo')} disabled={!history.redoCount || !!busy} title="Redo"><Redo2 size={18} /></button>
          <button type="button" onClick={saveFile} disabled={!!busy} title="Save file"><Save size={18} /></button>
          <button className="text-edit-toggle" type="button" onClick={() => setTextEditMode(value => !value)} title="Edit text">{textEditMode ? 'Editing Text' : 'Edit Text'}</button>
          <a href={publicPreviewUrl(jobId, selectedPage)} target="_blank" rel="noreferrer" title="Open preview"><ExternalLink size={18} /></a>
        </div>

        {textEditMode && (
          <div className="inline-edit-actions">
            <button type="button" onClick={saveInlineTextEdits} disabled={!!busy}><Save size={14} /> Save text</button>
            <button type="button" onClick={exitTextEditing} title="Exit text editing"><X size={15} /></button>
          </div>
        )}

        <section ref={chatRef} className="chat-log">
          {messages.map((message, index) => (
            <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
              <span>{message.role === 'user' ? 'You' : 'KillaWork™ AI'}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </section>

        <form className="prompt-form" onSubmit={runAiEdit}>
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="Describe the change you want AI to make."
          />
          {!!attachments.length && (
            <div className="attachments">
              {attachments.map(file => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
            </div>
          )}
          <div className="prompt-actions">
            <input ref={fileInputRef} type="file" multiple onChange={event => setAttachments([...event.target.files])} />
            <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach files"><Paperclip size={18} /></button>
            <button type="submit" disabled={!!busy}><Wand2 size={18} /> Make Changes</button>
          </div>
        </form>
      </aside>

      <section className="workspace">
        <div className="workspace-top">
          <div>
            <span>Live preview</span>
            <strong>{site?.siteTitle || 'Portfolio'}</strong>
          </div>
          <div className="status-line">{busy ? <><Loader2 className="spin" size={16} /> {busy}</> : <><Check size={16} /> {status || 'Ready'}</>}</div>
        </div>
        {previewRefreshing && (
          <div className="preview-refresh-overlay" aria-live="polite">
            <div className="refresh-orb"><Wand2 size={26} /></div>
            <strong>Applying changes</strong>
            <span>Refreshing the live preview</span>
          </div>
        )}
        {textEditMode && textTarget && (
          <div ref={toolbarRef} className="inline-text-toolbar" style={toolbarPosition}>
            <select value={textFont} onChange={event => { setTextFont(event.target.value); applyTextStyle('fontFamily', event.target.value); }}>
              <option value="Inter">Inter</option>
              <option value="Arial">Arial</option>
              <option value="Helvetica Neue">Helvetica Neue</option>
              <option value="Georgia">Georgia</option>
            </select>
            <input type="number" min="10" max="160" value={textSize} onChange={event => {
              const size = Math.max(10, Math.min(160, Number(event.target.value) || 16));
              setTextSize(size);
              applyTextStyle('fontSize', `${size}px`);
            }} />
            <button className={textBold ? 'active' : ''} type="button" onClick={toggleBold} title="Bold"><Bold size={16} /></button>
            <button className={textItalic ? 'active' : ''} type="button" onClick={toggleItalic} title="Italic"><Italic size={16} /></button>
            <span className="toolbar-divider" />
            <button className={textAlign === 'left' ? 'active' : ''} type="button" onClick={() => applyTextAlignment('left')} title="Align left"><AlignLeft size={16} /></button>
            <button className={textAlign === 'center' ? 'active' : ''} type="button" onClick={() => applyTextAlignment('center')} title="Align center"><AlignCenter size={16} /></button>
            <button className={textAlign === 'right' ? 'active' : ''} type="button" onClick={() => applyTextAlignment('right')} title="Align right"><AlignRight size={16} /></button>
            <span className="toolbar-divider" />
            <button type="button" onClick={exitTextEditing} title="Exit text editing"><X size={16} /></button>
          </div>
        )}
        <iframe
          ref={previewRef}
          className={`preview${previewRefreshing ? ' is-refreshing' : ''}`}
          src={previewSrc || previewUrl(jobId, selectedPage)}
          title="Live portfolio preview"
          onLoad={(event) => {
            applyTextEditingState(textEditMode);
            try {
              event.currentTarget.contentDocument?.addEventListener('click', handlePreviewClick);
              event.currentTarget.contentDocument?.addEventListener('keydown', handlePreviewKeyDown);
            } catch {}
            syncPageFromPreview(event.currentTarget);
            if (previewRefreshing) setTimeout(() => setPreviewRefreshing(false), 420);
          }}
        />
      </section>
    </main>
  );
}

async function bootstrap() {
  try {
    await loadAuth();
  } catch {}
  createRoot(document.getElementById('root')).render(<App />);
}

bootstrap();

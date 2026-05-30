import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Check,
  ExternalLink,
  FileText,
  FolderPlus,
  Home,
  Loader2,
  Paperclip,
  Redo2,
  Rocket,
  Save,
  Undo2,
  Wand2
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
  if (!window.KillerWorkAuth) await import(/* @vite-ignore */ '/auth.js?v=20260524-popup');
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
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function fileLabel(path) {
  if (path === 'index.html') return 'Home';
  return path.replace(/\/index\.html?$/i, '').split('/').pop().replace(/[-_]+/g, ' ');
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
  const [messages, setMessages] = React.useState([
    { role: 'ai', text: 'I edit the actual HTML, CSS, JS, and assets in this generated site. Tell me what to change, or upload work and ask me to build a new page.' }
  ]);
  const [busy, setBusy] = React.useState('Loading editor...');
  const [status, setStatus] = React.useState('');
  const [previewRefreshing, setPreviewRefreshing] = React.useState(false);
  const [history, setHistory] = React.useState({ undoCount: 0, redoCount: 0 });
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [subdomain, setSubdomain] = React.useState('');
  const fileInputRef = React.useRef(null);
  const chatRef = React.useRef(null);

  const pageOptions = pages.length ? pages : [{ path: 'index.html', title: 'Home', preview: publicPreviewUrl(jobId) }];

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
      body.append('contextPaths', JSON.stringify([selectedFile, selectedPage, 'styles.css'].filter(Boolean)));
      attachments.forEach(file => body.append('files', file));
      const data = await api(`/api/code-editor/${encodeURIComponent(jobId)}/ai-edit`, { method: 'POST', body });
      setFiles(data.files || files);
      setPages(data.pages || pages);
      setHistory(data.history || history);
      setAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      addMessage('ai', `${data.message || 'Done.'}${data.changedFiles?.length ? `\n\nChanged: ${data.changedFiles.join(', ')}` : ''}`);
      await openFile(data.changedFiles?.find(path => path === selectedFile) || selectedFile, data.pages || pages);
      refreshPreview(selectedPage);
      setStatus('Edit applied.');
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

  async function publish() {
    const clean = subdomain.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) return setStatus('Choose a subdomain first.');
    setBusy('Publishing...');
    try {
      const data = await api(`/api/publish/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        body: JSON.stringify({ subdomain: clean })
      });
      setSite(current => ({ ...(current || {}), published: data.published }));
      setPublishOpen(false);
      addMessage('ai', `Published at ${data.published.url}.`);
      setStatus('Published.');
    } catch (err) {
      setStatus(err.message || 'Publish failed.');
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
          <div className="select-row">
            <select value={selectedPage} onChange={event => choosePage(event.target.value)}>
              {pageOptions.map(page => (
                <option key={page.path} value={page.path}>{page.title || fileLabel(page.path)}</option>
              ))}
            </select>
            <button type="button" title="Create page with AI" onClick={() => setPrompt('Create a new campaign page using the files I upload. Match the portfolio style and add it to the site navigation.')}>
              <FolderPlus size={19} />
            </button>
          </div>
        </section>

        <div className="action-grid">
          <button type="button" onClick={() => snapshotAction('undo')} disabled={!history.undoCount || !!busy} title="Undo"><Undo2 size={18} /></button>
          <button type="button" onClick={() => snapshotAction('redo')} disabled={!history.redoCount || !!busy} title="Redo"><Redo2 size={18} /></button>
          <button type="button" onClick={saveFile} disabled={!!busy} title="Save file"><Save size={18} /></button>
          <button type="button" onClick={() => setPublishOpen(value => !value)} title="Publish"><Rocket size={18} /></button>
          <a href={publicPreviewUrl(jobId, selectedPage)} target="_blank" rel="noreferrer" title="Open preview"><ExternalLink size={18} /></a>
        </div>

        {publishOpen && (
          <section className="publish-box">
            <label>Portfolio URL</label>
            <div className="publish-input">
              <input value={subdomain} onChange={event => setSubdomain(event.target.value)} placeholder="abdullahfarouk" />
              <span>.killa.work</span>
            </div>
            <button type="button" onClick={publish}>Publish</button>
            <p>Need help? <a href="https://wa.me/971585002138" target="_blank" rel="noreferrer">Contact the Founder.</a></p>
          </section>
        )}

        <section ref={chatRef} className="chat-log">
          {messages.map((message, index) => (
            <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
              <span>{message.role === 'user' ? 'You' : 'KillaWork™ AI'}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </section>

        <section className="file-editor">
          <header>
            <span><FileText size={14} /> Text editor</span>
            <strong>{selectedFile}</strong>
          </header>
          <textarea
            value={fileContent}
            onChange={event => setFileContent(event.target.value)}
            spellCheck="false"
          />
          <button type="button" onClick={saveFile} disabled={!!busy || !/\.(html?|css|js|mjs|json|txt|md|svg|xml|webmanifest)$/i.test(selectedFile)}>
            Save text changes
          </button>
        </section>

        <form className="prompt-form" onSubmit={runAiEdit}>
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="Ask for copy, structure, title, ordering, styling, new pages, new sections, or uploaded work to be added directly into the site files."
          />
          {!!attachments.length && (
            <div className="attachments">
              {attachments.map(file => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
            </div>
          )}
          <div className="prompt-actions">
            <input ref={fileInputRef} type="file" multiple onChange={event => setAttachments([...event.target.files])} />
            <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach files"><Paperclip size={18} /></button>
            <button type="submit" disabled={!!busy}><Wand2 size={18} /> Generate edit</button>
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
        <iframe
          className={`preview${previewRefreshing ? ' is-refreshing' : ''}`}
          src={previewSrc || previewUrl(jobId, selectedPage)}
          title="Live portfolio preview"
          onLoad={(event) => {
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

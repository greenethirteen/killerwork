import { setupPublishControl } from './publish.js?v=20260620-namecheck';

const params = new URLSearchParams(location.search);
const jobId = params.get('job');
if (jobId) localStorage.setItem('killerwork:lastJobId', jobId);
const pageList = document.getElementById('pageList');
const titleInput = document.getElementById('titleInput');
const pagePreview = document.getElementById('pagePreview');
const undoEdit = document.getElementById('undoEdit');
const redoEdit = document.getElementById('redoEdit');
const savePage = document.getElementById('savePage');
const statusBox = document.getElementById('editorStatus');
const blockEditor = document.getElementById('blockEditor');
const canvasHeadline = document.getElementById('canvasHeadline');
const managePortfolio = document.getElementById('managePortfolio');
const inspector = document.getElementById('inspector');
const mediaUpload = document.getElementById('mediaUpload');
const addTextBlock = document.getElementById('addTextBlock');
const addImageBlock = document.getElementById('addImageBlock');
const addVideoBlock = document.getElementById('addVideoBlock');
const addAudioBlock = document.getElementById('addAudioBlock');
const addPdfBlock = document.getElementById('addPdfBlock');
const addSliderBlock = document.getElementById('addSliderBlock');
const videoChoiceModal = document.getElementById('videoChoiceModal');
const magicEditForm = document.getElementById('magicEditForm');
const magicPrompt = document.getElementById('magicPrompt');
const magicFiles = document.getElementById('magicFiles');
const magicApply = document.getElementById('magicApply');
const magicUploadLabel = document.getElementById('magicUploadLabel');
const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => jobId,
  setStatus
});

let currentSlug = '';
let currentPage = null;
let pages = [];
let selectedIndex = -1;
let draggedIndex = -1;
let dirty = false;
let pendingUploadMode = 'insert';
let pendingGalleryIndex = -1;
let undoStack = [];
let redoStack = [];
let restoringHistory = false;
let loadPageSeq = 0;

async function authHeaders() {
  const token = await window.KillerWorkAuth.requireToken();
  return { Authorization: `Bearer ${token}` };
}

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.dataset.tone = tone;
  statusBox.classList.toggle('hidden', !tone);
}

function setDirty(value = true) {
  dirty = value;
  savePage.dataset.dirty = dirty ? 'true' : '';
  const saveState = savePage.querySelector('[data-save-state]');
  if (saveState) saveState.textContent = dirty ? 'Unsaved changes' : 'Saved';
}

function pageSnapshot() {
  return currentPage ? JSON.stringify(currentPage) : '';
}

function updateHistoryButtons() {
  if (undoEdit) undoEdit.disabled = !undoStack.length;
  if (redoEdit) redoEdit.disabled = !redoStack.length;
}

function recordHistory() {
  if (!currentPage || restoringHistory) return;
  const snapshot = pageSnapshot();
  if (!snapshot || undoStack[undoStack.length - 1] === snapshot) return;
  undoStack.push(snapshot);
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateHistoryButtons();
}

function restoreHistory(snapshot) {
  if (!snapshot) return;
  restoringHistory = true;
  currentPage = JSON.parse(snapshot);
  currentPage.contentItems = currentPage.contentItems || [];
  titleInput.value = currentPage.title || '';
  selectedIndex = Math.max(-1, Math.min(selectedIndex, currentPage.contentItems.length - 1));
  setDirty(true);
  renderCanvas();
  renderInspector();
  updateHistoryButtons();
  restoringHistory = false;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mediaLabel(item) {
  if (item.type === 'home-card') return item.title || 'Project thumbnail';
  if (item.type === 'image') return `Image ${Number(item.imageIndex) + 1}`;
  if (item.type === 'video') return `Video ${Number(item.videoIndex) + 1}`;
  if (item.type === 'audio') return `Audio ${Number(item.audioIndex) + 1}`;
  if (item.type === 'document') return `PDF ${Number(item.documentIndex) + 1}`;
  if (item.type === 'gallery') return `Slider (${(item.imageIndexes || []).length})`;
  return 'Text';
}

function makeTextBlock(text = '') {
  return { type: 'text', order: 0, tag: 'p', text };
}

function assetUrl(asset) {
  if (!asset?.src) return '';
  if (/^https?:\/\//i.test(asset.src)) return asset.src;
  const cleanSrc = asset.src.replace(/^\/+/, '');
  return `/generated/${encodeURIComponent(jobId)}/site/${cleanSrc}`;
}

function imageAsset(item) {
  return currentPage?.images?.[item.imageIndex] || null;
}

function videoAsset(item) {
  return currentPage?.videos?.[item.videoIndex] || null;
}

function documentAsset(item) {
  return currentPage?.documents?.[item.documentIndex] || null;
}

function audioAsset(item) {
  return currentPage?.audios?.[item.audioIndex] || null;
}

function compatibleItemFor(kind) {
  if (kind === 'image') return { type: 'image', order: 0, imageIndex: 0 };
  if (kind === 'video') return { type: 'video', order: 0, videoIndex: 0 };
  if (kind === 'audio') return { type: 'audio', order: 0, audioIndex: 0 };
  return { type: 'document', order: 0, documentIndex: 0 };
}

function normalizeEmbedUrl(rawUrl, source = '') {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (/youtu\.be$/i.test(url.hostname)) return `https://www.youtube.com/embed/${url.pathname.replace(/^\/+/, '')}`;
    if (/youtube\.com$/i.test(url.hostname) || /youtube-nocookie\.com$/i.test(url.hostname)) {
      const id = url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?#]+)/)?.[1];
      if (id) return `https://www.youtube.com/embed/${id}`;
    }
    if (/vimeo\.com$/i.test(url.hostname) || /player\.vimeo\.com$/i.test(url.hostname)) {
      const id = url.pathname.match(/(?:video\/)?(\d+)/)?.[1];
      if (id) return `https://player.vimeo.com/video/${id}`;
    }
    return '';
  } catch {
    return '';
  }
}

function selectBlock(index) {
  selectedIndex = index;
  renderCanvas();
  renderInspector();
}

function isEditorControl(target) {
  return !!target?.closest?.('button,input,textarea,select,label,.text-style-toolbar');
}

function reorderBlock(from, to) {
  if (!currentPage || from === to || from < 0 || to < 0 || from >= currentPage.contentItems.length || to >= currentPage.contentItems.length) return;
  recordHistory();
  const [item] = currentPage.contentItems.splice(from, 1);
  currentPage.contentItems.splice(to, 0, item);
  selectedIndex = to;
  setDirty();
  renderCanvas();
  renderInspector();
}

function deleteBlock(index) {
  if (!currentPage || index < 0) return;
  recordHistory();
  currentPage.contentItems.splice(index, 1);
  selectedIndex = Math.min(index, currentPage.contentItems.length - 1);
  setDirty();
  renderCanvas();
  renderInspector();
}

function insertBlock(item, index = 0) {
  if (!currentPage) return;
  recordHistory();
  const safeIndex = Math.max(0, Math.min(index, currentPage.contentItems.length));
  currentPage.contentItems.splice(safeIndex, 0, item);
  selectedIndex = safeIndex;
  setDirty();
  renderCanvas();
  renderInspector();
}

function insertAfterSelected(item) {
  insertBlock(item, selectedIndex >= 0 ? selectedIndex + 1 : 0);
}

function triggerUpload(kind, mode = 'replace') {
  pendingUploadMode = mode;
  mediaUpload.value = '';
  mediaUpload.accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : 'application/pdf';
  mediaUpload.multiple = mode === 'gallery-create' || mode === 'gallery-add';
  mediaUpload.click();
}

function mediaPreview(item) {
  if (item.type === 'home-card') {
    const src = assetUrl({ src: item.thumb });
    return `<a class="editor-home-card-preview" href="${escapeHtml(item.url || '#')}" target="_blank">${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.title || 'Project')}" loading="lazy" decoding="async">` : '<div class="canvas-placeholder">No thumbnail</div>'}<span>${escapeHtml(item.title || 'Untitled project')}</span></a>`;
  }
  if (item.type === 'image') {
    const img = imageAsset(item);
    const src = assetUrl(img);
    return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(img?.alt || currentPage.title)}">` : '<div class="canvas-placeholder">Missing image</div>';
  }
  if (item.type === 'video') {
    const video = videoAsset(item);
    const src = assetUrl(video);
    if (!src) return '<div class="canvas-placeholder">Missing video</div>';
    if (video?.kind === 'iframe' || video?.type === 'iframe') return `<iframe src="${escapeHtml(src)}" title="${escapeHtml(video.title || 'Video')}" loading="lazy" allowfullscreen></iframe>`;
    return `<video src="${escapeHtml(src)}" controls playsinline></video>`;
  }
  if (item.type === 'document') {
    const doc = documentAsset(item);
    const src = assetUrl(doc);
    return src ? `<iframe src="${escapeHtml(src)}" title="${escapeHtml(doc?.title || 'PDF')}" loading="lazy"></iframe>` : '<div class="canvas-placeholder">Missing PDF</div>';
  }
  if (item.type === 'audio') {
    const audio = audioAsset(item);
    const src = assetUrl(audio);
    return src ? `<div class="canvas-audio"><span>${escapeHtml(audio?.title || audio?.original || 'Audio')}</span><audio src="${escapeHtml(src)}" controls preload="metadata"></audio></div>` : '<div class="canvas-placeholder">Missing audio</div>';
  }
  if (item.type === 'gallery') {
    const thumbs = (item.imageIndexes || [])
      .map(index => currentPage.images?.[index])
      .filter(Boolean)
      .map(img => `<img src="${escapeHtml(assetUrl(img))}" alt="${escapeHtml(img.alt || currentPage.title)}">`)
      .join('');
    return thumbs ? `<div class="canvas-gallery">${thumbs}</div>` : '<div class="canvas-placeholder">Empty slider</div>';
  }
  return '';
}

function renderCanvas() {
  blockEditor.innerHTML = '';
  if (!currentPage) {
    if (canvasHeadline) {
      canvasHeadline.classList.add('hidden');
      canvasHeadline.innerHTML = '';
    }
    return;
  }
  if (canvasHeadline) {
    canvasHeadline.classList.remove('hidden');
    const titleStyle = currentPage.titleFontSize ? ` style="font-size:${Math.max(28, Math.min(120, Number(currentPage.titleFontSize) || 82))}px"` : '';
    canvasHeadline.innerHTML = currentPage.kind === 'home'
      ? `<span class="back-link">Home</span><h1${titleStyle}>${escapeHtml(currentPage.title || 'Home page')}</h1>`
      : `<span class="back-link">← Work</span><h1${titleStyle}>${escapeHtml(currentPage.title || 'Untitled project')}</h1>`;
  }
  if (!currentPage.contentItems.length) {
    const empty = document.createElement('div');
    empty.className = 'editor-empty-state';
    empty.textContent = 'No blocks on this page.';
    blockEditor.appendChild(empty);
    return;
  }

  currentPage.contentItems.forEach((item, index) => {
    const row = document.createElement('article');
    row.className = `canvas-block ${item.type}${index === selectedIndex ? ' selected' : ''}`;
    row.dataset.index = index;
    row.draggable = true;
    row.addEventListener('click', event => {
      if (isEditorControl(event.target)) return;
      selectBlock(index);
    });
    row.addEventListener('dragstart', event => {
      if (isEditorControl(event.target)) {
        event.preventDefault();
        draggedIndex = -1;
        return;
      }
      draggedIndex = index;
      event.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', event => {
      event.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', event => {
      event.preventDefault();
      row.classList.remove('drop-target');
      reorderBlock(draggedIndex, index);
      draggedIndex = -1;
    });

    const chrome = document.createElement('div');
    chrome.className = 'canvas-block-chrome';
    chrome.innerHTML = `<span>${escapeHtml(mediaLabel(item))}</span>`;
    const controls = document.createElement('div');
    controls.className = 'canvas-block-controls';
    [
      ['Up', () => reorderBlock(index, index - 1), index === 0],
      ['Down', () => reorderBlock(index, index + 1), index === currentPage.contentItems.length - 1],
      ['Delete', () => deleteBlock(index), item.type === 'home-card', 'danger']
    ].forEach(([label, action, disabled, tone]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mini-button ${tone || ''}`;
      button.textContent = label;
      button.disabled = !!disabled;
      button.addEventListener('click', action);
      controls.appendChild(button);
    });
    chrome.appendChild(controls);
    row.appendChild(chrome);

    if (item.type === 'text') {
      row.draggable = false;
      const toolbar = document.createElement('div');
      toolbar.className = 'text-style-toolbar';
      toolbar.innerHTML = `
        <select data-text-font aria-label="Font">
          <option value="">Default</option>
          <option value="Arial, sans-serif">Arial</option>
          <option value="Helvetica Neue, Arial, sans-serif">Helvetica</option>
          <option value="Georgia, serif">Georgia</option>
          <option value="Courier New, monospace">Courier</option>
        </select>
        <input data-text-size type="number" min="12" max="96" step="1" value="${escapeHtml(item.fontSize || 20)}" aria-label="Font size" />
        <button type="button" data-text-bold class="${item.bold ? 'active' : ''}">B</button>
        <button type="button" data-text-italic class="${item.italic ? 'active' : ''}"><i>I</i></button>
        <select data-text-align aria-label="Text alignment">
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>`;
      const font = toolbar.querySelector('[data-text-font]');
      const size = toolbar.querySelector('[data-text-size]');
      const align = toolbar.querySelector('[data-text-align]');
      font.value = item.fontFamily || '';
      align.value = item.align || 'center';
      font.addEventListener('change', () => { recordHistory(); item.fontFamily = font.value; setDirty(); renderCanvas(); });
      size.addEventListener('change', () => { recordHistory(); item.fontSize = Math.max(12, Math.min(96, Number(size.value) || 20)); setDirty(); renderCanvas(); });
      toolbar.querySelector('[data-text-bold]').addEventListener('click', () => { recordHistory(); item.bold = !item.bold; setDirty(); renderCanvas(); });
      toolbar.querySelector('[data-text-italic]').addEventListener('click', () => { recordHistory(); item.italic = !item.italic; setDirty(); renderCanvas(); });
      align.addEventListener('change', () => { recordHistory(); item.align = align.value; setDirty(); renderCanvas(); });
      row.appendChild(toolbar);
      const area = document.createElement('textarea');
      let capturedTextHistory = false;
      area.className = 'canvas-textarea';
      area.value = item.text || '';
      area.style.fontFamily = item.fontFamily || '';
      area.style.fontSize = `${item.fontSize || 20}px`;
      area.style.fontWeight = item.bold ? '800' : '';
      area.style.fontStyle = item.italic ? 'italic' : '';
      area.style.textAlign = item.align || 'center';
      area.placeholder = 'Text';
      area.addEventListener('focus', () => {
        if (selectedIndex !== index) {
          selectedIndex = index;
          row.classList.add('selected');
          renderInspector();
        }
        if (!capturedTextHistory) {
          recordHistory();
          capturedTextHistory = true;
        }
      });
      area.addEventListener('input', () => {
        item.text = area.value;
        setDirty();
        renderInspector();
      });
      row.appendChild(area);
    } else {
      const media = document.createElement('div');
      media.className = 'canvas-media';
      media.innerHTML = mediaPreview(item);
      row.appendChild(media);
    }

    blockEditor.appendChild(row);
  });
}

function renderAssetButton(kind, asset, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'asset-choice';
  if (kind === 'image') button.classList.add('image-only');
  button.dataset.kind = kind;
  button.dataset.index = index;
  if (kind === 'image') {
    button.innerHTML = `<img src="${escapeHtml(assetUrl(asset))}" alt="${escapeHtml(asset.alt || `Image ${index + 1}`)}">`;
  } else {
    button.innerHTML = `<span class="asset-badge">${kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'PDF'}</span><span>${escapeHtml(asset.original || asset.localFile || `${kind} ${index + 1}`)}</span>`;
  }
  button.addEventListener('click', () => useLibraryAsset(kind, index));
  return button;
}

function useLibraryAsset(kind, index) {
  if (!currentPage) return;
  const item = currentPage.contentItems[selectedIndex];
  if (item?.type === kind) {
    if (kind === 'image') item.imageIndex = index;
    else if (kind === 'video') item.videoIndex = index;
    else if (kind === 'audio') item.audioIndex = index;
    else item.documentIndex = index;
  } else if (item?.type === 'gallery' && kind === 'image') {
    item.imageIndexes = [...new Set([...(item.imageIndexes || []), index])];
  } else {
    const next = compatibleItemFor(kind);
    if (kind === 'image') next.imageIndex = index;
    if (kind === 'video') next.videoIndex = index;
    if (kind === 'audio') next.audioIndex = index;
    if (kind === 'document') next.documentIndex = index;
    insertAfterSelected(next);
    return;
  }
  setDirty();
  renderCanvas();
  renderInspector();
}

function renderMediaLibrary() {
  const library = document.createElement('div');
  library.className = 'asset-library';
  const groups = [
    ['image', 'Images', currentPage.images || []],
    ['video', 'Videos', currentPage.videos || []],
    ['audio', 'Audio', currentPage.audios || []],
    ['document', 'PDFs', currentPage.documents || []]
  ];
  groups.forEach(([kind, title, assets]) => {
    const section = document.createElement('section');
    section.className = 'asset-section';
    section.innerHTML = `<div class="inspector-label">${title}</div>`;
    const grid = document.createElement('div');
    grid.className = kind === 'image' ? 'asset-grid image-grid' : 'asset-grid';
    if (assets.length) assets.forEach((asset, index) => grid.appendChild(renderAssetButton(kind, asset, index)));
    else {
      const empty = document.createElement('div');
      empty.className = 'asset-empty';
      empty.textContent = `No ${title.toLowerCase()}.`;
      grid.appendChild(empty);
    }
    section.appendChild(grid);
    library.appendChild(section);
  });
  return library;
}

function inspectorField(label, value, onInput) {
  const wrap = document.createElement('label');
  wrap.className = 'inspector-field';
  wrap.innerHTML = `<span>${escapeHtml(label)}</span>`;
  const input = document.createElement('input');
  let capturedHistory = false;
  input.value = value || '';
  input.addEventListener('focus', () => {
    if (!capturedHistory) {
      recordHistory();
      capturedHistory = true;
    }
  });
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);
  return wrap;
}

function renderInspector() {
  inspector.innerHTML = '';
  if (!currentPage) {
    inspector.textContent = 'Select a page.';
    return;
  }
  const item = currentPage.contentItems[selectedIndex];
  const panel = document.createElement('div');
  panel.className = 'inspector-stack';
  panel.innerHTML = `<h2>${item ? escapeHtml(mediaLabel(item)) : 'Page assets'}</h2>`;

  if (item?.type === 'image') {
    const asset = imageAsset(item);
    panel.appendChild(inspectorField('Alt text', asset?.alt || '', value => {
      if (asset) asset.alt = value;
      item.alt = value;
      setDirty();
    }));
    const actions = document.createElement('div');
    actions.className = 'inspector-actions';
    actions.innerHTML = '<button class="button secondary" type="button" data-upload="image">Upload replacement</button><button class="button ghost" type="button" data-gallery="true">Convert to slider</button>';
    actions.querySelector('[data-upload]').addEventListener('click', () => triggerUpload('image', 'replace'));
    actions.querySelector('[data-gallery]').addEventListener('click', () => {
      recordHistory();
      currentPage.contentItems[selectedIndex] = { type: 'gallery', order: item.order || 0, imageIndexes: [item.imageIndex] };
      setDirty();
      renderCanvas();
      renderInspector();
    });
    panel.appendChild(actions);
  } else if (item?.type === 'video') {
    const asset = videoAsset(item);
    panel.appendChild(inspectorField('Title', asset?.title || '', value => {
      if (asset) asset.title = value;
      item.title = value;
      setDirty();
    }));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = 'Upload replacement';
    button.addEventListener('click', () => triggerUpload('video', 'replace'));
    panel.appendChild(button);
  } else if (item?.type === 'audio') {
    const asset = audioAsset(item);
    panel.appendChild(inspectorField('Title', asset?.title || '', value => {
      if (asset) asset.title = value;
      item.title = value;
      setDirty();
    }));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = 'Upload replacement';
    button.addEventListener('click', () => triggerUpload('audio', 'replace'));
    panel.appendChild(button);
  } else if (item?.type === 'document') {
    const asset = documentAsset(item);
    panel.appendChild(inspectorField('Title', asset?.title || '', value => {
      if (asset) asset.title = value;
      item.title = value;
      setDirty();
    }));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.textContent = 'Upload replacement';
    button.addEventListener('click', () => triggerUpload('document', 'replace'));
    panel.appendChild(button);
  } else if (item?.type === 'gallery') {
    const list = document.createElement('div');
    list.className = 'gallery-editor-list';
    (item.imageIndexes || []).forEach((imageIndex, position) => {
      const img = currentPage.images?.[imageIndex];
      const row = document.createElement('div');
      row.innerHTML = `<img src="${escapeHtml(assetUrl(img))}" alt=""><span>${escapeHtml(img?.original || `Image ${imageIndex + 1}`)}</span>`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mini-button danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        recordHistory();
        item.imageIndexes.splice(position, 1);
        setDirty();
        renderCanvas();
        renderInspector();
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
    panel.appendChild(list);
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.className = 'button secondary';
    upload.textContent = 'Upload image';
    upload.addEventListener('click', () => {
      pendingGalleryIndex = selectedIndex;
      triggerUpload('image', 'gallery-add');
    });
    panel.appendChild(upload);
  } else if (item?.type === 'text') {
    const meta = document.createElement('p');
    meta.className = 'inspector-note';
    meta.textContent = `${(item.text || '').length} characters`;
    panel.appendChild(meta);
  } else if (item?.type === 'home-card') {
    panel.appendChild(inspectorField('Project title', item.title || '', value => {
      item.title = value;
      setDirty();
      renderCanvas();
    }));
    const note = document.createElement('p');
    note.className = 'inspector-note';
    note.textContent = 'Drag cards up or down to change the homepage order.';
    panel.appendChild(note);
  }

  if (currentPage.kind !== 'home') panel.appendChild(renderMediaLibrary());
  inspector.appendChild(panel);
}

function appendMediaBlock(kind) {
  triggerUpload(kind, 'insert');
}

function showVideoChoiceModal() {
  videoChoiceModal?.classList.remove('hidden');
}

function hideVideoChoiceModal() {
  videoChoiceModal?.classList.add('hidden');
}

async function addVideoUrl(source) {
  if (!currentPage) return;
  const label = source === 'youtube' ? 'YouTube' : 'Vimeo';
  const rawUrl = prompt(`Paste ${label} URL`);
  const embedUrl = normalizeEmbedUrl(rawUrl, source);
  if (!embedUrl) {
    setStatus(`That does not look like a ${label} URL.`, 'error');
    return;
  }
  setStatus(`Adding ${label} video...`);
  let headers;
  try {
    headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}/video-url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: embedUrl, source })
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Could not add video.', 'error');
    return;
  }
  const draftItems = currentPage.contentItems.map(item => ({ ...item, imageIndexes: item.imageIndexes ? [...item.imageIndexes] : undefined }));
  currentPage = data.page;
  currentPage.contentItems = draftItems;
  insertBlock(data.asset, 0);
  setStatus('Video added. Save the page to place it in the portfolio.', 'warn');
}

async function uploadOneMedia(file, mode = pendingUploadMode) {
  if (!currentPage || !file) return;
  const draftItems = currentPage.contentItems.map(item => ({ ...item, imageIndexes: item.imageIndexes ? [...item.imageIndexes] : undefined }));
  const form = new FormData();
  form.append('file', file);
  setStatus('Uploading media and rebuilding preview...');
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}/assets`, {
    method: 'POST',
    headers,
    body: form
  });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Upload failed.', 'error');
    return;
  }
  currentPage = data.page;
  currentPage.contentItems = draftItems;
  const asset = data.asset;
  const item = currentPage.contentItems[selectedIndex];
  if (mode === 'insert') {
    insertBlock(asset, 0);
    setStatus('Media uploaded. Save the page to place it in the portfolio.', 'warn');
    return asset;
  }
  if (mode === 'gallery-create' && asset.type === 'image') {
    insertBlock({ type: 'gallery', order: 0, imageIndexes: [asset.imageIndex] }, 0);
    pendingGalleryIndex = selectedIndex;
    setStatus('Slider image uploaded. Save the page to place it in the portfolio.', 'warn');
    return asset;
  }
  if (mode === 'gallery-add' && asset.type === 'image') {
    const gallery = currentPage.contentItems[pendingGalleryIndex] || item;
    if (gallery?.type === 'gallery') {
      recordHistory();
      gallery.imageIndexes = [...new Set([...(gallery.imageIndexes || []), asset.imageIndex])];
      selectedIndex = currentPage.contentItems.indexOf(gallery);
    } else {
      insertBlock({ type: 'gallery', order: 0, imageIndexes: [asset.imageIndex] }, 0);
      pendingGalleryIndex = selectedIndex;
    }
    setDirty();
    renderCanvas();
    renderInspector();
    setStatus('Slider image uploaded. Save the page to place it in the portfolio.', 'warn');
    return asset;
  }
  if (item?.type === asset.type) {
    recordHistory();
    Object.assign(item, asset);
  } else if (item?.type === 'gallery' && asset.type === 'image') {
    recordHistory();
    item.imageIndexes = [...new Set([...(item.imageIndexes || []), asset.imageIndex])];
  } else {
    insertBlock(asset, 0);
    setStatus('Media uploaded. Save the page to place it in the portfolio.', 'warn');
    return asset;
  }
  setDirty();
  renderCanvas();
  renderInspector();
  setStatus('Media uploaded. Save the page to place it in the portfolio.', 'warn');
  return asset;
}

async function uploadMedia(files) {
  const fileList = [...(files || [])].filter(Boolean);
  if (!fileList.length) return;
  if (pendingUploadMode === 'gallery-create') pendingGalleryIndex = -1;
  for (const file of fileList) {
    await uploadOneMedia(file, pendingUploadMode);
    if (pendingUploadMode === 'gallery-create') pendingUploadMode = 'gallery-add';
  }
}

async function loadPage(slug) {
  if (dirty && !confirm('Discard unsaved changes on this page?')) return;
  const seq = ++loadPageSeq;
  currentSlug = slug;
  selectedIndex = -1;
  dirty = false;
  setStatus('Loading page...');
  [...pageList.querySelectorAll('button')].forEach(btn => btn.classList.toggle('active', btn.dataset.slug === slug));
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(slug)}`, { headers });
  const pageData = await res.json();
  if (seq !== loadPageSeq) return;
  currentPage = pageData;
  if (!res.ok) {
    setStatus(currentPage.error || 'Could not load page.', 'error');
    return;
  }
  currentPage.contentItems = currentPage.contentItems || [];
  titleInput.value = currentPage.title || '';
  pagePreview.href = currentPage.kind === 'home'
    ? `/generated/${jobId}/site/index.html`
    : `/generated/${jobId}/site/work/${currentPage.slug}/index.html`;
  const titleLabel = document.querySelector('.editor-title-field span');
  if (titleLabel) titleLabel.textContent = currentPage.kind === 'home' ? 'Home headline' : 'Project Headline';
  [addTextBlock, addImageBlock, addVideoBlock, addAudioBlock, addPdfBlock, addSliderBlock].forEach(button => {
    if (button) button.disabled = currentPage.kind === 'home';
  });
  undoStack = [];
  redoStack = [];
  updateHistoryButtons();
  renderCanvas();
  renderInspector();
  setDirty(false);
  setStatus('Page loaded.');
}

async function loadPages() {
  if (!jobId) {
    setStatus('Missing job id. Open this from a completed import.', 'error');
    return;
  }
  if (managePortfolio) managePortfolio.href = '/manage.html';
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages`, { headers });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Could not load import.', 'error');
    return;
  }
  pages = data.pages || [];
  publishControl.show();
  publishControl.setPublished(data.published, data.customDomain);
  pageList.innerHTML = '';
  pages.forEach(page => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.slug = page.slug;
    btn.textContent = page.title;
    btn.addEventListener('click', () => loadPage(page.slug));
    pageList.appendChild(btn);
  });
  const requestedPage = params.get('page');
  if (requestedPage && pages.some(page => page.slug === requestedPage)) loadPage(requestedPage);
  else {
    const firstProject = pages.find(page => page.slug !== 'home') || pages[0];
    if (firstProject) loadPage(firstProject.slug);
  }
}

titleInput.addEventListener('focus', () => recordHistory());
titleInput.addEventListener('input', () => {
  if (!currentPage) return;
  currentPage.title = titleInput.value;
  setDirty();
  renderCanvas();
});

undoEdit?.addEventListener('click', () => {
  if (!undoStack.length || !currentPage) return;
  redoStack.push(pageSnapshot());
  const previous = undoStack.pop();
  restoreHistory(previous);
});

redoEdit?.addEventListener('click', () => {
  if (!redoStack.length || !currentPage) return;
  undoStack.push(pageSnapshot());
  const next = redoStack.pop();
  restoreHistory(next);
});

addTextBlock.addEventListener('click', () => insertBlock(makeTextBlock('')));
addImageBlock.addEventListener('click', () => appendMediaBlock('image'));
addVideoBlock.addEventListener('click', showVideoChoiceModal);
addAudioBlock.addEventListener('click', () => appendMediaBlock('audio'));
addPdfBlock.addEventListener('click', () => appendMediaBlock('document'));
addSliderBlock.addEventListener('click', () => triggerUpload('image', 'gallery-create'));
mediaUpload.addEventListener('change', () => uploadMedia(mediaUpload.files));
magicFiles?.addEventListener('change', () => {
  const count = magicFiles.files?.length || 0;
  if (magicUploadLabel) magicUploadLabel.textContent = count ? `${count} ad${count === 1 ? '' : 's'} selected` : 'Upload ads';
});

magicEditForm?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentPage) {
    setStatus('Choose a page before using the prompt editor.', 'error');
    return;
  }
  const promptText = magicPrompt?.value.trim() || '';
  if (promptText) sessionStorage.setItem('killerwork:aiPrompt', promptText);
  window.open(`/ai-editor.html?job=${encodeURIComponent(jobId)}&page=${encodeURIComponent(currentSlug || 'home')}`, '_blank', 'noopener');
});

videoChoiceModal?.addEventListener('click', event => {
  const choice = event.target?.dataset?.videoChoice;
  if (!choice) {
    if (event.target === videoChoiceModal) hideVideoChoiceModal();
    return;
  }
  hideVideoChoiceModal();
  if (choice === 'upload') triggerUpload('video', 'insert');
  else if (choice === 'youtube' || choice === 'vimeo') addVideoUrl(choice);
});

savePage.addEventListener('click', async () => {
  if (!currentPage) return;
  savePage.disabled = true;
  savePage.innerHTML = '<span>Saving...</span><small>Rebuilding</small>';
  setStatus('Saving and rebuilding preview/ZIP...');
  const body = {
    title: titleInput.value,
    titleFontSize: currentPage.titleFontSize || 0,
    aiLayout: currentPage.aiLayout || '',
    contentItems: currentPage.contentItems.map((item, idx) => ({ ...item, order: idx + 1 }))
  };
  let headers;
  try {
    headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    savePage.disabled = false;
    savePage.innerHTML = '<span>Save</span><small data-save-state>Unsaved changes</small>';
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
  const data = await res.json();
  savePage.disabled = false;
  savePage.innerHTML = '<span>Save</span><small data-save-state>Saved</small>';
  if (!res.ok) {
    setStatus(data.error || 'Save failed.', 'error');
    return;
  }
  currentPage = data.page;
  currentPage.contentItems = currentPage.contentItems || [];
  titleInput.value = currentPage.title;
  pagePreview.href = data.preview;
  selectedIndex = Math.min(selectedIndex, currentPage.contentItems.length - 1);
  dirty = false;
  setDirty(false);
  const listed = pages.find(page => page.slug === currentSlug);
  if (listed) listed.title = currentPage.title;
  [...pageList.querySelectorAll('button')].forEach(btn => {
    if (btn.dataset.slug === currentSlug) btn.textContent = currentPage.title;
  });
  renderCanvas();
  renderInspector();
  setStatus(data.validation?.ok ? 'Saved. Preview and ZIP rebuilt.' : 'Saved with validation warnings.', data.validation?.ok ? 'ok' : 'warn');
});

loadPages();

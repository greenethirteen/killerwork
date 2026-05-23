const params = new URLSearchParams(location.search);
const jobId = params.get('job');
if (jobId) localStorage.setItem('killerwork:lastJobId', jobId);
const pageList = document.getElementById('pageList');
const titleInput = document.getElementById('titleInput');
const pagePreview = document.getElementById('pagePreview');
const savePage = document.getElementById('savePage');
const statusBox = document.getElementById('editorStatus');
const blockEditor = document.getElementById('blockEditor');
const managePortfolio = document.getElementById('managePortfolio');
const inspector = document.getElementById('inspector');
const mediaUpload = document.getElementById('mediaUpload');
const addTextBlock = document.getElementById('addTextBlock');
const addImageBlock = document.getElementById('addImageBlock');
const addVideoBlock = document.getElementById('addVideoBlock');
const addAudioBlock = document.getElementById('addAudioBlock');
const addPdfBlock = document.getElementById('addPdfBlock');

let currentSlug = '';
let currentPage = null;
let pages = [];
let selectedIndex = -1;
let draggedIndex = -1;
let dirty = false;
let pendingUploadType = '';

async function authHeaders() {
  const token = await window.KillerWorkAuth.requireToken();
  return { Authorization: `Bearer ${token}` };
}

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.dataset.tone = tone;
}

function setDirty(value = true) {
  dirty = value;
  savePage.dataset.dirty = dirty ? 'true' : '';
  if (dirty) setStatus('Unsaved changes.');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mediaLabel(item) {
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

function mediaCount(kind) {
  if (kind === 'image') return currentPage?.images?.length || 0;
  if (kind === 'video') return currentPage?.videos?.length || 0;
  if (kind === 'audio') return currentPage?.audios?.length || 0;
  return currentPage?.documents?.length || 0;
}

function selectBlock(index) {
  selectedIndex = index;
  renderCanvas();
  renderInspector();
}

function reorderBlock(from, to) {
  if (!currentPage || from === to || from < 0 || to < 0 || from >= currentPage.contentItems.length || to >= currentPage.contentItems.length) return;
  const [item] = currentPage.contentItems.splice(from, 1);
  currentPage.contentItems.splice(to, 0, item);
  selectedIndex = to;
  setDirty();
  renderCanvas();
  renderInspector();
}

function deleteBlock(index) {
  if (!currentPage || index < 0) return;
  currentPage.contentItems.splice(index, 1);
  selectedIndex = Math.min(index, currentPage.contentItems.length - 1);
  setDirty();
  renderCanvas();
  renderInspector();
}

function insertBlock(item, afterIndex = selectedIndex) {
  if (!currentPage) return;
  const index = afterIndex >= 0 ? afterIndex + 1 : currentPage.contentItems.length;
  currentPage.contentItems.splice(index, 0, item);
  selectedIndex = index;
  setDirty();
  renderCanvas();
  renderInspector();
}

function triggerUpload(kind) {
  pendingUploadType = kind;
  mediaUpload.value = '';
  mediaUpload.accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : kind === 'audio' ? 'audio/*' : 'application/pdf';
  mediaUpload.click();
}

function mediaPreview(item) {
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
  if (!currentPage) return;
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
      if (event.target.closest('button')) return;
      selectBlock(index);
    });
    row.addEventListener('dragstart', event => {
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
      ['Delete', () => deleteBlock(index), false, 'danger']
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
      const area = document.createElement('textarea');
      area.className = 'canvas-textarea';
      area.value = item.text || '';
      area.placeholder = 'Text';
      area.addEventListener('focus', () => selectBlock(index));
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
  button.dataset.kind = kind;
  button.dataset.index = index;
  if (kind === 'image') {
    button.innerHTML = `<img src="${escapeHtml(assetUrl(asset))}" alt="${escapeHtml(asset.alt || 'Image')}"><span>${escapeHtml(asset.original || asset.localFile || `Image ${index + 1}`)}</span>`;
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
    insertBlock(next);
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
  input.value = value || '';
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
    actions.querySelector('[data-upload]').addEventListener('click', () => triggerUpload('image'));
    actions.querySelector('[data-gallery]').addEventListener('click', () => {
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
    button.addEventListener('click', () => triggerUpload('video'));
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
    button.addEventListener('click', () => triggerUpload('audio'));
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
    button.addEventListener('click', () => triggerUpload('document'));
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
    upload.addEventListener('click', () => triggerUpload('image'));
    panel.appendChild(upload);
  } else if (item?.type === 'text') {
    const meta = document.createElement('p');
    meta.className = 'inspector-note';
    meta.textContent = `${(item.text || '').length} characters`;
    panel.appendChild(meta);
  }

  panel.appendChild(renderMediaLibrary());
  inspector.appendChild(panel);
}

function appendMediaBlock(kind) {
  const count = mediaCount(kind);
  if (!count) {
    triggerUpload(kind);
    return;
  }
  const item = compatibleItemFor(kind);
  insertBlock(item);
}

async function uploadMedia(file) {
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
  if (item?.type === asset.type) {
    Object.assign(item, asset);
  } else if (item?.type === 'gallery' && asset.type === 'image') {
    item.imageIndexes = [...new Set([...(item.imageIndexes || []), asset.imageIndex])];
  } else {
    insertBlock(asset);
    setStatus('Media uploaded. Save the page to place it in the portfolio.', 'warn');
    return;
  }
  setDirty();
  renderCanvas();
  renderInspector();
  setStatus('Media uploaded. Save the page to place it in the portfolio.', 'warn');
}

async function loadPage(slug) {
  if (dirty && !confirm('Discard unsaved changes on this page?')) return;
  currentSlug = slug;
  selectedIndex = -1;
  dirty = false;
  setStatus('Loading page...');
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(slug)}`, { headers });
  currentPage = await res.json();
  if (!res.ok) {
    setStatus(currentPage.error || 'Could not load page.', 'error');
    return;
  }
  currentPage.contentItems = currentPage.contentItems || [];
  titleInput.value = currentPage.title || '';
  pagePreview.href = `/generated/${jobId}/site/work/${currentPage.slug}/index.html`;
  [...pageList.querySelectorAll('button')].forEach(btn => btn.classList.toggle('active', btn.dataset.slug === slug));
  renderCanvas();
  renderInspector();
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
  else if (pages[0]) loadPage(pages[0].slug);
}

titleInput.addEventListener('input', () => {
  if (!currentPage) return;
  currentPage.title = titleInput.value;
  setDirty();
});

addTextBlock.addEventListener('click', () => insertBlock(makeTextBlock('')));
addImageBlock.addEventListener('click', () => appendMediaBlock('image'));
addVideoBlock.addEventListener('click', () => appendMediaBlock('video'));
addAudioBlock.addEventListener('click', () => appendMediaBlock('audio'));
addPdfBlock.addEventListener('click', () => appendMediaBlock('document'));
mediaUpload.addEventListener('change', () => uploadMedia(mediaUpload.files?.[0], pendingUploadType));

savePage.addEventListener('click', async () => {
  if (!currentPage) return;
  savePage.disabled = true;
  savePage.textContent = 'Saving...';
  setStatus('Saving and rebuilding preview/ZIP...');
  const body = {
    title: titleInput.value,
    contentItems: currentPage.contentItems.map((item, idx) => ({ ...item, order: idx + 1 }))
  };
  let headers;
  try {
    headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    savePage.disabled = false;
    savePage.textContent = 'Save page';
    return;
  }
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
  const data = await res.json();
  savePage.disabled = false;
  savePage.textContent = 'Save page';
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

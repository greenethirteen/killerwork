const params = new URLSearchParams(location.search);
const jobId = params.get('job') || localStorage.getItem('killerwork:lastJobId') || '';
let currentSlug = params.get('page') || 'home';
let currentPage = null;
const undoStack = [];
const redoStack = [];

const preview = document.getElementById('aiPreview');
const form = document.getElementById('aiPromptForm');
const promptBox = document.getElementById('aiPrompt');
const applyButton = document.getElementById('aiApply');
const statusBox = document.getElementById('aiStatus');
const pageSelect = document.getElementById('aiPageSelect');
const editorLink = document.getElementById('classicEditorLink');
const openPreviewLink = document.getElementById('aiOpenPreview');
const pulse = document.getElementById('aiPulse');
const chatLog = document.getElementById('aiChatLog');
const undoButton = document.getElementById('aiUndo');
const redoButton = document.getElementById('aiRedo');
const saveButton = document.getElementById('aiSave');
const assetUpload = document.getElementById('aiAssetUpload');
const attachmentList = document.getElementById('aiAttachmentList');
let pendingFiles = [];

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.dataset.tone = tone;
}

async function authHeaders() {
  const token = await window.KillerWorkAuth.requireToken();
  return { Authorization: `Bearer ${token}` };
}

function previewUrl(slug = currentSlug, bust = true) {
  const base = slug === 'home'
    ? `/generated/${jobId}/site/index.html`
    : `/generated/${jobId}/site/work/${encodeURIComponent(slug)}/index.html`;
  return bust ? `${base}?v=${Date.now()}` : base;
}

function updateHistoryButtons() {
  undoButton.disabled = !undoStack.length;
  redoButton.disabled = !redoStack.length;
}

function pageSnapshot(page = currentPage) {
  if (!page) return null;
  return JSON.parse(JSON.stringify({
    title: page.title || '',
    subtitle: page.subtitle || '',
    titleFontSize: page.titleFontSize || 0,
    homeIntro: page.homeIntro || '',
    contentItems: page.contentItems || []
  }));
}

function addMessage(role, text, pending = false) {
  const item = document.createElement('article');
  item.className = `ai-message ${role}${pending ? ' pending' : ''}`;
  item.innerHTML = `<span>${role === 'user' ? 'You' : 'KillaWork™ AI'}</span><p></p>`;
  item.querySelector('p').textContent = text;
  chatLog.appendChild(item);
  chatLog.scrollTop = chatLog.scrollHeight;
  return item;
}

function refreshPreview() {
  const url = previewUrl();
  preview.src = url;
  editorLink.href = `/editor.html?job=${encodeURIComponent(jobId)}&page=${encodeURIComponent(currentSlug)}`;
  openPreviewLink.href = previewUrl(currentSlug, false);
}

function showPulse(text = 'Updating page') {
  pulse.textContent = text;
  pulse.classList.remove('hidden');
  setTimeout(() => pulse.classList.add('hidden'), 1300);
}

async function fetchPage() {
  const headers = await authHeaders();
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}`, { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load this page.');
  currentPage = data;
  return data;
}

async function restorePage(snapshot) {
  if (!snapshot) return;
  const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  const body = {
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    titleFontSize: snapshot.titleFontSize,
    homeIntro: snapshot.homeIntro,
    contentItems: snapshot.contentItems
  };
  const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not restore page.');
  currentPage = data.page;
  refreshPreview();
}

async function loadPages() {
  if (!jobId) {
    setStatus('Missing portfolio id. Open this from the editor.', 'error');
    return;
  }
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
    setStatus(data.error || 'Could not load pages.', 'error');
    return;
  }
  pageSelect.innerHTML = '';
  for (const page of data.pages || []) {
    const option = document.createElement('option');
    option.value = page.slug;
    option.textContent = page.title;
    pageSelect.appendChild(option);
  }
  if (![...pageSelect.options].some(option => option.value === currentSlug)) currentSlug = 'home';
  pageSelect.value = currentSlug;
  await fetchPage();
  refreshPreview();
  const savedPrompt = sessionStorage.getItem('killerwork:aiPrompt') || '';
  if (savedPrompt) {
    promptBox.value = savedPrompt;
    sessionStorage.removeItem('killerwork:aiPrompt');
  }
  updateHistoryButtons();
}

pageSelect.addEventListener('change', async () => {
  currentSlug = pageSelect.value;
  undoStack.length = 0;
  redoStack.length = 0;
  updateHistoryButtons();
  history.replaceState(null, '', `/ai-editor.html?job=${encodeURIComponent(jobId)}&page=${encodeURIComponent(currentSlug)}`);
  setStatus('Loading page...');
  try {
    await fetchPage();
    refreshPreview();
    addMessage('assistant', `Switched to ${pageSelect.selectedOptions[0]?.textContent || currentSlug}.`);
    setStatus('Page loaded.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Could not load page.', 'error');
  }
});

function renderAttachments() {
  attachmentList.innerHTML = '';
  if (!pendingFiles.length) return;
  for (const file of pendingFiles) {
    const chip = document.createElement('span');
    chip.textContent = file.name;
    attachmentList.appendChild(chip);
  }
}

async function uploadPendingFiles() {
  const files = [...pendingFiles];
  if (!files.length) return [];
  if (currentSlug === 'home') throw new Error('Upload ads to a project page, then ask AI to place them.');
  const headers = await authHeaders();
  const uploaded = [];
  for (const file of files) {
    const body = new FormData();
    body.append('file', file);
    body.append('insert', 'true');
    const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}/assets`, {
      method: 'POST',
      headers,
      body
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Could not upload ${file.name}.`);
    uploaded.push(data.asset);
    currentPage = data.page;
  }
  pendingFiles = [];
  if (assetUpload) assetUpload.value = '';
  renderAttachments();
  return uploaded;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = promptBox.value.trim();
  if (!prompt && !pendingFiles.length) {
    setStatus('Write a prompt or attach ads first.', 'warn');
    return;
  }
  applyButton.disabled = true;
  applyButton.textContent = 'Applying...';
  setStatus(pendingFiles.length ? 'Uploading ads and applying edit...' : 'Applying edit and rebuilding preview...');
  showPulse('Applying edit');
  const uploadCount = pendingFiles.length;
  addMessage('user', uploadCount ? `${prompt || 'Add these ads to the page.'}\n\nAttached: ${uploadCount} file${uploadCount === 1 ? '' : 's'}` : prompt);
  const pending = addMessage('assistant', 'Working on it...', true);
  try {
    const before = pageSnapshot(await fetchPage());
    const uploaded = await uploadPendingFiles();
    const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
    const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}/ai-edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: prompt || 'Place the uploaded ads on this page in a clean portfolio-ready order.',
        uploadedAssets: uploaded
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI edit failed.');
    if (before) undoStack.push(before);
    redoStack.length = 0;
    currentPage = data.page;
    promptBox.value = '';
    refreshPreview();
    pending.classList.remove('pending');
    pending.querySelector('p').textContent = data.message || 'Edit applied. The live preview has been refreshed.';
    setStatus('Saved. Preview refreshed.', 'ok');
    updateHistoryButtons();
  } catch (err) {
    pending.classList.remove('pending');
    pending.querySelector('p').textContent = err.message || 'AI edit failed.';
    setStatus(err.message || 'AI edit failed.', 'error');
  } finally {
    applyButton.disabled = false;
    applyButton.textContent = 'Apply edit';
  }
});

assetUpload?.addEventListener('change', () => {
  pendingFiles = [...(assetUpload.files || [])].filter(Boolean);
  renderAttachments();
  if (pendingFiles.length) setStatus(`${pendingFiles.length} file${pendingFiles.length === 1 ? '' : 's'} attached. Add a prompt or click Apply edit.`, 'ok');
});

undoButton.addEventListener('click', async () => {
  if (!undoStack.length) return;
  const target = undoStack.pop();
  const current = pageSnapshot(await fetchPage().catch(() => currentPage));
  if (current) redoStack.push(current);
  showPulse('Undo');
  try {
    await restorePage(target);
    addMessage('assistant', 'Undid the last edit and refreshed the preview.');
    setStatus('Undo complete.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Undo failed.', 'error');
  }
  updateHistoryButtons();
});

redoButton.addEventListener('click', async () => {
  if (!redoStack.length) return;
  const target = redoStack.pop();
  const current = pageSnapshot(await fetchPage().catch(() => currentPage));
  if (current) undoStack.push(current);
  showPulse('Redo');
  try {
    await restorePage(target);
    addMessage('assistant', 'Redid the edit and refreshed the preview.');
    setStatus('Redo complete.', 'ok');
  } catch (err) {
    setStatus(err.message || 'Redo failed.', 'error');
  }
  updateHistoryButtons();
});

saveButton.addEventListener('click', () => {
  showPulse('Saved');
  refreshPreview();
  addMessage('assistant', 'Saved. AI edits are written to the portfolio as soon as they are applied.');
  setStatus('Saved.', 'ok');
});

loadPages();

const params = new URLSearchParams(location.search);
const jobId = params.get('job') || localStorage.getItem('killerwork:lastJobId') || '';
let currentSlug = params.get('page') || 'home';

const preview = document.getElementById('aiPreview');
const form = document.getElementById('aiPromptForm');
const promptBox = document.getElementById('aiPrompt');
const applyButton = document.getElementById('aiApply');
const statusBox = document.getElementById('aiStatus');
const pageSelect = document.getElementById('aiPageSelect');
const editorLink = document.getElementById('classicEditorLink');
const pulse = document.getElementById('aiPulse');

function setStatus(text, tone = '') {
  statusBox.textContent = text;
  statusBox.dataset.tone = tone;
}

async function authHeaders() {
  const token = await window.KillerWorkAuth.requireToken();
  return { Authorization: `Bearer ${token}` };
}

function previewUrl(slug = currentSlug) {
  const base = slug === 'home'
    ? `/generated/${jobId}/site/index.html`
    : `/generated/${jobId}/site/work/${encodeURIComponent(slug)}/index.html`;
  return `${base}?v=${Date.now()}`;
}

function refreshPreview() {
  preview.src = previewUrl();
  editorLink.href = `/editor.html?job=${encodeURIComponent(jobId)}&page=${encodeURIComponent(currentSlug)}`;
}

function showPulse() {
  pulse.classList.remove('hidden');
  setTimeout(() => pulse.classList.add('hidden'), 1300);
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
  refreshPreview();
  const savedPrompt = sessionStorage.getItem('killerwork:aiPrompt') || '';
  if (savedPrompt) {
    promptBox.value = savedPrompt;
    sessionStorage.removeItem('killerwork:aiPrompt');
  }
}

pageSelect.addEventListener('change', () => {
  currentSlug = pageSelect.value;
  history.replaceState(null, '', `/ai-editor.html?job=${encodeURIComponent(jobId)}&page=${encodeURIComponent(currentSlug)}`);
  refreshPreview();
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const prompt = promptBox.value.trim();
  if (!prompt) {
    setStatus('Write a prompt first.', 'warn');
    return;
  }
  applyButton.disabled = true;
  applyButton.textContent = 'Applying...';
  setStatus('Applying edit and rebuilding preview...');
  showPulse();
  try {
    const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
    const res = await fetch(`/api/editor/${jobId}/pages/${encodeURIComponent(currentSlug)}/ai-edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI edit failed.');
    promptBox.value = '';
    refreshPreview();
    setStatus('Edit applied. The live preview has been refreshed.', 'ok');
  } catch (err) {
    setStatus(err.message || 'AI edit failed.', 'error');
  } finally {
    applyButton.disabled = false;
    applyButton.textContent = 'Apply edit';
  }
});

loadPages();

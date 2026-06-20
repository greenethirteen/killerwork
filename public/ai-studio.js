import { setupPublishControl } from './publish.js?v=20260620-modalportal';

// ── DOM refs ──────────────────────────────────────────────────────────────
const form = document.getElementById('asForm');
const feed = document.getElementById('asFeed');
const sourceTabs = form.querySelectorAll('.as-source-tab');
const tabZip = document.getElementById('asTabZip');
const tabUrl = document.getElementById('asTabUrl');
const zipInput = document.getElementById('asZip');
const zipLabel = document.getElementById('asZipLabel');
const zipName = document.getElementById('asZipName');
const portfolioUrlInput = document.getElementById('asPortfolioUrl');
const nameInput = document.getElementById('asName');
const titleInput = document.getElementById('asTitle');
const linkedinInput = document.getElementById('asLinkedin');
const promptInput = document.getElementById('asPrompt');
const submitBtn = document.getElementById('asSubmit');
const preview = document.getElementById('asPreview');
const previewEmpty = document.getElementById('asPreviewEmpty');
const address = document.getElementById('asAddress');
const editorLink = document.getElementById('asOpenEditor');
const downloadLink = document.getElementById('asDownload');

let currentJobId = '';
let pollTimer = null;
let renderedProgress = 0;
let activeTab = 'zip'; // 'zip' | 'url'

const publishControl = setupPublishControl({
  control: document.getElementById('asPublishControl'),
  getJobId: () => currentJobId,
  setStatus: text => addMessage('assistant', text)
});

// ── Source tab switching ──────────────────────────────────────────────────
sourceTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const next = tab.dataset.tab;
    if (next === activeTab) return;
    activeTab = next;
    sourceTabs.forEach(t => {
      const on = t.dataset.tab === next;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    tabZip.classList.toggle('hidden', next !== 'zip');
    tabUrl.classList.toggle('hidden', next !== 'url');
  });
});

zipInput.addEventListener('change', () => {
  const f = zipInput.files?.[0];
  if (f) {
    zipName.textContent = f.name;
    zipLabel.textContent = 'Change ZIP';
  } else {
    zipName.textContent = 'No file selected';
    zipLabel.textContent = 'Choose ZIP';
  }
});

// Auto-resize prompt textarea
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
});

// ── Auth helpers ──────────────────────────────────────────────────────────
function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

async function token() {
  return window.KillerWorkAuth.requireToken();
}

// ── Feed helpers ──────────────────────────────────────────────────────────
function addMessage(role, text, tone = '') {
  const article = document.createElement('article');
  article.className = `studio-message ${role}${tone ? ` ${tone}` : ''}`;
  article.innerHTML = `<span>${role === 'user' ? 'You' : 'Builder'}</span><p></p>`;
  article.querySelector('p').textContent = text;
  feed.appendChild(article);
  feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
}

function addProgress(stage, detail = '', percent = 0) {
  const article = document.createElement('article');
  article.className = 'studio-build-step';
  article.innerHTML = `<div><b></b><span></span></div><strong>${Math.round(percent)}%</strong>`;
  article.querySelector('b').textContent = stage;
  article.querySelector('span').textContent = detail || 'Working...';
  feed.appendChild(article);
  feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
}

function setActionLink(link, href) {
  link.href = href || '#';
  link.classList.toggle('disabled', !href);
}

function setBusy(isBusy) {
  submitBtn.disabled = isBusy;
  form.classList.toggle('is-building', isBusy);
}

// ── Poll loop ─────────────────────────────────────────────────────────────
async function pollJob() {
  const authToken = await token();
  const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  const job = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(job.error || 'Could not check the build status.');

  const progressItems = job.progress || [];
  progressItems.slice(renderedProgress).forEach(item => addProgress(item.stage || 'Working', item.detail || '', job.percent || 0));
  renderedProgress = progressItems.length;

  if (job.status === 'error') {
    clearInterval(pollTimer);
    setBusy(false);
    addMessage('assistant', job.error || 'The build failed. Check the details above and try again.', 'error');
    track('ai_studio_build_error');
    return;
  }

  if (job.status === 'done') {
    clearInterval(pollTimer);
    setBusy(false);
    addMessage('assistant', 'Done — your portfolio is ready. Open the code studio to tweak it, publish it live, or download the ZIP.');
    currentJobId = job.id;
    localStorage.setItem('killerwork:lastJobId', job.id);
    preview.src = `${job.links.preview}?v=${Date.now()}`;
    preview.classList.remove('hidden');
    previewEmpty.classList.add('hidden');
    address.textContent = job.links.preview;
    setActionLink(editorLink, `/ai-editor.html?job=${encodeURIComponent(job.id)}`);
    setActionLink(downloadLink, job.links.zip);
    publishControl.show();
    track('ai_studio_build_done');
  }
}

// ── Form submission ───────────────────────────────────────────────────────
form.addEventListener('submit', async e => {
  e.preventDefault();

  const zipFile = zipInput.files?.[0] || null;
  const portfolioUrl = portfolioUrlInput.value.trim();
  const name = nameInput.value.trim();
  const jobTitle = titleInput.value.trim();
  const linkedin = linkedinInput.value.trim();
  const style = form.querySelector('[name="asStyle"]:checked')?.value || 'straightforward';
  const prompt = promptInput.value.trim();

  // Validate source
  if (activeTab === 'zip' && !zipFile) {
    addMessage('assistant', 'Please attach a ZIP file first. Drop your campaign folders into a ZIP and upload it.', 'error');
    return;
  }
  if (activeTab === 'url' && !portfolioUrl) {
    addMessage('assistant', 'Please enter your portfolio URL.', 'error');
    return;
  }
  if (!prompt) {
    addMessage('assistant', 'Add a short description of the portfolio you want — just a sentence or two is enough.', 'error');
    return;
  }

  // Clear feed and start
  feed.innerHTML = '';
  renderedProgress = 0;
  setBusy(true);

  const sourceLabel = activeTab === 'zip' ? zipFile.name : portfolioUrl;
  addMessage('user', `Build me a ${style === 'parallax' ? 'bold animated' : 'classic clean'} portfolio from ${sourceLabel}.`);
  track('ai_studio_build_start', { style, source: activeTab });

  try {
    const authToken = await token();

    const fd = new FormData();
    if (activeTab === 'zip' && zipFile) fd.append('zip', zipFile);
    if (portfolioUrl) fd.append('portfolioUrl', portfolioUrl);
    if (linkedin) fd.append('linkedinUrl', linkedin);
    fd.append('name', name);
    fd.append('jobTitle', jobTitle);
    fd.append('style', style);
    fd.append('prompt', prompt);

    const res = await fetch('/api/ai-studio/build', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    currentJobId = data.id;
    addMessage('assistant', `Got it. Building your ${style === 'parallax' ? 'animated bold' : 'clean professional'} portfolio now...`);
    if (linkedin) addMessage('assistant', 'Fetching your LinkedIn profile to enrich the about section...');
    if (activeTab === 'url') addMessage('assistant', `Importing projects from ${portfolioUrl}...`);

    pollTimer = setInterval(async () => {
      try { await pollJob(); } catch (err) {
        clearInterval(pollTimer);
        setBusy(false);
        addMessage('assistant', err.message || 'Polling failed.', 'error');
      }
    }, 2500);
  } catch (err) {
    setBusy(false);
    addMessage('assistant', err.message || 'Could not start the build. Try again.', 'error');
    track('ai_studio_submit_error');
  }
});

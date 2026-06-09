import { setupPublishControl } from './publish.js?v=20260602-gtm';

const form = document.getElementById('studioForm');
const feed = document.getElementById('studioFeed');
const nameInput = document.getElementById('studioName');
const titleInput = document.getElementById('studioTitle');
const linkedinInput = document.getElementById('studioLinkedin');
const promptInput = document.getElementById('studioPrompt');
const zipInput = document.getElementById('studioZip');
const zipName = document.getElementById('studioZipName');
const submitButton = document.getElementById('studioSubmit');
const preview = document.getElementById('studioPreview');
const previewEmpty = document.getElementById('studioPreviewEmpty');
const address = document.getElementById('studioAddress');
const editorLink = document.getElementById('studioOpenEditor');
const downloadLink = document.getElementById('studioDownload');

let currentJobId = '';
let pollTimer = null;
let renderedProgress = 0;

const publishControl = setupPublishControl({
  control: document.getElementById('studioPublishControl'),
  getJobId: () => currentJobId,
  setStatus: text => addMessage('assistant', text)
});

function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

async function token() {
  return window.KillerWorkAuth.requireToken();
}

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
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? 'Building' : 'Build';
  form.classList.toggle('is-building', isBusy);
}

async function pollJob() {
  const authToken = await token();
  const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const job = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(job.error || 'Could not check the build.');
  const progressItems = job.progress || [];
  progressItems.slice(renderedProgress).forEach(item => addProgress(item.stage || 'Working', item.detail || '', job.percent || 0));
  renderedProgress = progressItems.length;

  if (job.status === 'error') {
    clearInterval(pollTimer);
    setBusy(false);
    addMessage('assistant', job.error || 'The build failed.', 'error');
    return;
  }

  if (job.status === 'done') {
    clearInterval(pollTimer);
    setBusy(false);
    addMessage('assistant', 'Done. I built the portfolio and loaded the preview. You can open the code studio, publish, or download the ZIP.');
    currentJobId = job.id;
    localStorage.setItem('killerwork:lastJobId', job.id);
    preview.src = `${job.links.preview}?v=${Date.now()}`;
    preview.classList.remove('hidden');
    previewEmpty.classList.add('hidden');
    address.textContent = job.links.preview;
    setActionLink(editorLink, `/ai-editor.html?job=${encodeURIComponent(job.id)}`);
    setActionLink(downloadLink, job.links.zip);
    publishControl.show();
  }
}

zipInput.addEventListener('change', () => {
  zipName.textContent = zipInput.files?.[0]?.name || 'No ZIP selected';
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const file = zipInput.files?.[0];
  const prompt = promptInput.value.trim();
  if (!file || !prompt) return;

  clearInterval(pollTimer);
  renderedProgress = 0;
  currentJobId = '';
  setActionLink(editorLink, '');
  setActionLink(downloadLink, '');
  publishControl.hide?.();
  preview.classList.add('hidden');
  preview.removeAttribute('src');
  previewEmpty.classList.remove('hidden');
  address.textContent = 'building...';

  addMessage('user', `${prompt}\n\nName: ${nameInput.value.trim() || 'Portfolio'}\nTitle: ${titleInput.value.trim() || 'Advertising Creative'}\nZIP: ${file.name}`);
  setBusy(true);

  try {
    const body = new FormData();
    body.append('name', nameInput.value.trim());
    body.append('jobTitle', titleInput.value.trim());
    body.append('linkedin', linkedinInput.value.trim());
    body.append('style', document.querySelector('input[name="studioStyle"]:checked')?.value || 'straightforward');
    body.append('prompt', prompt);
    body.append('zip', file);
    track('upload_start', { upload_type: 'portfolio_studio_zip', file_count: 1 });
    const authToken = await token();
    const response = await fetch('/api/portfolio-studio/build', { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not start the build.');
    track('upload_success', { upload_type: 'portfolio_studio_zip', file_count: 1 });
    currentJobId = data.id;
    addMessage('assistant', 'I have the ZIP. I’m analyzing the work and building a custom portfolio now.');
    pollTimer = setInterval(() => pollJob().catch(error => {
      clearInterval(pollTimer);
      setBusy(false);
      addMessage('assistant', error.message || 'Build interrupted.', 'error');
    }), 1200);
    await pollJob();
  } catch (error) {
    setBusy(false);
    address.textContent = 'portfolio preview';
    addMessage('assistant', error.message || 'Could not start the build.', 'error');
  }
});

downloadLink.addEventListener('click', async event => {
  if (downloadLink.classList.contains('disabled')) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  try {
    const authToken = await token();
    const response = await fetch(downloadLink.href, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Could not download the ZIP.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'killawork-portfolio.zip';
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    addMessage('assistant', error.message || 'Could not download the ZIP.', 'error');
  }
});

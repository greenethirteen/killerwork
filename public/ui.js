import { setupPublishControl } from './publish.js';

const form = document.getElementById('importForm');
const uploadForm = document.getElementById('uploadForm');
const urlInput = document.getElementById('urlInput');
const uploadTitle = document.getElementById('uploadTitle');
const uploadFiles = document.getElementById('uploadFiles');
const startBtn = document.getElementById('startBtn');
const buildUploadBtn = document.getElementById('buildUploadBtn');
const panel = document.getElementById('progressPanel');
const pill = document.getElementById('statusPill');
const title = document.getElementById('stageTitle');
const detail = document.getElementById('stageDetail');
const bar = document.getElementById('progressBar');
const pct = document.getElementById('percentText');
const logs = document.getElementById('logBox');
const actions = document.getElementById('actions');
const previewLink = document.getElementById('previewLink');
const manageLink = document.getElementById('manageLink');
const editorLink = document.getElementById('editorLink');
const reviewLink = document.getElementById('reviewLink');
const manifestLink = document.getElementById('manifestLink');
const downloadLink = document.getElementById('downloadLink');
const steps = [...document.querySelectorAll('.step')];
const switcher = document.querySelector('.dual-switcher');
const panels = [...document.querySelectorAll('.dual-panel')];
let timer;
let activeButton = startBtn;
let currentJobId = '';

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => currentJobId,
  setStatus: (text, tone = '') => {
    detail.textContent = text;
    if (tone) pill.textContent = tone === 'ok' ? 'Published' : 'Error';
  }
});

if (switcher && panels.length) {
  panels.forEach(panel => {
    const activate = () => {
      switcher.dataset.activePanel = panel.dataset.panel;
    };
    panel.addEventListener('click', activate);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });
}

function setStep(stage){
  const s = String(stage).toLowerCase();
  const map = s.includes('scan') ? 'scan' : s.includes('crawl') || s.includes('analyz') || s.includes('organizing') ? 'crawl' : s.includes('asset') || s.includes('download') || s.includes('saving') ? 'assets' : s.includes('build') || s.includes('generate') ? 'build' : s.includes('validat') ? 'validate' : s.includes('zip') ? 'zip' : '';
  steps.forEach(el => el.classList.toggle('active', el.dataset.step === map));
}

async function poll(id){
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/jobs/${id}`, { headers });
  const job = await res.json();
  const last = job.progress?.[job.progress.length-1];
  panel.classList.remove('hidden');
  pill.textContent = job.status;
  title.textContent = last?.stage || 'Import running';
  detail.textContent = last?.detail || job.url;
  bar.style.width = `${job.percent || 0}%`;
  pct.textContent = `${job.percent || 0}%`;
  logs.textContent = (job.progress || []).map(e => `[${new Date(e.at).toLocaleTimeString()}] ${e.stage}${e.detail ? ' — ' + e.detail : ''}`).join('\n');
  logs.scrollTop = logs.scrollHeight;
  setStep(last?.stage || '');
  if(job.status === 'done'){
    clearInterval(timer);
    pill.textContent = 'Complete';
    actions.classList.remove('hidden');
    currentJobId = job.id;
    previewLink.href = job.links.preview;
    localStorage.setItem('killerwork:lastJobId', job.id);
    manageLink.href = `/manage.html?job=${encodeURIComponent(job.id)}`;
    editorLink.href = `/editor.html?job=${encodeURIComponent(job.id)}`;
    reviewLink.href = job.links.review;
    manifestLink.href = job.links.manifest;
    downloadLink.href = job.links.zip;
    publishControl.show();
    publishControl.setPublished(job.published, job.customDomain);
    activeButton.disabled = false;
    activeButton.textContent = activeButton === buildUploadBtn ? 'Build another portfolio' : 'Start another import';
  }
  if(job.status === 'error'){
    clearInterval(timer);
    pill.textContent = 'Error';
    detail.textContent = job.error || 'Import failed';
    activeButton.disabled = false;
    activeButton.textContent = 'Try again';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  window.KillerWorkAnalytics?.track('import_click', { event_category: 'import', event_label: urlInput.value });
  activeButton = startBtn;
  actions.classList.add('hidden');
  publishControl.hide();
  logs.textContent = '';
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startBtn.disabled = true;
  startBtn.textContent = 'Signing in...';
  bar.style.width = '2%'; pct.textContent = '2%'; title.textContent = 'Starting import'; detail.textContent = urlInput.value;
  let token = '';
  try {
    token = await window.KillerWorkAuth.requireToken();
  } catch (err) {
    detail.textContent = err.message || 'Sign in required.';
    startBtn.disabled = false;
    startBtn.textContent = 'Start import';
    return;
  }
  startBtn.textContent = 'Importing...';
  const res = await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({ url: urlInput.value, aiCleanup: true }) });
  const data = await res.json();
  if(!res.ok){ detail.textContent = data.error || 'Could not start import'; startBtn.disabled=false; return; }
  clearInterval(timer);
  timer = setInterval(() => poll(data.id), 1000);
  poll(data.id);
});

if (uploadForm) {
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    activeButton = buildUploadBtn;
    actions.classList.add('hidden');
    publishControl.hide();
    logs.textContent = '';
    panel.classList.remove('hidden');
    buildUploadBtn.disabled = true;
    buildUploadBtn.textContent = 'Signing in...';
    bar.style.width = '2%'; pct.textContent = '2%'; title.textContent = 'Starting upload build'; detail.textContent = `${uploadFiles.files.length} file(s)`;
    let token = '';
    try {
      token = await window.KillerWorkAuth.requireToken();
    } catch (err) {
      detail.textContent = err.message || 'Sign in required.';
      buildUploadBtn.disabled = false;
      buildUploadBtn.textContent = 'Build from files';
      return;
    }
    buildUploadBtn.textContent = 'Building...';

    const body = new FormData();
    body.append('title', uploadTitle.value || '');
    body.append('aiCleanup', '1');
    [...uploadFiles.files].forEach(file => body.append('files', file));

    const res = await fetch('/api/upload-build', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    const data = await res.json().catch(() => ({}));
    if(!res.ok){ detail.textContent = data.error || 'Could not start upload build'; buildUploadBtn.disabled=false; buildUploadBtn.textContent='Try again'; return; }
    clearInterval(timer);
    timer = setInterval(() => poll(data.id), 1000);
    poll(data.id);
  });
}

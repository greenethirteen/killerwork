const form = document.getElementById('importForm');
const urlInput = document.getElementById('urlInput');
const startBtn = document.getElementById('startBtn');
const panel = document.getElementById('progressPanel');
const pill = document.getElementById('statusPill');
const title = document.getElementById('stageTitle');
const detail = document.getElementById('stageDetail');
const bar = document.getElementById('progressBar');
const pct = document.getElementById('percentText');
const logs = document.getElementById('logBox');
const actions = document.getElementById('actions');
const previewLink = document.getElementById('previewLink');
const editorLink = document.getElementById('editorLink');
const reviewLink = document.getElementById('reviewLink');
const manifestLink = document.getElementById('manifestLink');
const downloadLink = document.getElementById('downloadLink');
const aiCleanup = document.getElementById('aiCleanup');
const steps = [...document.querySelectorAll('.step')];
let timer;

function setStep(stage){
  const s = String(stage).toLowerCase();
  const map = s.includes('scan') ? 'scan' : s.includes('crawl') ? 'crawl' : s.includes('asset') || s.includes('download') ? 'assets' : s.includes('build') || s.includes('generate') ? 'build' : s.includes('validat') ? 'validate' : s.includes('zip') ? 'zip' : '';
  steps.forEach(el => el.classList.toggle('active', el.dataset.step === map));
}

async function poll(id){
  const res = await fetch(`/api/jobs/${id}`);
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
    previewLink.href = job.links.preview;
    editorLink.href = `/editor.html?job=${encodeURIComponent(job.id)}`;
    reviewLink.href = job.links.review;
    manifestLink.href = job.links.manifest;
    downloadLink.href = job.links.zip;
    startBtn.disabled = false;
    startBtn.textContent = 'Start another import';
  }
  if(job.status === 'error'){
    clearInterval(timer);
    pill.textContent = 'Error';
    detail.textContent = job.error || 'Import failed';
    startBtn.disabled = false;
    startBtn.textContent = 'Try again';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  actions.classList.add('hidden');
  logs.textContent = '';
  panel.classList.remove('hidden');
  startBtn.disabled = true;
  startBtn.textContent = 'Importing...';
  bar.style.width = '2%'; pct.textContent = '2%'; title.textContent = 'Starting import'; detail.textContent = urlInput.value;
  const res = await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: urlInput.value, aiCleanup: !!aiCleanup?.checked }) });
  const data = await res.json();
  if(!res.ok){ detail.textContent = data.error || 'Could not start import'; startBtn.disabled=false; return; }
  clearInterval(timer);
  timer = setInterval(() => poll(data.id), 1000);
  poll(data.id);
});

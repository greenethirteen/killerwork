const form = document.getElementById('adbForm');
const titleInput = document.getElementById('adbTitle');
const zipInput = document.getElementById('adbZip');
const zipName = document.getElementById('adbZipName');
const drop = document.getElementById('adbDrop');
const submitButton = document.getElementById('adbSubmit');
const progressPanel = document.getElementById('adbProgress');
const statusPill = document.getElementById('adbStatusPill');
const stageTitle = document.getElementById('adbStageTitle');
const stageDetail = document.getElementById('adbStageDetail');
const percentText = document.getElementById('adbPercentText');
const progressBar = document.getElementById('adbProgressBar');
const result = document.getElementById('adbResult');
const previewLink = document.getElementById('adbPreviewLink');
const editLink = document.getElementById('adbEditLink');
const previewFrame = document.getElementById('adbPreviewFrame');

let pollTimer = null;

function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

async function token() {
  return window.KillerWorkAuth.requireToken();
}

zipInput.addEventListener('change', () => {
  const file = zipInput.files?.[0];
  zipName.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)}MB` : '';
});

['dragover', 'dragenter'].forEach(evt => drop.addEventListener(evt, e => {
  e.preventDefault();
  drop.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(evt => drop.addEventListener(evt, e => {
  e.preventDefault();
  drop.classList.remove('dragover');
}));
drop.addEventListener('drop', e => {
  const file = [...(e.dataTransfer?.files || [])].find(f => /\.zip$/i.test(f.name));
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  zipInput.files = dt.files;
  zipInput.dispatchEvent(new Event('change'));
});

function setProgress(stage, detail, percent, state = 'running') {
  progressPanel.classList.remove('hidden');
  stageTitle.textContent = stage;
  stageDetail.textContent = detail || '';
  percentText.textContent = `${Math.round(percent)}%`;
  progressBar.style.width = `${Math.max(2, Math.min(100, percent))}%`;
  statusPill.textContent = state === 'error' ? 'Failed' : state === 'done' ? 'Done' : 'Working';
}

async function pollJob(id) {
  const authToken = await token();
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const job = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(job.error || 'Could not check the build.');

  const last = (job.progress || [])[job.progress.length - 1];
  if (job.status === 'error') {
    clearInterval(pollTimer);
    setProgress('Build failed', job.error?.split('\n')[0] || last?.detail || 'Something went wrong.', job.percent || 0, 'error');
    submitButton.disabled = false;
    submitButton.textContent = 'Try again';
    track('ad_zip_build_failed');
    return;
  }
  if (job.status === 'done' && job.links) {
    clearInterval(pollTimer);
    setProgress('Your portfolio is ready', 'Preview it below, or open the editor to fine-tune.', 100, 'done');
    previewLink.href = job.links.preview;
    editLink.href = `/pixel-editor.html?job=${encodeURIComponent(id)}`;
    previewFrame.src = job.links.preview;
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    submitButton.disabled = false;
    submitButton.textContent = 'Build another';
    try { localStorage.setItem('killerwork:lastJobId', id); } catch {}
    track('ad_zip_build_done');
    return;
  }
  setProgress(last?.stage || 'Building', last?.detail || '', job.percent || 0);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = zipInput.files?.[0];
  if (!file) { zipName.textContent = 'Choose a ZIP file first.'; return; }

  submitButton.disabled = true;
  submitButton.textContent = 'Building…';
  result.classList.add('hidden');
  setProgress('Uploading ZIP', `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)}MB`, 2);
  track('ad_zip_build_started');

  try {
    const authToken = await token();
    const body = new FormData();
    body.append('zip', file);
    body.append('title', titleInput.value.trim());
    const res = await fetch('/api/ad-zip-build', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    clearInterval(pollTimer);
    pollTimer = setInterval(() => pollJob(data.id).catch(err => {
      clearInterval(pollTimer);
      setProgress('Build failed', err.message, 0, 'error');
      submitButton.disabled = false;
      submitButton.textContent = 'Try again';
    }), 1600);
  } catch (err) {
    setProgress('Build failed', err.message, 0, 'error');
    submitButton.disabled = false;
    submitButton.textContent = 'Try again';
  }
});

import { setupPublishControl } from './publish.js?v=20260617-price999';
import { bindProtectedZipLink } from './billing.js?v=20260617-price999';

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
const importCopyFlip = document.querySelector('.import-copy-flip');
const importCopySlides = [...document.querySelectorAll('.import-copy-slide')];
const squarespacePreview = document.querySelector('[data-squarespace-preview]');
const squarespaceTabs = [...document.querySelectorAll('[data-squarespace-tab]')];
let timer;
let progressTimer;
let displayPercent = 0;
let targetPercent = 0;
let maxPhase = -1;
let activeButton = startBtn;
let currentJobId = '';

function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

document.querySelectorAll('.dual-panel-build .button, .purchase-block .button').forEach(link => {
  link.addEventListener('click', () => track('secondary_cta_click', {
    cta_text: link.textContent.trim(),
    location: link.closest('.purchase-block') ? 'pricing' : 'hero'
  }));
});
startBtn?.addEventListener('click', () => track('hero_cta_click', {
  cta_text: startBtn.textContent.trim(),
  location: 'hero'
}));

const pricing = document.querySelector('.purchase-block');
if (pricing) {
  const pricingObserver = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    track('pricing_view');
    pricingObserver.disconnect();
  }, { threshold: 0.35 });
  pricingObserver.observe(pricing);
}

function syncImportCopyHeight() {
  if (!importCopyFlip || !importCopySlides.length) return;
  const slideHeight = importCopySlides.reduce((maxHeight, slide) => {
    const slideTop = slide.getBoundingClientRect().top;
    const lastChild = slide.lastElementChild;
    const contentBottom = lastChild?.getBoundingClientRect().bottom || slideTop + slide.scrollHeight;
    return Math.max(maxHeight, Math.ceil(contentBottom - slideTop));
  }, 0);
  if (slideHeight > 0) {
    importCopyFlip.style.setProperty('--import-copy-height', `${slideHeight}px`);
  }
}

if (importCopyFlip && importCopySlides.length) {
  requestAnimationFrame(syncImportCopyHeight);
  window.addEventListener('resize', syncImportCopyHeight);
  window.setInterval(syncImportCopyHeight, 250);
}

if (squarespacePreview && squarespaceTabs.length) {
  squarespaceTabs.forEach(button => {
    button.addEventListener('click', () => {
      const state = button.dataset.squarespaceTab;
      squarespacePreview.dataset.squarespacePreview = state;
      squarespaceTabs.forEach(tab => {
        const active = tab === button;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
      track('squarespace_preview_toggle', { state });
    });
  });
}

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => currentJobId,
  setStatus: (text, tone = '') => {
    detail.textContent = text;
    if (tone) pill.textContent = tone === 'ok' ? 'Published' : 'Error';
  }
});
bindProtectedZipLink(downloadLink, (text, tone = '') => {
  detail.textContent = text;
  if (tone) pill.textContent = tone === 'ok' ? 'Complete' : 'Error';
});
previewLink?.addEventListener('click', () => track('action_click', { action: 'preview_site', job_id: currentJobId }));
editorLink?.addEventListener('click', () => track('action_click', { action: 'edit_site', job_id: currentJobId }));
downloadLink?.addEventListener('click', () => track('action_click', { action: 'download_zip', job_id: currentJobId }));
document.querySelector('[data-publish-toggle]')?.addEventListener('click', () => track('action_click', { action: 'publish_open', job_id: currentJobId }));

if (switcher && panels.length) {
  const setActivePanel = panelName => {
    if (panelName) switcher.dataset.activePanel = panelName;
  };

  panels.forEach(panel => {
    const activate = () => {
      setActivePanel(panel.dataset.panel);
    };
    panel.addEventListener('click', activate);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
      }
    });
  });

  buildUploadBtn?.addEventListener('click', event => {
    if (buildUploadBtn.classList.contains('button-disabled') || buildUploadBtn.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      setActivePanel('build');
    }
  });
}

function initLandingMotion() {
  const root = document.querySelector('.parallax-home');
  if (!root) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const mobile = window.matchMedia('(max-width: 760px)').matches;
  const revealItems = [...document.querySelectorAll('[data-reveal]')];
  const parallaxItems = [...document.querySelectorAll('[data-parallax]')];

  document.documentElement.classList.add('motion-ready');

  if (reduceMotion) {
    revealItems.forEach(item => item.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  revealItems.forEach(item => observer.observe(item));

  let scrollFrame = 0;
  const renderParallax = () => {
    const scrollY = window.scrollY;
    const mobileFactor = mobile ? 0.55 : 1;
    parallaxItems.forEach(item => {
      const speed = Number(item.dataset.parallaxSpeed || 0);
      item.style.setProperty('--parallax-y', `${Math.round(scrollY * speed * mobileFactor)}px`);
    });
    scrollFrame = 0;
  };
  const requestParallax = () => {
    if (!scrollFrame) scrollFrame = window.requestAnimationFrame(renderParallax);
  };

  renderParallax();
  window.addEventListener('scroll', requestParallax, { passive: true });

  if (finePointer && switcher) {
    switcher.addEventListener('pointermove', event => {
      const box = switcher.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      switcher.style.setProperty('--stage-tilt-x', `${(-y * 2.2).toFixed(2)}deg`);
      switcher.style.setProperty('--stage-tilt-y', `${(x * 2.8).toFixed(2)}deg`);
    });
    switcher.addEventListener('pointerleave', () => {
      switcher.style.setProperty('--stage-tilt-x', '0deg');
      switcher.style.setProperty('--stage-tilt-y', '0deg');
    });
  }
}

initLandingMotion();

// Forward-only import phases. Each backend stage maps to one of these; the phase
// index only ever increases, so the label never flips back (e.g. from "Importing
// the media" to "Finding the work") during the per-project crawl/download loop.
const PHASES = [
  { title: 'Reading your portfolio', detail: 'Looking through the site and finding the work', step: 'scan' },
  { title: 'Finding the work', detail: 'Collecting projects and campaign structure', step: 'crawl' },
  { title: 'Importing the media', detail: 'Bringing images and videos into KillaWork', step: 'assets' },
  { title: 'Polishing the portfolio', detail: 'Cleaning up structure, titles, and copy', step: 'build' },
  { title: 'Building your preview', detail: 'Turning the imported work into a polished portfolio', step: 'build' },
  { title: 'Checking the preview', detail: 'Making sure the pages are ready to view', step: 'validate' },
  { title: 'Preparing your preview', detail: 'Getting your preview and download ready', step: 'zip' },
];

// Map a backend stage string to a phase index, or -1 when it doesn't clearly
// belong to one (caller then holds the current phase).
function stagePhase(stage = '') {
  const t = String(stage).toLowerCase();
  if (t.includes('zip') || t.includes('ready')) return 6;
  if (t.includes('validat')) return 5;
  if (t.includes('build') || t.includes('generate') || t.includes('static site')) return 4;
  if (t.includes('ai') || t.includes('cleanup') || t.includes('manifest') || t.includes('polish')) return 3;
  if (t.includes('asset') || t.includes('download') || t.includes('saving')) return 2;
  if (t.includes('project') || t.includes('crawl') || t.includes('found') || t.includes('organizing')) return 1;
  if (t.includes('scan') || t.includes('start') || t.includes('read')) return 0;
  return -1;
}

function renderBar(value) {
  const v = Math.max(0, Math.min(100, value));
  bar.style.width = `${v}%`;
  pct.textContent = `${Math.round(v)}%`;
}

// Smoothly eases the displayed bar toward real backend progress while always
// trickling a little further, so it never sits frozen on one number then jumps.
function tickProgress() {
  const ceiling = Math.min(95, targetPercent + 14);
  if (displayPercent < targetPercent) {
    displayPercent += Math.max(0.5, (targetPercent - displayPercent) * 0.16);
  } else if (displayPercent < ceiling) {
    displayPercent += Math.max(0.08, (ceiling - displayPercent) * 0.045);
  }
  displayPercent = Math.min(displayPercent, 99);
  renderBar(displayPercent);
}

function startProgressAnim() {
  if (progressTimer) return;
  progressTimer = setInterval(tickProgress, 150);
}

function stopProgressAnim() {
  clearInterval(progressTimer);
  progressTimer = null;
}

function resetProgress(startAt = 2) {
  displayPercent = startAt;
  targetPercent = startAt;
  maxPhase = -1;
  renderBar(startAt);
  startProgressAnim();
}

function completeProgress() {
  stopProgressAnim();
  displayPercent = 100;
  targetPercent = 100;
  renderBar(100);
}

async function poll(id){
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/jobs/${id}`, { headers });
  const job = await res.json();
  const last = job.progress?.[job.progress.length-1];
  panel.classList.remove('hidden');
  pill.textContent = job.status === 'running' ? 'Working' : job.status;
  // Advance the phase forward only — never regress to an earlier label/step.
  const phase = stagePhase(last?.stage);
  if (phase > maxPhase) maxPhase = phase;
  if (maxPhase >= 0) {
    title.textContent = PHASES[maxPhase].title;
    detail.textContent = PHASES[maxPhase].detail;
  }
  // Feed real progress as a monotonic floor; the animation loop renders it smoothly.
  targetPercent = Math.max(targetPercent, job.percent || 0);
  if (job.status === 'running') startProgressAnim();
  if (logs) {
    const entries = job.progress || [];
    const atBottom = logs.scrollHeight - logs.scrollTop <= logs.clientHeight + 32;
    logs.innerHTML = '';
    entries.forEach((item, i) => {
      const line = document.createElement('span');
      line.className = 'log-line';
      const ts = item.at ? new Date(item.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const msg = [item.stage, item.detail].filter(Boolean).join(' — ');
      if (ts) { const t = document.createElement('span'); t.className = 'log-ts'; t.textContent = ts; line.appendChild(t); }
      line.appendChild(document.createTextNode('> ' + msg));
      logs.appendChild(line);
    });
    if (job.status === 'running') {
      const cur = document.createElement('span');
      cur.className = 'log-cursor';
      logs.appendChild(cur);
    }
    if (atBottom) logs.scrollTop = logs.scrollHeight;
  }
  if (maxPhase >= 0) {
    const stepName = PHASES[maxPhase].step;
    steps.forEach(el => el.classList.toggle('active', el.dataset.step === stepName));
  }
  if(job.status === 'done'){
    clearInterval(timer);
    completeProgress();
    pill.textContent = 'Complete';
    title.textContent = 'Your preview is ready';
    detail.textContent = 'Open it now, make edits, or publish when you are ready';
    actions.classList.remove('hidden');
    currentJobId = job.id;
    previewLink.href = job.links.preview;
    localStorage.setItem('killerwork:lastJobId', job.id);
    manageLink.href = '/manage.html';
    editorLink.href = `/pixel-editor.html?job=${encodeURIComponent(job.id)}`;
    reviewLink.href = job.links.review;
    manifestLink.href = job.links.manifest;
    downloadLink.href = job.links.zip;
    publishControl.show();
    publishControl.setPublished(job.published, job.customDomain);
    activeButton.disabled = false;
    activeButton.textContent = activeButton === buildUploadBtn ? 'Build another portfolio' : 'Start another import';
    track('import_complete', { job_id: job.id, source_url: job.url, source_domain: (() => { try { return new URL(job.url).hostname; } catch { return job.url || ''; } })() });
    window.open(job.links.preview, '_blank', 'noopener');
  }
  if(job.status === 'error'){
    clearInterval(timer);
    stopProgressAnim();
    pill.textContent = 'Error';
    title.textContent = 'Import needs attention';
    detail.textContent = job.error || 'Something stopped the import. Please try again.';
    activeButton.disabled = false;
    activeButton.textContent = 'Try again';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  activeButton = startBtn;
  actions.classList.add('hidden');
  publishControl.hide();
  if (logs) logs.innerHTML = '';
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startBtn.disabled = true;
  startBtn.textContent = 'Signing in...';
  resetProgress(2); title.textContent = 'Getting ready'; detail.textContent = 'We will sign you in and start building a preview';
  let token = '';
  try {
    token = await window.KillerWorkAuth.requireToken();
  } catch (err) {
    detail.textContent = err.message || 'Sign in required.';
    startBtn.disabled = false;
    startBtn.textContent = 'Import it';
    return;
  }
  startBtn.textContent = 'Importing...';
  const importUrl = urlInput.value.trim();
  track('import_start', { source_url: importUrl, source_domain: (() => { try { return new URL(importUrl).hostname; } catch { return ''; } })() });
  const res = await fetch('/api/import', { method:'POST', headers:{'Content-Type':'application/json', Authorization: `Bearer ${token}`}, body: JSON.stringify({ url: importUrl, aiCleanup: true }) });
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
    if (logs) logs.textContent = '';
    panel.classList.remove('hidden');
    buildUploadBtn.disabled = true;
    buildUploadBtn.textContent = 'Signing in...';
    resetProgress(2); title.textContent = 'Starting upload build'; detail.textContent = `${uploadFiles.files.length} file(s)`;
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
    track('upload_start', { file_count: uploadFiles.files.length, upload_type: 'campaign_files' });

    const res = await fetch('/api/upload-build', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
    const data = await res.json().catch(() => ({}));
    if(!res.ok){ detail.textContent = data.error || 'Could not start upload build'; buildUploadBtn.disabled=false; buildUploadBtn.textContent='Try again'; return; }
    track('upload_success', { file_count: uploadFiles.files.length, upload_type: 'campaign_files' });
    clearInterval(timer);
    timer = setInterval(() => poll(data.id), 1000);
    poll(data.id);
  });
}

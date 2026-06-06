import { setupPublishControl } from './publish.js?v=20260602-gtm';
import { bindProtectedZipLink } from './billing.js?v=20260602-gtm';

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

function setStep(stage){
  const s = String(stage).toLowerCase();
  const map = s.includes('scan') ? 'scan' : s.includes('crawl') || s.includes('analyz') || s.includes('organizing') ? 'crawl' : s.includes('asset') || s.includes('download') || s.includes('saving') ? 'assets' : s.includes('build') || s.includes('generate') ? 'build' : s.includes('validat') ? 'validate' : s.includes('zip') ? 'zip' : '';
  steps.forEach(el => el.classList.toggle('active', el.dataset.step === map));
}

function friendlyProgress(stage = '', fallback = '') {
  const text = String(stage).toLowerCase();
  if (text.includes('fail')) return { title: 'Import needs attention', detail: fallback || 'Something stopped the import. Please try again.' };
  if (text.includes('zip') || text.includes('ready')) return { title: 'Preparing your preview', detail: 'Getting your preview and download ready' };
  if (text.includes('validat')) return { title: 'Checking the preview', detail: 'Making sure the pages are ready to view' };
  if (text.includes('build') || text.includes('generate')) return { title: 'Building your preview', detail: 'Turning the imported work into a polished portfolio' };
  if (text.includes('ai') || text.includes('cleanup')) return { title: 'Polishing the portfolio', detail: 'Cleaning up structure, titles, and copy' };
  if (text.includes('asset') || text.includes('download') || text.includes('saving')) return { title: 'Importing the media', detail: 'Bringing images and videos into KillaWork' };
  if (text.includes('project') || text.includes('crawl') || text.includes('found') || text.includes('organizing')) return { title: 'Finding the work', detail: 'Collecting projects and campaign structure' };
  if (text.includes('scan') || text.includes('start')) return { title: 'Reading your portfolio', detail: 'Looking through the site and finding the work' };
  return { title: 'Import running', detail: fallback || 'Your preview is being created' };
}

async function poll(id){
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/jobs/${id}`, { headers });
  const job = await res.json();
  const last = job.progress?.[job.progress.length-1];
  const friendly = friendlyProgress(last?.stage, job.url);
  panel.classList.remove('hidden');
  pill.textContent = job.status === 'running' ? 'Working' : job.status;
  title.textContent = friendly.title;
  detail.textContent = friendly.detail;
  bar.style.width = `${job.percent || 0}%`;
  pct.textContent = `${job.percent || 0}%`;
  if (logs) {
    logs.textContent = '';
  }
  setStep(last?.stage || '');
  if(job.status === 'done'){
    clearInterval(timer);
    pill.textContent = 'Complete';
    title.textContent = 'Your preview is ready';
    detail.textContent = 'Open it now, make edits, or publish when you are ready';
    actions.classList.remove('hidden');
    currentJobId = job.id;
    previewLink.href = job.links.preview;
    localStorage.setItem('killerwork:lastJobId', job.id);
    manageLink.href = `/manage.html?job=${encodeURIComponent(job.id)}`;
    editorLink.href = `/ai-editor.html?job=${encodeURIComponent(job.id)}`;
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
  if (logs) logs.textContent = '';
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startBtn.disabled = true;
  startBtn.textContent = 'Signing in...';
  bar.style.width = '2%'; pct.textContent = '2%'; title.textContent = 'Getting ready'; detail.textContent = 'We will sign you in and start building a preview';
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
    if (logs) logs.textContent = '';
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

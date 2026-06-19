import { setupPublishControl } from './publish.js?v=20260619-publish-modal';

const panels = [...document.querySelectorAll('[data-step-panel]')];
const markers = [...document.querySelectorAll('[data-step-marker]')];
const uploadForm = document.getElementById('zipUploadForm');
const zipFile = document.getElementById('zipFile');
const zipFileName = document.getElementById('zipFileName');
const campaignList = document.getElementById('zipCampaignList');
const campaignTemplate = document.getElementById('zipCampaignTemplate');
const approveCampaigns = document.getElementById('approveCampaigns');
const startZipBuild = document.getElementById('startZipBuild');
const buildTitle = document.getElementById('zipBuildTitle');
const buildDetail = document.getElementById('zipBuildDetail');
const buildBar = document.getElementById('zipBuildBar');
const buildPercent = document.getElementById('zipBuildPercent');
const buildActions = document.getElementById('zipBuildActions');
const previewLink = document.getElementById('zipPreviewLink');
const editLink = document.getElementById('zipEditLink');
const downloadLink = document.getElementById('zipDownloadLink');
const ownerName = document.getElementById('zipOwnerName');
const ownerIntro = document.getElementById('zipOwnerIntro');
let sessionId = '';
let currentJobId = '';
let timer;
let selectedTemplate = 'editorial-grid';
let campaigns = [];

function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

function showStep(step) {
  panels.forEach(panel => panel.classList.toggle('hidden', panel.dataset.stepPanel !== step));
  const activeIndex = markers.findIndex(marker => marker.dataset.stepMarker === step);
  markers.forEach((marker, index) => marker.classList.toggle('active', index <= activeIndex));
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function alphaLabel(index = 0) {
  return `Campaign ${String.fromCharCode(65 + (index % 26))}`;
}

function cardData(card) {
  const read = field => card.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
  return {
    id: card.dataset.id,
    campaign: read('campaign'),
    brand: read('brand'),
    agency: read('agency'),
    notes: read('notes')
  };
}

function renderCampaigns() {
  campaignList.innerHTML = '';
  campaigns.forEach((campaign, index) => {
    const card = campaignTemplate.content.firstElementChild.cloneNode(true);
    card.dataset.id = campaign.id;
    card.querySelector('h3').textContent = campaign.label || alphaLabel(index);
    card.querySelector('[data-field="campaign"]').value = campaign.campaign || '';
    card.querySelector('[data-field="brand"]').value = campaign.brand || '';
    card.querySelector('[data-field="agency"]').value = campaign.agency || '';
    card.querySelector('[data-field="notes"]').value = campaign.notes || '';
    card.querySelector('.zip-campaign-files').innerHTML = (campaign.files || [])
      .map(file => `<span>${escapeHtml(file.name)}</span>`)
      .join('');
    card.querySelector('[data-remove-campaign]').addEventListener('click', () => {
      campaigns = campaigns.filter(item => item.id !== campaign.id);
      renderCampaigns();
    });
    campaignList.appendChild(card);
  });
}

async function token() {
  return window.KillerWorkAuth.requireToken();
}

function setBuildProgress(percent = 0, detail = '') {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  buildBar.style.width = `${normalized}%`;
  buildPercent.textContent = `${normalized}%`;
  if (detail) buildDetail.textContent = detail;
}

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => currentJobId,
  setStatus: text => { buildDetail.textContent = text; }
});

async function pollJob() {
  const authToken = await token();
  const response = await fetch(`/api/jobs/${encodeURIComponent(currentJobId)}`, { headers: { Authorization: `Bearer ${authToken}` } });
  const job = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(job.error || 'Could not check the build.');
  const last = job.progress?.[job.progress.length - 1];
  setBuildProgress(job.percent || 0, last?.detail || last?.stage || 'Building portfolio.');
  if (job.status === 'error') {
    clearInterval(timer);
    buildTitle.textContent = 'Build failed';
    buildDetail.textContent = job.error || 'Could not build the portfolio.';
  }
  if (job.status === 'done') {
    clearInterval(timer);
    setBuildProgress(100, 'Your portfolio is ready to preview, edit, publish, or download.');
    buildTitle.textContent = 'Portfolio ready';
    previewLink.href = job.links.preview;
    editLink.href = `/pixel-editor.html?job=${encodeURIComponent(job.id)}`;
    downloadLink.href = job.links.zip;
    buildActions.classList.remove('hidden');
    publishControl.show();
    localStorage.setItem('killerwork:lastJobId', job.id);
  }
}

zipFile.addEventListener('change', () => {
  zipFileName.textContent = zipFile.files?.[0]?.name || 'No ZIP selected';
});

uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const file = zipFile.files?.[0];
  if (!file) return;
  const button = uploadForm.querySelector('button');
  button.disabled = true;
  button.textContent = 'AI organising...';
  zipFileName.textContent = 'Uploading and checking campaign folders...';
  try {
    const body = new FormData();
    body.append('zip', file);
    track('upload_start', { file_count: 1, upload_type: 'portfolio_zip' });
    const authToken = await token();
    const response = await fetch('/api/zip-builder/analyze', { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not analyse the ZIP.');
    track('upload_success', { file_count: 1, upload_type: 'portfolio_zip' });
    sessionId = data.sessionId;
    campaigns = data.campaigns || [];
    renderCampaigns();
    showStep('review');
  } catch (error) {
    zipFileName.textContent = error.message || 'Could not analyse the ZIP.';
  } finally {
    button.disabled = false;
    button.textContent = 'Organise my work';
  }
});

approveCampaigns.addEventListener('click', () => {
  campaigns = [...campaignList.querySelectorAll('.zip-campaign-card')].map(cardData);
  if (!campaigns.length) {
    window.alert('Keep at least one campaign.');
    return;
  }
  if (campaigns.some(campaign => !campaign.campaign)) {
    window.alert('Add a campaign name for each approved project.');
    return;
  }
  showStep('template');
});

document.getElementById('zipTemplateGrid').addEventListener('click', event => {
  const button = event.target.closest('[data-template]');
  if (!button) return;
  selectedTemplate = button.dataset.template;
  track('template_selected', { template_id: selectedTemplate });
  document.querySelectorAll('[data-template]').forEach(item => item.classList.toggle('selected', item === button));
});

startZipBuild.addEventListener('click', async () => {
  startZipBuild.disabled = true;
  startZipBuild.textContent = 'Starting build...';
  showStep('build');
  setBuildProgress(4, 'Sending your approved campaigns to the portfolio builder.');
  try {
    const authToken = await token();
    const response = await fetch('/api/zip-builder/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        sessionId,
        title: ownerName.value.trim(),
        subtitle: ownerIntro.value.trim(),
        template: selectedTemplate,
        campaigns
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not start the build.');
    currentJobId = data.id;
    timer = setInterval(() => pollJob().catch(error => {
      clearInterval(timer);
      buildTitle.textContent = 'Build interrupted';
      buildDetail.textContent = error.message;
    }), 1000);
    pollJob();
  } catch (error) {
    buildTitle.textContent = 'Build could not start';
    buildDetail.textContent = error.message || 'Try uploading the ZIP again.';
  } finally {
    startZipBuild.disabled = false;
    startZipBuild.textContent = 'Build portfolio';
  }
});

document.querySelectorAll('[data-back-step]').forEach(button => {
  button.addEventListener('click', () => showStep(button.dataset.backStep));
});

downloadLink.addEventListener('click', async event => {
  event.preventDefault();
  if (!downloadLink.href) return;
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
    buildDetail.textContent = error.message || 'Could not download the ZIP.';
  }
});

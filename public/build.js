import { setupPublishControl } from './publish.js';

const form = document.getElementById('campaignBuilder');
const campaignList = document.getElementById('campaignList');
const addCampaign = document.getElementById('addCampaign');
const buildCampaigns = document.getElementById('buildCampaigns');
const template = document.getElementById('campaignTemplate');
const panel = document.getElementById('progressPanel');
const pill = document.getElementById('statusPill');
const stageTitle = document.getElementById('stageTitle');
const stageDetail = document.getElementById('stageDetail');
const progressBar = document.getElementById('progressBar');
const percentText = document.getElementById('percentText');
const logBox = document.getElementById('logBox');
const actions = document.getElementById('actions');
const editorLink = document.getElementById('editorLink');
const previewLink = document.getElementById('previewLink');
const manageLink = document.getElementById('manageLink');
const downloadLink = document.getElementById('downloadLink');

let timer;
let currentJobId = '';

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => currentJobId,
  setStatus: (text, tone = '') => {
    stageDetail.textContent = text;
    if (tone) pill.textContent = tone === 'ok' ? 'Published' : 'Error';
  }
});

function renumberCampaigns() {
  [...campaignList.querySelectorAll('.campaign-card')].forEach((card, index) => {
    card.querySelector('[data-campaign-number]').textContent = String(index + 1);
    card.querySelector('.remove-campaign').classList.toggle('hidden', campaignList.children.length === 1);
  });
}

function updateFileSummary(card) {
  const input = card.querySelector('[data-field="files"]');
  const summary = card.querySelector('[data-file-summary]');
  const count = input.files?.length || 0;
  summary.textContent = count ? `${count} file${count === 1 ? '' : 's'} selected` : 'No files selected';
}

function addCampaignCard() {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector('.remove-campaign').addEventListener('click', () => {
    if (campaignList.children.length > 1) {
      node.remove();
      renumberCampaigns();
    }
  });
  const drop = node.querySelector('.asset-drop');
  const input = node.querySelector('[data-field="files"]');
  input.addEventListener('change', () => updateFileSummary(node));
  ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, event => {
    event.preventDefault();
    drop.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, event => {
    event.preventDefault();
    drop.classList.remove('dragging');
  }));
  campaignList.appendChild(node);
  renumberCampaigns();
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function campaignData(card) {
  const read = field => card.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
  const number = [...campaignList.children].indexOf(card) + 1;
  return {
    title: `Campaign ${number}`,
    campaign: `Campaign ${number}`,
    notes: read('notes')
  };
}

async function poll(id) {
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/jobs/${id}`, { headers });
  const job = await res.json();
  const last = job.progress?.[job.progress.length - 1];
  pill.textContent = job.status;
  stageTitle.textContent = last?.stage || 'Build running';
  stageDetail.textContent = last?.detail || 'Building portfolio';
  progressBar.style.width = `${job.percent || 0}%`;
  percentText.textContent = `${job.percent || 0}%`;
  logBox.textContent = (job.progress || []).map(e => `[${new Date(e.at).toLocaleTimeString()}] ${e.stage}${e.detail ? ' - ' + e.detail : ''}`).join('\n');
  logBox.scrollTop = logBox.scrollHeight;

  if (job.status === 'done') {
    clearInterval(timer);
    pill.textContent = 'Complete';
    actions.classList.remove('hidden');
    currentJobId = job.id;
    localStorage.setItem('killerwork:lastJobId', job.id);
    editorLink.href = `/ai-editor.html?job=${encodeURIComponent(job.id)}`;
    previewLink.href = job.links.preview;
    manageLink.href = `/manage.html?job=${encodeURIComponent(job.id)}`;
    downloadLink.href = job.links.zip;
    publishControl.show();
    publishControl.setPublished(job.published, job.customDomain);
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Build another portfolio';
  }

  if (job.status === 'error') {
    clearInterval(timer);
    pill.textContent = 'Error';
    stageDetail.textContent = job.error || 'Build failed';
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Try again';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const cards = [...campaignList.querySelectorAll('.campaign-card')];
  const campaigns = cards.map(campaignData);
  const totalFiles = cards.reduce((sum, card) => sum + (card.querySelector('[data-field="files"]')?.files?.length || 0), 0);
  if (!totalFiles) {
    stageDetail.textContent = 'Upload at least one asset.';
    panel.classList.remove('hidden');
    return;
  }

  const body = new FormData();
  body.append('title', 'Uploaded Portfolio');
  body.append('campaigns', JSON.stringify(campaigns));
  cards.forEach((card, index) => {
    const files = card.querySelector('[data-field="files"]')?.files || [];
    [...files].forEach(file => body.append(`campaignFiles-${index}`, file));
  });

  actions.classList.add('hidden');
  publishControl.hide();
  panel.classList.remove('hidden');
  logBox.textContent = '';
  buildCampaigns.disabled = true;
  buildCampaigns.textContent = 'Signing in...';
  pill.textContent = 'running';
  stageTitle.textContent = 'Starting campaign build';
  stageDetail.textContent = `${campaigns.length} campaign page(s), ${totalFiles} asset(s)`;
  progressBar.style.width = '2%';
  percentText.textContent = '2%';
  let token = '';
  try {
    token = await window.KillerWorkAuth.requireToken();
  } catch (err) {
    stageDetail.textContent = err.message || 'Sign in required.';
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Build portfolio';
    return;
  }
  buildCampaigns.textContent = 'Building...';

  const res = await fetch('/api/campaign-build', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    stageDetail.textContent = data.error || 'Could not start build';
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Try again';
    return;
  }
  clearInterval(timer);
  timer = setInterval(() => poll(data.id), 1000);
  poll(data.id);
});

addCampaign.addEventListener('click', addCampaignCard);
addCampaignCard();

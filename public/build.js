const form = document.getElementById('campaignBuilder');
const portfolioTitle = document.getElementById('portfolioTitle');
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

function addCampaignCard() {
  const node = template.content.firstElementChild.cloneNode(true);
  node.querySelector('.remove-campaign').addEventListener('click', () => {
    if (campaignList.children.length > 1) node.remove();
  });
  campaignList.appendChild(node);
}

function campaignData(card) {
  const read = field => card.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
  return {
    title: read('title'),
    brand: read('brand'),
    campaign: read('campaign'),
    agency: read('agency'),
    role: read('role'),
    awards: read('awards'),
    notes: read('notes')
  };
}

async function poll(id) {
  const res = await fetch(`/api/jobs/${id}`);
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
    editorLink.href = `/editor.html?job=${encodeURIComponent(job.id)}`;
    previewLink.href = job.links.preview;
    manageLink.href = `/manage.html?job=${encodeURIComponent(job.id)}`;
    downloadLink.href = job.links.zip;
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
  body.append('title', portfolioTitle.value.trim());
  body.append('campaigns', JSON.stringify(campaigns));
  cards.forEach((card, index) => {
    const files = card.querySelector('[data-field="files"]')?.files || [];
    [...files].forEach(file => body.append(`campaignFiles-${index}`, file));
  });

  actions.classList.add('hidden');
  panel.classList.remove('hidden');
  logBox.textContent = '';
  buildCampaigns.disabled = true;
  buildCampaigns.textContent = 'Building...';
  pill.textContent = 'running';
  stageTitle.textContent = 'Starting campaign build';
  stageDetail.textContent = `${campaigns.length} campaign page(s), ${totalFiles} asset(s)`;
  progressBar.style.width = '2%';
  percentText.textContent = '2%';

  const res = await fetch('/api/campaign-build', { method: 'POST', body });
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

import { setupPublishControl } from './publish.js';

const form = document.getElementById('campaignBuilder');
const dashboard = document.getElementById('portfolioDashboard');
const builderFlow = document.getElementById('builderFlow');
const builderBack = document.getElementById('builderBack');
const campaignList = document.getElementById('campaignList');
const addCampaign = document.getElementById('addCampaign');
const buildCampaigns = document.getElementById('buildCampaigns');
const template = document.getElementById('campaignTemplate');
const portfolioHeaderInput = document.getElementById('portfolioHeaderInput');
const portfolioSubheadInput = document.getElementById('portfolioSubheadInput');
const portfolioName = document.getElementById('portfolioName');
const portfolioTagline = document.getElementById('portfolioTagline');
const portfolioGrid = document.getElementById('portfolioGrid');
const previewPortfolioButton = document.getElementById('previewPortfolioButton');
const publishLiveSiteButton = document.getElementById('publishLiveSiteButton');
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
const previewTitle = document.getElementById('builderPreviewTitle');
const previewMeta = document.getElementById('builderPreviewMeta');
const previewArt = document.getElementById('builderPreviewArt');
const previewBrand = document.getElementById('builderPreviewBrand');
const builderFullPreview = document.getElementById('builderFullPreview');

let timer;
let currentJobId = '';
let latestPortfolio = null;

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

function openBuilder() {
  portfolioHeaderInput.value = cleanEditableText(portfolioName?.textContent) || 'Your Name';
  if (portfolioSubheadInput) portfolioSubheadInput.value = cleanEditableText(portfolioTagline?.textContent) || 'Your Job Title or Short Description';
  builderFlow?.classList.remove('hidden');
  if (!campaignList.children.length) addCampaignCard(false);
  document.body.classList.add('builder-modal-open');
  updatePreviewCopy();
  builderFlow?.querySelector('[data-field="files"]')?.focus();
}

function closeBuilder() {
  builderFlow?.classList.add('hidden');
  document.body.classList.remove('builder-modal-open');
}

function cleanEditableText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function updateFileSummary(card) {
  const input = card.querySelector('[data-field="files"]');
  const summary = card.querySelector('[data-file-summary]');
  const count = input.files?.length || 0;
  summary.textContent = count ? `${count} file${count === 1 ? '' : 's'} selected` : 'No files selected';
  const firstImage = [...(input.files || [])].find(file => file.type?.startsWith('image/'));
  if (firstImage && previewArt) {
    const url = URL.createObjectURL(firstImage);
    previewArt.style.backgroundImage = `linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.72)),url("${url}")`;
  }
  updatePreviewCopy();
}

function updatePreviewCopy() {
  const first = campaignList.querySelector('.campaign-card');
  const title = first?.querySelector('[data-field="title"]')?.value?.trim() || 'Your campaign';
  const brandName = first?.querySelector('[data-field="brand"]')?.value?.trim();
  const agency = first?.querySelector('[data-field="agency"]')?.value?.trim();
  const role = [brandName, agency].filter(Boolean).join(' / ') || 'Portfolio page preview';
  const brand = [portfolioHeaderInput?.value?.trim() || 'Your Name', portfolioSubheadInput?.value?.trim()].filter(Boolean).join(' | ');
  if (previewTitle) previewTitle.textContent = title;
  if (previewMeta) previewMeta.textContent = role;
  if (previewBrand) previewBrand.textContent = brand;
}

function addCampaignCard(scroll = true) {
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
  node.querySelectorAll('input, textarea').forEach(field => {
    field.addEventListener('input', updatePreviewCopy);
  });
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
  updatePreviewCopy();
  if (scroll) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function campaignData(card) {
  const read = field => card.querySelector(`[data-field="${field}"]`)?.value?.trim() || '';
  const number = [...campaignList.children].indexOf(card) + 1;
  const title = read('title') || `Campaign ${number}`;
  return {
    title,
    campaign: title,
    brand: read('brand'),
    agency: read('agency'),
    notes: read('notes')
  };
}

function projectTile(project, jobId) {
  const tile = document.createElement('article');
  tile.className = 'portfolio-tile built-project-tile';
  const previewHref = project.preview || `/generated/${jobId}/site/work/${project.slug}/index.html`;
  tile.dataset.href = previewHref;
  const thumb = project.thumbnail || project.thumb || project.image || '';
  if (thumb) tile.style.setProperty('--project-thumb', `url("${thumb}")`);
  tile.innerHTML = `
    <div class="tile-project-actions">
      <a href="${previewHref}" target="_blank" rel="noreferrer" aria-label="Preview ${project.title || 'project'}">Preview</a>
      <a href="/ai-editor.html?job=${encodeURIComponent(jobId)}&path=${encodeURIComponent(`work/${project.slug}/index.html`)}" target="_blank" rel="noreferrer" aria-label="Edit ${project.title || 'project'}">Edit</a>
      <button type="button" data-delete-project="${project.slug}" aria-label="Delete ${project.title || 'project'}">Delete</button>
    </div>
    <strong>${project.title || 'Untitled project'}</strong>
  `;
  tile.addEventListener('click', event => {
    if (event.target.closest('a,button')) return;
    window.open(previewHref, '_blank', 'noopener');
  });
  tile.querySelector('[data-delete-project]')?.addEventListener('click', () => deleteProject(jobId, project.slug));
  return tile;
}

function plusTile(index = 0) {
  const tile = document.createElement('article');
  const classes = ['tile-nike', 'tile-cold', 'tile-flora', 'tile-social', 'tile-pitch', 'tile-car'];
  tile.className = `portfolio-tile ${classes[index % classes.length]}`;
  tile.innerHTML = '<button type="button" data-open-builder aria-label="Add project">+</button>';
  tile.querySelector('button').addEventListener('click', openBuilder);
  return tile;
}

function renderPortfolioPreview(portfolio) {
  if (!portfolioGrid) return;
  portfolioGrid.innerHTML = '';
  const projects = portfolio?.projects || [];
  projects.forEach(project => portfolioGrid.appendChild(projectTile(project, portfolio.id)));
  for (let i = projects.length; i < Math.max(6, projects.length + 1); i += 1) {
    portfolioGrid.appendChild(plusTile(i));
  }
}

async function loadLatestPortfolio() {
  let headers;
  try {
    headers = await window.KillerWorkAuth.authHeaders();
  } catch {
    renderPortfolioPreview(null);
    return;
  }
  const res = await fetch('/api/portfolios', { headers }).catch(() => null);
  if (!res?.ok) {
    renderPortfolioPreview(null);
    return;
  }
  const data = await res.json();
  latestPortfolio = data.portfolios?.[0] || null;
  const lastId = localStorage.getItem('killerwork:lastJobId');
  if (lastId) latestPortfolio = data.portfolios?.find(item => item.id === lastId) || latestPortfolio;
  currentJobId = latestPortfolio?.id || currentJobId;
  if (latestPortfolio?.preview && previewPortfolioButton) {
    previewPortfolioButton.href = latestPortfolio.preview;
    previewPortfolioButton.removeAttribute('aria-disabled');
  }
  renderPortfolioPreview(latestPortfolio);
}

async function deleteProject(jobId, slug) {
  if (!jobId || !slug) return;
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}/projects/${encodeURIComponent(slug)}`, { method: 'DELETE', headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    stageDetail.textContent = data.error || 'Could not delete project.';
    panel.classList.remove('hidden');
    return;
  }
  await loadLatestPortfolio();
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
    builderFullPreview?.classList.remove('hidden');
    if (builderFullPreview) builderFullPreview.href = job.links.preview;
    publishControl.show();
    publishControl.setPublished(job.published, job.customDomain);
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Build another portfolio';
    loadLatestPortfolio();
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
  const portfolioHeader = portfolioHeaderInput?.value?.trim() || cleanEditableText(portfolioName?.textContent) || 'Your Name';
  const portfolioSubhead = portfolioSubheadInput?.value?.trim() || cleanEditableText(portfolioTagline?.textContent);
  const totalFiles = cards.reduce((sum, card) => sum + (card.querySelector('[data-field="files"]')?.files?.length || 0), 0);
  if (!totalFiles) {
    stageDetail.textContent = 'Upload at least one asset.';
    panel.classList.remove('hidden');
    return;
  }

  const body = new FormData();
  body.append('title', portfolioHeader);
  body.append('subtitle', portfolioSubhead);
  body.append('campaigns', JSON.stringify(campaigns));
  cards.forEach((card, index) => {
    const files = card.querySelector('[data-field="files"]')?.files || [];
    [...files].forEach(file => body.append(`campaignFiles-${index}`, file));
  });

  actions.classList.add('hidden');
  publishControl.hide();
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

addCampaign.addEventListener('click', () => addCampaignCard());
portfolioHeaderInput?.addEventListener('input', updatePreviewCopy);
portfolioSubheadInput?.addEventListener('input', updatePreviewCopy);
portfolioName?.addEventListener('input', () => {
  if (portfolioHeaderInput) portfolioHeaderInput.value = cleanEditableText(portfolioName.textContent);
  updatePreviewCopy();
});
portfolioTagline?.addEventListener('input', () => {
  if (portfolioSubheadInput) portfolioSubheadInput.value = cleanEditableText(portfolioTagline.textContent);
  updatePreviewCopy();
});
builderBack?.addEventListener('click', closeBuilder);
document.querySelectorAll('[data-close-builder]').forEach(element => element.addEventListener('click', closeBuilder));
document.querySelectorAll('[data-open-builder]').forEach(button => {
  button.addEventListener('click', openBuilder);
});
previewPortfolioButton?.addEventListener('click', event => {
  if (!latestPortfolio?.preview) {
    event.preventDefault();
    openBuilder();
  }
});
publishLiveSiteButton?.addEventListener('click', () => {
  if (!currentJobId) {
    openBuilder();
    return;
  }
  panel.classList.remove('hidden');
  actions.classList.remove('hidden');
  publishControl.show();
  document.querySelector('[data-publish-toggle]')?.click();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

loadLatestPortfolio();

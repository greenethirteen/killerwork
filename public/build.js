import { setupPublishControl } from './publish.js';

const form = document.getElementById('campaignBuilder');
const dashboard = document.getElementById('portfolioDashboard');
const builderFlow = document.getElementById('builderFlow');
const builderBack = document.getElementById('builderBack');
const campaignList = document.getElementById('campaignList');
const buildCampaigns = document.getElementById('buildCampaigns');
const template = document.getElementById('campaignTemplate');
const portfolioName = document.getElementById('portfolioName');
const portfolioTagline = document.getElementById('portfolioTagline');
const portfolioGrid = document.getElementById('portfolioGrid');
const portfolioSiteSelect = document.getElementById('portfolioSiteSelect');
const previewPortfolioButton = document.getElementById('previewPortfolioButton');
const editPortfolioButton = document.getElementById('editPortfolioButton');
const publishLiveSiteButton = document.getElementById('publishLiveSiteButton');
const panel = document.getElementById('progressPanel');
const pill = document.getElementById('statusPill');
const stageTitle = document.getElementById('stageTitle');
const stageDetail = document.getElementById('stageDetail');
const progressBar = document.getElementById('progressBar');
const percentText = document.getElementById('percentText');

let timer;
let optimisticProgressTimer;
let currentJobId = '';
let latestPortfolio = null;
let buildPortfolios = [];

function setProgress(percent = 0) {
  const normalized = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${normalized}%`;
  percentText.textContent = `${normalized}%`;
  const activeStep = normalized >= 100 ? 3 : normalized >= 62 ? 2 : normalized >= 24 ? 1 : 0;
  panel.querySelectorAll('.builder-generation-steps span').forEach((step, index) => {
    step.classList.toggle('active', index <= activeStep);
  });
}

function showProgress({ status = 'Building', title = 'Building your portfolio page', detail = 'Getting your files ready.', percent = 2 } = {}) {
  panel.classList.remove('hidden');
  form.classList.add('hidden');
  builderFlow?.classList.add('is-building');
  pill.textContent = status;
  stageTitle.textContent = title;
  stageDetail.textContent = detail;
  setProgress(percent);
}

function hideProgress() {
  clearInterval(optimisticProgressTimer);
  panel.classList.add('hidden');
  form.classList.remove('hidden');
  builderFlow?.classList.remove('is-building');
  setProgress(0);
}

function startOptimisticProgress(initial = 12, maximum = 88) {
  clearInterval(optimisticProgressTimer);
  let percent = initial;
  setProgress(percent);
  optimisticProgressTimer = setInterval(() => {
    percent = Math.min(maximum, percent + Math.max(1, Math.ceil((maximum - percent) / 7)));
    setProgress(percent);
  }, 700);
}

async function finishProgress(title, detail) {
  clearInterval(optimisticProgressTimer);
  pill.textContent = 'Complete';
  stageTitle.textContent = title;
  stageDetail.textContent = detail;
  setProgress(100);
  await new Promise(resolve => setTimeout(resolve, 550));
}

function showProgressError(message) {
  clearInterval(optimisticProgressTimer);
  panel.classList.remove('hidden');
  form.classList.remove('hidden');
  builderFlow?.classList.remove('is-building');
  pill.textContent = 'Error';
  stageTitle.textContent = 'Could not build page';
  stageDetail.textContent = message;
}

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
  builderFlow?.classList.remove('hidden');
  hideProgress();
  resetCampaignForm();
  document.body.classList.add('builder-modal-open');
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
  if (scroll) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetCampaignForm() {
  campaignList.innerHTML = '';
  addCampaignCard(false);
  buildCampaigns.disabled = false;
  buildCampaigns.textContent = currentJobId ? 'Create Page' : 'Generate portfolio page';
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
    role: read('role'),
    notes: read('notes')
  };
}

function projectTile(project, jobId) {
  const tile = document.createElement('article');
  tile.className = 'portfolio-tile built-project-tile';
  const previewHref = project.preview || `/generated/${jobId}/site/work/${project.slug}/index.html`;
  tile.dataset.href = previewHref;
  const thumb = project.thumbnail || project.thumb || project.image || '';
  tile.innerHTML = `
    ${thumb ? `<img class="built-project-thumb" src="${thumb}" alt="">` : '<span class="built-project-thumb-placeholder"></span>'}
    <span class="built-project-thumb-loader" aria-hidden="true"></span>
    <div class="tile-project-actions">
      <a class="tile-action-btn" href="${previewHref}" target="_blank" rel="noreferrer" aria-label="Preview ${project.title || 'project'}">Preview</a>
      <a class="tile-action-btn" href="/ai-editor.html?job=${encodeURIComponent(jobId)}&path=${encodeURIComponent(`work/${project.slug}/index.html`)}" target="_blank" rel="noreferrer" aria-label="Edit ${project.title || 'project'}">Edit</a>
      <button class="tile-action-btn" type="button" data-delete-project="${project.slug}" aria-label="Delete ${project.title || 'project'}">Delete page</button>
    </div>
    <strong contenteditable="true" spellcheck="false" data-edit-title="${project.slug}" data-last-title="${project.title || 'Untitled project'}">${project.title || 'Untitled project'}</strong>
  `;
  tile.addEventListener('click', event => {
    if (event.target.closest('a,button')) return;
    window.open(previewHref, '_blank', 'noopener');
  });
  tile.querySelector('[data-delete-project]')?.addEventListener('click', () => deleteProject(jobId, project.slug));
  const image = tile.querySelector('.built-project-thumb');
  const loader = tile.querySelector('.built-project-thumb-loader');
  if (image && loader) {
    const hideLoader = () => loader.classList.add('hidden');
    if (image.complete) hideLoader();
    else {
      image.addEventListener('load', hideLoader, { once: true });
      image.addEventListener('error', hideLoader, { once: true });
    }
  } else if (loader) {
    loader.classList.add('hidden');
  }
  const editableTitle = tile.querySelector('[data-edit-title]');
  editableTitle?.addEventListener('blur', () => saveProjectTitle(jobId, project.slug, editableTitle));
  editableTitle?.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      editableTitle.blur();
    }
  });
  return tile;
}

async function saveProjectTitle(jobId, slug, node) {
  if (!jobId || !slug || !node) return;
  const nextTitle = cleanEditableText(node.textContent || '') || 'Untitled project';
  if (nextTitle === (node.dataset.lastTitle || '')) return;
  const headers = { 'Content-Type': 'application/json', ...(await window.KillerWorkAuth.authHeaders()) };
  const res = await fetch(`/api/editor/${encodeURIComponent(jobId)}/pages/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ title: nextTitle })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || 'Could not rename project.');
    return;
  }
  node.textContent = nextTitle;
  node.dataset.lastTitle = nextTitle;
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

function setPortfolioAction(link, href = '') {
  if (!link) return;
  link.href = href || '#';
  if (href) link.removeAttribute('aria-disabled');
  else link.setAttribute('aria-disabled', 'true');
}

function updatePortfolioControls(portfolio) {
  currentJobId = portfolio?.id || '';
  latestPortfolio = portfolio || null;
  if (portfolioName) portfolioName.textContent = portfolio?.ownerName || portfolio?.siteTitle || 'Your Name';
  if (portfolioTagline) portfolioTagline.textContent = portfolio?.homeIntro || 'Your Job Title or Short Description';
  setPortfolioAction(previewPortfolioButton, portfolio?.preview);
  setPortfolioAction(editPortfolioButton, portfolio?.editor);
  if (portfolioSiteSelect) portfolioSiteSelect.value = portfolio?.id || '';
  if (portfolio) {
    publishControl.setPublished(portfolio.published, portfolio.customDomain);
  } else {
    publishControl.hide();
  }
}

async function loadPortfolio(id) {
  if (!id) {
    updatePortfolioControls(null);
    renderPortfolioPreview(null);
    return null;
  }
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/manage/${encodeURIComponent(id)}`, { headers });
  const portfolio = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(portfolio.error || 'Could not load portfolio.');
  updatePortfolioControls(portfolio);
  renderPortfolioPreview(portfolio);
  localStorage.setItem('killerwork:lastJobId', portfolio.id);
  return portfolio;
}

function renderPortfolioSelector() {
  if (!portfolioSiteSelect) return;
  portfolioSiteSelect.innerHTML = '<option value="">New portfolio</option>';
  for (const portfolio of buildPortfolios) {
    const option = document.createElement('option');
    option.value = portfolio.id;
    option.textContent = `${portfolio.siteTitle || portfolio.ownerName || 'Untitled portfolio'} (${portfolio.projectCount || 0} page${portfolio.projectCount === 1 ? '' : 's'})`;
    portfolioSiteSelect.appendChild(option);
  }
}

async function loadLatestPortfolio(preferredId = '') {
  let headers;
  try {
    headers = await window.KillerWorkAuth.authHeaders();
  } catch {
    updatePortfolioControls(null);
    renderPortfolioPreview(null);
    return;
  }
  const res = await fetch('/api/portfolios', { headers }).catch(() => null);
  if (!res?.ok) {
    renderPortfolioPreview(null);
    return;
  }
  const data = await res.json();
  buildPortfolios = (data.portfolios || []).filter(item => item.buildMode === 'campaign-builder' || item.sourceUrl === 'campaign-builder');
  renderPortfolioSelector();
  let selected = buildPortfolios[0] || null;
  const lastId = localStorage.getItem('killerwork:lastJobId');
  const selectedId = preferredId || new URLSearchParams(location.search).get('portfolio') || lastId;
  if (selectedId) selected = buildPortfolios.find(item => item.id === selectedId) || selected;
  if (new URLSearchParams(location.search).has('new') && !preferredId) selected = null;
  await loadPortfolio(selected?.id || '');
}

async function deleteProject(jobId, slug) {
  if (!jobId || !slug) return;
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}/projects/${encodeURIComponent(slug)}`, { method: 'DELETE', headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    window.alert(data.error || 'Could not delete project.');
    return;
  }
  await loadPortfolio(jobId);
  await loadLatestPortfolio(jobId);
}

async function poll(id) {
  const headers = await window.KillerWorkAuth.authHeaders();
  const res = await fetch(`/api/jobs/${id}`, { headers });
  const job = await res.json();
  const last = job.progress?.[job.progress.length - 1];
  pill.textContent = job.status;
  stageTitle.textContent = last?.stage || 'Build running';
  stageDetail.textContent = last?.detail || 'Building portfolio';
  setProgress(job.percent || 0);

  if (job.status === 'done') {
    clearInterval(timer);
    currentJobId = job.id;
    localStorage.setItem('killerwork:lastJobId', job.id);
    publishControl.show();
    publishControl.setPublished(job.published, job.customDomain);
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Create Page';
    await finishProgress('Portfolio page ready', 'Your new project is now in the portfolio preview.');
    closeBuilder();
    hideProgress();
    await loadLatestPortfolio(job.id);
  }

  if (job.status === 'error') {
    clearInterval(timer);
    showProgressError(job.error || 'Build failed');
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Try again';
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const cards = [...campaignList.querySelectorAll('.campaign-card')];
  const campaigns = cards.map(campaignData);
  const portfolioHeader = cleanEditableText(portfolioName?.textContent) || 'Your Name';
  const portfolioSubhead = cleanEditableText(portfolioTagline?.textContent);
  const totalFiles = cards.reduce((sum, card) => sum + (card.querySelector('[data-field="files"]')?.files?.length || 0), 0);
  if (!totalFiles) {
    showProgressError('Upload at least one asset.');
    return;
  }

  const body = new FormData();
  if (currentJobId) {
    const campaign = campaigns[0];
    const prompt = [
      campaign.brand ? `Brand: ${campaign.brand}` : '',
      campaign.agency ? `Agency: ${campaign.agency}` : '',
      campaign.notes || ''
    ].filter(Boolean).join('\n');
    body.append('title', campaign.title);
    body.append('prompt', prompt);
    body.append('buildMode', 'campaign-builder');
    body.append('brand', campaign.brand);
    body.append('agency', campaign.agency);
    body.append('role', campaign.role);
    body.append('notes', campaign.notes);
    const files = cards[0].querySelector('[data-field="files"]')?.files || [];
    [...files].forEach(file => body.append('files', file));
    showProgress({ title: 'Adding portfolio page', detail: `${campaign.title}, ${totalFiles} asset(s)`, percent: 12 });
    startOptimisticProgress(12);
    buildCampaigns.disabled = true;
    buildCampaigns.textContent = 'Building...';
    try {
      const token = await window.KillerWorkAuth.requireToken();
      const res = await fetch(`/api/editor/${encodeURIComponent(currentJobId)}/pages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not add portfolio page.');
      await finishProgress('Portfolio page added', `${data.page?.title || campaign.title} is now in your portfolio.`);
      closeBuilder();
      hideProgress();
      await loadPortfolio(currentJobId);
      await loadLatestPortfolio(currentJobId);
    } catch (err) {
      showProgressError(err.message || 'Could not add portfolio page.');
    } finally {
      buildCampaigns.disabled = false;
      buildCampaigns.textContent = 'Create Page';
    }
    return;
  }
  body.append('title', portfolioHeader);
  body.append('subtitle', portfolioSubhead);
  body.append('campaigns', JSON.stringify(campaigns));
  cards.forEach((card, index) => {
    const files = card.querySelector('[data-field="files"]')?.files || [];
    [...files].forEach(file => body.append(`campaignFiles-${index}`, file));
  });

  publishControl.hide();
  showProgress({ title: 'Starting campaign build', detail: `${campaigns.length} campaign page(s), ${totalFiles} asset(s)`, percent: 2 });
  buildCampaigns.disabled = true;
  buildCampaigns.textContent = 'Signing in...';
  let token = '';
  try {
    token = await window.KillerWorkAuth.requireToken();
  } catch (err) {
    showProgressError(err.message || 'Sign in required.');
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Build portfolio';
    return;
  }
  buildCampaigns.textContent = 'Building...';

  const res = await fetch('/api/campaign-build', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showProgressError(data.error || 'Could not start build');
    buildCampaigns.disabled = false;
    buildCampaigns.textContent = 'Try again';
    return;
  }
  clearInterval(timer);
  timer = setInterval(() => poll(data.id), 1000);
  poll(data.id);
});

builderBack?.addEventListener('click', closeBuilder);
document.querySelectorAll('[data-close-builder]').forEach(element => element.addEventListener('click', closeBuilder));
document.querySelectorAll('[data-open-builder]').forEach(button => {
  button.addEventListener('click', openBuilder);
});
previewPortfolioButton?.addEventListener('click', event => {
  if (!latestPortfolio?.preview) event.preventDefault();
});
editPortfolioButton?.addEventListener('click', event => {
  if (!latestPortfolio?.editor) event.preventDefault();
});
publishLiveSiteButton?.addEventListener('click', () => {
  if (!currentJobId) {
    openBuilder();
    return;
  }
  publishControl.show();
  document.querySelector('[data-publish-toggle]')?.click();
});
portfolioSiteSelect?.addEventListener('change', () => {
  const id = portfolioSiteSelect.value;
  if (id) history.replaceState(null, '', `/build.html?portfolio=${encodeURIComponent(id)}`);
  else history.replaceState(null, '', `/build.html?new=${Date.now()}`);
  loadPortfolio(id).catch(err => {
    window.alert(err.message || 'Could not load portfolio.');
  });
});

loadLatestPortfolio();

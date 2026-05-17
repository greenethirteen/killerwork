import { setupPublishControl } from './publish.js';

const params = new URLSearchParams(location.search);
const jobId = params.get('job');
if (jobId) localStorage.setItem('killerwork:lastJobId', jobId);
const ownerNameInput = document.getElementById('ownerNameInput');
const siteTitleInput = document.getElementById('siteTitleInput');
const savePortfolio = document.getElementById('savePortfolio');
const deletePortfolio = document.getElementById('deletePortfolio');
const portfolioPreview = document.getElementById('portfolioPreview');
const portfolioEditor = document.getElementById('portfolioEditor');
const portfolioZip = document.getElementById('portfolioZip');
const managerStatus = document.getElementById('managerStatus');
const projectList = document.getElementById('projectList');
const managerForm = document.querySelector('.manager-form');
const managerActions = document.querySelector('.manager-actions');

let portfolio = null;

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => jobId,
  setStatus
});

if (!jobId) {
  managerForm?.classList.add('hidden');
  managerActions?.classList.add('hidden');
}

async function authHeaders() {
  const token = await window.KillerWorkAuth.requireToken();
  return { Authorization: `Bearer ${token}` };
}

function setStatus(text, tone = '') {
  managerStatus.textContent = text;
  managerStatus.dataset.tone = tone;
}

function projectCount(project) {
  const parts = [];
  if (project.images) parts.push(`${project.images} image${project.images === 1 ? '' : 's'}`);
  if (project.videos) parts.push(`${project.videos} video${project.videos === 1 ? '' : 's'}`);
  if (project.documents) parts.push(`${project.documents} PDF${project.documents === 1 ? '' : 's'}`);
  return parts.join(' / ') || 'No media';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function renderProjects() {
  projectList.innerHTML = '';
  if (!portfolio?.projects?.length) {
    const empty = document.createElement('article');
    empty.className = 'manager-empty';
    empty.textContent = 'No projects left in this portfolio.';
    projectList.appendChild(empty);
    return;
  }

  portfolio.projects.forEach(project => {
    const row = document.createElement('article');
    row.className = 'manager-project';
    row.innerHTML = `
      <div>
        <h2>${escapeHtml(project.title)}</h2>
        <p>${projectCount(project)}</p>
      </div>
      <div class="manager-project-actions">
        <a class="button ghost" href="${project.preview}" target="_blank">Preview</a>
        <a class="button secondary" href="${project.editor}">Edit</a>
        <button class="danger-button" type="button">Delete</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => deleteProject(project));
    projectList.appendChild(row);
  });
}

function renderPortfolioList(portfolios) {
  projectList.innerHTML = '';
  if (!portfolios.length) {
    const empty = document.createElement('article');
    empty.className = 'manager-empty manager-empty-stack';
    empty.innerHTML = `
      <div>
        <h2>No portfolios yet</h2>
        <p>Import an existing portfolio or build one from campaign files, then it will appear here.</p>
      </div>
      <div class="manager-project-actions">
        <a class="button" href="/">Import portfolio</a>
        <a class="button secondary" href="/build.html">Build from files</a>
      </div>
    `;
    projectList.appendChild(empty);
    return;
  }

  portfolios.forEach(item => {
    const row = document.createElement('article');
    row.className = 'manager-project';
    const projectLabel = `${item.projectCount} project${item.projectCount === 1 ? '' : 's'}`;
    const source = item.sourceUrl ? ` from ${escapeHtml(item.sourceUrl)}` : '';
    row.innerHTML = `
      <div>
        <h2>${escapeHtml(item.siteTitle)}</h2>
        <p>${projectLabel}${source}</p>
      </div>
      <div class="manager-project-actions">
        <a class="button" href="${item.manage}">Manage</a>
        <a class="button secondary" href="${item.editor}">Edit pages</a>
        <a class="button ghost" href="${item.preview}" target="_blank">Preview</a>
        <button class="danger-button" type="button" data-delete-portfolio="${escapeHtml(item.id)}">Delete</button>
      </div>
    `;
    row.querySelector('[data-delete-portfolio]').addEventListener('click', () => deletePortfolioItem(item, row));
    projectList.appendChild(row);
  });
}

async function deletePortfolioItem(item, row) {
  if (!confirm(`Delete "${item.siteTitle}" and all of its projects? This cannot be undone.`)) return;
  setStatus(`Deleting ${item.siteTitle}...`);
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(item.id)}`, { method: 'DELETE', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(data.error || 'Delete failed.', 'error');
    return;
  }
  row.remove();
  if (!projectList.children.length) renderPortfolioList([]);
  setStatus('Portfolio deleted.', 'ok');
}

async function loadPortfolioDashboard() {
  setStatus('Loading your portfolios...');
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch('/api/portfolios', { headers });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Could not load portfolios.', 'error');
    return;
  }
  renderPortfolioList(data.portfolios || []);
  setStatus(data.portfolios?.length ? 'Choose a portfolio to manage.' : 'No portfolios yet.');
}

function applyPortfolio(data) {
  portfolio = data;
  ownerNameInput.value = data.ownerName || '';
  siteTitleInput.value = data.siteTitle || '';
  portfolioPreview.href = data.preview;
  portfolioEditor.href = data.editor;
  portfolioZip.href = data.zip;
  publishControl.setPublished(data.published, data.customDomain);
  renderProjects();
}

async function loadPortfolio() {
  if (!jobId) {
    await loadPortfolioDashboard();
    return;
  }
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`, { headers });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Could not load portfolio.', 'error');
    return;
  }
  applyPortfolio(data);
  setStatus('Portfolio loaded.');
}

savePortfolio.addEventListener('click', async () => {
  if (!portfolio) return;
  savePortfolio.disabled = true;
  savePortfolio.textContent = 'Saving...';
  setStatus('Saving and rebuilding preview/ZIP...');
  let headers;
  try {
    headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    savePortfolio.disabled = false;
    savePortfolio.textContent = 'Save portfolio';
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ownerName: ownerNameInput.value,
      siteTitle: siteTitleInput.value
    })
  });
  const data = await res.json();
  savePortfolio.disabled = false;
  savePortfolio.textContent = 'Save portfolio';
  if (!res.ok) {
    setStatus(data.error || 'Save failed.', 'error');
    return;
  }
  applyPortfolio(data);
  setStatus(data.validation?.ok ? 'Saved. Preview and ZIP rebuilt.' : 'Saved with validation warnings.', data.validation?.ok ? 'ok' : 'warn');
});

async function deleteProject(project) {
  if (!confirm(`Delete "${project.title}" from this portfolio?`)) return;
  setStatus(`Deleting ${project.title}...`);
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}/projects/${encodeURIComponent(project.slug)}`, { method: 'DELETE', headers });
  const data = await res.json();
  if (!res.ok) {
    setStatus(data.error || 'Delete failed.', 'error');
    return;
  }
  applyPortfolio(data);
  setStatus(data.validation?.ok ? 'Project deleted. Preview and ZIP rebuilt.' : 'Project deleted with validation warnings.', data.validation?.ok ? 'ok' : 'warn');
}

deletePortfolio.addEventListener('click', async () => {
  if (!portfolio) return;
  if (!confirm('Delete this entire generated portfolio and its stored assets?')) return;
  let headers;
  try {
    headers = await authHeaders();
  } catch (err) {
    setStatus(err.message || 'Sign in required.', 'error');
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`, { method: 'DELETE', headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(data.error || 'Delete failed.', 'error');
    return;
  }
  setStatus('Portfolio deleted.', 'ok');
  projectList.innerHTML = '';
  savePortfolio.disabled = true;
  deletePortfolio.disabled = true;
});

loadPortfolio();

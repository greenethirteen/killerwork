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
        <a class="button secondary" href="${project.editor}">AI Edit</a>
        <button class="danger-button" type="button">Delete</button>
      </div>
    `;
    row.querySelector('button').addEventListener('click', () => deleteProject(project));
    projectList.appendChild(row);
  });
}

function publishControlHtml() {
  return `
    <div class="publish-control manager-row-publish" data-publish-domain="killa.work">
      <button class="button secondary compact-button" type="button" data-publish-toggle>Publish</button>
      <div class="publish-panel hidden" data-publish-panel>
        <form data-publish-form>
          <label>
            <span>Portfolio URL</span>
            <div class="publish-url-field">
              <input data-publish-input type="text" placeholder="abdullahfarouk" autocomplete="off" />
              <b>.killa.work</b>
            </div>
          </label>
          <button data-publish-submit type="submit">Publish</button>
        </form>
        <p class="publish-result hidden" data-publish-result></p>
        <div class="custom-domain-block" data-custom-domain-block>
          <div class="publish-divider">Or connect your own domain</div>
          <form data-custom-domain-form>
            <label>
              <span>Owned domain</span>
              <input data-custom-domain-input type="text" placeholder="www.yourportfolio.com" autocomplete="off" disabled />
            </label>
            <button data-custom-domain-submit type="submit" disabled>Connect domain</button>
          </form>
          <div class="custom-domain-instructions hidden" data-custom-domain-instructions>
            <h4>DNS setup</h4>
            <p>Add this CNAME record where you bought your domain.</p>
            <div class="dns-record">
              <strong>Type:</strong> CNAME<br>
              <strong>Name:</strong> <span data-dns-name>www.yourportfolio.com</span><br>
              <strong>Value:</strong> <span data-dns-value>your-name.killa.work</span>
            </div>
            <p class="note">Publish to a KillaWork URL first. DNS changes can take a while to appear everywhere.</p>
          </div>
          <p class="publish-result hidden" data-custom-domain-result></p>
        </div>
      </div>
    </div>
  `;
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
    const buildDashboard = item.buildMode === 'campaign-builder' || item.sourceUrl === 'campaign-builder'
      ? `<a class="button secondary compact-button" href="/build.html?portfolio=${encodeURIComponent(item.id)}">Manage</a>`
      : '';
    row.innerHTML = `
      <div>
        <h2>${escapeHtml(item.siteTitle)}</h2>
        <p>${projectLabel}${source}</p>
      </div>
      <div class="manager-project-actions">
        <a class="button secondary compact-button" href="${item.editor}">AI Edit</a>
        ${buildDashboard}
        <a class="button ghost compact-button" href="${item.preview}" target="_blank">Preview</a>
        <button class="danger-button compact-button" type="button" data-delete-portfolio="${escapeHtml(item.id)}">Delete</button>
        <a class="button hot compact-button" href="${item.zip}">Download Zip</a>
        ${publishControlHtml()}
      </div>
    `;
    row.querySelector('[data-delete-portfolio]').addEventListener('click', () => deletePortfolioItem(item, row));
    const rowPublish = setupPublishControl({
      control: row.querySelector('.manager-row-publish'),
      getJobId: () => item.id,
      setStatus
    });
    rowPublish.setPublished(item.published, item.customDomain);
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
  setStatus(data.portfolios?.length ? 'Your imported portfolios are ready.' : 'No portfolios yet.');
}

function applyPortfolio(data) {
  portfolio = data;
  if (ownerNameInput) ownerNameInput.value = data.ownerName || '';
  if (siteTitleInput) siteTitleInput.value = data.siteTitle || '';
  if (portfolioPreview) portfolioPreview.href = data.preview;
  if (portfolioEditor) portfolioEditor.href = data.editor;
  if (portfolioZip) portfolioZip.href = data.zip;
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

savePortfolio?.addEventListener('click', async () => {
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

deletePortfolio?.addEventListener('click', async () => {
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

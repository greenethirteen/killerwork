const params = new URLSearchParams(location.search);
const jobId = params.get('job');
const ownerNameInput = document.getElementById('ownerNameInput');
const siteTitleInput = document.getElementById('siteTitleInput');
const savePortfolio = document.getElementById('savePortfolio');
const deletePortfolio = document.getElementById('deletePortfolio');
const portfolioPreview = document.getElementById('portfolioPreview');
const portfolioEditor = document.getElementById('portfolioEditor');
const portfolioZip = document.getElementById('portfolioZip');
const managerStatus = document.getElementById('managerStatus');
const projectList = document.getElementById('projectList');

let portfolio = null;

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
        <h2>${project.title}</h2>
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

function applyPortfolio(data) {
  portfolio = data;
  ownerNameInput.value = data.ownerName || '';
  siteTitleInput.value = data.siteTitle || '';
  portfolioPreview.href = data.preview;
  portfolioEditor.href = data.editor;
  portfolioZip.href = data.zip;
  renderProjects();
}

async function loadPortfolio() {
  if (!jobId) {
    setStatus('Missing job id. Open this page from a completed portfolio build.', 'error');
    return;
  }
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`);
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
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}/projects/${encodeURIComponent(project.slug)}`, { method: 'DELETE' });
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
  const res = await fetch(`/api/manage/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
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

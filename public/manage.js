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

let portfolio = null;

const publishControl = setupPublishControl({
  control: document.getElementById('publishControl'),
  getJobId: () => jobId,
  setStatus
});

function setupCustomDomainControl({ control, getJobId, setStatus }) {
  if (!control) return { show() {}, hide() {}, setCustomDomain() {} };
  const toggle = control.querySelector('[data-custom-domain-toggle]');
  const panel = control.querySelector('[data-custom-domain-panel]');
  const form = control.querySelector('[data-custom-domain-form]');
  const input = control.querySelector('[data-custom-domain-input]');
  const result = control.querySelector('[data-custom-domain-result]');
  const instructions = control.querySelector('[data-custom-domain-instructions]');
  const dnsName = control.querySelector('[data-dns-name]');
  const dnsValue = control.querySelector('[data-dns-value]');
  const submit = control.querySelector('[data-custom-domain-submit]');

  function cleanDomain(value) {
    return String(value || '').toLowerCase().trim();
  }

  function showInstructions(domain) {
    if (!instructions || !dnsName || !dnsValue) return;
    instructions.classList.remove('hidden');
    dnsName.textContent = domain;
    dnsValue.textContent = `${portfolio.published?.subdomain || 'your-subdomain'}.killer.work`;
  }

  function hideInstructions() {
    if (!instructions) return;
    instructions.classList.add('hidden');
  }

  function resultLink(domain) {
    if (!result) return;
    if (!domain) {
      result.classList.add('hidden');
      result.innerHTML = '';
      return;
    }
    result.classList.remove('hidden');
    result.textContent = '';
    const label = document.createElement('span');
    label.textContent = 'Connected to';
    const link = document.createElement('a');
    link.href = `https://${domain}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = domain;
    result.append(label, link);
  }

  function openPanel() {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) input.focus();
  }

  toggle.addEventListener('click', openPanel);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const jobId = getJobId();
    const domain = cleanDomain(input.value);
    if (!jobId) return setStatus?.('Build or import a portfolio before connecting a domain.', 'error');
    if (!domain) return setStatus?.('Enter a domain before connecting.', 'error');
    if (!portfolio?.published?.subdomain) return setStatus?.('Publish your portfolio first before connecting a custom domain.', 'error');
    submit.disabled = true;
    submit.textContent = 'Connecting...';
    setStatus?.(`Connecting ${domain}...`);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await authHeaders()) };
      const res = await fetch(`/api/custom-domain/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Domain connection failed.');
      input.value = data.customDomain?.domain || domain;
      resultLink(data.customDomain?.domain);
      showInstructions(data.customDomain?.domain);
      panel.classList.add('hidden');
      setStatus?.(`${domain} connected. Update your DNS settings.`, 'ok');
    } catch (err) {
      setStatus?.(err.message || 'Domain connection failed.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Connect Domain';
    }
  });

  return {
    show() {
      control.classList.remove('hidden');
    },
    hide() {
      control.classList.add('hidden');
      panel.classList.add('hidden');
      resultLink(null);
      hideInstructions();
    },
    setCustomDomain(customDomain) {
      if (customDomain?.domain) {
        input.value = customDomain.domain;
        resultLink(customDomain.domain);
        showInstructions(customDomain.domain);
      }
    }
  };
}

const customDomainControl = setupCustomDomainControl({
  control: document.getElementById('customDomainControl'),
  getJobId: () => jobId,
  setStatus
});

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
  publishControl.setPublished(data.published);
  customDomainControl.setCustomDomain(data.customDomain);
  // Show custom domain control only if published
  if (data.published?.subdomain) {
    customDomainControl.show();
  } else {
    customDomainControl.hide();
  }
  renderProjects();
}

async function loadPortfolio() {
  if (!jobId) {
    setStatus('Missing job id. Open this page from a completed portfolio build.', 'error');
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

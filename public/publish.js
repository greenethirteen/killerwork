export function setupPublishControl({ control, getJobId, setStatus }) {
  if (!control) return { show() {}, hide() {}, setPublished() {} };
  const toggle = control.querySelector('[data-publish-toggle]');
  const panel = control.querySelector('[data-publish-panel]');
  const form = control.querySelector('[data-publish-form]');
  const input = control.querySelector('[data-publish-input]');
  const result = control.querySelector('[data-publish-result]');
  const submit = control.querySelector('[data-publish-submit]');
  const domain = control.dataset.publishDomain || 'killa.work';

  function clean(value) {
    return String(value || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  }

  function resultLink(published) {
    if (!result) return;
    if (!published) {
      result.classList.add('hidden');
      result.innerHTML = '';
      return;
    }
    const href = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? published.localPreview : published.url;
    result.classList.remove('hidden');
    result.textContent = '';
    const label = document.createElement('span');
    label.textContent = 'Published at';
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = published.url;
    result.append(label, link);
  }

  function openPanel() {
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) input.focus();
  }

  toggle.addEventListener('click', openPanel);
  input.addEventListener('input', () => {
    input.value = clean(input.value);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const jobId = getJobId();
    const subdomain = clean(input.value);
    if (!jobId) return setStatus?.('Build or import a portfolio before publishing.', 'error');
    if (!subdomain) return setStatus?.('Choose a subdomain before publishing.', 'error');
    submit.disabled = true;
    submit.textContent = 'Publishing...';
    setStatus?.(`Publishing to ${subdomain}.${domain}...`);
    try {
      const headers = { 'Content-Type': 'application/json', ...(await window.KillerWorkAuth.authHeaders()) };
      const res = await fetch(`/api/publish/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subdomain })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Publish failed.');
      input.value = data.published?.subdomain || subdomain;
      resultLink(data.published);
      panel.classList.add('hidden');
      setStatus?.(`Published at ${data.published.url}`, 'ok');
    } catch (err) {
      setStatus?.(err.message || 'Publish failed.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Publish';
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
    },
    setPublished(published) {
      if (published?.subdomain) input.value = published.subdomain;
      resultLink(published);
    }
  };
}

import { handleSubscriptionRequired } from './billing.js?v=20260602-gtm';

export function setupPublishControl({ control, getJobId, setStatus }) {
  const noop = { show() {}, hide() {}, setPublished() {} };
  if (!control) return noop;
  const toggle = control.querySelector('[data-publish-toggle]');
  const panel = control.querySelector('[data-publish-panel]');
  const form = control.querySelector('[data-publish-form]');
  const input = control.querySelector('[data-publish-input]');
  const result = control.querySelector('[data-publish-result]');
  const submit = control.querySelector('[data-publish-submit]');
  const domain = control.dataset.publishDomain || 'killa.work';
  const customForm = control.querySelector('[data-custom-domain-form]');
  const customInput = control.querySelector('[data-custom-domain-input]');
  const customSubmit = control.querySelector('[data-custom-domain-submit]');
  const customResult = control.querySelector('[data-custom-domain-result]');
  const customInstructions = control.querySelector('[data-custom-domain-instructions]');
  const dnsName = control.querySelector('[data-dns-name]');
  const dnsValue = control.querySelector('[data-dns-value]');
  const customBlock = control.querySelector('[data-custom-domain-block]');
  let publishedState = null;

  if (!toggle || !panel || !form || !input || !submit) {
    console.warn('Publish control is missing required elements and has been disabled.');
    return noop;
  }

  if (panel && !panel.querySelector('[data-founder-help]')) {
    const help = document.createElement('p');
    help.className = 'publish-help';
    help.dataset.founderHelp = 'true';
    help.append('Need help? ');
    const link = document.createElement('a');
    link.href = 'https://wa.me/971585002138';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Contact the Founder.';
    help.append(link);
    panel.appendChild(help);
  }

  function clean(value) {
    return String(value || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  }

  function cleanDomain(value) {
    return String(value || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@$/, '');
  }

  async function authedJsonHeaders() {
    const token = await window.KillerWorkAuth.requireToken();
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  }

  function linkResult(target, labelText, href, text) {
    if (!target) return;
    target.classList.remove('hidden');
    target.textContent = '';
    const label = document.createElement('span');
    label.textContent = labelText;
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = text;
    target.append(label, link);
  }

  function resultLink(published) {
    if (!result) return;
    if (!published) {
      result.classList.add('hidden');
      result.innerHTML = '';
      return;
    }
    const href = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? published.localPreview : published.url;
    linkResult(result, 'Published at', href, published.url);
  }

  function customResultLink(customDomain) {
    if (!customResult) return;
    if (!customDomain?.domain) {
      customResult.classList.add('hidden');
      customResult.innerHTML = '';
      return;
    }
    linkResult(customResult, 'Connected domain', `https://${customDomain.domain}`, customDomain.domain);
  }

  function updateCustomDomainState(customDomain = null) {
    if (!customBlock) return;
    const canConnect = !!publishedState?.subdomain;
    customBlock.dataset.enabled = canConnect ? 'true' : 'false';
    if (customInput) customInput.disabled = !canConnect;
    if (customSubmit) customSubmit.disabled = !canConnect;
    if (dnsName) dnsName.textContent = customDomain?.domain || 'www.yourportfolio.com';
    if (dnsValue) dnsValue.textContent = publishedState?.subdomain ? `${publishedState.subdomain}.${domain}` : `your-name.${domain}`;
    if (customInstructions) customInstructions.classList.toggle('hidden', !canConnect);
    if (customDomain?.domain && customInput) customInput.value = customDomain.domain;
    customResultLink(customDomain);
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
      const headers = await authedJsonHeaders();
      const res = await fetch(`/api/publish/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ subdomain })
      });
      const data = await res.json().catch(() => ({}));
      if (await handleSubscriptionRequired(res, data, setStatus)) return;
      if (!res.ok) throw new Error(data.error || 'Publish failed.');
      input.value = data.published?.subdomain || subdomain;
      publishedState = data.published;
      resultLink(data.published);
      updateCustomDomainState(data.customDomain);
      panel.classList.add('hidden');
      setStatus?.(`Published at ${data.published.url}`, 'ok');
    } catch (err) {
      setStatus?.(err.message || 'Publish failed.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Publish';
    }
  });

  customInput?.addEventListener('input', () => {
    customInput.value = cleanDomain(customInput.value);
  });

  customForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!customInput || !customSubmit) {
      setStatus?.('Custom domain form is not ready.', 'error');
      return;
    }
    const jobId = getJobId();
    const customDomain = cleanDomain(customInput?.value || '');
    if (!jobId) return setStatus?.('Build or import a portfolio before connecting a domain.', 'error');
    if (!publishedState?.subdomain) return setStatus?.(`Publish to a ${domain} URL before connecting your own domain.`, 'error');
    if (!customDomain) return setStatus?.('Enter the domain you own before connecting.', 'error');
    customSubmit.disabled = true;
    customSubmit.textContent = 'Connecting...';
    setStatus?.(`Connecting ${customDomain}...`);
    try {
      const headers = await authedJsonHeaders();
      const res = await fetch(`/api/custom-domain/${encodeURIComponent(jobId)}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain: customDomain })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Domain connection failed.');
      updateCustomDomainState(data.customDomain);
      setStatus?.(`${customDomain} connected. Add the DNS record shown in Publish.`, 'ok');
    } catch (err) {
      setStatus?.(err.message || 'Domain connection failed.', 'error');
    } finally {
      customSubmit.disabled = !publishedState?.subdomain;
      customSubmit.textContent = 'Connect domain';
    }
  });

  return {
    show() {
      control.classList.remove('hidden');
    },
    hide() {
      control.classList.add('hidden');
      panel.classList.add('hidden');
      publishedState = null;
      resultLink(null);
      updateCustomDomainState(null);
    },
    setPublished(published, customDomain = null) {
      publishedState = published || null;
      if (published?.subdomain) input.value = published.subdomain;
      resultLink(published);
      updateCustomDomainState(customDomain);
    }
  };
}

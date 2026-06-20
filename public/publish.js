import { handleSubscriptionRequired } from './billing.js?v=20260620-autopublish';

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
  let unpublishBtn = null;

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
    if (unpublishBtn) unpublishBtn.classList.toggle('hidden', !published);
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

  // Home-page publish is presented as a centered modal (control has .publish-modal).
  // Elsewhere it stays the anchored dropdown — setOpen works for both.
  const isModal = control.classList.contains('publish-modal');
  let backdrop = null;
  let segWrap = null;

  function selectSegment(which) {
    if (!segWrap) return;
    segWrap.querySelectorAll('[data-seg]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.seg === which);
    });
    form.classList.toggle('hidden', which !== 'free');
    if (customBlock) customBlock.classList.toggle('hidden', which !== 'custom');
  }

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    if (backdrop) backdrop.classList.toggle('hidden', !open);
    document.body.classList.toggle('publish-modal-open', isModal && open);
    if (open) {
      if (segWrap) selectSegment('free');
      input.focus();
    }
  }

  if (isModal) {
    const head = document.createElement('div');
    head.className = 'publish-modal-head';
    const heading = document.createElement('strong');
    heading.textContent = 'Publish your site';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'publish-modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => setOpen(false));
    head.append(heading, closeBtn);
    panel.prepend(head);

    segWrap = document.createElement('div');
    segWrap.className = 'publish-seg';
    segWrap.innerHTML = '<button type="button" data-seg="free">Free URL</button><button type="button" data-seg="custom">Custom domain</button>';
    segWrap.querySelectorAll('[data-seg]').forEach(btn => {
      btn.addEventListener('click', () => selectSegment(btn.dataset.seg));
    });
    head.after(segWrap);

    // Portal the panel + backdrop out to <body>. The panel is position:fixed but an
    // ancestor (#progressPanel.glass) has backdrop-filter, which makes it the
    // containing block AND stacking context for fixed descendants — trapping the
    // panel beneath the body-level backdrop (the whole modal looked blurred).
    backdrop = document.createElement('div');
    backdrop.className = 'publish-modal-backdrop hidden';
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) setOpen(false);
    });
    document.body.appendChild(backdrop);
    backdrop.appendChild(panel);

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false);
    });
  }

  function openPanel() {
    setOpen(panel.classList.contains('hidden'));
  }

  // "Take site offline" — only visible while a site is live (toggled in resultLink).
  unpublishBtn = document.createElement('button');
  unpublishBtn.type = 'button';
  unpublishBtn.className = 'publish-unpublish hidden';
  unpublishBtn.dataset.unpublish = 'true';
  unpublishBtn.textContent = 'Take site offline';
  unpublishBtn.addEventListener('click', async () => {
    const jobId = getJobId();
    if (!jobId) return;
    if (!window.confirm('Take your live site offline? Your URL will stop working until you publish again.')) return;
    unpublishBtn.disabled = true;
    unpublishBtn.textContent = 'Taking offline...';
    setStatus?.('Taking your site offline...');
    try {
      const token = await window.KillerWorkAuth.requireToken();
      const res = await fetch(`/api/publish/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not take the site offline.');
      publishedState = null;
      input.value = '';
      resultLink(null);
      updateCustomDomainState(data.customDomain);
      setStatus?.('Your site is now offline. Publish again any time.', 'ok');
    } catch (err) {
      setStatus?.(err.message || 'Could not take the site offline.', 'error');
    } finally {
      unpublishBtn.disabled = false;
      unpublishBtn.textContent = 'Take site offline';
    }
  });
  form.after(unpublishBtn);

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
      if (await handleSubscriptionRequired(res, data, setStatus, { jobId, subdomain })) return;
      if (!res.ok) throw new Error(data.error || 'Publish failed.');
      input.value = data.published?.subdomain || subdomain;
      publishedState = data.published;
      resultLink(data.published);
      updateCustomDomainState(data.customDomain);
      setOpen(false);
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
      if (await handleSubscriptionRequired(res, data, setStatus, { jobId })) return;
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
      setOpen(false);
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

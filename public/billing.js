async function authHeaders(json = false) {
  const token = await window.KillerWorkAuth.requireToken();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`
  };
}

function track(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, { page_path: window.location.pathname, ...params });
}

export async function startSubscriptionCheckout(setStatus, { jobId } = {}) {
  setStatus?.('Opening secure checkout...');
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: await authHeaders(true),
    body: JSON.stringify({ jobId: jobId || null })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not open checkout.');
  track('checkout_start', {
    plan_name: 'KillaWork one-time',
    price: 9.99,
    currency: 'USD',
    job_id: jobId || ''
  });
  window.location.assign(data.url);
}

export async function trackSubscriptionCheckoutReturn(setStatus) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('payment') === 'cancelled') {
    setStatus?.('Checkout cancelled.');
    return;
  }
  const sessionId = params.get('session_id');
  if (params.get('payment') !== 'success' || !sessionId) return;
  setStatus?.('Confirming your payment...');
  const res = await fetch(`/api/billing/checkout-session/${encodeURIComponent(sessionId)}`, {
    headers: await authHeaders()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.confirmed) throw new Error(data.error || 'Could not confirm your payment.');
  const storageKey = `killerwork:payment-conversion:${sessionId}`;
  if (!localStorage.getItem(storageKey)) {
    track('payment_purchase', {
      value: data.value,
      currency: data.currency,
      transaction_id: data.transactionId
    });
    localStorage.setItem(storageKey, 'true');
  }
  params.delete('payment');
  params.delete('session_id');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  setStatus?.('Payment confirmed. Publishing, custom domains, and ZIP downloads are unlocked.', 'ok');
}

export async function handleSubscriptionRequired(res, data = {}, setStatus, { jobId } = {}) {
  if (res.status !== 402 || data.code !== 'subscription_required') return false;
  setStatus?.(data.error || 'A one-time $9.99 payment unlocks publishing, custom domains, and ZIP downloads.', 'error');
  await startSubscriptionCheckout(setStatus, { jobId });
  return true;
}

export async function downloadProtectedZip(url, setStatus) {
  setStatus?.('Preparing your ZIP download...');
  const res = await fetch(url, { headers: await authHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (await handleSubscriptionRequired(res, data, setStatus)) return;
    throw new Error(data.error || 'ZIP download failed.');
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = 'killawork-import.zip';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
  setStatus?.('ZIP downloaded.', 'ok');
}

export function bindProtectedZipLink(link, setStatus) {
  if (!link || link.dataset.protectedZipBound === 'true') return;
  link.dataset.protectedZipBound = 'true';
  link.addEventListener('click', async event => {
    event.preventDefault();
    try {
      await downloadProtectedZip(link.href, setStatus);
    } catch (err) {
      setStatus?.(err.message || 'ZIP download failed.', 'error');
    }
  });
}

async function authHeaders(json = false) {
  const token = await window.KillerWorkAuth.requireToken();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`
  };
}

function track(name, params = {}) {
  window.KillerWorkAnalytics?.track?.(name, params);
}

export async function startSubscriptionCheckout(setStatus) {
  setStatus?.('Opening secure subscription checkout...');
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: await authHeaders(true)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not open subscription checkout.');
  track('begin_checkout', {
    value: 5,
    currency: 'USD',
    items: [{ item_id: 'killawork-monthly', item_name: 'KillaWork monthly subscription', price: 5, quantity: 1 }]
  });
  window.location.assign(data.url);
}

export async function trackSubscriptionCheckoutReturn(setStatus) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('subscription') === 'cancelled') {
    setStatus?.('Subscription checkout cancelled.');
    return;
  }
  const sessionId = params.get('session_id');
  if (params.get('subscription') !== 'success' || !sessionId) return;
  setStatus?.('Confirming your subscription...');
  const res = await fetch(`/api/billing/checkout-session/${encodeURIComponent(sessionId)}`, {
    headers: await authHeaders()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.confirmed) throw new Error(data.error || 'Could not confirm your subscription.');
  const storageKey = `killerwork:subscription-conversion:${sessionId}`;
  if (!localStorage.getItem(storageKey)) {
    track('conversion', {
      send_to: data.googleAdsSendTo,
      value: data.value,
      currency: data.currency,
      transaction_id: data.transactionId
    });
    localStorage.setItem(storageKey, 'true');
  }
  params.delete('subscription');
  params.delete('session_id');
  const query = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  setStatus?.('Subscription active. Publishing and ZIP downloads are unlocked.', 'ok');
}

export async function handleSubscriptionRequired(res, data = {}, setStatus) {
  if (res.status !== 402 || data.code !== 'subscription_required') return false;
  setStatus?.(data.error || 'Subscribe to publish or download your portfolio.', 'error');
  await startSubscriptionCheckout(setStatus);
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

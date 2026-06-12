import { startSubscriptionCheckout } from './billing.js?v=20260602-gtm';

const statusEl = document.getElementById('profileStatus');
const profileName = document.getElementById('profileName');
const profileEmail = document.getElementById('profileEmail');
const profileProvider = document.getElementById('profileProvider');
const subscriptionStatus = document.getElementById('subscriptionStatus');
const resetPasswordButton = document.getElementById('resetPasswordButton');
const subscribeButton = document.getElementById('subscribeButton');
const cancelSubscriptionButton = document.getElementById('cancelSubscriptionButton');

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

async function authHeaders(json = false) {
  const token = await window.KillerWorkAuth.requireToken();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${token}`
  };
}

function providerLabel(providerId = '') {
  if (providerId === 'google.com') return 'Google';
  if (providerId === 'password') return 'Email and password';
  return providerId || 'Signed-in account';
}

async function loadBilling() {
  const res = await fetch('/api/billing/status', { headers: await authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not check your subscription.');
  const active = !!data.active;
  subscriptionStatus.textContent = active ? 'Paid' : data.status === 'not_configured' ? 'Not configured' : 'Not purchased';
  subscribeButton.classList.toggle('hidden', active);
  cancelSubscriptionButton.classList.add('hidden');
}

async function openBillingPortal() {
  setStatus('Opening billing portal...');
  const res = await fetch('/api/billing/portal', {
    method: 'POST',
    headers: await authHeaders(true)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || 'Could not open billing portal.');
  window.location.assign(data.url);
}

async function initProfile() {
  await window.KillerWorkAuth.ready;
  const user = await window.KillerWorkAuth.currentUser();
  if (!user) {
    setStatus('Sign in to view your profile.', 'error');
    await window.KillerWorkAuth.requireToken();
    return initProfile();
  }

  profileName.textContent = user.displayName || 'No name set';
  profileEmail.textContent = user.email || 'No email available';
  profileProvider.textContent = providerLabel(user.providerId);
  setStatus('Profile loaded.', 'ok');

  await loadBilling().catch(err => {
    subscriptionStatus.textContent = 'Unavailable';
    setStatus(err.message || 'Could not load billing status.', 'error');
  });
}

resetPasswordButton?.addEventListener('click', async () => {
  try {
    const email = await window.KillerWorkAuth.sendPasswordReset();
    setStatus(`Password reset email sent to ${email}.`, 'ok');
  } catch (err) {
    setStatus(err.message || 'Could not send password reset email.', 'error');
  }
});

subscribeButton?.addEventListener('click', async () => {
  try {
    await startSubscriptionCheckout(setStatus);
  } catch (err) {
    setStatus(err.message || 'Could not start checkout.', 'error');
  }
});

cancelSubscriptionButton?.addEventListener('click', async () => {
  try {
    await openBillingPortal();
  } catch (err) {
    setStatus(err.message || 'Could not open billing portal.', 'error');
  }
});

initProfile().catch(err => setStatus(err.message || 'Could not load profile.', 'error'));

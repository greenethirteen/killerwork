import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const manageLatestLinks = [...document.querySelectorAll('[data-manage-latest]')];
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const logoutButtons = [...document.querySelectorAll('[data-auth-logout]')];
const userBadges = [...document.querySelectorAll('[data-user-badge]')];
const GOOGLE_ADS_ID = 'AW-18188860218';
let authInstance = null;
let authReadyResolve;
let authReadyDone = false;
let authStateSettled = false;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });

function initGoogleAdsTag() {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  if (!document.querySelector(`script[src*="googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}"]`)) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`;
    document.head.appendChild(script);
  }
  if (!window.__killerworkGoogleAdsConfigured) {
    window.gtag('js', new Date());
    window.gtag('config', GOOGLE_ADS_ID);
    window.__killerworkGoogleAdsConfigured = true;
  }
}

function trackGoogleAdsEvent(name, params = {}) {
  initGoogleAdsTag();
  window.gtag('event', name, { send_to: GOOGLE_ADS_ID, ...params });
}

initGoogleAdsTag();
window.KillerWorkAnalytics = {
  track: trackGoogleAdsEvent,
  googleAdsId: GOOGLE_ADS_ID
};

function resolveAuthReady() {
  if (authReadyDone) return;
  authReadyDone = true;
  authReadyResolve();
}

function showAuthUi() {
  document.documentElement.classList.remove('auth-pending');
}

function googleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

async function signInWithGooglePopup(auth) {
  const result = await signInWithPopup(auth, googleProvider());
  const user = result?.user || auth.currentUser;
  if (user) {
    setSignedIn(user);
    trackGoogleAdsEvent('sign_in', { method: 'Google' });
  }
  resolveAuthReady();
  return user;
}

window.KillerWorkAuth = {
  ready: authReady,
  async currentToken() {
    await authReady;
    const user = authInstance?.currentUser;
    return user ? user.getIdToken() : '';
  },
  async requireToken() {
    await authReady;
    if (!authInstance) throw new Error('Firebase sign-in is not configured.');
    if (!authInstance.currentUser) {
      const user = await signInWithGooglePopup(authInstance);
      if (user) return user.getIdToken();
    }
    return authInstance.currentUser.getIdToken();
  },
  async authHeaders() {
    const token = await this.currentToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
};

manageLatestLinks.forEach(link => {
  link.href = '/manage.html';
  link.classList.add('hidden');
});

function setSignedOut(message = '') {
  authLinks.forEach(link => {
    link.classList.remove('hidden');
    link.href = '#';
    if (message) link.title = message;
  });
  manageLatestLinks.forEach(link => link.classList.add('hidden'));
  logoutButtons.forEach(button => button.classList.add('hidden'));
  userBadges.forEach(badge => {
    badge.classList.add('hidden');
    badge.textContent = '';
  });
}

function setSignedIn(user) {
  authLinks.forEach(link => link.classList.add('hidden'));
  manageLatestLinks.forEach(link => {
    link.href = '/manage.html';
    link.classList.remove('hidden');
  });
  logoutButtons.forEach(button => button.classList.remove('hidden'));
  userBadges.forEach(badge => {
    badge.classList.remove('hidden');
    badge.textContent = user.displayName || user.email || 'Signed in';
  });
}

async function initFirebaseAuth() {
  document.documentElement.classList.add('auth-pending');
  const res = await fetch('/api/firebase-config');
  const data = await res.json();
  if (!data.configured) {
    setSignedOut('Firebase Web App config is missing.');
    authReadyResolve();
    return;
  }

  const app = initializeApp(data.config);
  const auth = getAuth(app);
  authInstance = auth;
  await setPersistence(auth, browserLocalPersistence);

  authLinks.forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      link.setAttribute('aria-busy', 'true');
      try {
        await signInWithGooglePopup(auth);
      } catch (error) {
        if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
          setSignedOut(error?.message || 'Google sign-in failed.');
        }
      } finally {
        link.removeAttribute('aria-busy');
      }
    });
  });

  logoutButtons.forEach(button => {
    button.addEventListener('click', async () => {
      await signOut(auth);
    });
  });

  onAuthStateChanged(auth, async user => {
    authStateSettled = true;
    showAuthUi();
    resolveAuthReady();
    if (!user) {
      setSignedOut();
      return;
    }
    setSignedIn(user);
    const token = await user.getIdToken();
    fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  });
}

initFirebaseAuth().catch(() => {
  setSignedOut('Firebase sign-in could not start.');
  authReadyResolve();
  showAuthUi();
});

setTimeout(() => {
  if (!authStateSettled) showAuthUi();
}, 1200);

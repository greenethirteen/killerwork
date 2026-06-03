import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  getAdditionalUserInfo,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const manageLatestLinks = [...document.querySelectorAll('[data-manage-latest]')];
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const logoutButtons = [...document.querySelectorAll('[data-auth-logout]')];
const userBadges = [...document.querySelectorAll('[data-user-badge]')];
let authInstance = null;
let authReadyResolve;
let authReadyDone = false;
let authStateSettled = false;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });

function trackEvent(name, params = {}) {
  window.KillerWorkTracking?.trackEvent?.(name, params);
}

window.KillerWorkAnalytics = {
  track: trackEvent
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
    trackEvent('sign_in', { page_path: window.location.pathname, method: 'google' });
    if (getAdditionalUserInfo(result)?.isNewUser) {
      trackEvent('signup_complete', { page_path: window.location.pathname, method: 'google' });
    }
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
  const res = await fetch('/api/firebase-config');
  const data = await res.json();
  if (!data.configured) {
    setSignedOut('Firebase Web App config is missing.');
    resolveAuthReady();
    showAuthUi();
    return;
  }

  const app = initializeApp(data.config);
  const auth = getAuth(app);
  authInstance = auth;
  await setPersistence(auth, browserLocalPersistence);

  authLinks.forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      trackEvent('signup_start', { page_path: window.location.pathname, source_section: 'header' });
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
  resolveAuthReady();
  showAuthUi();
});

setTimeout(() => {
  if (!authStateSettled) showAuthUi();
}, 8000);

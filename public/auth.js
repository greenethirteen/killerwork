import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const manageLatestLinks = [...document.querySelectorAll('[data-manage-latest]')];
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const logoutButtons = [...document.querySelectorAll('[data-auth-logout]')];
const userBadges = [...document.querySelectorAll('[data-user-badge]')];
let authInstance = null;
let authReadyResolve;
let authReadyDone = false;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });

function shouldUseRedirectFallback(error) {
  return error?.code === 'auth/popup-blocked';
}

async function signInWithGoogle(auth, provider) {
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    if (!shouldUseRedirectFallback(error)) throw error;
    await signInWithRedirect(auth, provider);
  }
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
      const provider = new GoogleAuthProvider();
      await signInWithGoogle(authInstance, provider);
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
    authReadyResolve();
    return;
  }

  const app = initializeApp(data.config);
  const auth = getAuth(app);
  authInstance = auth;
  const provider = new GoogleAuthProvider();
  getRedirectResult(auth).catch(error => {
    setSignedOut(error?.message || 'Google sign-in could not finish.');
  });

  authLinks.forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      link.setAttribute('aria-busy', 'true');
      try {
        await signInWithGoogle(auth, provider);
      } catch (error) {
        setSignedOut(error?.message || 'Google sign-in failed.');
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
    if (!authReadyDone) {
      authReadyDone = true;
      authReadyResolve();
    }
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
});

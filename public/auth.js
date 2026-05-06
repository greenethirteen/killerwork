import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const latestJobId = localStorage.getItem('killerwork:lastJobId') || '';
const manageLatestLinks = [...document.querySelectorAll('[data-manage-latest]')];
const authLinks = [...document.querySelectorAll('[data-auth-link]')];
const logoutButtons = [...document.querySelectorAll('[data-auth-logout]')];
const userBadges = [...document.querySelectorAll('[data-user-badge]')];
let authInstance = null;
let authReadyResolve;
let authReadyDone = false;
const authReady = new Promise(resolve => { authReadyResolve = resolve; });

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
      await signInWithPopup(authInstance, provider);
    }
    return authInstance.currentUser.getIdToken();
  },
  async authHeaders() {
    const token = await this.currentToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
};

manageLatestLinks.forEach(link => {
  if (latestJobId) {
    link.href = `/manage.html?job=${encodeURIComponent(latestJobId)}`;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
});

function setSignedOut(message = '') {
  authLinks.forEach(link => {
    link.classList.remove('hidden');
    link.href = '#';
    if (message) link.title = message;
  });
  logoutButtons.forEach(button => button.classList.add('hidden'));
  userBadges.forEach(badge => {
    badge.classList.add('hidden');
    badge.textContent = '';
  });
}

function setSignedIn(user) {
  authLinks.forEach(link => link.classList.add('hidden'));
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

  authLinks.forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      await signInWithPopup(auth, provider);
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

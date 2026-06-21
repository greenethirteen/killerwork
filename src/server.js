import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import Stripe from 'stripe';
import { runImport, generateSite, validateSite, zipDir, resolvePortfolioIdentity, renderAboutPage } from './importer.js';
import { cleanupCampaignBuilderManifestWithAI, planPageEditWithAI, planPageOperationsWithAI, planSiteFileEditsWithAI } from './ai.js';
import { runCampaignBuild, runUploadBuild, buildProjectFromUpload, generatePageCopyWithAI } from './uploadBuilder.js';
import { analyzePortfolioZip, stagedFilesForBuild } from './zipBuilder.js';
import { runPortfolioStudioBuild } from './portfolioStudio.js';
import { hash, safeSlug } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 8787;
const jobs = new Map();
const zipBuilderSessions = new Map();

// Per-portfolio async lock — serialises read-modify-write cycles (fix #6)
const portfolioLocks = new Map();
async function withPortfolioLock(id, fn) {
  const prior = portfolioLocks.get(id) || Promise.resolve();
  let release;
  const next = new Promise(res => { release = res; });
  portfolioLocks.set(id, next);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    if (portfolioLocks.get(id) === next) portfolioLocks.delete(id);
  }
}

// Per-user build concurrency limiter — max 2 concurrent builds per user (fix #10)
const activeBuildsByUser = new Map();
function acquireBuildSlot(uid) {
  const count = activeBuildsByUser.get(uid) || 0;
  if (count >= 2) return false;
  activeBuildsByUser.set(uid, count + 1);
  return true;
}
function releaseBuildSlot(uid) {
  const count = activeBuildsByUser.get(uid) || 1;
  const next = count - 1;
  if (next <= 0) activeBuildsByUser.delete(uid);
  else activeBuildsByUser.set(uid, next);
}

// CSS value validators — prevent injection into <style> blocks and inline styles (fix #1/#2)
const CSS_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*[\d.]+)?\s*\)|hsla?\(\s*[\d.]+(?:deg|turn|rad)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+)?\s*\)|[a-zA-Z]{2,30}|transparent)$/;
function safeCssColor(value, fallback = '') {
  const v = String(value || '').trim();
  return CSS_COLOR_RE.test(v) ? v : fallback;
}
function safeFontFamily(value) {
  const v = String(value || '').trim();
  return /^[a-zA-Z0-9 ,_\-+]{1,120}$/.test(v) ? v : 'Inter';
}

// Schedule job eviction 30 min after reaching a terminal state (fix #8)
function finaliseJob(job) {
  setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000);
}
const generatedRoot = process.env.GENERATED_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.resolve(process.env.GENERATED_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH)
  : path.join(root, 'generated');
const tmpUploadsDir = path.join(root, '.uploads-tmp');
const upload = multer({
  dest: tmpUploadsDir,
  limits: { files: 60, fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || '');
    const codeTypes = new Set(['text/plain', 'text/html', 'text/css', 'text/javascript', 'application/javascript', 'application/json', 'image/svg+xml']);
    if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf' || codeTypes.has(type)) return cb(null, true);
    cb(new Error('Only images, videos, audio files, PDFs, and web text files are supported.'));
  }
});
const zipUpload = multer({
  dest: tmpUploadsDir,
  limits: { files: 1, fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext === '.zip' || ['application/zip', 'application/x-zip-compressed'].includes(String(file.mimetype || ''))) return cb(null, true);
    cb(new Error('Upload one ZIP file.'));
  }
});

await fs.ensureDir(generatedRoot);
await fs.ensureDir(tmpUploadsDir);

// Stripe webhook must read the RAW body to verify the signature, so it is
// registered before express.json(). It completes the post-payment publish even
// if the buyer closes the tab before the redirect-confirm runs. No-ops safely
// until STRIPE_WEBHOOK_SECRET is set (and the endpoint is added in Stripe).
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeWebhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const jobId = session.metadata?.jobId;
      const subdomain = session.metadata?.subdomain;
      const uid = session.metadata?.firebaseUid || session.client_reference_id;
      if (jobId && subdomain && session.payment_status === 'paid') {
        const manifest = await readManifest(jobId).catch(() => null);
        if (manifest && canAccessPortfolio(manifest, { uid })) {
          const result = await publishPortfolioSubdomain(jobId, manifest, subdomain);
          if (result.error) console.warn('Webhook auto-publish skipped:', result.error.body?.error);
        }
      }
    } catch (err) {
      console.error('Stripe webhook publish failed:', err.message);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '2mb' }));
app.use(compression());
app.get('*', serveCustomDomainIfMapped);
app.get(['/published/:subdomain', '/published/:subdomain/*'], servePublishedSite);
app.get('*', serveKillaWorkHost);
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(root, 'public', 'favicon-logo-144.png')));
app.get('/api/tracking-config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ containerId: process.env.GTM_CONTAINER_ID || 'GTM-NDCKPZ6Z' });
});
app.get('/gtm-noscript.html', (req, res) => {
  const containerId = String(process.env.GTM_CONTAINER_ID || 'GTM-NDCKPZ6Z');
  if (!/^GTM-[A-Z0-9]+$/i.test(containerId)) return res.status(204).end();
  res.redirect(302, `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(containerId)}`);
});
// Firebase Auth requires /__/auth/* to be served on the authDomain.
// Since authDomain resolves to the request hostname (e.g. killa.work), proxy
// these routes to Firebase Hosting where they are natively served.
app.get('/__/auth/*', async (req, res) => {
  if (!firebaseProjectId) return res.status(503).end();
  const target = `https://${firebaseProjectId}.firebaseapp.com${req.url}`;
  try {
    const upstream = await fetch(target);
    const ct = upstream.headers.get('content-type') || 'text/html';
    res.status(upstream.status)
      .setHeader('Content-Type', ct)
      .setHeader('Cache-Control', 'no-cache');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});
app.use('/', express.static(path.join(root, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(?:js|css|png|jpe?g|webp|avif|svg)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.html$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
      if (path.relative(path.join(root, 'public'), filePath) !== 'index.html') {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
    }
  }
}));
app.get(['/generated/:id/site', '/generated/:id/site/', '/generated/:id/site/index.html'], serveGeneratedHomePage);
app.get('/generated/:id/site/work/:slug/index.html', serveGeneratedCampaignPage);
app.get(['/generated/:id/site/favicon.ico', '/generated/:id/site/favicon.png'], (req, res) => res.sendFile(path.join(root, 'public', 'favicon-logo-144.png')));
app.use('/generated', express.static(generatedRoot, { setHeaders: setGeneratedStaticHeaders }));

// Per-template display fonts. Prepended (as @import, which must lead the stylesheet)
// so each template reads as a distinct design system, not just recoloured Inter.
const TEMPLATE_FONT_IMPORTS = {
  cinema: "@import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;700&display=swap');\n",
  gallery: "@import url('https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&display=swap');\n",
};

// Fallback: if styles.css is missing from disk (old import, pruned volume), generate it on the fly.
// express.static calls next() when the file isn't found, so this only fires on a real 404.
app.get('/generated/:id/site/styles.css', async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await readManifest(id).catch(() => ({}));
    const baseCss = await fs.readFile(path.join(root, 'public', 'portfolio.css'), 'utf8').catch(() => '');
    const templateName = manifest?.portfolioTemplate || 'default';
    let css = baseCss;
    if (templateName !== 'default') {
      const overlayPath = path.join(root, 'public', 'templates', `${templateName}.css`);
      if (await fs.pathExists(overlayPath)) css = (TEMPLATE_FONT_IMPORTS[templateName] || '') + baseCss + '\n' + await fs.readFile(overlayPath, 'utf8');
    }
    // Write to disk so the next request is served by express.static
    await fs.ensureDir(siteDir(id));
    await fs.writeFile(path.join(siteDir(id), 'styles.css'), css).catch(() => {});
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(css);
  } catch (err) {
    res.status(500).send('/* styles.css generation failed */');
  }
});
app.get('/generated/:id/*', generatedMissingHandler);

function firebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    return {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    };
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    return fs.readJsonSync(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }
  return null;
}

const firebaseAccount = firebaseServiceAccount();
const firebaseProjectId = process.env.FIREBASE_PROJECT_ID || firebaseAccount?.project_id || '';
const firebaseAdmin = firebaseAccount ? admin.initializeApp({
  credential: admin.credential.cert(firebaseAccount),
  projectId: firebaseProjectId
}) : null;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripeProductId = process.env.STRIPE_PRODUCT_ID || 'prod_Uio91cAmqETWVG';
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

function requestHostname(req) {
  const forwardedHost = String(req?.get?.('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req?.get?.('host') || '').trim();
  return host.replace(/:\d+$/, '').toLowerCase();
}

function firebaseAuthDomain() {
  const defaultFirebaseDomain = firebaseProjectId ? `${firebaseProjectId}.firebaseapp.com` : '';
  return process.env.FIREBASE_AUTH_DOMAIN || defaultFirebaseDomain;
}

function firebaseWebConfig(req) {
  const projectId = process.env.FIREBASE_PROJECT_ID || firebaseProjectId;
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || '',
    authDomain: firebaseAuthDomain(),
    projectId,
    appId: process.env.FIREBASE_WEB_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
  };
}

async function verifiedFirebaseUser(req) {
  if (!firebaseAdmin) return null;
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const decoded = await firebaseAdmin.auth().verifyIdToken(token);
  return {
    uid: decoded.uid,
    email: decoded.email || '',
    name: decoded.name || '',
    picture: decoded.picture || ''
  };
}

async function requireFirebaseAuth(req, res, next) {
  try {
    const user = await verifiedFirebaseUser(req);
    if (!user) return res.status(firebaseAdmin ? 401 : 503).json({ error: firebaseAdmin ? 'Sign in required.' : 'Firebase authentication is not configured.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Sign in required.' });
  }
}

function requestOrigin(req) {
  return String(process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

async function stripeCustomerFor(user, { create = false } = {}) {
  if (!stripe) return null;
  const uid = String(user?.uid || '').replace(/'/g, "\\'");
  const matches = uid
    ? await stripe.customers.search({ query: `metadata['firebaseUid']:'${uid}'`, limit: 1 })
    : { data: [] };
  if (matches.data[0]) return matches.data[0];

  const byEmail = user?.email
    ? await stripe.customers.list({ email: user.email, limit: 1 })
    : { data: [] };
  if (byEmail.data[0]) {
    const customer = byEmail.data[0];
    if (user?.uid && customer.metadata?.firebaseUid !== user.uid) {
      return stripe.customers.update(customer.id, { metadata: { ...customer.metadata, firebaseUid: user.uid } });
    }
    return customer;
  }
  if (!create) return null;
  return stripe.customers.create({
    email: user?.email || undefined,
    name: user?.name || undefined,
    metadata: { firebaseUid: user.uid }
  });
}

async function subscriptionStateFor(user) {
  if (!stripe) return { configured: false, active: false, status: 'not_configured' };
  const customer = await stripeCustomerFor(user);
  if (!customer) return { configured: true, active: false, status: 'none' };
  const sessions = await stripe.checkout.sessions.list({ customer: customer.id, limit: 100 });
  const paid = sessions.data.some(s => s.mode === 'payment' && s.payment_status === 'paid' && s.status === 'complete');
  return { configured: true, active: paid, status: paid ? 'paid' : 'none', customerId: customer.id };
}

async function requireActiveSubscription(req, res, next) {
  try {
    const state = await subscriptionStateFor(req.user);
    if (!state.configured) {
      return res.status(503).json({ error: 'Subscriptions are not configured yet.', code: 'billing_not_configured' });
    }
    if (!state.active) {
      return res.status(402).json({
        error: 'A one-time $9.99 payment unlocks publishing, custom domains, and ZIP downloads.',
        code: 'subscription_required'
      });
    }
    req.subscription = state;
    next();
  } catch (err) {
    console.error('Stripe payment check failed', err);
    res.status(503).json({ error: 'Could not verify your payment status. Please try again.', code: 'billing_unavailable' });
  }
}

function attachOwner(manifest, user) {
  manifest.ownerUid = user.uid;
  manifest.owner = { uid: user.uid };
  return manifest;
}

function canAccessPortfolio(manifest, user) {
  if (!manifest.ownerUid) return true; // legacy un-owned portfolio; callers must backfill ownerUid
  return manifest.ownerUid === user.uid;
}

function publicHost() {
  return process.env.PUBLIC_SITE_HOST || 'killa.work';
}

function normalizeSubdomain(value = '') {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

function validSubdomain(value = '') {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function normalizeDomain(value = '') {
  return String(value || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@$/, '');
}

function validDomain(value = '') {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}

function setGeneratedStaticHeaders(res, filePath) {
  const normalized = String(filePath || '');
  const isImportedAsset = normalized.includes(`${path.sep}assets${path.sep}imported${path.sep}`);
  if (isImportedAsset) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  // styles.css is rewritten in place when the user switches templates — it must
  // revalidate on every load or the old template keeps showing for up to an hour
  if (/[\\/]styles\.css$/i.test(normalized)) {
    res.setHeader('Cache-Control', 'no-cache');
    return;
  }
  if (/\.(?:css|js|png|jpe?g|webp|gif|ico|svg|mp4|webm|mov|m4a|mp3|wav|pdf)$/i.test(normalized)) {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
}

function publishedUrlFor(subdomain) {
  return `https://${subdomain}.${publicHost()}`;
}

async function publishedIndex() {
  const generatedDir = generatedRoot;
  if (!(await fs.pathExists(generatedDir))) return new Map();
  const entries = await fs.readdir(generatedDir);
  const index = new Map();
  await Promise.all(entries.map(async id => {
    const manifest = await readManifest(id);
    const subdomain = normalizeSubdomain(manifest?.published?.subdomain || '');
    if (subdomain) index.set(subdomain, { id, manifest, customDomain: manifest?.customDomain });
  }));
  return index;
}

async function serveSiteFile(res, id, requestedPath = '') {
  const siteRoot = path.join(jobDir(id), 'site');
  const manifest = await readManifest(id);
  const cleanPath = String(requestedPath || '').replace(/^\/+/, '') || 'index.html';
  if (cleanPath === 'favicon.svg') return res.sendFile(path.join(root, 'public', 'favicon.svg'));
  if (cleanPath === 'favicon.png' || cleanPath === 'favicon.ico') return res.sendFile(path.join(root, 'public', 'favicon-logo-144.png'));
  const target = path.normalize(path.join(siteRoot, cleanPath));
  if (target !== siteRoot && !target.startsWith(siteRoot + path.sep)) return res.status(400).send('Bad path');
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) {
    const indexFile = path.join(target, 'index.html');
    if (await fs.pathExists(indexFile)) {
      const relativePath = path.relative(siteRoot, indexFile);
      if (needsPortfolioRuntime(manifest, relativePath)) return sendPortfolioHtmlWithRuntime(res, indexFile, portfolioRuntimeOptions(manifest, relativePath));
      return res.sendFile(indexFile);
    }
  }
  if (stat?.isFile()) {
    const relativePath = path.relative(siteRoot, target);
    if (needsPortfolioRuntime(manifest, relativePath)) return sendPortfolioHtmlWithRuntime(res, target, portfolioRuntimeOptions(manifest, relativePath));
    return res.sendFile(target);
  }
  const fallback = path.join(siteRoot, 'index.html');
  if (await fs.pathExists(fallback)) {
    if (needsPortfolioRuntime(manifest, 'index.html')) return sendPortfolioHtmlWithRuntime(res, fallback, portfolioRuntimeOptions(manifest, 'index.html'));
    return res.sendFile(fallback);
  }
  return res.status(404).send('Published site not found');
}

function isCampaignPagePath(relativePath = '') {
  return /^work[/\\][^/\\]+[/\\]index\.html$/i.test(String(relativePath || ''));
}

function isHomePagePath(relativePath = '') {
  return /^index\.html$/i.test(String(relativePath || ''));
}

function portfolioRuntimeOptions(manifest, relativePath = '') {
  const isBehance = manifest?.sourcePlatform === 'behance';
  return {
    behanceHome: isBehance && isHomePagePath(relativePath),
    behanceProject: isBehance && isCampaignPagePath(relativePath),
    pageTitle: isHomePagePath(relativePath) ? portfolioBrowserTitle(manifest) : '',
  };
}

function needsPortfolioRuntime(manifest, relativePath = '') {
  return isCampaignPagePath(relativePath) || isHomePagePath(relativePath);
}

function portfolioOwnerTitle(manifest) {
  const identity = resolvePortfolioIdentity(manifest);
  return String(identity.ownerName || manifest?.homeTitle || manifest?.siteTitle || 'Portfolio').trim();
}

function portfolioBrowserTitle(manifest) {
  if (manifest?.sourcePlatform === 'website' && manifest?.sourceHome?.title) {
    return String(manifest.sourceHome.title).trim();
  }
  return portfolioOwnerTitle(manifest);
}

function escapeHtmlText(value = '') {
  return String(value).replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

function addBodyClass(html, className) {
  return html.replace(/<body([^>]*)>/i, (body, attributes) => {
    if (/\bclass\s*=\s*["']/i.test(attributes)) {
      return `<body${attributes.replace(/\bclass\s*=\s*(["'])(.*?)\1/i, (value, quote, classes) => {
        const classNames = String(classes).split(/\s+/).filter(Boolean);
        if (!classNames.includes(className)) classNames.push(className);
        return `class=${quote}${classNames.join(' ')}${quote}`;
      })}>`;
    }
    return `<body${attributes} class="${className}">`;
  });
}

// Thin "KillaWork preview" top bar injected into PREVIEW pages only (Home + Publish
// Live). Published/live sites are served through serveSiteFile and never pass through
// here, so visitors of a published portfolio never see this bar. It is shown only when
// the preview is the top-level document (kept out of the editor preview iframes) and it
// pushes the page down so it never covers the site's own nav.
function previewPublishButton(jobId) {
  if (!jobId) return '';
  const safeId = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '');
  const fallbackHref = `/manage.html?job=${encodeURIComponent(jobId)}&publish=1`;
  return `<link rel="stylesheet" href="/publish-embed.css?v=20260620-pubembed6">
<style>
.kw-preview-bar{position:fixed;top:0;left:0;right:0;z-index:2147483000;display:none;align-items:center;justify-content:space-between;gap:12px;height:46px;padding:0 14px;box-sizing:border-box;background:rgba(8,9,13,.94);backdrop-filter:blur(10px);border-bottom:1px solid rgba(255,255,255,.12);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.kw-preview-bar a,.kw-preview-bar button{display:inline-flex;align-items:center;gap:7px;padding:8px 16px;border:0;border-radius:999px;text-decoration:none;font-weight:900;font-size:14px;line-height:1;white-space:nowrap;cursor:pointer;font-family:inherit}
.kw-preview-bar .kw-actions{display:inline-flex;align-items:center;gap:10px}
.kw-preview-bar select.kw-template{padding:8px 12px;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(255,255,255,.06);color:#fffaf2;font-weight:900;font-size:13px;line-height:1;cursor:pointer;font-family:inherit}
.kw-preview-bar select.kw-template:hover{background:rgba(255,255,255,.12)}
.kw-preview-bar select.kw-template option{color:#111}
.kw-preview-bar .kw-home,.kw-preview-bar .kw-edit{color:#fffaf2;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06)}
.kw-preview-bar .kw-home:hover,.kw-preview-bar .kw-edit:hover{background:rgba(255,255,255,.12)}
.kw-preview-bar .kw-pub{background:linear-gradient(135deg,#8cffc1,#7bdff2);color:#07120c}
.kw-preview-bar .kw-pub:hover{filter:brightness(1.05)}
@media print{.kw-preview-bar{display:none!important}}
</style>
<div class="kw-preview-bar" id="kwPreviewBar">
  <a class="kw-home" href="https://killa.work/" target="_blank" rel="noopener">⌂ Home</a>
  <div class="kw-actions">
    <select class="kw-template" id="kwTemplateSelect" aria-label="Preview a template style">
      <option value="default">Template: Default</option>
      <option value="grid-3">Default · 3 across</option>
      <option value="grid-4">Default · 4 across</option>
      <option value="editorial">Editorial</option>
      <option value="bold">Bold</option>
      <option value="neo">Neo</option>
      <option value="cinema">Cinema</option>
      <option value="gallery">Gallery</option>
      <option value="french">French</option>
      <option value="agency">Agency</option>
    </select>
    <a class="kw-edit" href="/pixel-editor.html?job=${safeId}" target="_top" rel="noopener" aria-label="Edit this portfolio in the editor">✎ Edit</a>
    <button class="kw-pub" id="kwPubBtn" type="button" aria-label="Publish this portfolio live">⬆ Publish Live</button>
  </div>
</div>
<div id="kwPublishControl" class="publish-control publish-modal hidden" data-publish-domain="killa.work">
  <button type="button" data-publish-toggle style="display:none"></button>
  <div class="publish-panel hidden" data-publish-panel>
    <form data-publish-form>
      <label><span>Portfolio URL</span><div class="publish-url-field"><input data-publish-input type="text" placeholder="yourname" autocomplete="off"><b>.killa.work</b></div></label>
      <button data-publish-submit type="submit">Publish</button>
    </form>
    <p class="publish-result hidden" data-publish-result></p>
    <div class="custom-domain-block" data-custom-domain-block>
      <div class="publish-divider">Or connect your own domain</div>
      <p class="custom-domain-note">Publish to a free .killa.work URL above first — then you can connect a domain you own.</p>
      <form data-custom-domain-form>
        <label><span>Owned domain</span><input data-custom-domain-input type="text" placeholder="www.yourportfolio.com" autocomplete="off" disabled></label>
        <button data-custom-domain-submit type="submit" disabled>Connect domain</button>
      </form>
      <div class="custom-domain-instructions hidden" data-custom-domain-instructions>
        <h4>DNS setup</h4>
        <p>Add this CNAME record where you bought your domain.</p>
        <div class="dns-record"><strong>Type:</strong> CNAME<br><strong>Name:</strong> <span data-dns-name>www.yourportfolio.com</span><br><strong>Value:</strong> <span data-dns-value>your-name.killa.work</span></div>
      </div>
      <p class="publish-result hidden" data-custom-domain-result></p>
    </div>
  </div>
</div>
<div class="kw-pub-toast hidden" id="kwPubToast" aria-live="polite"></div>
<script>(function(){try{if(window.top===window.self){var b=document.getElementById('kwPreviewBar');b.style.display='flex';document.documentElement.style.scrollPaddingTop='46px';document.body.style.marginTop='46px';
  // Some templates animate the <body> with a transform (page-in). A transform on
  // an ancestor makes position:fixed resolve against that ancestor instead of the
  // viewport, which pushed this fixed bar down by the body margin and left a gap
  // above it. Re-parent the preview chrome to <html> so it ignores body transforms.
  ['kwPreviewBar','kwPublishControl','kwPubToast'].forEach(function(id){var el=document.getElementById(id);if(el) document.documentElement.appendChild(el);});
  // Live-preview-only template switcher: swaps the overlay stylesheet (and its font)
  // in <head> so it cascades over the base styles.css. Not persisted to the manifest.
  var sel=document.getElementById('kwTemplateSelect');
  if(sel){
    var FONTS={
      cinema:'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;700&display=swap',
      gallery:'https://fonts.googleapis.com/css2?family=Jost:wght@300;400;500;600&display=swap'
    };
    sel.addEventListener('change',function(){
      var t=sel.value;
      var oldCss=document.getElementById('kwTemplateOverlay'); if(oldCss) oldCss.remove();
      var oldFont=document.getElementById('kwTemplateFont'); if(oldFont) oldFont.remove();
      if(t && t!=='default'){
        if(FONTS[t]){ var f=document.createElement('link'); f.id='kwTemplateFont'; f.rel='stylesheet'; f.href=FONTS[t]; document.head.appendChild(f); }
        var l=document.createElement('link'); l.id='kwTemplateOverlay'; l.rel='stylesheet'; l.href='/templates/'+t+'.css'; document.head.appendChild(l);
      }
    });
  }
}}catch(e){}})();</script>
<script type="module">
  if (window.top === window.self) {
    (async () => {
      const toast = document.getElementById('kwPubToast');
      const setStatus = (msg, tone) => {
        if (!msg) return;
        toast.textContent = msg;
        toast.className = 'kw-pub-toast' + (tone === 'error' ? ' err' : tone === 'ok' ? ' ok' : '');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.add('hidden'), tone === 'ok' ? 9000 : 5000);
      };
      try {
        // publish.js is all the modal needs; auth.js is only used at submit time,
        // so load it in the background and don't block opening the popup on it.
        import('/auth.js?v=20260605-nav-auth-cta').catch(() => {});
        const mod = await import('/publish.js?v=20260620-namecheck');
        const ctrl = mod.setupPublishControl({ control: document.getElementById('kwPublishControl'), getJobId: () => '${safeId}', setStatus });
        ctrl.show();
        document.getElementById('kwPubBtn').addEventListener('click', () => {
          document.querySelector('#kwPublishControl [data-publish-toggle]').click();
        });
      } catch (e) {
        // publish.js failed to load — fall back to opening the publish flow on the dashboard
        document.getElementById('kwPubBtn').addEventListener('click', () => { window.location.href = '${fallbackHref}'; });
      }
    })();
  }
</script>`;
}

async function sendPortfolioHtmlWithRuntime(res, filePath, { behanceHome = false, behanceProject = false, pageTitle = '', jobId = '' } = {}) {
  let html = await fs.readFile(filePath, 'utf8');
  if (pageTitle) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlText(pageTitle)}</title>`);
  if (/<link\b[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i.test(html)) {
    html = html.replace(/<link\b[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/i, '<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  } else {
    html = html.replace(/<\/head>/i, '<link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>');
  }
  if (behanceHome) {
    html = addBodyClass(html, 'behance-site');
    html = html.replace(/<a\b[^>]*href=["'][^"']*import-review\.html["'][^>]*>\s*Review\s*<\/a>/gi, '');
  }
  if (behanceProject) {
    html = addBodyClass(html, 'behance-project');
    html = html.replace(/<a\b[^>]*class=["'][^"']*\bback-link\b[^"']*["'][^>]*>\s*←\s*Work\s*<\/a>/gi, '');
  }
  if (html.includes('/portfolio-loader.js')) {
    html = html.replace(/\/portfolio-loader\.js(?:\?[^"'\\s<]*)?/g, '/portfolio-loader.js?v=20260601-squarespace-speed');
  } else {
    html = html.replace(/<\/body>/i, '<script src="/portfolio-loader.js?v=20260601-squarespace-speed"></script></body>');
  }
  const publishButton = previewPublishButton(jobId);
  if (publishButton) {
    html = html.replace(/<\/body>/i, `${publishButton}</body>`);
  }
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('html').send(html);
}

async function serveGeneratedHomePage(req, res, next) {
  try {
    const manifest = await readManifest(req.params.id);
    if (!manifest) return next();
    const target = path.join(siteDir(req.params.id), 'index.html');
    if (!(await fs.pathExists(target))) return next();
    await refreshStylesIfStale(req.params.id, manifest);
    return sendPortfolioHtmlWithRuntime(res, target, { ...portfolioRuntimeOptions(manifest, 'index.html'), jobId: req.params.id });
  } catch (err) {
    next(err);
  }
}

async function serveGeneratedCampaignPage(req, res, next) {
  try {
    const siteRoot = siteDir(req.params.id);
    const target = path.normalize(path.join(siteRoot, 'work', req.params.slug, 'index.html'));
    if (!target.startsWith(siteRoot + path.sep)) return res.status(400).send('Bad path');
    if (!(await fs.pathExists(target))) return next();
    const manifest = await readManifest(req.params.id);
    return sendPortfolioHtmlWithRuntime(res, target, { behanceProject: manifest?.sourcePlatform === 'behance', jobId: req.params.id });
  } catch (err) {
    next(err);
  }
}

async function serveCustomDomainIfMapped(req, res, next) {
  try {
    if (req.path.startsWith('/api/') || req.path === '/auth.js' || req.path === '/ui.css' || req.path === '/portfolio-loader.js') return next();
    const host = String(req.hostname || '').toLowerCase();
    // Skip if it's localhost or the main domain
    if (host === 'localhost' || host === '127.0.0.1' || host === publicHost().toLowerCase()) return next();
    // Check if this host is mapped to a custom domain
    const index = await publishedIndex();
    for (const published of index.values()) {
      if (published.customDomain?.domain === host) {
        const rest = req.path.slice(1) || '';
        return serveSiteFile(res, published.id, rest);
      }
    }
    return next();
  } catch (err) {
    next(err);
  }
}

async function servePublishedSite(req, res, next) {
  try {
    const subdomain = normalizeSubdomain(req.params.subdomain);
    const index = await publishedIndex();
    const published = index.get(subdomain);
    if (!published) return res.status(404).send('Published site not found');
    const rest = req.params[0] || '';
    return serveSiteFile(res, published.id, rest);
  } catch (err) {
    next(err);
  }
}

async function serveKillaWorkHost(req, res, next) {
  try {
    if (req.path.startsWith('/api/') || req.path === '/auth.js' || req.path === '/ui.css' || req.path === '/portfolio-loader.js') return next();
    const host = String(req.hostname || '').toLowerCase();
    const base = publicHost().toLowerCase();
    if (!host.endsWith(`.${base}`)) return next();
    const subdomain = normalizeSubdomain(host.slice(0, -(base.length + 1)));
    if (!subdomain || subdomain === 'www') return next();
    const index = await publishedIndex();
    const published = index.get(subdomain);
    if (!published) return res.status(404).send('Published site not found');
    return serveSiteFile(res, published.id, req.path);
  } catch (err) {
    next(err);
  }
}

async function generatedMissingHandler(req, res) {
  const id = String(req.params.id || '');
  const manifestExists = await fs.pathExists(path.join(jobDir(id), 'manifest.json'));
  res.status(404).type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Preview unavailable - KillaWork</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080811;color:#fffaf2;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(620px,calc(100% - 32px));padding:32px;border:1px solid rgba(255,255,255,.14);border-radius:24px;background:linear-gradient(135deg,rgba(255,255,255,.1),rgba(255,255,255,.045));box-shadow:0 30px 90px rgba(0,0,0,.35)}
    h1{margin:0 0 12px;font-size:40px;line-height:1;letter-spacing:-.05em}
    p{margin:0 0 18px;color:#b8b1a8;font-size:16px;line-height:1.5}
    a{display:inline-flex;margin-right:10px;padding:12px 16px;border-radius:14px;background:#fffaf2;color:#111;text-decoration:none;font-weight:900}
    a.secondary{background:rgba(255,255,255,.1);color:#fffaf2;border:1px solid rgba(255,255,255,.14)}
    code{color:#ffd166}
  </style>
</head>
<body>
  <main>
    <h1>Preview unavailable</h1>
    <p>${manifestExists ? 'The portfolio manifest exists, but the static site files are missing. Open the AI editor and save or rebuild the portfolio.' : 'This generated portfolio is not present on this server. It may have been created before the latest deploy or before persistent generated storage was mounted.'}</p>
    <p>Portfolio id: <code>${escapeHtml(id)}</code></p>
    <a href="/ai-editor.html?job=${encodeURIComponent(id)}">Open AI editor</a>
    <a class="secondary" href="/manage.html">Manage projects</a>
  </main>
</body>
</html>`);
}

app.get('/api/firebase-config', (req, res) => {
  const config = firebaseWebConfig(req);
  res.json({
    configured: !!(config.apiKey && config.authDomain && config.projectId),
    adminConfigured: !!firebaseAdmin,
    config
  });
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await verifiedFirebaseUser(req);
    res.json({
      authenticated: !!user,
      user,
      firebaseConfigured: !!(firebaseWebConfig().apiKey && firebaseAdmin)
    });
  } catch {
    res.json({ authenticated: false, user: null, firebaseConfigured: !!(firebaseWebConfig().apiKey && firebaseAdmin) });
  }
});

app.post('/api/import', requireFirebaseAuth, async (req, res) => {
  if (!acquireBuildSlot(req.user.uid)) return res.status(429).json({ error: 'You already have 2 builds running. Wait for one to finish.' });
  const url = String(req.body?.url || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  if (!/^https?:\/\//i.test(url)) { releaseBuildSlot(req.user.uid); return res.status(400).json({ error: 'Enter a valid http/https URL.' }); }
  const id = `${Date.now()}-${hash(url)}`;
  const outDir = jobDir(id);
  const job = { id, url, aiCleanup, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Starting import','Scanning homepage','Found projects','Crawling project','Downloading assets','Raw manifest saved','AI cleanup','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    if (stage.startsWith('Crawling project')) return Math.max(job.percent, 35);
    if (stage.startsWith('Downloading assets')) return Math.max(job.percent, 55);
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx+1)/stages.length)*100));
  };

  try {
    const result = await runImport({ url, outDir, aiCleanup, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      review: `/generated/${id}/site/import-review.html`,
      manifest: `/generated/${id}/manifest.json`,
      rawManifest: `/generated/${id}/manifest.raw.json`,
      cleanedManifest: `/generated/${id}/manifest.cleaned.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (e) {
    job.status = 'error';
    finaliseJob(job);
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Import failed', detail: e.message, at: new Date().toISOString() });
  } finally {
    releaseBuildSlot(req.user.uid);
  }
});

app.post('/api/upload-build', requireFirebaseAuth, upload.array('files', 60), async (req, res) => {
  if (!acquireBuildSlot(req.user.uid)) return res.status(429).json({ error: 'You already have 2 builds running. Wait for one to finish.' });
  const title = String(req.body?.title || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  const files = req.files || [];
  if (!files.length) { releaseBuildSlot(req.user.uid); return res.status(400).json({ error: 'Upload at least one image, video, or PDF.' }); }
  const id = `${Date.now()}-${hash(`${title}:${files.map(f => f.originalname).join('|')}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: 'uploaded-files', aiCleanup, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving uploaded assets','Analyzing uploaded work','AI analyzing asset','AI organizing portfolio','Raw manifest saved','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  try {
    const result = await runUploadBuild({ files, outDir, title, aiCleanup, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      review: `/generated/${id}/site/import-review.html`,
      manifest: `/generated/${id}/manifest.json`,
      rawManifest: `/generated/${id}/manifest.raw.json`,
      cleanedManifest: `/generated/${id}/manifest.cleaned.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (e) {
    job.status = 'error';
    finaliseJob(job);
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Build failed', detail: e.message, at: new Date().toISOString() });
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  } finally {
    releaseBuildSlot(req.user.uid);
  }
});

app.post('/api/ad-zip-build', requireFirebaseAuth, zipUpload.single('zip'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload one ZIP file.' });
  if (!acquireBuildSlot(req.user.uid)) {
    await fs.remove(file.path).catch(() => {});
    return res.status(429).json({ error: 'You already have 2 builds running. Wait for one to finish.' });
  }
  const title = String(req.body?.title || '').trim();
  const id = `${Date.now()}-${hash(`${req.user.uid}:${title}:${file.originalname}:${file.size}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: 'ad-zip-builder', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Reading ZIP', 'Saving uploaded assets', 'Analyzing uploaded work', 'AI analyzing asset', 'AI organizing portfolio', 'Raw manifest saved', 'Building static portfolio', 'Generated static site', 'Validating output', 'Validation passed', 'Validation warnings', 'ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };
  const pushProgress = (evt) => {
    updatePercent(evt.stage);
    job.progress.push(evt);
    if (job.progress.length > 300) job.progress.shift();
  };

  const extractDir = path.join(tmpUploadsDir, `adzip-${id}`);
  const extractedFiles = [];
  try {
    pushProgress({ stage: 'Reading ZIP', detail: file.originalname, at: new Date().toISOString() });
    const { default: AdmZip } = await import('adm-zip');
    const mime = (await import('mime-types')).default;
    const zip = new AdmZip(file.path);
    const MEDIA_EXT = /\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mp3|m4a|wav|aac|pdf)$/i;
    const MAX_FILES = 250;
    // Zip-bomb guards: entry.getData() loads the whole uncompressed entry into
    // memory, so cap per-entry and total expanded size before extracting
    const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
    let expandedBytes = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entryName.includes('__MACOSX/') || path.basename(entryName).startsWith('.')) continue;
      if (!MEDIA_EXT.test(entryName)) continue;
      if (extractedFiles.length >= MAX_FILES) {
        pushProgress({ stage: 'Reading ZIP', detail: `Stopping at ${MAX_FILES} media files`, at: new Date().toISOString() });
        break;
      }
      const entrySize = Number(entry.header?.size || 0);
      if (entrySize > MAX_ENTRY_BYTES) {
        pushProgress({ stage: 'Reading ZIP', detail: `Skipped ${path.basename(entryName)} — larger than 200MB`, at: new Date().toISOString() });
        continue;
      }
      if (expandedBytes + entrySize > MAX_TOTAL_BYTES) {
        pushProgress({ stage: 'Reading ZIP', detail: 'Stopping — ZIP expands beyond the 1GB limit', at: new Date().toISOString() });
        break;
      }
      expandedBytes += entrySize;
      const outPath = path.join(extractDir, `${extractedFiles.length}-${safeSlug(path.basename(entryName)) || 'asset'}`);
      await fs.outputFile(outPath, entry.getData());
      const stat = await fs.stat(outPath);
      extractedFiles.push({
        // Keep the folder path in originalname — folder names are strong campaign-grouping
        // signals for the AI organizer (e.g. "Nike Just Do It/print-01.jpg")
        originalname: entryName.split('/').filter(Boolean).slice(-2).join('/'),
        fieldname: 'zip',
        path: outPath,
        mimetype: mime.lookup(entryName) || 'application/octet-stream',
        size: stat.size
      });
    }
    if (!extractedFiles.length) throw new Error('No images, videos, audio files, or PDFs found in the ZIP.');
    pushProgress({ stage: 'Reading ZIP', detail: `${extractedFiles.length} media file(s) found`, at: new Date().toISOString() });

    const result = await runUploadBuild({ files: extractedFiles, outDir, title, aiCleanup: true, onProgress: pushProgress });
    result.manifest.buildMode = 'ad-zip-builder';
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      review: `/generated/${id}/site/import-review.html`,
      manifest: `/generated/${id}/manifest.json`,
      rawManifest: `/generated/${id}/manifest.raw.json`,
      cleanedManifest: `/generated/${id}/manifest.cleaned.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (e) {
    job.status = 'error';
    finaliseJob(job);
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Build failed', detail: e.message, at: new Date().toISOString() });
    await Promise.all(extractedFiles.map(f => fs.remove(f.path).catch(() => {})));
  } finally {
    releaseBuildSlot(req.user.uid);
    await fs.remove(file.path).catch(() => {});
    await fs.remove(extractDir).catch(() => {});
  }
});

app.post('/api/campaign-build', requireFirebaseAuth, upload.any(), async (req, res) => {
  if (!acquireBuildSlot(req.user.uid)) return res.status(429).json({ error: 'You already have 2 builds running. Wait for one to finish.' });
  const title = String(req.body?.title || '').trim();
  const subtitle = String(req.body?.subtitle || '').trim();
  let campaigns = [];
  try {
    campaigns = JSON.parse(String(req.body?.campaigns || '[]'));
  } catch {
    return res.status(400).json({ error: 'Campaign data was not valid JSON.' });
  }
  const files = req.files || [];
  if (!Array.isArray(campaigns) || !campaigns.length) return res.status(400).json({ error: 'Add at least one campaign.' });
  if (!files.length) return res.status(400).json({ error: 'Upload at least one asset.' });

  const id = `${Date.now()}-${hash(`${title}:${campaigns.map(c => c.title || c.campaign || '').join('|')}:${files.map(f => f.originalname).join('|')}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: 'campaign-builder', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving campaign assets','AI analyzing campaign asset','Building campaign pages','AI cleanup','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  try {
    const result = await runCampaignBuild({ files, campaigns, outDir, title, subtitle, aiCleanup: true, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      review: `/generated/${id}/site/import-review.html`,
      manifest: `/generated/${id}/manifest.json`,
      rawManifest: `/generated/${id}/manifest.raw.json`,
      cleanedManifest: `/generated/${id}/manifest.cleaned.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (e) {
    job.status = 'error';
    finaliseJob(job);
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Build failed', detail: e.message, at: new Date().toISOString() });
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  } finally {
    releaseBuildSlot(req.user.uid);
  }
});

app.post('/api/portfolio-studio/build', requireFirebaseAuth, zipUpload.single('zip'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload one ZIP file.' });
  const name = String(req.body?.name || '').trim();
  const jobTitle = String(req.body?.jobTitle || '').trim();
  const linkedin = String(req.body?.linkedin || '').trim();
  const style = String(req.body?.style || 'straightforward').trim();
  const prompt = String(req.body?.prompt || '').trim().slice(0, 4000);
  if (!prompt) {
    await fs.remove(file.path).catch(() => {});
    return res.status(400).json({ error: 'Describe the portfolio you want to build.' });
  }

  const id = `${Date.now()}-${hash(`${req.user.uid}:${name}:${jobTitle}:${linkedin}:${style}:${prompt}:${file.originalname}:${file.size}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: 'portfolio-studio', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Reading upload', 'ZIP analyzed', 'AI planning site', 'Creating code project', 'Portfolio code ready', 'Validating output', 'Validation passed', 'Validation warnings', 'ZIP ready'];
  const updatePercent = (stage) => {
    const index = stages.findIndex(item => stage.startsWith(item));
    if (index >= 0) job.percent = Math.max(job.percent, Math.round(((index + 1) / stages.length) * 100));
  };

  try {
    const result = await runPortfolioStudioBuild({
      zipPath: file.path,
      outDir,
      name,
      jobTitle,
      linkedin,
      style,
      prompt,
      onProgress: (event) => {
        updatePercent(event.stage);
        job.progress.push(event);
        if (job.progress.length > 300) job.progress.shift();
      }
    });
    attachOwner(result.manifest, req.user);
    await fs.writeJson(path.join(outDir, 'manifest.json'), result.manifest, { spaces: 2 });
    await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), result.manifest, { spaces: 2 });
    job.progress.push({ stage: 'Validating output', detail: 'Checking generated links and local assets', at: new Date().toISOString() });
    updatePercent('Validating output');
    const validation = await validateSite(result.siteDir);
    job.progress.push({ stage: validation.ok ? 'Validation passed' : 'Validation warnings', detail: validation.ok ? 'No missing local assets found' : `${validation.errors.length} issue(s) found`, at: new Date().toISOString() });
    updatePercent(validation.ok ? 'Validation passed' : 'Validation warnings');
    await zipDir(result.siteDir, path.join(outDir, 'site.zip'));
    job.progress.push({ stage: 'ZIP ready', detail: 'Portfolio package created', at: new Date().toISOString() });
    updatePercent('ZIP ready');
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      manifest: `/generated/${id}/manifest.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (error) {
    job.status = 'error';
    finaliseJob(job);
    job.error = error.stack || error.message;
    job.progress.push({ stage: 'Build failed', detail: error.message, at: new Date().toISOString() });
  } finally {
    await fs.remove(file.path).catch(() => {});
  }
});

app.post('/api/ai-studio/build', requireFirebaseAuth, zipUpload.single('zip'), async (req, res) => {
  const file = req.file; // optional — null when portfolioUrl provided instead
  const portfolioUrl = String(req.body?.portfolioUrl || '').trim();
  const linkedinUrl = String(req.body?.linkedinUrl || '').trim();
  const name = String(req.body?.name || '').trim();
  const jobTitle = String(req.body?.jobTitle || '').trim();
  const style = String(req.body?.style || 'straightforward').trim();
  const prompt = String(req.body?.prompt || '').trim().slice(0, 4000);

  if (!file && !portfolioUrl) {
    return res.status(400).json({ error: 'Either upload a ZIP file or enter a portfolio URL.' });
  }
  if (!prompt) {
    if (file) await fs.remove(file.path).catch(() => {});
    return res.status(400).json({ error: 'Describe the portfolio you want to build.' });
  }

  const id = `${Date.now()}-${hash(`${req.user.uid}:${name}:${jobTitle}:${style}:${prompt}:${portfolioUrl}:${file?.size || 0}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: portfolioUrl || 'ai-studio', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Reading upload', 'Scraping portfolio', 'Fetching LinkedIn', 'ZIP analyzed', 'AI planning site', 'Creating code project', 'Portfolio code ready', 'Validating output', 'Validation passed', 'Validation warnings', 'ZIP ready'];
  const updatePercent = stage => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  let tempScrapDir = null;

  try {
    let resolvedName = name;
    let resolvedJobTitle = jobTitle;
    let linkedinAbout = '';

    // Try LinkedIn extraction (best-effort, never fatal)
    if (linkedinUrl && /linkedin\.com/i.test(linkedinUrl)) {
      try {
        job.progress.push({ stage: 'Fetching LinkedIn', detail: 'Extracting profile info...', at: new Date().toISOString() });
        updatePercent('Fetching LinkedIn');
        const { scrapeLinkedInMeta } = await import('./portfolioScraper.js');
        const li = await scrapeLinkedInMeta(linkedinUrl);
        if (li) {
          if (!resolvedName && li.name) resolvedName = li.name;
          if (!resolvedJobTitle && li.jobTitle) resolvedJobTitle = li.jobTitle;
          if (li.about) linkedinAbout = li.about;
          job.progress.push({ stage: 'Fetching LinkedIn', detail: resolvedName ? `Got profile: ${resolvedName}` : 'Profile extracted', at: new Date().toISOString() });
        }
      } catch { /* graceful */ }
    }

    let zipPath = file?.path || null;

    // Scrape portfolio URL if provided (and no ZIP, or in addition to ZIP)
    if (!zipPath && portfolioUrl && /^https?:\/\//i.test(portfolioUrl)) {
      job.progress.push({ stage: 'Scraping portfolio', detail: `Loading ${new URL(portfolioUrl).hostname}...`, at: new Date().toISOString() });
      updatePercent('Scraping portfolio');

      const { scrapePortfolioAssets } = await import('./portfolioScraper.js');
      tempScrapDir = path.join(tmpUploadsDir, `aisc-${id}`);
      await fs.ensureDir(tempScrapDir);

      const scraped = await scrapePortfolioAssets({
        url: portfolioUrl,
        workDir: tempScrapDir,
        onProgress: (stage, detail) => {
          job.progress.push({ stage, detail, at: new Date().toISOString() });
          updatePercent(stage);
        }
      });

      // Pack scraped assets into a ZIP for the studio builder
      if (scraped.projects.length) {
        const { default: AdmZip } = await import('adm-zip');
        const zip = new AdmZip();
        for (const project of scraped.projects) {
          for (const asset of project.assets) {
            const buf = await fs.readFile(asset.rawPath);
            const ext = path.extname(asset.rawPath);
            zip.addFile(`${project.slug}/${asset.originalName.slice(0, 60)}${ext}`, buf);
          }
        }
        const synthZip = path.join(tempScrapDir, 'scraped.zip');
        zip.writeZip(synthZip);
        zipPath = synthZip;
        job.progress.push({ stage: 'Scraping portfolio', detail: `Collected ${scraped.projects.length} project group(s)`, at: new Date().toISOString() });
      }
    }

    if (!zipPath) throw new Error('No content could be collected. Please upload a ZIP file or check the portfolio URL.');

    const enrichedPrompt = linkedinAbout
      ? `${prompt}\n\nAbout (from LinkedIn): ${linkedinAbout.slice(0, 480)}`
      : prompt;

    const result = await runPortfolioStudioBuild({
      zipPath,
      outDir,
      name: resolvedName,
      jobTitle: resolvedJobTitle,
      linkedin: linkedinUrl,
      style,
      prompt: enrichedPrompt,
      onProgress: event => {
        updatePercent(event.stage);
        job.progress.push(event);
        if (job.progress.length > 300) job.progress.shift();
      }
    });

    attachOwner(result.manifest, req.user);
    await fs.writeJson(path.join(outDir, 'manifest.json'), result.manifest, { spaces: 2 });
    await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), result.manifest, { spaces: 2 });
    job.progress.push({ stage: 'Validating output', detail: 'Checking generated links and local assets', at: new Date().toISOString() });
    updatePercent('Validating output');
    const validation = await validateSite(result.siteDir);
    job.progress.push({ stage: validation.ok ? 'Validation passed' : 'Validation warnings', detail: validation.ok ? 'No missing local assets found' : `${validation.errors.length} issue(s) found`, at: new Date().toISOString() });
    updatePercent(validation.ok ? 'Validation passed' : 'Validation warnings');
    await zipDir(result.siteDir, path.join(outDir, 'site.zip'));
    job.progress.push({ stage: 'ZIP ready', detail: 'Portfolio package created', at: new Date().toISOString() });
    updatePercent('ZIP ready');

    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      manifest: `/generated/${id}/manifest.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (error) {
    job.status = 'error';
    finaliseJob(job);
    job.error = error.stack || error.message;
    job.progress.push({ stage: 'Build failed', detail: error.message, at: new Date().toISOString() });
  } finally {
    if (file) await fs.remove(file.path).catch(() => {});
    if (tempScrapDir) await fs.remove(tempScrapDir).catch(() => {});
  }
});

app.post('/api/zip-builder/analyze', requireFirebaseAuth, zipUpload.single('zip'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload one ZIP file.' });
  const staleBefore = Date.now() - (2 * 60 * 60 * 1000);
  for (const [id, session] of zipBuilderSessions) {
    if (Date.parse(session.createdAt || '') >= staleBefore) continue;
    zipBuilderSessions.delete(id);
    await fs.remove(session.sessionDir).catch(() => {});
  }
  const sessionId = `${Date.now()}-${hash(`${req.user.uid}:${file.originalname}:${file.size}`)}`;
  const sessionDir = path.join(tmpUploadsDir, 'zip-builder', sessionId);
  try {
    const campaigns = await analyzePortfolioZip(file.path, sessionDir);
    const session = { id: sessionId, ownerUid: req.user.uid, sessionDir, campaigns, createdAt: new Date().toISOString() };
    zipBuilderSessions.set(sessionId, session);
    res.json({
      sessionId,
      campaigns: campaigns.map(campaign => ({
        id: campaign.id,
        label: campaign.label,
        campaign: campaign.campaign,
        brand: campaign.brand,
        agency: campaign.agency,
        notes: campaign.notes,
        files: campaign.files.map(asset => ({ name: asset.name, size: asset.size }))
      }))
    });
  } catch (error) {
    await fs.remove(sessionDir).catch(() => {});
    res.status(400).json({ error: error.message || 'Could not analyze that ZIP.' });
  } finally {
    await fs.remove(file.path).catch(() => {});
  }
});

app.post('/api/zip-builder/build', requireFirebaseAuth, async (req, res) => {
  const session = zipBuilderSessions.get(String(req.body?.sessionId || ''));
  if (!session) return res.status(404).json({ error: 'ZIP session expired. Upload the ZIP again.' });
  if (session.ownerUid !== req.user.uid) return res.status(403).json({ error: 'Not your ZIP session.' });
  const title = String(req.body?.title || '').trim();
  const subtitle = String(req.body?.subtitle || '').trim();
  const template = String(req.body?.template || 'editorial-grid').trim();
  const approved = Array.isArray(req.body?.campaigns) ? req.body.campaigns : [];
  if (!approved.length) return res.status(400).json({ error: 'Approve at least one campaign.' });

  let files;
  let campaigns;
  try {
    ({ files, campaigns } = stagedFilesForBuild(session, approved));
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Campaign approval data was invalid.' });
  }
  if (!files.length) return res.status(400).json({ error: 'No campaign assets were selected.' });

  const id = `${Date.now()}-${hash(`${title}:${template}:${campaigns.map(campaign => campaign.title).join('|')}`)}`;
  const outDir = jobDir(id);
  const job = { id, url: 'zip-builder', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving campaign assets','AI analyzing campaign asset','Building campaign pages','AI cleanup','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const index = stages.findIndex(item => stage.startsWith(item));
    if (index >= 0) job.percent = Math.max(job.percent, Math.round(((index + 1) / stages.length) * 100));
  };

  try {
    const result = await runCampaignBuild({ files, campaigns, outDir, title, subtitle, template, aiCleanup: true, onProgress: (event) => {
      updatePercent(event.stage);
      job.progress.push(event);
      if (job.progress.length > 300) job.progress.shift();
    }});
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
    finaliseJob(job);
    job.percent = 100;
    job.links = {
      preview: `/generated/${id}/site/index.html`,
      manifest: `/generated/${id}/manifest.json`,
      validation: `/generated/${id}/reports/validation.json`,
      zip: `/api/download/${id}`
    };
  } catch (error) {
    job.status = 'error';
    finaliseJob(job);
    job.error = error.stack || error.message;
    job.progress.push({ stage: 'Build failed', detail: error.message, at: new Date().toISOString() });
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  } finally {
    zipBuilderSessions.delete(session.id);
    await fs.remove(session.sessionDir).catch(() => {});
  }
});

app.get('/api/jobs/:id', requireFirebaseAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.ownerUid && job.ownerUid !== req.user.uid) return res.status(403).json({ error: 'Not your portfolio.' });
  res.json(job);
});

app.get('/api/download/:id', requireFirebaseAuth, requireActiveSubscription, async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  const zip = path.join(jobDir(req.params.id), 'site.zip');
  if (!(await fs.pathExists(zip))) return res.status(404).json({ error: 'ZIP not ready.' });
  res.download(zip, 'killawork-import.zip');
});

function jobDir(id) {
  if (!id || !/^[a-zA-Z0-9_\-]{1,120}$/.test(String(id))) {
    const err = new Error('Invalid portfolio id.');
    err.status = 400;
    throw err;
  }
  const resolved = path.join(generatedRoot, id);
  if (resolved !== generatedRoot && !resolved.startsWith(generatedRoot + path.sep)) {
    const err = new Error('Invalid portfolio id.');
    err.status = 400;
    throw err;
  }
  return resolved;
}

function siteDir(id) {
  return path.join(jobDir(id), 'site');
}

function editorSnapshotsDir(id) {
  return path.join(jobDir(id), '.editor-snapshots');
}

function safeSitePath(id, requested = '') {
  const siteRoot = siteDir(id);
  const clean = String(requested || '').replace(/^\/+/, '');
  if (!clean || clean.includes('\0')) throw new Error('Bad path');
  const normalized = path.normalize(clean);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('Bad path');
  const target = path.join(siteRoot, normalized);
  if (target !== siteRoot && !target.startsWith(siteRoot + path.sep)) throw new Error('Bad path');
  return { target, relative: normalized.replaceAll(path.sep, '/') };
}

const editableTextExtensions = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.xml', '.webmanifest'
]);

function isTextSiteFile(filePath = '') {
  return editableTextExtensions.has(path.extname(filePath).toLowerCase());
}

async function listSiteFiles(id, dir = siteDir(id), prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSiteFiles(id, abs, rel));
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(abs).catch(() => null);
    files.push({
      path: rel,
      size: stat?.size || 0,
      editable: isTextSiteFile(rel),
      kind: path.extname(rel).replace(/^\./, '').toLowerCase() || 'file',
      page: /(^|\/)index\.html?$/i.test(rel)
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function listSitePages(id) {
  const files = await listSiteFiles(id);
  const manifest = await readManifest(id);
  const projectOrder = (manifest?.projects || []).map(p => p.slug);
  // Sidebar order: Home, work pages (manifest order), About, Awards, Contact, anything else
  const orderFor = (p, slug) => {
    if (p === 'index.html') return 0;
    if (p.startsWith('work/')) {
      const idx = projectOrder.indexOf(slug);
      return 100 + (idx >= 0 ? idx : 9000);
    }
    if (p === 'about.html') return 100000;
    if (p === 'awards.html') return 100001;
    if (p === 'contact.html') return 100002;
    return 200000;
  };
  return files
    .filter(file => /\.html?$/i.test(file.path) && file.path !== 'import-review.html')
    .map(file => {
      const isHome = file.path === 'index.html';
      const slug = isHome ? 'home' : file.path.replace(/\/index\.html?$/i, '').replace(/^work\//, '');
      const project = manifest?.projects?.find(item => item.slug === slug);
      const fallback = slug.split('/').pop().replace(/^behance-\d+-/i, '').replace(/[-_]+/g, ' ');
      const rawThumb = project?.thumbnail?.thumbSrc || project?.thumbnail?.src || project?.images?.[0]?.thumbSrc || project?.images?.[0]?.src || '';
      const thumbnail = rawThumb ? (/^https?:\/\//i.test(rawThumb) ? rawThumb : `/generated/${id}/site/${rawThumb}`) : '';
      return {
        slug,
        path: file.path,
        title: isHome ? 'Home'
          : file.path === 'about.html' ? 'About'
          : file.path === 'awards.html' ? 'Awards'
          : file.path === 'contact.html' ? 'Contact'
          : project?.title || fallback,
        preview: `/generated/${id}/site/${file.path}`,
        thumbnail,
        order: orderFor(file.path, slug)
      };
    })
    .sort((a, b) => a.order - b.order);
}

async function readTextSiteFile(id, relativePath) {
  const { target, relative } = safeSitePath(id, relativePath);
  if (!isTextSiteFile(relative)) throw new Error('This file type cannot be edited as text.');
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) throw new Error('File not found');
  if (stat.size > 900000) throw new Error('File is too large to edit here.');
  return { path: relative, content: await fs.readFile(target, 'utf8') };
}

async function writeTextSiteFile(id, relativePath, content) {
  const { target, relative } = safeSitePath(id, relativePath);
  if (!isTextSiteFile(relative)) throw new Error('This file type cannot be written as text.');
  await fs.ensureDir(path.dirname(target));
  await fs.writeFile(target, String(content || ''), 'utf8');
  return relative;
}

// Write styles.css into the site directory, always. Old imports may be missing it;
// even fresh sites need it refreshed when portfolio.css changes.
async function ensureStylesCss(id, manifest) {
  try {
    const baseCss = await fs.readFile(path.join(root, 'public', 'portfolio.css'), 'utf8').catch(() => '');
    const templateName = manifest?.portfolioTemplate || 'default';
    let css = baseCss;
    if (templateName !== 'default') {
      const overlayPath = path.join(root, 'public', 'templates', `${templateName}.css`);
      if (await fs.pathExists(overlayPath)) css = (TEMPLATE_FONT_IMPORTS[templateName] || '') + baseCss + '\n' + await fs.readFile(overlayPath, 'utf8');
    }
    await fs.ensureDir(siteDir(id));
    await fs.writeFile(path.join(siteDir(id), 'styles.css'), css);
  } catch (e) {
    console.error('[ensureStylesCss] failed for', id, e.message);
  }
}

// Regenerate styles.css only when the base portfolio.css is newer than the baked
// copy — so CSS tweaks reach already-generated previews on the next load without
// rewriting the file on every request.
async function refreshStylesIfStale(id, manifest) {
  try {
    const stylesPath = path.join(siteDir(id), 'styles.css');
    const basePath = path.join(root, 'public', 'portfolio.css');
    const [sStat, bStat] = await Promise.all([
      fs.stat(stylesPath).catch(() => null),
      fs.stat(basePath).catch(() => null)
    ]);
    if (!bStat) return;
    if (!sStat || bStat.mtimeMs > sStat.mtimeMs) await ensureStylesCss(id, manifest);
  } catch {
    /* non-fatal — fall back to whatever styles.css is on disk */
  }
}

// Remove snapshot dirs and manifest sidecars that history no longer references.
// Every save/upload/add/delete copies the whole site here; without pruning the
// volume fills up — history caps at 20 entries but old dirs were never deleted.
async function pruneEditorSnapshots(id, history) {
  try {
    const snapshots = editorSnapshotsDir(id);
    const keep = new Set([...(history.undo || []), ...(history.redo || [])]);
    const entries = await fs.readdir(snapshots).catch(() => []);
    await Promise.all(entries.map(entry => {
      if (entry === 'history.json') return null;
      const base = entry.replace(/\.manifest\.json$/, '');
      if (keep.has(base)) return null;
      return fs.remove(path.join(snapshots, entry)).catch(() => {});
    }));
  } catch {}
}

async function createEditorSnapshot(id) {
  const source = siteDir(id);
  if (!(await fs.pathExists(source))) throw new Error('Generated site files are missing.');
  const snapshots = editorSnapshotsDir(id);
  await fs.ensureDir(snapshots);
  const name = `${Date.now()}`;
  const target = path.join(snapshots, name);
  await fs.copy(source, target, {
    filter: src => !src.includes(`${path.sep}.editor-snapshots${path.sep}`)
  });
  // Manifest sidecar — restoring a snapshot must also restore manifest state
  // (page deletes/adds are manifest changes; site files alone would drift)
  const manifestFile = path.join(jobDir(id), 'manifest.json');
  if (await fs.pathExists(manifestFile)) await fs.copy(manifestFile, path.join(snapshots, `${name}.manifest.json`));
  const historyFile = path.join(snapshots, 'history.json');
  const history = await fs.readJson(historyFile).catch(() => ({ undo: [], redo: [] }));
  history.undo = [...(history.undo || []), name].slice(-20);
  history.redo = [];
  await fs.writeJson(historyFile, history, { spaces: 2 });
  await pruneEditorSnapshots(id, history);
  return name;
}

async function restoreEditorSnapshot(id, direction = 'undo') {
  const snapshots = editorSnapshotsDir(id);
  const historyFile = path.join(snapshots, 'history.json');
  const history = await fs.readJson(historyFile).catch(() => ({ undo: [], redo: [] }));
  const from = direction === 'redo' ? 'redo' : 'undo';
  const to = from === 'undo' ? 'redo' : 'undo';
  const snapshot = (history[from] || []).pop();
  if (!snapshot) return null;
  const current = `${Date.now()}-current`;
  await fs.copy(siteDir(id), path.join(snapshots, current));
  const currentManifest = path.join(jobDir(id), 'manifest.json');
  if (await fs.pathExists(currentManifest)) await fs.copy(currentManifest, path.join(snapshots, `${current}.manifest.json`));
  history[to] = [...(history[to] || []), current].slice(-20);
  // Atomic-ish restore: copy to a temp dir first, then swap — avoids an empty siteDir window
  const tmpRestore = path.join(jobDir(id), 'site-restore-tmp');
  await fs.remove(tmpRestore).catch(() => {});
  await fs.copy(path.join(snapshots, snapshot), tmpRestore);
  const oldSite = path.join(jobDir(id), 'site-old-tmp');
  await fs.rename(siteDir(id), oldSite);
  await fs.rename(tmpRestore, siteDir(id));
  await fs.remove(oldSite).catch(() => {});
  // Restore the manifest sidecar when the snapshot has one (older snapshots may not)
  const sidecar = path.join(snapshots, `${snapshot}.manifest.json`);
  if (await fs.pathExists(sidecar)) {
    await fs.copy(sidecar, path.join(jobDir(id), 'manifest.json'));
    await fs.copy(sidecar, path.join(jobDir(id), 'manifest.cleaned.json'));
  }
  await fs.writeJson(historyFile, history, { spaces: 2 });
  await pruneEditorSnapshots(id, history);
  // Old snapshots pre-date styles.css — always regenerate it after restore so the preview never 404s
  const restoredManifest = await readManifest(id).catch(() => null);
  if (restoredManifest) await ensureStylesCss(id, restoredManifest);
  await zipDir(siteDir(id), path.join(jobDir(id), 'site.zip'));
  return { restored: snapshot, undoCount: history.undo?.length || 0, redoCount: history.redo?.length || 0 };
}

async function editorHistoryState(id) {
  const history = await fs.readJson(path.join(editorSnapshotsDir(id), 'history.json')).catch(() => ({ undo: [], redo: [] }));
  return { undoCount: history.undo?.length || 0, redoCount: history.redo?.length || 0 };
}

async function readManifest(id) {
  const file = path.join(jobDir(id), 'manifest.json');
  if (!(await fs.pathExists(file))) return null;
  return fs.readJson(file);
}

function publicProject(project) {
  return {
    title: project.title,
    subtitle: project.subtitle || '',
    titleFontSize: project.titleFontSize || 0,
    aiLayout: project.aiLayout || '',
    pageStyle: project.pageStyle || {},
    slug: project.slug,
    url: project.url,
    images: project.images || [],
    videos: project.videos || [],
    audios: project.audios || [],
    documents: project.documents || [],
    contentItems: project.contentItems || []
  };
}

function publicHomePage(manifest, id) {
  const identity = resolvePortfolioIdentity(manifest);
  const items = (manifest.projects || []).map((project, index) => {
    const thumb = project.thumbnail?.thumbSrc || project.thumbnail?.src || project.images?.[0]?.thumbSrc || project.images?.[0]?.src || '';
    return {
      type: 'home-card',
      order: index + 1,
      slug: project.slug,
      title: project.title,
      thumb,
      url: `/generated/${id}/site/work/${project.slug}/index.html`
    };
  });
  return {
    kind: 'home',
    title: identity.ownerName || manifest.homeTitle || manifest.siteTitle || 'Home',
    homeIntro: identity.homeIntro || '',
    slug: 'home',
    url: manifest.sourceUrl || '',
    images: [],
    videos: [],
    audios: [],
    documents: [],
    contentItems: items
  };
}

function uniqueProjectSlug(manifest, title = 'new-campaign') {
  const base = safeSlug(title || 'new-campaign');
  const used = new Set((manifest.projects || []).map(project => project.slug));
  let slug = base;
  let suffix = 2;
  while (used.has(slug)) slug = `${base}-${suffix++}`;
  return slug;
}

function titleFromPrompt(value = '') {
  const lines = String(value || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => cleanInlineText(line, 120))
    .filter(Boolean);
  const first = lines.find(line => line.length >= 3) || 'New campaign';
  return first.replace(/^(campaign|title|headline)\s*:\s*/i, '').slice(0, 90) || 'New campaign';
}

function cleanInlineText(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function replaceAllText(value, replacements = []) {
  let out = String(value || '');
  for (const item of replacements) {
    if (!item.find) continue;
    out = out.split(item.find).join(item.replace);
  }
  return out;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function applyTextReplacementsToProject(project, replacements = []) {
  if (!replacements.length) return;
  project.title = replaceAllText(project.title, replacements).replace(/\s+/g, ' ').trim();
  project.subtitle = replaceAllText(project.subtitle || '', replacements).replace(/\s+/g, ' ').trim();
  project.description = replaceAllText(project.description || '', replacements);
  project.copyBlocks = (project.copyBlocks || []).map(block => ({ ...block, text: replaceAllText(block.text || '', replacements) }));
  project.contentItems = (project.contentItems || []).map(item => (
    item.type === 'text' ? { ...item, text: replaceAllText(item.text || '', replacements) } : item
  ));
  if (project.sourceCloneHtml) project.sourceCloneHtml = replaceAllText(project.sourceCloneHtml, replacements);
}

function formatCreditsText(value = '') {
  let text = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  const labels = [
    'Credits (Film)',
    'Production House',
    'Executive Producers',
    'Creative Director',
    'Senior Account Manager',
    'Producer',
    'Director',
    'Agency',
    'DOP'
  ];
  for (const label of labels.sort((a, b) => b.length - a.length)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\s*(${escaped})\\s*:`, 'gi'), '\n$1:');
  }
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function compactForMatch(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function applyCreditLineBreakEdit(project, prompt = '') {
  if (!/\b(agency|creative director|credits|producer|dop|production house)\b/i.test(prompt)) return '';
  if (!/\b(break|separate|split|line by line|vertically|format|credits?)\b/i.test(prompt) && !String(prompt).includes(':')) return '';
  let pasted = String(prompt).trim();
  const beforeCommand = pasted.split(/\b(?:break|separate|split)\b/i)[0].trim();
  if (beforeCommand && /\b(agency|creative director|credits|producer|dop|production house)\b/i.test(beforeCommand)) pasted = beforeCommand;
  pasted = pasted.replace(/^.*?(?=(?:Agency|Credits(?:\s*\([^)]*\))?|Production House|Creative Director|Senior Account Manager|Producer|Director|DOP)\s*:)/is, '').trim();
  const formatted = formatCreditsText(pasted);
  if (!formatted.includes('\n')) return '';
  project.contentItems = project.contentItems || [];
  const targetKey = compactForMatch(pasted).slice(0, 500);
  let bestIndex = -1;
  let bestScore = 0;
  project.contentItems.forEach((item, index) => {
    if (item.type !== 'text') return;
    const key = compactForMatch(item.text || '');
    const score = targetKey && key.includes(targetKey.slice(0, Math.min(120, targetKey.length))) ? 100 : ['agency', 'creativedirector', 'producer', 'dop'].filter(word => key.includes(word)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  const nextText = formatted;
  if (bestIndex >= 0) {
    project.contentItems[bestIndex] = { ...project.contentItems[bestIndex], text: nextText, preserveLineBreaks: true, align: project.contentItems[bestIndex].align || 'left' };
  } else {
    project.contentItems.push({ type: 'text', order: project.contentItems.length + 1, tag: 'p', text: nextText, preserveLineBreaks: true, fontSize: 20, align: 'left' });
  }
  project.cleaned = null;
  return 'Separated credits into individual lines.';
}

function applyHeadlineSizeEdit(project, prompt = '') {
  if (!/\b(headline|title)\b/i.test(prompt) || !/\b(reduce|smaller|decrease|lower|shrink)\b/i.test(prompt) || !/\b(font|size)\b/i.test(prompt)) return '';
  const current = Number(project.titleFontSize) || 82;
  project.titleFontSize = Math.max(28, Math.round(current * 0.78));
  project.cleaned = null;
  return 'Reduced the headline font size.';
}

function applyDirectAiEdit(project, prompt = '') {
  const messages = [
    applyHeadlineSizeEdit(project, prompt),
    applyCreditLineBreakEdit(project, prompt)
  ].filter(Boolean);
  return messages.length ? messages.join(' ') : '';
}

function mediaRank(item) {
  if (item.type === 'video') return 0;
  if (item.type === 'image') return 1;
  if (item.type === 'gallery') return 2;
  if (item.type === 'text') return 3;
  return 4;
}

function setMediaTreatment(project, target = '', treatment = '') {
  const safeTreatment = ['hero', 'full-width', 'contained'].includes(treatment) ? treatment : 'full-width';
  const items = project.contentItems || [];
  const isMedia = item => ['image', 'video', 'gallery', 'document'].includes(item.type);
  if (target === 'first-media') {
    const item = items.find(isMedia);
    if (item) item.treatment = safeTreatment;
    return !!item;
  }
  const predicate = target === 'all-images' ? item => item.type === 'image' : isMedia;
  let changed = false;
  for (const item of items) {
    if (predicate(item)) {
      item.treatment = safeTreatment;
      changed = true;
    }
  }
  return changed;
}

function applyPageOperation(project, operation = {}, prompt = '') {
  const op = String(operation.op || '').trim();
  project.contentItems = project.contentItems || [];
  if (op === 'updateTitle') {
    if (operation.title) project.title = cleanInlineText(operation.title, 200);
    if (Object.prototype.hasOwnProperty.call(operation, 'subtitle')) project.subtitle = cleanInlineText(operation.subtitle, 220);
    return 'Updated the page headline.';
  }
  if (op === 'resizeHeadline') {
    const current = Number(project.titleFontSize) || 82;
    project.titleFontSize = operation.size ? Math.max(28, Math.min(120, Number(operation.size))) : Math.max(28, Math.round(current * (operation.scale || 0.82)));
    return 'Resized the headline.';
  }
  if (op === 'replaceText' && operation.find && operation.replace) {
    applyTextReplacementsToProject(project, [{ find: operation.find, replace: operation.replace }]);
    return 'Replaced matching page text.';
  }
  if (op === 'splitCredits') {
    return applyCreditLineBreakEdit(project, operation.text || prompt);
  }
  if (op === 'insertText' && operation.text) {
    project.contentItems.unshift({
      type: 'text',
      order: 0,
      tag: 'p',
      text: operation.text,
      fontSize: 22,
      align: ['left', 'center', 'right'].includes(operation.align) ? operation.align : 'center',
      preserveLineBreaks: operation.text.includes('\n')
    });
    return 'Added a text section.';
  }
  if (op === 'setPageLayout') {
    const layout = ['editorial', 'gallery', 'case-study', 'video-led', 'minimal'].includes(operation.layout) ? operation.layout : 'editorial';
    project.aiLayout = layout;
    project.pageStyle = project.pageStyle || {};
    if (layout === 'editorial') project.pageStyle.contentWidth = 1040;
    if (layout === 'gallery') project.pageStyle.contentWidth = 1280;
    if (layout === 'minimal') project.pageStyle.contentWidth = 900;
    return `Changed the page layout to ${layout}.`;
  }
  if (op === 'setMediaTreatment') {
    return setMediaTreatment(project, operation.target || 'first-media', operation.treatment || 'full-width') ? 'Changed media sizing and treatment.' : '';
  }
  if (op === 'reorderBlocks') {
    project.contentItems.sort((a, b) => mediaRank(a) - mediaRank(b));
    return 'Reordered the page blocks.';
  }
  if (op === 'groupImagesIntoSlider') {
    const imageIndexes = project.contentItems.filter(item => item.type === 'image' && Number.isInteger(item.imageIndex)).map(item => item.imageIndex);
    if (imageIndexes.length < 2) return '';
    project.contentItems = [
      { type: 'gallery', order: 1, imageIndexes: [...new Set(imageIndexes)] },
      ...project.contentItems.filter(item => item.type !== 'image')
    ];
    return 'Grouped images into a slider.';
  }
  if (op === 'setColors') {
    project.pageStyle = project.pageStyle || {};
    if (/^#[0-9a-f]{3,8}$/i.test(operation.backgroundColor || '')) project.pageStyle.backgroundColor = operation.backgroundColor;
    if (/^#[0-9a-f]{3,8}$/i.test(operation.textColor || '')) project.pageStyle.textColor = operation.textColor;
    return 'Updated page colors.';
  }
  return '';
}

function applyPageOperations(project, plan = {}, prompt = '') {
  const applied = [];
  for (const operation of plan.operations || []) {
    const message = applyPageOperation(project, operation, prompt);
    if (message) applied.push(message);
  }
  if (applied.length) {
    project.contentItems = (project.contentItems || []).map((item, index) => ({ ...item, order: index + 1 }));
    project.cleaned = null;
  }
  return applied;
}

function applyAiEditToProject(project, edit) {
  const previousTitle = project.title || '';
  applyTextReplacementsToProject(project, edit.replaceText || []);
  if (edit.title) project.title = edit.title;
  if (edit.subtitle) project.subtitle = edit.subtitle;
  if (project.sourceCloneHtml && edit.title && previousTitle && previousTitle !== project.title) {
    const titleMarkup = edit.subtitle
      ? `<span class="killerwork-ai-title">${escapeHtml(edit.title)}<br><span>${escapeHtml(edit.subtitle)}</span></span>`
      : escapeHtml(edit.title);
    project.sourceCloneHtml = replaceAllText(project.sourceCloneHtml, [
      { find: previousTitle, replace: titleMarkup },
      { find: escapeHtml(previousTitle), replace: titleMarkup }
    ]);
  }
  if (edit.prependText) {
    project.contentItems = project.contentItems || [];
    project.contentItems.unshift({
      type: 'text',
      order: 0,
      tag: 'p',
      text: edit.prependText,
      fontSize: 24,
      bold: false,
      align: 'center'
    });
  }
  project.contentItems = (project.contentItems || []).map((item, index) => ({ ...item, order: index + 1 }));
  project.cleaned = null;
}

function extensionForMime(type = '') {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/aac': '.aac',
    'audio/ogg': '.ogg',
    'application/pdf': '.pdf'
  };
  return map[String(type || '').toLowerCase()] || '';
}

function uploadedAssetName(file) {
  const ext = path.extname(file.originalname || '').toLowerCase() || extensionForMime(file.mimetype);
  const base = path.basename(file.originalname || 'asset', ext)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'asset';
  return `${Date.now()}-${hash(`${file.originalname}:${file.size}:${file.path}`).slice(0, 8)}-${base}${ext}`;
}

function mediaKindForUpload(file) {
  const type = String(file.mimetype || '');
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'document';
  return '';
}

async function moveUploadedPortfolioAsset(id, file) {
  const kind = mediaKindForUpload(file);
  if (!kind) {
    await fs.remove(file.path).catch(() => {});
    return null;
  }
  const assetsDir = path.join(jobDir(id), 'assets-imported');
  await fs.ensureDir(assetsDir);
  const fileName = uploadedAssetName(file);
  await fs.move(file.path, path.join(assetsDir, fileName), { overwrite: true });
  return {
    kind,
    src: `assets/imported/${fileName}`,
    fileName,
    original: file.originalname || fileName
  };
}

async function createProjectFromUploads(id, manifest, { title, prompt, files = [], builderInput = null } = {}) {
  const projectTitle = cleanInlineText(title || titleFromPrompt(prompt), 160) || 'New campaign';
  const project = {
    title: projectTitle,
    subtitle: '',
    slug: uniqueProjectSlug(manifest, projectTitle),
    url: '',
    sourcePlatform: 'ai-editor',
    images: [],
    videos: [],
    audios: [],
    documents: [],
    contentItems: [],
    aiLayout: 'editorial',
    pageStyle: { contentWidth: 1040 },
    builderInput,
    importedAt: new Date().toISOString()
  };
  const contentItems = [];
  for (const file of files) {
    const moved = await moveUploadedPortfolioAsset(id, file);
    if (!moved) continue;
    const order = contentItems.length + 1;
    if (moved.kind === 'image') {
      const imageIndex = project.images.push({
        src: moved.src,
        localFile: moved.fileName,
        alt: projectTitle,
        original: moved.original,
        order
      }) - 1;
      if (!project.thumbnail) project.thumbnail = { src: moved.src, original: moved.original };
      contentItems.push({ type: 'image', order, imageIndex, original: moved.original, treatment: order === 1 ? 'hero' : 'contained' });
    } else if (moved.kind === 'video') {
      const videoIndex = project.videos.push({
        kind: 'video',
        type: 'video',
        src: moved.src,
        localFile: moved.fileName,
        title: projectTitle,
        original: moved.original,
        order
      }) - 1;
      contentItems.push({ type: 'video', order, videoIndex, original: moved.original, treatment: order === 1 ? 'hero' : 'contained' });
    } else if (moved.kind === 'audio') {
      const audioIndex = project.audios.push({
        kind: 'audio',
        type: 'audio',
        src: moved.src,
        localFile: moved.fileName,
        title: moved.original,
        original: moved.original,
        order
      }) - 1;
      contentItems.push({ type: 'audio', order, audioIndex, original: moved.original });
    } else if (moved.kind === 'document') {
      const documentIndex = project.documents.push({
        src: moved.src,
        localFile: moved.fileName,
        title: moved.original,
        original: moved.original,
        order
      }) - 1;
      contentItems.push({ type: 'document', order, documentIndex, original: moved.original });
    }
  }
  const description = String(builderInput?.notes || prompt || '').replace(/\r/g, '\n').trim().slice(0, 4000);
  project.description = description;
  project.copyBlocks = [builderInput?.brand, builderInput?.agency, builderInput?.role]
    .map(value => cleanInlineText(value || ''))
    .filter(Boolean)
    .map(text => ({ tag: 'p', text }));
  if (description) {
    if (!builderInput) contentItems.push({
      type: 'text',
      order: contentItems.length + 1,
      tag: 'p',
      text: description,
      preserveLineBreaks: true,
      align: 'left',
      fontSize: 18
    });
  }
  project.contentItems = contentItems;
  if (!project.thumbnail && project.images[0]) project.thumbnail = { src: project.images[0].src, original: project.images[0].original };
  return project;
}

function visualManagerEnabled(manifest = {}) {
  return manifest.sourceUrl === 'campaign-builder' || !!manifest.sourceHome?.html;
}

function projectSummary(project, id) {
  const thumb = project.thumbnail?.thumbSrc || project.thumbnail?.src || project.images?.[0]?.thumbSrc || project.images?.[0]?.src || '';
  const thumbnail = /^https?:\/\//i.test(thumb) ? thumb : (thumb ? `/generated/${id}/site/${thumb}` : '');
  return {
    title: project.title,
    slug: project.slug,
    thumbnail,
    images: (project.images || []).length,
    videos: (project.videos || []).length,
    audios: (project.audios || []).length,
    documents: (project.documents || []).length,
    preview: `/generated/${id}/site/work/${project.slug}/index.html`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}&page=${encodeURIComponent(project.slug)}`
  };
}

function publicPortfolio(id, manifest, validation = null) {
  const identity = resolvePortfolioIdentity(manifest);
  return {
    id,
    siteTitle: identity.ownerName || manifest.siteTitle || '',
    ownerName: identity.ownerName || '',
    homeIntro: identity.homeIntro || '',
    sourceUrl: manifest.sourceUrl || '',
    buildMode: manifest.buildMode || '',
    visualManager: visualManagerEnabled(manifest),
    generatedAt: manifest.generatedAt || '',
    preview: `/generated/${id}/site/index.html`,
    review: `/generated/${id}/site/import-review.html`,
    manifest: `/generated/${id}/manifest.json`,
    zip: `/api/download/${id}`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}`,
    published: manifest.published || null,
    customDomain: manifest.customDomain || null,
    projects: (manifest.projects || []).map(project => projectSummary(project, id)),
    hasAboutPage: !!(manifest.aboutProfile?.paragraphs?.length || manifest.sourceAbout?.html),
    aboutProfile: manifest.aboutProfile || null,
    validation
  };
}

function publicPortfolioListItem(id, manifest) {
  const identity = resolvePortfolioIdentity(manifest);
  return {
    id,
    siteTitle: identity.ownerName || manifest.siteTitle || 'Untitled portfolio',
    ownerName: identity.ownerName || '',
    sourceUrl: manifest.sourceUrl || '',
    buildMode: manifest.buildMode || '',
    visualManager: visualManagerEnabled(manifest),
    generatedAt: manifest.generatedAt || '',
    projectCount: (manifest.projects || []).length,
    preview: `/generated/${id}/site/index.html`,
    manage: `/manage.html?job=${encodeURIComponent(id)}`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}`,
    zip: `/api/download/${id}`,
    published: manifest.published || null,
    customDomain: manifest.customDomain || null
  };
}

async function userPortfolioList(user) {
  const generatedDir = generatedRoot;
  if (!(await fs.pathExists(generatedDir))) return [];
  const entries = await fs.readdir(generatedDir);
  const validEntries = entries.filter(id => /^[a-zA-Z0-9_\-]{1,120}$/.test(id));
  const portfolios = await Promise.all(validEntries.map(async id => {
    const manifest = await readManifest(id);
    if (!manifest || !canAccessPortfolio(manifest, user)) return null;
    return publicPortfolioListItem(id, manifest);
  }));
  return portfolios
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt || b.id).localeCompare(String(a.generatedAt || a.id)));
}

async function saveManifestAndRebuild(id, manifest) {
  return withPortfolioLock(id, async () => {
    const outDir = jobDir(id);
    await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });
    await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), manifest, { spaces: 2 });
    const sDir = await generateSite(manifest, outDir);
    const validation = await validateSite(sDir);
    await zipDir(sDir, path.join(outDir, 'site.zip'));
    return validation;
  });
}

app.get('/api/manage/:id', requireFirebaseAuth, async (req, res) => {
  try {
    const manifest = await readManifest(req.params.id);
    if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
    if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
    res.json(publicPortfolio(req.params.id, manifest));
  } catch (err) {
    console.error('GET /api/manage/:id failed', err);
    res.status(500).json({ error: 'Could not load portfolio.' });
  }
});

app.get('/api/portfolios', requireFirebaseAuth, async (req, res) => {
  try {
    res.json({ portfolios: await userPortfolioList(req.user) });
  } catch (err) {
    console.error('GET /api/portfolios failed', err);
    res.status(500).json({ error: 'Could not load your portfolios.' });
  }
});

app.get('/api/billing/status', requireFirebaseAuth, async (req, res) => {
  try {
    res.json(await subscriptionStateFor(req.user));
  } catch (err) {
    console.error('Stripe billing status failed', err);
    res.status(503).json({ error: 'Could not check your subscription.', code: 'billing_unavailable' });
  }
});

app.get('/api/billing/checkout-session/:sessionId', requireFirebaseAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet.', code: 'billing_not_configured' });
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    const belongsToUser = session.client_reference_id === req.user.uid || session.metadata?.firebaseUid === req.user.uid;
    if (!belongsToUser) return res.status(403).json({ error: 'This checkout session does not belong to your account.' });
    if (session.mode !== 'payment' || session.status !== 'complete' || session.payment_status !== 'paid') {
      return res.status(409).json({ error: 'Your payment has not been confirmed yet.', code: 'payment_pending' });
    }
    // Finish the publish the user started before paying, using the subdomain captured
    // at checkout — so they land on a live site instead of having to re-publish.
    let published = null;
    const pendingJob = session.metadata?.jobId;
    const pendingSubdomain = session.metadata?.subdomain;
    if (pendingJob && pendingSubdomain) {
      const manifest = await readManifest(pendingJob).catch(() => null);
      if (manifest && canAccessPortfolio(manifest, req.user)) {
        const result = await publishPortfolioSubdomain(pendingJob, manifest, pendingSubdomain);
        if (!result.error) published = result.published;
      }
    }
    res.json({
      confirmed: true,
      transactionId: session.id,
      value: Number.isFinite(session.amount_total) ? session.amount_total / 100 : 9.99,
      currency: String(session.currency || 'usd').toUpperCase(),
      published
    });
  } catch (err) {
    console.error('Stripe checkout confirmation failed', err);
    res.status(503).json({ error: 'Could not confirm your payment. Please try again.', code: 'billing_unavailable' });
  }
});

app.post('/api/billing/checkout', requireFirebaseAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet.', code: 'billing_not_configured' });
    const customer = await stripeCustomerFor(req.user, { create: true });
    const origin = requestOrigin(req);
    const jobId = String(req.body?.jobId || '').trim().slice(0, 80);
    const subdomain = normalizeSubdomain(req.body?.subdomain || '');
    const sourceUrl = jobId ? String((await readManifest(jobId).catch(() => null))?.sourceUrl || '').slice(0, 500) : '';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customer.id,
      client_reference_id: req.user.uid,
      line_items: [{
        price_data: { currency: 'usd', unit_amount: 999, product: stripeProductId },
        quantity: 1
      }],
      success_url: `${origin}/manage.html?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/manage.html?payment=cancelled`,
      allow_promotion_codes: true,
      metadata: { firebaseUid: req.user.uid, ...(jobId && { jobId }), ...(subdomain && { subdomain }), ...(sourceUrl && { sourceUrl }) }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session failed', err);
    res.status(503).json({ error: 'Could not open checkout. Please try again.', code: 'billing_unavailable' });
  }
});

app.post('/api/billing/portal', requireFirebaseAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Subscriptions are not configured yet.', code: 'billing_not_configured' });
    const customer = await stripeCustomerFor(req.user);
    if (!customer) return res.status(404).json({ error: 'No billing customer exists for this account.', code: 'billing_customer_missing' });
    const origin = requestOrigin(req);
    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: `${origin}/profile.html`
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe billing portal failed', err);
    res.status(503).json({ error: 'Could not open billing portal. Please try again.', code: 'billing_unavailable' });
  }
});

app.put('/api/manage/:id', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  const siteTitle = String(req.body?.siteTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ownerName = String(req.body?.ownerName || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (siteTitle) manifest.siteTitle = siteTitle;
  if (ownerName) manifest.ownerName = ownerName;
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json(publicPortfolio(id, manifest, validation));
});

const RESERVED_SUBDOMAINS = new Set(['www', 'app', 'api', 'admin', 'assets', 'static', 'cdn', 'mail', 'support', 'help', 'killawork']);

// Validate a requested subdomain and confirm it isn't taken by another portfolio.
// Returns { error } or { requested }. Checked BEFORE the payment gate so a bad/taken
// name is reported in the popup rather than after the user has paid.
async function subdomainAvailability(id, requestedRaw) {
  const requested = normalizeSubdomain(requestedRaw || '');
  if (!validSubdomain(requested) || RESERVED_SUBDOMAINS.has(requested)) {
    return { error: { status: 400, body: { error: 'Choose a valid subdomain using letters, numbers, or hyphens.' } } };
  }
  const index = await publishedIndex();
  const existing = index.get(requested);
  if (existing && existing.id !== id) {
    return { error: { status: 409, body: { error: `${requested}.${publicHost()} is already taken. Try another name.` } } };
  }
  return { requested };
}

// Core publish: validate availability, then write the subdomain onto the manifest.
// Shared by the publish endpoint and the post-payment auto-publish so both behave
// identically. Returns { error } or { published, customDomain, paid }.
async function publishPortfolioSubdomain(id, manifest, requestedRaw) {
  const availability = await subdomainAvailability(id, requestedRaw);
  if (availability.error) return availability;
  const requested = availability.requested;
  manifest.paid = true;
  manifest.published = {
    subdomain: requested,
    url: publishedUrlFor(requested),
    localPreview: `/published/${requested}/`,
    publishedAt: new Date().toISOString()
  };
  // Connected custom domains pin their DNS target to the subdomain — keep it in sync
  // when the URL changes so the instructions never go stale.
  if (manifest.customDomain?.domain) {
    manifest.customDomain.dnsValue = `${requested}.${publicHost()}`;
  }
  await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
  return { published: manifest.published, customDomain: manifest.customDomain || null, paid: manifest.paid };
}

app.post('/api/publish/:id', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  // Check the name BEFORE the payment gate so a taken/invalid subdomain is reported
  // in the popup and never sends the user to checkout for a name they can't have.
  const availability = await subdomainAvailability(id, req.body?.subdomain);
  if (availability.error) return res.status(availability.error.status).json(availability.error.body);
  // Then require the one-time payment (inlined from requireActiveSubscription so it
  // runs only after the name is confirmed available).
  const state = await subscriptionStateFor(req.user);
  if (!state.configured) return res.status(503).json({ error: 'Subscriptions are not configured yet.', code: 'billing_not_configured' });
  if (!state.active) {
    return res.status(402).json({
      error: 'A one-time $9.99 payment unlocks publishing, custom domains, and ZIP downloads.',
      code: 'subscription_required'
    });
  }
  const result = await publishPortfolioSubdomain(id, manifest, availability.requested);
  if (result.error) return res.status(result.error.status).json(result.error.body);
  res.json({ ok: true, published: result.published, customDomain: result.customDomain, paid: result.paid });
});

// Unpublish: take a live site offline. The custom domain (if any) is kept on the
// manifest so reconnecting later is one click, but the site stops resolving.
app.delete('/api/publish/:id', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  if (!manifest.published) return res.json({ ok: true, published: null, customDomain: manifest.customDomain || null });
  manifest.published = null;
  await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
  res.json({ ok: true, published: null, customDomain: manifest.customDomain || null });
});

app.post('/api/custom-domain/:id', requireFirebaseAuth, requireActiveSubscription, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  if (!manifest.published?.subdomain) return res.status(400).json({ error: 'Publish your portfolio first before connecting a custom domain.' });
  const domain = normalizeDomain(req.body?.domain || '');
  if (!domain) return res.status(400).json({ error: 'Domain is required.' });
  if (!validDomain(domain)) return res.status(400).json({ error: 'Enter a valid domain, like www.yourportfolio.com.' });
  if (domain === publicHost().toLowerCase() || domain.endsWith(`.${publicHost().toLowerCase()}`)) {
    return res.status(400).json({ error: `Use the ${publicHost()} subdomain field for KillaWork URLs.` });
  }
  const index = await publishedIndex();
  for (const published of index.values()) {
    if (published.id !== id && published.customDomain?.domain === domain) {
      return res.status(409).json({ error: `${domain} is already connected to another portfolio.` });
    }
  }
  manifest.customDomain = {
    domain,
    dnsType: 'CNAME',
    dnsName: domain,
    dnsValue: `${manifest.published.subdomain}.${publicHost()}`,
    connectedAt: new Date().toISOString()
  };
  await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
  res.json({ ok: true, customDomain: manifest.customDomain });
});

app.delete('/api/manage/:id/projects/:slug', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  const before = (manifest.projects || []).length;
  manifest.projects = (manifest.projects || []).filter(project => project.slug !== req.params.slug);
  if (manifest.projects.length === before) return res.status(404).json({ error: 'Project not found.' });
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json(publicPortfolio(id, manifest, validation));
});

app.delete('/api/manage/:id', requireFirebaseAuth, async (req, res) => {
  const dir = jobDir(req.params.id);
  if (!(await fs.pathExists(dir))) return res.status(404).json({ error: 'Portfolio not found.' });
  const manifest = await readManifest(req.params.id);
  if (manifest && !canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  await fs.remove(dir);
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/about-page/:id', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });

  const name = String(req.body?.name || '').trim();
  const role = String(req.body?.role || '').trim();
  const agency = String(req.body?.agency || '').trim();
  const location = String(req.body?.location || '').trim();
  const bio = String(req.body?.bio || '').trim().slice(0, 2000);
  const email = String(req.body?.email || '').trim();
  const awards = String(req.body?.awards || '').trim().slice(0, 1000);
  const linkedinUrl = String(req.body?.linkedinUrl || '').trim();

  try {
    let resolvedName = name || manifest.ownerName || '';
    let resolvedRole = role;
    let linkedinAbout = '';

    // LinkedIn enrichment (best-effort)
    if (linkedinUrl && /linkedin\.com/i.test(linkedinUrl)) {
      try {
        const { scrapeLinkedInMeta } = await import('./portfolioScraper.js');
        const li = await scrapeLinkedInMeta(linkedinUrl);
        if (li) {
          if (!resolvedName && li.name) resolvedName = li.name;
          if (!resolvedRole && li.jobTitle) resolvedRole = li.jobTitle;
          if (li.about) linkedinAbout = li.about;
        }
      } catch { /* graceful */ }
    }

    const rawBio = bio || linkedinAbout || '';
    let paragraphs = rawBio.split(/\n\n+/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);

    // AI bio rewrite (if OpenAI available and bio provided)
    if (rawBio && process.env.OPENAI_API_KEY) {
      try {
        const systemPrompt = `You are writing the About page copy for an advertising professional's portfolio.
Write 2-3 punchy, confident paragraphs. Senior voice. No filler phrases.
Never use: "I am passionate about", "journey", "obsessed with", "unleash", "vibrant world", "creative storytelling", "showcases", "drive results".
Return JSON only: { "paragraphs": ["para1", "para2"] }`;
        const userContent = [
          `Name: ${resolvedName}`,
          resolvedRole ? `Role: ${resolvedRole}` : '',
          agency ? `Agency/Company: ${agency}` : '',
          location ? `Location: ${location}` : '',
          awards ? `Awards/Recognition: ${awards}` : '',
          `Bio: ${rawBio}`
        ].filter(Boolean).join('\n');

        const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            temperature: 0.4,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }]
          }),
          signal: AbortSignal.timeout(20000)
        });
        if (aiRes.ok) {
          const aiData = await aiRes.json();
          const parsed = JSON.parse(aiData.choices?.[0]?.message?.content || '{}');
          if (Array.isArray(parsed.paragraphs) && parsed.paragraphs.length) {
            paragraphs = parsed.paragraphs.filter(Boolean);
          }
        }
      } catch { /* fall through to raw paragraphs */ }
    }

    const links = [];
    if (linkedinUrl) links.push({ url: linkedinUrl, label: 'LinkedIn' });

    manifest.aboutProfile = {
      name: resolvedName,
      role: resolvedRole,
      agency,
      location,
      paragraphs,
      email,
      links,
      awards
    };
    if (resolvedName && !manifest.ownerName) manifest.ownerName = resolvedName;

    // Write about.html directly (no full site rebuild needed)
    const sitePath = siteDir(id);
    await fs.writeFile(path.join(sitePath, 'about.html'), renderAboutPage(manifest));
    await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
    await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
    await zipDir(sitePath, path.join(jobDir(id), 'site.zip'));

    res.json({ ok: true, portfolio: publicPortfolio(id, manifest), aboutProfile: manifest.aboutProfile });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not build about page.' });
  }
});

async function requireEditablePortfolio(id, user) {
  const manifest = await readManifest(id);
  if (!manifest) {
    const err = new Error('Portfolio not found.');
    err.status = 404;
    throw err;
  }
  if (!manifest.ownerUid) {
    // Backfill: first authenticated user to write claims ownership
    manifest.ownerUid = user.uid;
    manifest.owner = { uid: user.uid };
    await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
  }
  if (!canAccessPortfolio(manifest, user)) {
    const err = new Error('Not your portfolio.');
    err.status = 403;
    throw err;
  }
  if (!(await fs.pathExists(siteDir(id)))) {
    const err = new Error('Generated site files are missing.');
    err.status = 404;
    throw err;
  }
  return manifest;
}

function parseJsonField(value, fallback) {
  if (Array.isArray(value)) value = value[value.length - 1];
  if (value === undefined || value === null || value === '') return fallback;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

async function moveAiEditorUploads(id, files = []) {
  const moved = [];
  if (!files.length) return moved;
  const assetsDir = path.join(siteDir(id), 'assets', 'ai');
  await fs.ensureDir(assetsDir);
  for (const file of files) {
    const fileName = uploadedAssetName(file);
    const target = path.join(assetsDir, fileName);
    await fs.move(file.path, target, { overwrite: true });
    moved.push({
      path: `assets/ai/${fileName}`,
      original: file.originalname || fileName,
      mime: file.mimetype || '',
      size: file.size || 0
    });
  }
  return moved;
}

function localSiteReference(ref = '', fromPath = 'index.html') {
  const raw = String(ref || '').trim();
  if (!raw || raw.startsWith('#') || raw.startsWith('data:')) return '';
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || /^(?:mailto|tel):/i.test(raw)) return '';
  const clean = raw.split('#')[0].split('?')[0];
  if (!clean || clean.endsWith('/')) return '';
  const base = path.posix.dirname(String(fromPath || 'index.html'));
  const normalized = path.posix.normalize(clean.startsWith('/') ? clean.replace(/^\/+/, '') : path.posix.join(base, clean));
  if (!normalized || normalized.startsWith('..') || normalized.includes('\0')) return '';
  return normalized;
}

function linkedEditableRefs(file = {}) {
  const content = String(file.content || '');
  const refs = new Set();
  for (const match of content.matchAll(/(?:src|href|poster)=["']([^"']+)["']/gi)) {
    const ref = localSiteReference(match[1], file.path);
    if (ref && isTextSiteFile(ref)) refs.add(ref);
  }
  for (const match of content.matchAll(/@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?/gi)) {
    const ref = localSiteReference(match[1], file.path);
    if (ref && isTextSiteFile(ref)) refs.add(ref);
  }
  return [...refs];
}

function operationLabel(operation = {}) {
  const op = String(operation.op || '').trim();
  const file = operation.path ? ` ${operation.path}` : '';
  if (op === 'replaceAll') return 'updated repeated sitewide text';
  if (op === 'replace') return `updated${file || ' a file'}`;
  if (op === 'writeFile') return `rewrote${file || ' a file'}`;
  if (op === 'createFile') return `created${file || ' a file'}`;
  if (op === 'deleteFile') return `deleted${file || ' a file'}`;
  if (op === 'renameFile') return `renamed${file || ' a file'}`;
  return op || 'edited a file';
}

function summarizeAiEditResult(plan = {}, changedFiles = [], validation = null, uploadedAssets = []) {
  const operations = Array.isArray(plan.operations) ? plan.operations : [];
  const operationSummary = operations.map(operationLabel).filter(Boolean).slice(0, 8);
  const validationErrors = Array.isArray(validation?.errors) ? validation.errors : [];
  const changed = new Set((changedFiles || []).map(file => String(file || '')));
  const changedValidationErrors = validationErrors.filter(item => changed.has(String(item.file || '')));
  const details = [];
  if (uploadedAssets.length) details.push(`used ${uploadedAssets.length} uploaded asset${uploadedAssets.length === 1 ? '' : 's'}`);
  if (changedFiles.length) details.push(`changed ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}`);
  if (operationSummary.length) details.push(operationSummary.join('; '));
  details.push(validationErrors.length ? `validation found ${validationErrors.length} issue${validationErrors.length === 1 ? '' : 's'}` : 'validation passed');
  return {
    message: plan.message || 'Applied the requested file edits.',
    details,
    operationSummary,
    validationSummary: {
      ok: !!validation?.ok,
      errorCount: validationErrors.length,
      changedFileErrorCount: changedValidationErrors.length,
      errors: validationErrors.slice(0, 8)
    }
  };
}

async function contextFilesForAi(id, requestedPaths = [], pagePath = '', fileTree = []) {
  const files = [];
  const seen = new Set();
  const knownFiles = fileTree.length ? fileTree : await listSiteFiles(id);
  const byPath = new Map(knownFiles.map(file => [file.path, file]));
  const add = async rel => {
    rel = String(rel || '').replace(/^\/+/, '');
    if (!rel || seen.has(rel)) return null;
    const meta = byPath.get(rel);
    if (meta && (!meta.editable || meta.size > 900000)) return null;
    seen.add(rel);
    try {
      const file = await readTextSiteFile(id, rel);
      files.push(file);
      return file;
    } catch {}
    return null;
  };
  const pageFile = await add(pagePath || 'index.html');
  for (const rel of requestedPaths || []) await add(String(rel || ''));
  if (pageFile) {
    for (const rel of linkedEditableRefs(pageFile)) await add(rel);
  }
  const cssAndJs = knownFiles
    .filter(file => file.editable && /(^|\/)(?:styles|portfolio|main|app|site|ui)\.(?:css|js|mjs)$/i.test(file.path))
    .map(file => file.path);
  for (const rel of ['styles.css', 'portfolio.css', 'portfolio.js', 'index.html', ...cssAndJs]) await add(rel);
  const currentIsWork = /^work\//i.test(pagePath);
  const templatePage = knownFiles.find(file => file.page && /^work\//i.test(file.path) && (!currentIsWork || file.path !== pagePath));
  if (templatePage) await add(templatePage.path);
  return files.slice(0, 18);
}

async function applySiteEditOperations(id, operations = []) {
  const changed = [];
  const assertNonDestructiveWrite = (relative, content) => {
    if (!/\.html?$/i.test(relative)) return;
    const html = String(content || '');
    const visible = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/<body[\s>]/i.test(html) || visible.length < 8) {
      throw new Error(`Refused to write a blank or structurally empty HTML page to ${relative}.`);
    }
  };
  for (const operation of operations) {
    const op = String(operation.op || '').trim();
    if (op === 'replaceAll') {
      if (!operation.find) throw new Error('Missing find text for sitewide replacement.');
      const files = await listSiteFiles(id);
      for (const file of files) {
        if (!file.editable || file.size > 900000) continue;
        const current = await readTextSiteFile(id, file.path).catch(() => null);
        if (!current?.content?.includes(operation.find)) continue;
        const next = current.content.split(operation.find).join(operation.replace || '');
        assertNonDestructiveWrite(current.path, next);
        await writeTextSiteFile(id, current.path, next);
        changed.push(current.path);
      }
      if (!changed.length) throw new Error('Could not find that text anywhere in the generated site.');
      continue;
    }
    if (op === 'replace') {
      const current = await readTextSiteFile(id, operation.path);
      if (!operation.find) throw new Error(`Missing find text for ${operation.path}.`);
      if (!current.content.includes(operation.find)) throw new Error(`Could not find requested text in ${operation.path}.`);
      const next = current.content.split(operation.find).join(operation.replace || '');
      assertNonDestructiveWrite(current.path, next);
      await writeTextSiteFile(id, current.path, next);
      changed.push(current.path);
      continue;
    }
    if (op === 'writeFile' || op === 'createFile') {
      assertNonDestructiveWrite(operation.path, operation.content || '');
      const rel = await writeTextSiteFile(id, operation.path, operation.content || '');
      changed.push(rel);
      continue;
    }
    if (op === 'deleteFile') {
      const { target, relative } = safeSitePath(id, operation.path);
      await fs.remove(target);
      changed.push(relative);
      continue;
    }
    if (op === 'renameFile') {
      const from = safeSitePath(id, operation.path);
      const to = safeSitePath(id, operation.to);
      await fs.ensureDir(path.dirname(to.target));
      await fs.move(from.target, to.target, { overwrite: true });
      changed.push(from.relative, to.relative);
    }
  }
  return [...new Set(changed)];
}

app.get('/api/code-editor/:id/site', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    await ensureStylesCss(id, manifest);
    const [files, pages, history] = await Promise.all([
      listSiteFiles(id),
      listSitePages(id),
      editorHistoryState(id)
    ]);
    res.json({
      id,
      siteTitle: manifest.siteTitle || manifest.ownerName || 'Portfolio',
      ownerName: manifest.ownerName || '',
      preview: `/generated/${id}/site/index.html`,
      published: manifest.published || null,
      customDomain: manifest.customDomain || null,
      sourcePlatform: manifest.sourcePlatform || '',
      sourceUrl: manifest.sourceUrl || '',
      portfolioTemplate: manifest.portfolioTemplate || 'default',
      files,
      pages,
      history
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load site.' });
  }
});

app.post('/api/code-editor/:id/add-page', requireFirebaseAuth, upload.array('files', 16), async (req, res) => {
  const files = req.files || [];
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const type = String(req.body?.type || 'project');
    const title = String(req.body?.title || '').trim().slice(0, 90);
    const prompt = String(req.body?.prompt || '').replace(/\r/g, '\n').trim().slice(0, 6000);
    if (!['project', 'contact', 'awards'].includes(type)) return res.status(400).json({ error: 'Unknown page type.' });
    if (type === 'contact' && manifest.contactPage) return res.status(400).json({ error: 'This site already has a contact page.' });
    if (type === 'awards' && manifest.awardsPage) return res.status(400).json({ error: 'This site already has an awards page.' });
    if (type === 'project' && !title) return res.status(400).json({ error: 'Give the project a title.' });
    if (type === 'project' && !files.length) return res.status(400).json({ error: 'Upload at least one image, video, or PDF for the project.' });

    let pagePath = '';
    if (type === 'project') {
      const project = await buildProjectFromUpload({
        files,
        outDir: jobDir(id),
        title,
        prompt,
        existingSlugs: (manifest.projects || []).map(p => p.slug)
      });
      manifest.projects = [...(manifest.projects || []), project];
      pagePath = `work/${project.slug}/index.html`;
    } else {
      let copy = null;
      try { copy = await generatePageCopyWithAI({ type, title: title || (type === 'contact' ? 'Contact' : 'Awards'), prompt }); } catch {}
      if (type === 'contact') {
        manifest.contactPage = { title: title || 'Contact', intro: prompt.slice(0, 500), ...(copy || {}) };
        pagePath = 'contact.html';
      } else {
        manifest.awardsPage = { title: title || 'Awards', intro: '', awards: [], ...(copy || { intro: prompt.slice(0, 300) }) };
        pagePath = 'awards.html';
      }
      await Promise.all(files.map(f => fs.remove(f.path).catch(() => {})));
    }

    const validation = await saveManifestAndRebuild(id, manifest);
    res.json({ ok: true, pagePath, pages: await listSitePages(id), validation });
  } catch (err) {
    console.error('POST /api/code-editor/:id/add-page failed', err);
    await Promise.all(files.map(f => fs.remove(f.path).catch(() => {})));
    res.status(err.status || 500).json({ error: err.message || 'Could not create the page.' });
  }
});

app.post('/api/code-editor/:id/delete-page', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const pagePath = String(req.body?.path || '').replace(/^\/+/, '');
    if (!pagePath || pagePath === 'index.html') return res.status(400).json({ error: 'The home page cannot be deleted.' });

    // Snapshot first (site files + manifest sidecar) so the delete is undoable
    await createEditorSnapshot(id);

    const workMatch = pagePath.match(/^work\/([^/]+)\/index\.html?$/i);
    if (workMatch) {
      const slug = workMatch[1];
      const before = (manifest.projects || []).length;
      manifest.projects = (manifest.projects || []).filter(p => p.slug !== slug);
      if (manifest.projects.length === before) return res.status(404).json({ error: 'Project not found.' });
      await saveManifestAndRebuild(id, manifest);
    } else if (pagePath === 'about.html') {
      manifest.aboutPageHidden = true;
      await saveManifestAndRebuild(id, manifest);
    } else if (pagePath === 'awards.html') {
      delete manifest.awardsPage;
      await saveManifestAndRebuild(id, manifest);
    } else if (pagePath === 'contact.html') {
      delete manifest.contactPage;
      await saveManifestAndRebuild(id, manifest);
    } else if (/^[^/]+\.html?$/i.test(pagePath)) {
      // Loose root-level page (e.g. created outside the manifest) — just remove the file
      const { target } = safeSitePath(id, pagePath);
      if (!(await fs.pathExists(target))) return res.status(404).json({ error: 'Page not found.' });
      await fs.remove(target);
      await zipDir(siteDir(id), path.join(jobDir(id), 'site.zip'));
    } else {
      return res.status(400).json({ error: 'This page cannot be deleted.' });
    }

    res.json({ ok: true, pages: await listSitePages(id), history: await editorHistoryState(id) });
  } catch (err) {
    console.error('POST /api/code-editor/:id/delete-page failed', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not delete the page.' });
  }
});

app.post('/api/code-editor/:id/template', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const ALLOWED = ['default', 'grid-3', 'grid-4', 'editorial', 'bold', 'neo', 'cinema', 'gallery', 'french', 'agency'];
    const templateName = String(req.body?.template || 'default');
    if (!ALLOWED.includes(templateName)) return res.status(400).json({ error: 'Unknown template.' });
    manifest.portfolioTemplate = templateName;
    await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
    await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
    const baseCss = await fs.readFile(path.join(root, 'public', 'portfolio.css'), 'utf8');
    let css = baseCss;
    if (templateName !== 'default') {
      const overlayPath = path.join(root, 'public', 'templates', `${templateName}.css`);
      if (await fs.pathExists(overlayPath)) css = (TEMPLATE_FONT_IMPORTS[templateName] || '') + baseCss + '\n' + await fs.readFile(overlayPath, 'utf8');
    }
    await fs.writeFile(path.join(siteDir(id), 'styles.css'), css);
    res.json({ ok: true, template: templateName });
  } catch (err) {
    console.error('POST /api/code-editor/:id/template failed', err);
    res.status(err.status || 500).json({ error: err.message || 'Could not apply template.' });
  }
});

app.get('/api/code-editor/:id/file', requireFirebaseAuth, async (req, res) => {
  try {
    await requireEditablePortfolio(req.params.id, req.user);
    res.json(await readTextSiteFile(req.params.id, req.query.path || 'index.html'));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Could not read file.' });
  }
});

app.put('/api/code-editor/:id/file', requireFirebaseAuth, async (req, res) => {
  try {
    const manifest = await requireEditablePortfolio(req.params.id, req.user);
    await ensureStylesCss(req.params.id, manifest);
    await createEditorSnapshot(req.params.id);
    const rel = await writeTextSiteFile(req.params.id, req.body?.path || '', req.body?.content || '');
    const validation = await validateSite(siteDir(req.params.id));
    await zipDir(siteDir(req.params.id), path.join(jobDir(req.params.id), 'site.zip'));
    res.json({ ok: true, path: rel, validation, history: await editorHistoryState(req.params.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message || 'Could not save file.' });
  }
});

app.post('/api/code-editor/:id/upload', requireFirebaseAuth, upload.array('files', 60), async (req, res) => {
  const files = req.files || [];
  try {
    await requireEditablePortfolio(req.params.id, req.user);
    await createEditorSnapshot(req.params.id);
    const uploaded = await moveAiEditorUploads(req.params.id, files);
    await zipDir(siteDir(req.params.id), path.join(jobDir(req.params.id), 'site.zip'));
    res.json({ ok: true, uploaded, files: await listSiteFiles(req.params.id), history: await editorHistoryState(req.params.id) });
  } catch (err) {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
    res.status(err.status || 500).json({ error: err.message || 'Could not upload files.' });
  }
});

app.post('/api/code-editor/:id/ai-edit', requireFirebaseAuth, upload.array('files', 60), async (req, res) => {
  const files = req.files || [];
  try {
    const id = req.params.id;
    await requireEditablePortfolio(id, req.user);
    const prompt = String(req.body?.prompt || '').replace(/\r/g, '\n').trim().slice(0, 12000);
    if (!prompt && !files.length) return res.status(400).json({ error: 'Write a prompt or upload files first.' });
    const pagePath = String(req.body?.pagePath || 'index.html').replace(/^\/+/, '');
    const contextPaths = parseJsonField(req.body?.contextPaths, []);
    const fileTree = await listSiteFiles(id);
    const contextFiles = await contextFilesForAi(id, contextPaths, pagePath, fileTree);
    await createEditorSnapshot(id);
    const uploadedAssets = await moveAiEditorUploads(id, files);
    const plan = await planSiteFileEditsWithAI({
      prompt: prompt || 'Add the uploaded assets to the current page in a polished portfolio layout.',
      files: contextFiles,
      fileTree: fileTree.map(file => ({ path: file.path, size: file.size, editable: file.editable })),
      uploadedAssets,
      pagePath
    });
    const changedFiles = await applySiteEditOperations(id, plan.operations || []);
    const validation = await validateSite(siteDir(id));
    const summary = summarizeAiEditResult(plan, changedFiles, validation, uploadedAssets);
    await zipDir(siteDir(id), path.join(jobDir(id), 'site.zip'));
    const manifest = await readManifest(id);
    if (manifest) {
      manifest.editorUpdatedAt = new Date().toISOString();
      await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
    }
    res.json({
      ok: true,
      message: summary.message,
      details: summary.details,
      operationSummary: summary.operationSummary,
      validationSummary: summary.validationSummary,
      changedFiles,
      uploadedAssets,
      operations: plan.operations || [],
      validation,
      files: await listSiteFiles(id),
      pages: await listSitePages(id),
      history: await editorHistoryState(id)
    });
  } catch (err) {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
    res.status(err.status || 500).json({ error: err.message || 'AI edit failed.' });
  }
});

app.post('/api/code-editor/:id/undo', requireFirebaseAuth, async (req, res) => {
  try {
    await requireEditablePortfolio(req.params.id, req.user);
    const restored = await restoreEditorSnapshot(req.params.id, 'undo');
    if (!restored) return res.status(400).json({ error: 'Nothing to undo.' });
    res.json({ ok: true, ...restored, files: await listSiteFiles(req.params.id), pages: await listSitePages(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Undo failed.' });
  }
});

app.post('/api/code-editor/:id/redo', requireFirebaseAuth, async (req, res) => {
  try {
    await requireEditablePortfolio(req.params.id, req.user);
    const restored = await restoreEditorSnapshot(req.params.id, 'redo');
    if (!restored) return res.status(400).json({ error: 'Nothing to redo.' });
    res.json({ ok: true, ...restored, files: await listSiteFiles(req.params.id), pages: await listSitePages(req.params.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Redo failed.' });
  }
});

app.get('/api/editor/:id/pages', requireFirebaseAuth, async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  res.json({
    id: req.params.id,
    siteTitle: manifest.siteTitle,
    ownerName: manifest.ownerName,
    published: manifest.published || null,
    customDomain: manifest.customDomain || null,
    pages: [
      {
        slug: 'home',
        title: 'Home page',
        kind: 'home',
        preview: `/generated/${req.params.id}/site/index.html`
      },
      ...(manifest.projects || []).map(p => ({
      slug: p.slug,
      title: p.title,
      kind: 'project',
      preview: `/generated/${req.params.id}/site/work/${p.slug}/index.html`
      }))
    ]
  });
});

app.post('/api/editor/:id/pages', requireFirebaseAuth, upload.array('files', 60), async (req, res) => {
  const id = req.params.id;
  const files = req.files || [];
  const manifest = await readManifest(id);
  if (!manifest) {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
    return res.status(404).json({ error: 'Import not found.' });
  }
  if (!canAccessPortfolio(manifest, req.user)) {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
    return res.status(403).json({ error: 'Not your portfolio.' });
  }
  const title = cleanInlineText(req.body?.title || '', 160);
  const prompt = String(req.body?.prompt || '').replace(/\r/g, '\n').trim().slice(0, 4000);
  const requestedBuildMode = String(req.body?.buildMode || '');
  const builderInput = ['campaign-builder', 'imported-site'].includes(requestedBuildMode) ? {
    brand: cleanInlineText(req.body?.brand || '', 160),
    campaign: title,
    agency: cleanInlineText(req.body?.agency || '', 160),
    role: cleanInlineText(req.body?.role || '', 160),
    notes: String(req.body?.notes || prompt || '').replace(/\r/g, '\n').trim().slice(0, 4000)
  } : null;
  if (!title && !prompt && !files.length) {
    return res.status(400).json({ error: 'Add a campaign title, prompt, or files.' });
  }
  try {
    const project = await createProjectFromUploads(id, manifest, { title, prompt, files, builderInput });
    const importedHomepage = requestedBuildMode === 'imported-site' && !!manifest.sourceHome?.html;
    if (importedHomepage) {
      const reference = (manifest.projects || []).find(item => item.pageStyle || item.sourceCss);
      project.addedToImportedSite = true;
      project.pageStyle = {
        ...(reference?.pageStyle || {}),
        ...(project.pageStyle || {})
      };
      project.sourceCss = reference?.sourceCss || manifest.sourceHome.sourceCss || '';
    }
    manifest.projects = manifest.projects || [];
    manifest.projects.push(project);
    manifest.homeOverride = importedHomepage ? false : true;
    const buildPrompt = prompt
      ? `Make this new campaign page portfolio-ready. Preserve all campaign facts from the campaign info.\n\nCampaign info:\n${prompt}`
      : 'Make this new campaign page portfolio-ready.';
    if (requestedBuildMode === 'campaign-builder') {
      const cleanedManifest = await cleanupCampaignBuilderManifestWithAI(manifest, {
        progress: (stage, detail) => console.log(`[${stage}] ${detail}`)
      });
      Object.assign(manifest, cleanedManifest);
    } else {
      const plan = await planPageOperationsWithAI({
        prompt: buildPrompt,
        page: { kind: 'project', ...publicProject(project) },
        manifest
      });
      if (prompt && Array.isArray(plan.operations)) {
        const promptKey = compactForMatch(prompt);
        plan.operations = plan.operations.filter(op => op?.op !== 'insertText' || !promptKey.includes(compactForMatch(op.text || '').slice(0, 120)));
      }
      applyPageOperations(project, plan, buildPrompt);
    }
    const validation = await saveManifestAndRebuild(id, manifest);
    const savedProject = (manifest.projects || []).find(item => item.slug === project.slug) || project;
    res.json({
      ok: true,
      message: `Created ${savedProject.title}.`,
      validation,
      page: publicProject(savedProject),
      pages: [
        { slug: 'home', title: 'Home page', kind: 'home', preview: `/generated/${id}/site/index.html` },
        ...(manifest.projects || []).map(p => ({
          slug: p.slug,
          title: p.title,
          kind: 'project',
          preview: `/generated/${id}/site/work/${p.slug}/index.html`
        }))
      ],
      preview: `/generated/${id}/site/work/${savedProject.slug}/index.html`
    });
  } catch (err) {
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
    res.status(500).json({ error: err.message || 'Could not create the page.' });
  }
});

app.get('/api/editor/:id/pages/:slug', requireFirebaseAuth, async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  if (req.params.slug === 'home') return res.json(publicHomePage(manifest, req.params.id));
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });
  res.json(publicProject(project));
});

app.post('/api/editor/:id/pages/:slug/assets', requireFirebaseAuth, upload.single('file'), async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'Import not found.' });
  }
  if (!canAccessPortfolio(manifest, req.user)) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(403).json({ error: 'Not your portfolio.' });
  }
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'Page not found.' });
  }
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Upload one image, video, or PDF.' });

  const kind = mediaKindForUpload(file);
  if (!kind) {
    await fs.remove(file.path).catch(() => {});
    return res.status(400).json({ error: 'Only images, videos, and PDFs are supported.' });
  }

  const assetsDir = path.join(jobDir(id), 'assets-imported');
  await fs.ensureDir(assetsDir);
  const fileName = uploadedAssetName(file);
  await fs.move(file.path, path.join(assetsDir, fileName), { overwrite: true });
  const src = `assets/imported/${fileName}`;
  const original = file.originalname || fileName;
  let assetRef;

  if (kind === 'image') {
    project.images = project.images || [];
    const index = project.images.push({
      src,
      localFile: fileName,
      alt: cleanInlineText(req.body?.alt || project.title || original),
      original,
      order: Date.now()
    }) - 1;
    if (!project.thumbnail) project.thumbnail = { src, original };
    assetRef = { type: 'image', imageIndex: index };
  } else if (kind === 'video') {
    project.videos = project.videos || [];
    const index = project.videos.push({
      kind: 'video',
      type: 'video',
      src,
      localFile: fileName,
      title: cleanInlineText(req.body?.title || project.title || original),
      original,
      order: Date.now()
    }) - 1;
    assetRef = { type: 'video', videoIndex: index };
  } else if (kind === 'audio') {
    project.audios = project.audios || [];
    const index = project.audios.push({
      kind: 'audio',
      type: 'audio',
      src,
      localFile: fileName,
      title: cleanInlineText(req.body?.title || project.title || original),
      original,
      order: Date.now()
    }) - 1;
    assetRef = { type: 'audio', audioIndex: index };
  } else {
    project.documents = project.documents || [];
    const index = project.documents.push({
      src,
      localFile: fileName,
      title: cleanInlineText(req.body?.title || original),
      original,
      order: Date.now()
    }) - 1;
    assetRef = { type: 'document', documentIndex: index };
  }

  if (String(req.body?.insert || '').toLowerCase() === 'true') {
    project.contentItems = project.contentItems || [];
    project.contentItems.unshift({ ...assetRef, order: 0 });
    project.contentItems = project.contentItems.map((item, index) => ({ ...item, order: index + 1 }));
  }

  project.cleaned = null;
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json({
    ok: true,
    asset: assetRef,
    validation,
    page: publicProject(project),
    preview: `/generated/${id}/site/work/${project.slug}/index.html`
  });
});

function normalizedVideoEmbedUrl(value = '') {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\/+/, '').split('/')[0];
      return id ? `https://www.youtube.com/embed/${id}` : '';
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const id = url.searchParams.get('v') || url.pathname.match(/\/(?:shorts|embed)\/([^/?#]+)/)?.[1];
      return id ? `https://www.youtube.com/embed/${id}` : '';
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = url.pathname.match(/(?:video\/)?(\d+)/)?.[1];
      return id ? `https://player.vimeo.com/video/${id}` : '';
    }
    return '';
  } catch {
    return '';
  }
}

app.post('/api/editor/:id/pages/:slug/video-url', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  if (req.params.slug === 'home') {
    applyHomeEdit(manifest, req.body || {});
    const validation = await saveManifestAndRebuild(id, manifest);
    return res.json({ ok: true, validation, page: publicHomePage(manifest, id), preview: `/generated/${id}/site/index.html` });
  }
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });

  const src = normalizedVideoEmbedUrl(req.body?.url || '');
  if (!src) return res.status(400).json({ error: 'Use a valid YouTube or Vimeo URL.' });

  project.videos = project.videos || [];
  const source = /vimeo/i.test(src) ? 'Vimeo' : 'YouTube';
  const index = project.videos.push({
    kind: 'iframe',
    type: 'iframe',
    src,
    title: cleanInlineText(req.body?.title || `${source} video`),
    original: src,
    order: Date.now()
  }) - 1;

  project.cleaned = null;
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json({
    ok: true,
    asset: { type: 'video', videoIndex: index },
    validation,
    page: publicProject(project),
    preview: `/generated/${id}/site/work/${project.slug}/index.html`
  });
});

app.post('/api/editor/:id/pages/:slug/ai-edit', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  const prompt = String(req.body?.prompt || '').replace(/\r/g, '\n').trim().slice(0, 4000);
  if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

  if (req.params.slug === 'home') {
    const before = publicHomePage(manifest, id);
    const edit = await planPageEditWithAI({ prompt, page: before, manifest });
    if (edit.homeTitle || edit.title) manifest.homeTitle = edit.homeTitle || edit.title;
    if (edit.homeIntro || edit.prependText) manifest.homeIntro = edit.homeIntro || edit.prependText.replace(/\s+/g, ' ').slice(0, 500);
    if (edit.replaceText?.length) {
      manifest.homeTitle = replaceAllText(manifest.homeTitle || manifest.ownerName || '', edit.replaceText).replace(/\s+/g, ' ').trim();
      manifest.homeIntro = replaceAllText(manifest.homeIntro || '', edit.replaceText).replace(/\s+/g, ' ').trim();
      for (const project of manifest.projects || []) project.title = replaceAllText(project.title || '', edit.replaceText).replace(/\s+/g, ' ').trim();
    }
    manifest.homeOverride = true;
    const validation = await saveManifestAndRebuild(id, manifest);
    return res.json({
      ok: true,
      message: edit.message,
      changes: edit,
      before,
      validation,
      page: publicHomePage(manifest, id),
      preview: `/generated/${id}/site/index.html`
    });
  }

  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });
  const before = publicProject(project);
  const uploadedAssets = Array.isArray(req.body?.uploadedAssets) ? req.body.uploadedAssets : [];
  const plan = uploadedAssets.length && /^place the uploaded ads on this page/i.test(prompt)
    ? { message: `Added ${uploadedAssets.length} uploaded file${uploadedAssets.length === 1 ? '' : 's'} to the page.`, operations: [] }
    : await planPageOperationsWithAI({ prompt, page: { kind: 'project', ...before }, manifest });
  const applied = applyPageOperations(project, plan, prompt);
  if (!applied.length && !uploadedAssets.length) {
    const edit = await planPageEditWithAI({ prompt, page: { kind: 'project', ...before }, manifest });
    applyAiEditToProject(project, edit);
    applied.push(edit.message || 'Applied the requested edit.');
  }
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json({
    ok: true,
    message: applied.length ? applied.join(' ') : plan.message,
    changes: { operations: plan.operations || [], applied },
    before,
    validation,
    page: publicProject(project),
    preview: `/generated/${id}/site/work/${project.slug}/index.html`
  });
});

function sanitizeContentItems(items, project) {
  const imageMax = (project.images || []).length;
  const videoMax = (project.videos || []).length;
  const audioMax = (project.audios || []).length;
  const documentMax = (project.documents || []).length;
  const safe = [];
  items.forEach((item, idx) => {
    const order = idx + 1;
    if (item.type === 'text') {
      const text = String(item.text || '').replace(/\r/g, '\n').trim().slice(0, 4000);
      if (text) safe.push({ type: 'text', order, tag: 'p', text, ...(item.preserveLineBreaks ? { preserveLineBreaks: true } : {}), ...sanitizeTextStyle(item) });
      return;
    }
    if (item.type === 'image' && Number.isInteger(item.imageIndex) && item.imageIndex >= 0 && item.imageIndex < imageMax) {
      const alt = String(item.alt || '').slice(0, 500);
      if (alt && project.images?.[item.imageIndex]) project.images[item.imageIndex].alt = alt;
      safe.push({ type: 'image', order, alt, imageIndex: item.imageIndex, original: item.original || project.images[item.imageIndex]?.original || '', ...sanitizedTreatmentObject(item) });
      return;
    }
    if (item.type === 'video' && Number.isInteger(item.videoIndex) && item.videoIndex >= 0 && item.videoIndex < videoMax) {
      const title = String(item.title || '').slice(0, 500);
      if (title && project.videos?.[item.videoIndex]) project.videos[item.videoIndex].title = title;
      safe.push({ type: 'video', order, title, videoIndex: item.videoIndex, original: item.original || project.videos[item.videoIndex]?.original || '', ...sanitizedTreatmentObject(item) });
      return;
    }
    if (item.type === 'audio' && Number.isInteger(item.audioIndex) && item.audioIndex >= 0 && item.audioIndex < audioMax) {
      const title = String(item.title || '').slice(0, 500);
      if (title && project.audios?.[item.audioIndex]) project.audios[item.audioIndex].title = title;
      safe.push({ type: 'audio', order, title, audioIndex: item.audioIndex, original: item.original || project.audios[item.audioIndex]?.original || '' });
      return;
    }
    if (item.type === 'document' && Number.isInteger(item.documentIndex) && item.documentIndex >= 0 && item.documentIndex < documentMax) {
      const title = String(item.title || '').slice(0, 500);
      if (title && project.documents?.[item.documentIndex]) project.documents[item.documentIndex].title = title;
      safe.push({ type: 'document', order, title, documentIndex: item.documentIndex, original: item.original || project.documents[item.documentIndex]?.original || '', ...sanitizedTreatmentObject(item) });
      return;
    }
    if (item.type === 'gallery' && Array.isArray(item.imageIndexes)) {
      const imageIndexes = item.imageIndexes.filter(n => Number.isInteger(n) && n >= 0 && n < imageMax);
      if (imageIndexes.length) safe.push({ type: 'gallery', order, imageIndexes, originals: imageIndexes.map(n => project.images[n]?.original || ''), ...sanitizedTreatmentObject(item) });
    }
  });
  return safe;
}

function sanitizedTreatmentObject(item = {}) {
  return ['hero', 'full-width', 'contained'].includes(item.treatment) ? { treatment: item.treatment } : {};
}

function sanitizeTextStyle(item = {}) {
  const fontFamily = cleanInlineText(item.fontFamily || '', 80);
  const fontSize = Math.max(12, Math.min(96, Number(item.fontSize) || 0));
  const align = ['left', 'center', 'right'].includes(item.align) ? item.align : '';
  return {
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize ? { fontSize } : {}),
    ...(item.bold ? { bold: true } : {}),
    ...(item.italic ? { italic: true } : {}),
    ...(align ? { align } : {})
  };
}

function applyHomeEdit(manifest, body = {}) {
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (title) manifest.homeTitle = title;
  const order = Array.isArray(body.contentItems)
    ? body.contentItems
      .filter(item => item?.type === 'home-card' && item.slug)
      .map(item => String(item.slug))
    : [];
  if (order.length) {
    const bySlug = new Map((manifest.projects || []).map(project => [project.slug, project]));
    const ordered = order.map(slug => bySlug.get(slug)).filter(Boolean);
    const used = new Set(ordered.map(project => project.slug));
    const rest = (manifest.projects || []).filter(project => !used.has(project.slug));
    manifest.projects = [...ordered, ...rest];
    for (const item of body.contentItems || []) {
      if (item?.type !== 'home-card' || !item.slug) continue;
      const project = bySlug.get(String(item.slug));
      const nextTitle = cleanInlineText(item.title || '', 200);
      if (project && nextTitle) project.title = nextTitle;
    }
    manifest.homeOverride = true;
  }
}

app.put('/api/editor/:id/pages/:slug', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  if (req.params.slug === 'home') {
    applyHomeEdit(manifest, req.body || {});
    if (typeof req.body?.homeIntro === 'string') manifest.homeIntro = req.body.homeIntro.replace(/\s+/g, ' ').trim().slice(0, 500);
    const validation = await saveManifestAndRebuild(id, manifest);
    return res.json({ ok: true, validation, page: publicHomePage(manifest, id), preview: `/generated/${id}/site/index.html` });
  }
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });

  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (title) project.title = title;
  if (Number.isFinite(Number(req.body?.titleFontSize))) {
    project.titleFontSize = Math.max(0, Math.min(120, Number(req.body.titleFontSize) || 0));
  }
  if (typeof req.body?.aiLayout === 'string') {
    project.aiLayout = ['editorial', 'gallery', 'case-study', 'video-led', 'minimal'].includes(req.body.aiLayout) ? req.body.aiLayout : '';
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'subtitle')) {
    project.subtitle = String(req.body?.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  if (Array.isArray(req.body?.contentItems)) {
    project.contentItems = sanitizeContentItems(req.body.contentItems, project);
    project.cleaned = null;
  }

  const outDir = jobDir(id);
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json({ ok: true, validation, page: publicProject(project), preview: `/generated/${id}/site/work/${project.slug}/index.html` });
});

// ── Pixel / Visual Editor ─────────────────────────────────────────────────────

function generatePixelEditorDefaults(id, manifest) {
  const identity = resolvePortfolioIdentity(manifest);
  const ownerName = identity.ownerName || manifest.siteTitle || 'My Portfolio';
  const intro = identity.homeIntro || '';
  let counter = 1;
  const nextId = () => `el_${counter++}`;
  const elements = [];

  elements.push({
    id: nextId(), type: 'text',
    x: 60, y: 80, w: 680, h: 70,
    content: ownerName,
    fontSize: 52, fontFamily: 'Inter', color: '#1a1a1a',
    fontWeight: '700', fontStyle: 'normal',
    textAlign: 'left', opacity: 1, zIndex: 1, letterSpacing: -2
  });

  if (intro) {
    elements.push({
      id: nextId(), type: 'text',
      x: 60, y: 162, w: 560, h: 40,
      content: intro,
      fontSize: 17, fontFamily: 'Inter', color: '#666666',
      fontWeight: '400', fontStyle: 'normal',
      textAlign: 'left', opacity: 1, zIndex: 2, letterSpacing: 0
    });
  }

  elements.push({
    id: nextId(), type: 'rect',
    x: 60, y: intro ? 220 : 168, w: 48, h: 4,
    color: '#ff5200', opacity: 1, zIndex: 3, borderRadius: 2
  });

  const projects = (manifest.projects || []).slice(0, 6);
  const gridStartY = intro ? 255 : 200;
  const cols = 3;
  const imgW = 218;
  const imgH = 148;
  const hGap = 22;

  projects.forEach((project, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 60 + col * (imgW + hGap);
    const y = gridStartY + row * (imgH + 48);
    const z = 10 + i * 2;

    let src = project.thumbnail?.thumbSrc || project.thumbnail?.src || '';
    if (src && !src.startsWith('http')) src = `/generated/${id}/site/${src}`;

    if (src) {
      elements.push({
        id: nextId(), type: 'image',
        x, y, w: imgW, h: imgH,
        src, opacity: 1, zIndex: z, objectFit: 'cover', borderRadius: 4
      });
    }

    elements.push({
      id: nextId(), type: 'text',
      x, y: y + imgH + 8, w: imgW, h: 26,
      content: project.title || `Project ${i + 1}`,
      fontSize: 12, fontFamily: 'Inter', color: '#333333',
      fontWeight: '600', fontStyle: 'normal',
      textAlign: 'left', opacity: 1, zIndex: z + 1, letterSpacing: 0.5
    });
  });

  return elements;
}

function generateHtmlFromPixelElements(elements, { canvasColor = '#f8f7f4', pageW = 800, ownerName = '', hasAbout = false } = {}) {
  canvasColor = safeCssColor(canvasColor, '#f8f7f4');
  const maxBottom = elements.reduce((mx, el) => Math.max(mx, (el.y || 0) + (el.h || 0)), 600);
  const pageH = Math.max(maxBottom + 80, 600);

  function escA(s) { return String(s || '').replace(/[&"'<>]/g, c => ({ '&': '&amp;', '"': '&quot;', "'": '&#39;', '<': '&lt;', '>': '&gt;' }[c])); }
  function escH(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  const sorted = [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const elHtml = sorted.map(el => {
    const base = `position:absolute;left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px;opacity:${el.opacity};z-index:${Math.round(el.zIndex || 1)};box-sizing:border-box;`;
    if (el.type === 'text') {
      return `<div style="${base}font-size:${el.fontSize}px;font-family:'${safeFontFamily(el.fontFamily)}',sans-serif;color:${safeCssColor(el.color, '#111111')};font-weight:${el.fontWeight};font-style:${el.fontStyle};text-align:${el.textAlign};letter-spacing:${el.letterSpacing ?? 0}px;line-height:1.2;white-space:pre-wrap;overflow:hidden;">${escH(el.content)}</div>`;
    }
    if (el.type === 'rect') return `<div style="${base}background:${safeCssColor(el.color, '#cccccc')};border-radius:${el.borderRadius ?? 0}px;"></div>`;
    if (el.type === 'circle') return `<div style="${base}background:${safeCssColor(el.color, '#cccccc')};border-radius:50%;"></div>`;
    if (el.type === 'line') return `<div style="${base}display:flex;align-items:center;"><div style="width:100%;height:${el.thickness ?? 2}px;background:${safeCssColor(el.color, '#cccccc')};border-radius:2px;"></div></div>`;
    if (el.type === 'image') return `<div style="${base}overflow:hidden;border-radius:${el.borderRadius ?? 0}px;"><img src="${escA(el.src)}" alt="" style="width:100%;height:100%;object-fit:${el.objectFit ?? 'cover'};display:block;" loading="lazy"></div>`;
    return '';
  }).filter(Boolean).join('\n    ');

  const aboutLink = hasAbout ? `<a href="about.html" style="color:#888;font-size:13px;text-decoration:none;font-weight:500;">About</a>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escH(ownerName || 'Portfolio')}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,700;1,400&family=Montserrat:wght@400;600;700;900&family=Bebas+Neue&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${canvasColor};font-family:Inter,system-ui,sans-serif;min-height:100vh}
    .kw-nav{display:flex;align-items:center;justify-content:space-between;padding:16px 32px;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid rgba(0,0,0,.07);position:sticky;top:0;z-index:1000}
    .kw-nav-brand{font-weight:700;font-size:15px;color:#1a1a1a;text-decoration:none;letter-spacing:-.3px}
    .kw-nav-links{display:flex;align-items:center;gap:24px}
    .kw-canvas-wrap{width:${pageW}px;max-width:100%;margin:0 auto}
    .kw-canvas{position:relative;width:${pageW}px;min-height:${pageH}px}
    @media(max-width:${pageW}px){.kw-canvas-wrap,.kw-canvas{width:100%;min-height:auto}}
  </style>
</head>
<body>
  <nav class="kw-nav">
    <a class="kw-nav-brand" href="index.html">${escH(ownerName || 'Portfolio')}</a>
    <div class="kw-nav-links">${aboutLink}</div>
  </nav>
  <div class="kw-canvas-wrap">
    <div class="kw-canvas">
    ${elHtml}
    </div>
  </div>
</body>
</html>`;
}

app.get('/api/pixel-editor/:id/state', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const identity = resolvePortfolioIdentity(manifest);

    // Collect portfolio images for the photos panel
    const images = [];
    const seen = new Set();
    for (const project of (manifest.projects || [])) {
      const raw = project.thumbnail?.thumbSrc || project.thumbnail?.src || '';
      if (raw) {
        const src = raw.startsWith('http') ? raw : `/generated/${id}/site/${raw}`;
        if (!seen.has(src)) { seen.add(src); images.push({ src, label: project.title || 'Project' }); }
      }
      for (const img of (project.images || []).slice(0, 2)) {
        const raw2 = img.thumbSrc || img.src || '';
        if (raw2) {
          const src2 = raw2.startsWith('http') ? raw2 : `/generated/${id}/site/${raw2}`;
          if (!seen.has(src2)) { seen.add(src2); images.push({ src: src2, label: project.title || 'Image' }); }
        }
      }
    }

    const saved = manifest.pixelEditorState;
    res.json({
      id,
      siteTitle: identity.ownerName || manifest.siteTitle || 'Portfolio',
      ownerName: identity.ownerName || '',
      preview: `/generated/${id}/site/index.html`,
      elements: saved?.elements || generatePixelEditorDefaults(id, manifest),
      canvasColor: saved?.canvasColor || '#f8f7f4',
      images
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not load editor state.' });
  }
});

app.put('/api/pixel-editor/:id/state', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const { elements, canvasColor } = req.body || {};
    manifest.pixelEditorState = {
      elements: Array.isArray(elements) ? elements : [],
      canvasColor: canvasColor || '#f8f7f4',
      savedAt: new Date().toISOString()
    };
    await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save editor state.' });
  }
});

app.post('/api/pixel-editor/:id/publish', requireFirebaseAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const manifest = await requireEditablePortfolio(id, req.user);
    const { elements, canvasColor } = req.body || {};
    const identity = resolvePortfolioIdentity(manifest);
    const ownerName = identity.ownerName || manifest.siteTitle || 'Portfolio';
    const hasAbout = !!(manifest.aboutProfile?.paragraphs?.length || manifest.sourceAbout?.html);

    manifest.pixelEditorState = {
      elements: Array.isArray(elements) ? elements : [],
      canvasColor: canvasColor || '#f8f7f4',
      savedAt: new Date().toISOString()
    };

    const html = generateHtmlFromPixelElements(Array.isArray(elements) ? elements : [], {
      canvasColor: canvasColor || '#f8f7f4',
      pageW: 800,
      ownerName,
      hasAbout
    });

    await fs.writeFile(path.join(siteDir(id), 'index.html'), html, 'utf8');
    await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
    await zipDir(siteDir(id), path.join(jobDir(id), 'site.zip'));

    res.json({ ok: true, preview: `/generated/${id}/site/index.html` });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not publish.' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    // Scan all manifests from generatedRoot
    const entries = await fs.readdir(generatedRoot, { withFileTypes: true }).catch(() => []);
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const mf = path.join(generatedRoot, entry.name, 'manifest.json');
      if (!(await fs.pathExists(mf))) continue;
      try {
        const data = await fs.readJson(mf);
        manifests.push({ id: entry.name, data });
      } catch { /* skip corrupt manifests */ }
    }

    const imports = manifests.map(({ id, data }) => ({
      id,
      sourceUrl: data.sourceUrl || '',
      sourceDomain: (() => { try { return data.sourceUrl ? new URL(data.sourceUrl).hostname : ''; } catch { return ''; } })(),
      siteTitle: data.siteTitle || data.homeTitle || '',
      ownerName: data.ownerName || data.profile?.name || '',
      ownerUid: data.ownerUid || data.owner?.uid || '',
      published: data.published?.subdomain ? data.published.subdomain + '.killa.work' : '',
      publishedAt: data.published?.publishedAt || '',
      projectCount: (data.projects || []).length,
    }));

    // Domain frequency
    const domainMap = {};
    for (const imp of imports) {
      if (imp.sourceDomain) domainMap[imp.sourceDomain] = (domainMap[imp.sourceDomain] || 0) + 1;
    }
    const topDomains = Object.entries(domainMap).sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count }));

    // Stripe data
    let checkoutSessions = [];
    let stripeConfigured = false;
    if (stripe) {
      stripeConfigured = true;
      let hasMore = true;
      let startingAfter;
      while (hasMore) {
        const page = await stripe.checkout.sessions.list({ limit: 100, ...(startingAfter && { starting_after: startingAfter }) });
        for (const session of page.data) {
          checkoutSessions.push({
            id: session.id,
            createdAt: new Date(session.created * 1000).toISOString(),
            email: session.customer_details?.email || session.customer_email || '',
            status: session.payment_status,
            amount: session.amount_total ? session.amount_total / 100 : 0,
            currency: (session.currency || 'usd').toUpperCase(),
            sourceUrl: session.metadata?.sourceUrl || '',
            sourceDomain: (() => { try { return session.metadata?.sourceUrl ? new URL(session.metadata.sourceUrl).hostname : ''; } catch { return ''; } })(),
            jobId: session.metadata?.jobId || '',
          });
        }
        hasMore = page.has_more;
        if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
        else break;
      }
      checkoutSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    const paid = checkoutSessions.filter(s => s.status === 'paid');
    const abandoned = checkoutSessions.filter(s => s.status !== 'paid');

    res.json({
      totals: {
        imports: imports.length,
        published: imports.filter(i => i.published).length,
        paid: paid.length,
        abandoned: abandoned.length,
        revenue: paid.reduce((sum, s) => sum + s.amount, 0),
      },
      topDomains,
      imports,
      checkoutSessions,
      stripeConfigured,
    });
  } catch (err) {
    console.error('Admin stats error', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`KillaWork™ Importer running on http://localhost:${PORT}`));

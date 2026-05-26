import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';
import { runImport, generateSite, validateSite, zipDir } from './importer.js';
import { planPageEditWithAI, planPageOperationsWithAI } from './ai.js';
import { runCampaignBuild, runUploadBuild } from './uploadBuilder.js';
import { hash, safeSlug } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 8787;
const jobs = new Map();
const tmpUploadsDir = path.join(root, '.uploads-tmp');
const upload = multer({
  dest: tmpUploadsDir,
  limits: { files: 60, fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const type = String(file.mimetype || '');
    if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type === 'application/pdf') return cb(null, true);
    cb(new Error('Only images, videos, audio files, and PDFs are supported.'));
  }
});

app.use(express.json({ limit: '2mb' }));
app.get('*', serveCustomDomainIfMapped);
app.get(['/published/:subdomain', '/published/:subdomain/*'], servePublishedSite);
app.get('*', serveKillaWorkHost);
app.use('/', express.static(path.join(root, 'public')));
app.use('/generated', express.static(path.join(root, 'generated')));

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

function firebaseWebConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID || firebaseProjectId;
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : ''),
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

function attachOwner(manifest, user) {
  manifest.ownerUid = user.uid;
  manifest.owner = { uid: user.uid };
  return manifest;
}

function canAccessPortfolio(manifest, user) {
  return !manifest.ownerUid || manifest.ownerUid === user.uid;
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

function publishedUrlFor(subdomain) {
  return `https://${subdomain}.${publicHost()}`;
}

async function publishedIndex() {
  const generatedDir = path.join(root, 'generated');
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
  const cleanPath = String(requestedPath || '').replace(/^\/+/, '') || 'index.html';
  const target = path.normalize(path.join(siteRoot, cleanPath));
  if (target !== siteRoot && !target.startsWith(siteRoot + path.sep)) return res.status(400).send('Bad path');
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) {
    const indexFile = path.join(target, 'index.html');
    if (await fs.pathExists(indexFile)) return res.sendFile(indexFile);
  }
  if (stat?.isFile()) return res.sendFile(target);
  const fallback = path.join(siteRoot, 'index.html');
  if (await fs.pathExists(fallback)) return res.sendFile(fallback);
  return res.status(404).send('Published site not found');
}

async function serveCustomDomainIfMapped(req, res, next) {
  try {
    if (req.path.startsWith('/api/') || req.path === '/auth.js' || req.path === '/ui.css') return next();
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
    if (req.path.startsWith('/api/') || req.path === '/auth.js' || req.path === '/ui.css') return next();
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

app.get('/api/firebase-config', (req, res) => {
  const config = firebaseWebConfig();
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
  const url = String(req.body?.url || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a valid http/https URL.' });
  const id = `${Date.now()}-${hash(url)}`;
  const outDir = path.join(root, 'generated', id);
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
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Import failed', detail: e.message, at: new Date().toISOString() });
  }
});

app.post('/api/upload-build', requireFirebaseAuth, upload.array('files', 60), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Upload at least one image, video, or PDF.' });
  const id = `${Date.now()}-${hash(`${title}:${files.map(f => f.originalname).join('|')}`)}`;
  const outDir = path.join(root, 'generated', id);
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
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Build failed', detail: e.message, at: new Date().toISOString() });
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  }
});

app.post('/api/campaign-build', requireFirebaseAuth, upload.any(), async (req, res) => {
  const title = String(req.body?.title || '').trim();
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
  const outDir = path.join(root, 'generated', id);
  const job = { id, url: 'campaign-builder', aiCleanup: true, ownerUid: req.user.uid, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving campaign assets','AI analyzing campaign asset','Building campaign pages','AI cleanup','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  try {
    const result = await runCampaignBuild({ files, campaigns, outDir, title, aiCleanup: true, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
    attachOwner(result.manifest, req.user);
    await saveManifestAndRebuild(id, result.manifest);
    job.status = 'done';
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
    job.error = e.stack || e.message;
    job.progress.push({ stage: 'Build failed', detail: e.message, at: new Date().toISOString() });
    await Promise.all(files.map(file => fs.remove(file.path).catch(() => {})));
  }
});

app.get('/api/jobs/:id', requireFirebaseAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.ownerUid && job.ownerUid !== req.user.uid) return res.status(403).json({ error: 'Not your portfolio.' });
  res.json(job);
});

app.get('/api/download/:id', async (req, res) => {
  const zip = path.join(root, 'generated', req.params.id, 'site.zip');
  if (!(await fs.pathExists(zip))) return res.status(404).send('ZIP not ready');
  res.download(zip, 'killawork-import.zip');
});

function jobDir(id) {
  return path.join(root, 'generated', id);
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
    title: manifest.homeTitle || manifest.ownerName || manifest.siteTitle || 'Home',
    homeIntro: manifest.homeIntro || '',
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
  if (!/\b(break|separate|split|line by line|vertically)\b/i.test(prompt) || !/\b(agency|creative director|credits|producer|dop|production house)\b/i.test(prompt)) return '';
  const pasted = String(prompt).split(/\b(?:break|separate|split)\b/i)[0].trim();
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

async function createProjectFromUploads(id, manifest, { title, prompt, files = [] } = {}) {
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
  const description = String(prompt || '').replace(/\r/g, '\n').trim().slice(0, 4000);
  if (description) {
    contentItems.push({
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

function projectSummary(project, id) {
  return {
    title: project.title,
    slug: project.slug,
    images: (project.images || []).length,
    videos: (project.videos || []).length,
    audios: (project.audios || []).length,
    documents: (project.documents || []).length,
    preview: `/generated/${id}/site/work/${project.slug}/index.html`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}&page=${encodeURIComponent(project.slug)}`,
    manualEditor: `/editor.html?job=${encodeURIComponent(id)}&page=${encodeURIComponent(project.slug)}`
  };
}

function publicPortfolio(id, manifest, validation = null) {
  return {
    id,
    siteTitle: manifest.siteTitle || '',
    ownerName: manifest.ownerName || '',
    sourceUrl: manifest.sourceUrl || '',
    generatedAt: manifest.generatedAt || '',
    preview: `/generated/${id}/site/index.html`,
    review: `/generated/${id}/site/import-review.html`,
    manifest: `/generated/${id}/manifest.json`,
    zip: `/api/download/${id}`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}`,
    manualEditor: `/editor.html?job=${encodeURIComponent(id)}`,
    published: manifest.published || null,
    customDomain: manifest.customDomain || null,
    projects: (manifest.projects || []).map(project => projectSummary(project, id)),
    validation
  };
}

function publicPortfolioListItem(id, manifest) {
  return {
    id,
    siteTitle: manifest.siteTitle || manifest.ownerName || 'Untitled portfolio',
    ownerName: manifest.ownerName || '',
    sourceUrl: manifest.sourceUrl || '',
    generatedAt: manifest.generatedAt || '',
    projectCount: (manifest.projects || []).length,
    preview: `/generated/${id}/site/index.html`,
    manage: `/manage.html?job=${encodeURIComponent(id)}`,
    editor: `/ai-editor.html?job=${encodeURIComponent(id)}`,
    manualEditor: `/editor.html?job=${encodeURIComponent(id)}`,
    zip: `/api/download/${id}`,
    published: manifest.published || null,
    customDomain: manifest.customDomain || null
  };
}

async function userPortfolioList(user) {
  const generatedDir = path.join(root, 'generated');
  if (!(await fs.pathExists(generatedDir))) return [];
  const entries = await fs.readdir(generatedDir);
  const portfolios = await Promise.all(entries.map(async id => {
    const manifest = await readManifest(id);
    if (!manifest || !canAccessPortfolio(manifest, user)) return null;
    return publicPortfolioListItem(id, manifest);
  }));
  return portfolios
    .filter(Boolean)
    .sort((a, b) => String(b.generatedAt || b.id).localeCompare(String(a.generatedAt || a.id)));
}

async function saveManifestAndRebuild(id, manifest) {
  const outDir = jobDir(id);
  await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), manifest, { spaces: 2 });
  const siteDir = await generateSite(manifest, outDir);
  const validation = await validateSite(siteDir);
  await zipDir(siteDir, path.join(outDir, 'site.zip'));
  return validation;
}

app.get('/api/manage/:id', requireFirebaseAuth, async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  res.json(publicPortfolio(req.params.id, manifest));
});

app.get('/api/portfolios', requireFirebaseAuth, async (req, res) => {
  res.json({ portfolios: await userPortfolioList(req.user) });
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

app.post('/api/publish/:id', requireFirebaseAuth, async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  if (!canAccessPortfolio(manifest, req.user)) return res.status(403).json({ error: 'Not your portfolio.' });
  const requested = normalizeSubdomain(req.body?.subdomain || '');
  const reserved = new Set(['www', 'app', 'api', 'admin', 'assets', 'static', 'cdn', 'mail', 'support', 'help', 'killawork']);
  if (!validSubdomain(requested) || reserved.has(requested)) {
    return res.status(400).json({ error: 'Choose a valid subdomain using letters, numbers, or hyphens.' });
  }
  const index = await publishedIndex();
  const existing = index.get(requested);
  if (existing && existing.id !== id) return res.status(409).json({ error: `${requested}.${publicHost()} is already taken.` });
  manifest.published = {
    subdomain: requested,
    url: publishedUrlFor(requested),
    localPreview: `/published/${requested}/`,
    publishedAt: new Date().toISOString()
  };
  await fs.writeJson(path.join(jobDir(id), 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(jobDir(id), 'manifest.cleaned.json'), manifest, { spaces: 2 });
  res.json({ ok: true, published: manifest.published, customDomain: manifest.customDomain || null });
});

app.post('/api/custom-domain/:id', requireFirebaseAuth, async (req, res) => {
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
  if (!title && !prompt && !files.length) {
    return res.status(400).json({ error: 'Add a campaign title, prompt, or files.' });
  }
  try {
    const project = await createProjectFromUploads(id, manifest, { title, prompt, files });
    manifest.projects = manifest.projects || [];
    manifest.projects.push(project);
    manifest.homeOverride = true;
    const buildPrompt = prompt
      ? `Make this new campaign page portfolio-ready. Preserve all campaign facts from the campaign info.\n\nCampaign info:\n${prompt}`
      : 'Make this new campaign page portfolio-ready.';
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
    const validation = await saveManifestAndRebuild(id, manifest);
    res.json({
      ok: true,
      message: `Created ${project.title}.`,
      validation,
      page: publicProject(project),
      pages: [
        { slug: 'home', title: 'Home page', kind: 'home', preview: `/generated/${id}/site/index.html` },
        ...(manifest.projects || []).map(p => ({
          slug: p.slug,
          title: p.title,
          kind: 'project',
          preview: `/generated/${id}/site/work/${p.slug}/index.html`
        }))
      ],
      preview: `/generated/${id}/site/work/${project.slug}/index.html`
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

app.listen(PORT, () => console.log(`KillaWork™ Importer running on http://localhost:${PORT}`));

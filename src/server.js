import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { runImport, generateSite, validateSite, zipDir } from './importer.js';
import { runCampaignBuild, runUploadBuild } from './uploadBuilder.js';
import { hash } from './utils.js';

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
app.use('/', express.static(path.join(root, 'public')));
app.use('/generated', express.static(path.join(root, 'generated')));

app.post('/api/import', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Enter a valid http/https URL.' });
  const id = `${Date.now()}-${hash(url)}`;
  const outDir = path.join(root, 'generated', id);
  const job = { id, url, aiCleanup, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
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

app.post('/api/upload-build', upload.array('files', 60), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const aiCleanup = !!req.body?.aiCleanup;
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Upload at least one image, video, or PDF.' });
  const id = `${Date.now()}-${hash(`${title}:${files.map(f => f.originalname).join('|')}`)}`;
  const outDir = path.join(root, 'generated', id);
  const job = { id, url: 'uploaded-files', aiCleanup, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving uploaded assets','Analyzing uploaded work','AI analyzing asset','AI organizing portfolio','Raw manifest saved','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  try {
    await runUploadBuild({ files, outDir, title, aiCleanup, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
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

app.post('/api/campaign-build', upload.any(), async (req, res) => {
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
  const job = { id, url: 'campaign-builder', aiCleanup: true, status: 'running', progress: [], percent: 2, createdAt: new Date().toISOString(), links: null, error: null };
  jobs.set(id, job);
  res.json({ id });

  const stages = ['Saving campaign assets','AI analyzing campaign asset','Building campaign pages','AI cleanup','Building static portfolio','Generated static site','Validating output','Validation passed','Validation warnings','ZIP ready'];
  const updatePercent = (stage) => {
    const idx = stages.findIndex(s => stage.startsWith(s));
    if (idx >= 0) job.percent = Math.max(job.percent, Math.round(((idx + 1) / stages.length) * 100));
  };

  try {
    await runCampaignBuild({ files, campaigns, outDir, title, aiCleanup: true, onProgress: (evt) => {
      updatePercent(evt.stage);
      job.progress.push(evt);
      if (job.progress.length > 300) job.progress.shift();
    }});
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

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/download/:id', async (req, res) => {
  const zip = path.join(root, 'generated', req.params.id, 'site.zip');
  if (!(await fs.pathExists(zip))) return res.status(404).send('ZIP not ready');
  res.download(zip, 'killerwork-import.zip');
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
    slug: project.slug,
    url: project.url,
    images: project.images || [],
    videos: project.videos || [],
    audios: project.audios || [],
    documents: project.documents || [],
    contentItems: project.contentItems || []
  };
}

function cleanInlineText(value = '', max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
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

function projectSummary(project, id) {
  return {
    title: project.title,
    slug: project.slug,
    images: (project.images || []).length,
    videos: (project.videos || []).length,
    audios: (project.audios || []).length,
    documents: (project.documents || []).length,
    preview: `/generated/${id}/site/work/${project.slug}/index.html`,
    editor: `/editor.html?job=${encodeURIComponent(id)}&page=${encodeURIComponent(project.slug)}`
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
    editor: `/editor.html?job=${encodeURIComponent(id)}`,
    projects: (manifest.projects || []).map(project => projectSummary(project, id)),
    validation
  };
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

app.get('/api/manage/:id', async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  res.json(publicPortfolio(req.params.id, manifest));
});

app.put('/api/manage/:id', async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  const siteTitle = String(req.body?.siteTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const ownerName = String(req.body?.ownerName || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (siteTitle) manifest.siteTitle = siteTitle;
  if (ownerName) manifest.ownerName = ownerName;
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json(publicPortfolio(id, manifest, validation));
});

app.delete('/api/manage/:id/projects/:slug', async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Portfolio not found.' });
  const before = (manifest.projects || []).length;
  manifest.projects = (manifest.projects || []).filter(project => project.slug !== req.params.slug);
  if (manifest.projects.length === before) return res.status(404).json({ error: 'Project not found.' });
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json(publicPortfolio(id, manifest, validation));
});

app.delete('/api/manage/:id', async (req, res) => {
  const dir = jobDir(req.params.id);
  if (!(await fs.pathExists(dir))) return res.status(404).json({ error: 'Portfolio not found.' });
  await fs.remove(dir);
  jobs.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/editor/:id/pages', async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  res.json({
    id: req.params.id,
    siteTitle: manifest.siteTitle,
    ownerName: manifest.ownerName,
    pages: (manifest.projects || []).map(p => ({
      slug: p.slug,
      title: p.title,
      preview: `/generated/${req.params.id}/site/work/${p.slug}/index.html`
    }))
  });
});

app.get('/api/editor/:id/pages/:slug', async (req, res) => {
  const manifest = await readManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });
  res.json(publicProject(project));
});

app.post('/api/editor/:id/pages/:slug/assets', upload.single('file'), async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) {
    if (req.file) await fs.remove(req.file.path).catch(() => {});
    return res.status(404).json({ error: 'Import not found.' });
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
      if (text) safe.push({ type: 'text', order, tag: 'p', text });
      return;
    }
    if (item.type === 'image' && Number.isInteger(item.imageIndex) && item.imageIndex >= 0 && item.imageIndex < imageMax) {
      const alt = String(item.alt || '').slice(0, 500);
      if (alt && project.images?.[item.imageIndex]) project.images[item.imageIndex].alt = alt;
      safe.push({ type: 'image', order, alt, imageIndex: item.imageIndex, original: item.original || project.images[item.imageIndex]?.original || '' });
      return;
    }
    if (item.type === 'video' && Number.isInteger(item.videoIndex) && item.videoIndex >= 0 && item.videoIndex < videoMax) {
      const title = String(item.title || '').slice(0, 500);
      if (title && project.videos?.[item.videoIndex]) project.videos[item.videoIndex].title = title;
      safe.push({ type: 'video', order, title, videoIndex: item.videoIndex, original: item.original || project.videos[item.videoIndex]?.original || '' });
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
      safe.push({ type: 'document', order, title, documentIndex: item.documentIndex, original: item.original || project.documents[item.documentIndex]?.original || '' });
      return;
    }
    if (item.type === 'gallery' && Array.isArray(item.imageIndexes)) {
      const imageIndexes = item.imageIndexes.filter(n => Number.isInteger(n) && n >= 0 && n < imageMax);
      if (imageIndexes.length) safe.push({ type: 'gallery', order, imageIndexes, originals: imageIndexes.map(n => project.images[n]?.original || '') });
    }
  });
  return safe;
}

app.put('/api/editor/:id/pages/:slug', async (req, res) => {
  const id = req.params.id;
  const manifest = await readManifest(id);
  if (!manifest) return res.status(404).json({ error: 'Import not found.' });
  const project = (manifest.projects || []).find(p => p.slug === req.params.slug);
  if (!project) return res.status(404).json({ error: 'Page not found.' });

  const title = String(req.body?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (title) project.title = title;
  if (Array.isArray(req.body?.contentItems)) {
    project.contentItems = sanitizeContentItems(req.body.contentItems, project);
    project.cleaned = null;
  }

  const outDir = jobDir(id);
  const validation = await saveManifestAndRebuild(id, manifest);
  res.json({ ok: true, validation, page: publicProject(project), preview: `/generated/${id}/site/work/${project.slug}/index.html` });
});

app.listen(PORT, () => console.log(`KillerWork™ Importer running on http://localhost:${PORT}`));

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import { runImport, generateSite, validateSite, zipDir } from './importer.js';
import { hash } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 8787;
const jobs = new Map();

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

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/download/:id', async (req, res) => {
  const zip = path.join(root, 'generated', req.params.id, 'site.zip');
  if (!(await fs.pathExists(zip))) return res.status(404).send('ZIP not ready');
  res.download(zip, 'onlyportfolios-import.zip');
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
    contentItems: project.contentItems || []
  };
}

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

function sanitizeContentItems(items, project) {
  const imageMax = (project.images || []).length;
  const videoMax = (project.videos || []).length;
  const safe = [];
  items.forEach((item, idx) => {
    const order = idx + 1;
    if (item.type === 'text') {
      const text = String(item.text || '').replace(/\r/g, '\n').trim().slice(0, 4000);
      if (text) safe.push({ type: 'text', order, tag: 'p', text });
      return;
    }
    if (item.type === 'image' && Number.isInteger(item.imageIndex) && item.imageIndex >= 0 && item.imageIndex < imageMax) {
      safe.push({ type: 'image', order, alt: String(item.alt || '').slice(0, 500), imageIndex: item.imageIndex, original: item.original || project.images[item.imageIndex]?.original || '' });
      return;
    }
    if (item.type === 'video' && Number.isInteger(item.videoIndex) && item.videoIndex >= 0 && item.videoIndex < videoMax) {
      safe.push({ type: 'video', order, title: String(item.title || '').slice(0, 500), videoIndex: item.videoIndex, original: item.original || project.videos[item.videoIndex]?.original || '' });
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
  await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), manifest, { spaces: 2 });
  const siteDir = await generateSite(manifest, outDir);
  const validation = await validateSite(siteDir);
  await zipDir(siteDir, path.join(outDir, 'site.zip'));
  res.json({ ok: true, validation, page: publicProject(project), preview: `/generated/${id}/site/work/${project.slug}/index.html` });
});

app.listen(PORT, () => console.log(`OnlyPortfolios Importer running on http://localhost:${PORT}`));

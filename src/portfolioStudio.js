import path from 'path';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import { chromium } from 'playwright';

const MAX_ENTRIES = 300;
const MAX_BYTES = 700 * 1024 * 1024;
const SUPPORTED = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif',
  '.mp4', '.mov', '.webm', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac',
  '.pdf'
]);

function text(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slug(value = 'item') {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function titleCase(value = '') {
  return text(value.replace(/[-_]+/g, ' ')).replace(/\b\w/g, char => char.toUpperCase());
}

function safeZipPath(value = '') {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const clean = path.posix.normalize(normalized);
  if (clean === '..' || clean.startsWith('../') || path.posix.isAbsolute(clean)) return '';
  return clean;
}

function html(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function jsonFromText(value = '') {
  const cleaned = String(value || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('AI did not return valid JSON');
}

function stalePortfolioCopy(value = '') {
  return /\b(unleash|journey|vibrant world|creativity knows no bounds|essence|resonate|dynamic projects|showcases|welcome to|passion for|portfolio showcases|innovative storytelling)\b/i.test(String(value || ''));
}

function cleanUrl(value = '') {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (!/^https?:$/i.test(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizeStyle(value = '') {
  return value === 'parallax' ? 'parallax' : 'straightforward';
}

function usefulFallbackDirection({ name, jobTitle, prompt, style = 'straightforward' }) {
  return {
    intro: `${jobTitle || 'Advertising creative'} portfolio for ${name || 'selected work'}. Built around the uploaded campaigns, with the work doing the talking.`,
    tone: style === 'parallax' ? 'immersive, visual, cinematic, work-first' : 'direct, work-first, senior, sharp',
    palette: ['#050505', '#f7f2ea', '#ff6b00', '#9af27f', '#7bdff2'],
    sections: ['Selected work', 'Campaign pages', 'About', 'Contact']
  };
}

function sectionLabel(value) {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object') return text(value.title || value.name || value.label || value.section || '');
  return '';
}

function assetType(type = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'document';
  return 'file';
}

function firstFolder(relativePath = '') {
  const parts = relativePath.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : 'Selected Work';
}

async function extractZip(zipPath, workDir, progress) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('The ZIP is empty.');
  if (entries.length > MAX_ENTRIES) throw new Error(`The ZIP has too many files. Keep it under ${MAX_ENTRIES} entries.`);

  const rawDir = path.join(workDir, 'raw');
  await fs.emptyDir(rawDir);
  const groups = new Map();
  let expanded = 0;
  let index = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relative = safeZipPath(entry.entryName);
    if (!relative || relative.startsWith('__MACOSX/') || path.basename(relative) === '.DS_Store') continue;
    const ext = path.extname(relative).toLowerCase();
    if (!SUPPORTED.has(ext)) continue;
    expanded += Number(entry.header?.size || 0);
    if (expanded > MAX_BYTES) throw new Error('The ZIP expands beyond the portfolio studio limit.');

    const originalName = path.basename(relative);
    const storedName = `${String(++index).padStart(4, '0')}-${slug(path.basename(originalName, ext))}${ext}`;
    const rawPath = path.join(rawDir, storedName);
    await fs.writeFile(rawPath, entry.getData());
    const type = mime.lookup(ext) || 'application/octet-stream';
    const group = firstFolder(relative);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      originalName,
      relativePath: relative,
      rawPath,
      size: Number(entry.header?.size || 0),
      mime: type,
      type: assetType(type)
    });
  }
  if (!groups.size) throw new Error('No portfolio-ready media was found. Add images, video, audio, or PDFs to the ZIP.');
  progress('ZIP analyzed', `${index} usable file(s) grouped into ${groups.size} project(s)`);
  return [...groups.entries()].map(([folder, assets], i) => ({
    title: folder === 'Selected Work' ? `Project ${i + 1}` : titleCase(folder),
    folder,
    slug: slug(folder === 'Selected Work' ? `project-${i + 1}` : folder),
    assets
  }));
}

async function askForDirection({ name, jobTitle, prompt, projects, style }) {
  const fallback = usefulFallbackDirection({ name, jobTitle, prompt, style });
  if (!process.env.OPENAI_API_KEY) return fallback;
  const system = `You are the creative director for a custom advertising portfolio builder.
Return JSON only. Do not write code.
Use the user's prompt and ZIP inventory to define a strong portfolio direction.
Do not invent awards, client facts, metrics, employment history, or campaign claims.
Write like a senior advertising creative, not a generic portfolio template.
Avoid these words and phrases: unleash, journey, vibrant world, creativity knows no bounds, essence, resonate, dynamic projects, showcases, welcome to, passion for, innovative storytelling.
The hero headline is controlled by the product and must not be written by you.
The intro should be one plain sentence that can sit below the user's job title.
Schema: { "intro": "", "tone": "", "palette": ["#000000"], "sections": [""] }`;
  const payload = {
    name,
    jobTitle,
    prompt,
    selectedStyle: style,
    projects: projects.map(project => ({
      title: project.title,
      files: project.assets.map(asset => ({ name: asset.originalName, type: asset.type })).slice(0, 25)
    }))
  };
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!response.ok) return fallback;
    const parsed = jsonFromText((await response.json()).choices?.[0]?.message?.content || '{}');
    const direction = {
      ...fallback,
      ...parsed,
      palette: Array.isArray(parsed.palette) && parsed.palette.length >= 3 ? parsed.palette.slice(0, 6) : fallback.palette,
      sections: Array.isArray(parsed.sections) ? parsed.sections.map(sectionLabel).filter(Boolean).slice(0, 6) : fallback.sections
    };
    if (stalePortfolioCopy(direction.intro)) direction.intro = fallback.intro;
    return direction;
  } catch {
    return fallback;
  }
}

async function copyAssets(projects, siteDir) {
  const usedSlugs = new Set();
  for (const project of projects) {
    const base = project.slug;
    let next = base;
    let suffix = 2;
    while (usedSlugs.has(next)) next = `${base}-${suffix++}`;
    project.slug = next;
    usedSlugs.add(next);

    const assetDir = path.join(siteDir, 'assets', project.slug);
    await fs.ensureDir(assetDir);
    let count = 0;
    for (const asset of project.assets) {
      const ext = path.extname(asset.originalName).toLowerCase() || `.${mime.extension(asset.mime) || 'bin'}`;
      const fileName = `${String(++count).padStart(3, '0')}-${slug(path.basename(asset.originalName, ext))}${ext}`;
      const target = path.join(assetDir, fileName);
      await fs.copy(asset.rawPath, target);
      asset.sitePath = `assets/${project.slug}/${fileName}`;
      asset.pagePath = `../../assets/${project.slug}/${fileName}`;
    }
  }
}

function media(asset, prefix = '') {
  const src = `${prefix}${asset.sitePath}`;
  const label = html(asset.originalName);
  if (asset.type === 'image') return `<img src="${src}" alt="${label}" decoding="async">`;
  if (asset.type === 'video') return `<video src="${src}" controls playsinline preload="metadata"></video>`;
  if (asset.type === 'audio') return `<div class="audio-card"><b>${label}</b><audio src="${src}" controls preload="metadata"></audio></div>`;
  if (asset.type === 'document') return `<a class="doc-card" href="${src}" target="_blank" rel="noreferrer"><span>PDF</span><b>${label}</b></a>`;
  return `<a class="doc-card" href="${src}" target="_blank" rel="noreferrer"><span>File</span><b>${label}</b></a>`;
}

function thumbnailMedia(asset, prefix = '') {
  if (!asset) return '<div class="thumb-fallback"></div>';
  const src = `${prefix}${asset.sitePath}`;
  const label = html(asset.originalName);
  if (asset.type === 'image') return `<img src="${src}" alt="${label}" decoding="async">`;
  if (asset.type === 'video') return `<video src="${src}" muted loop playsinline preload="metadata"></video>`;
  return `<div class="thumb-fallback"><span>${asset.type === 'document' ? 'PDF' : 'File'}</span></div>`;
}

function previewAsset(project) {
  return project.assets.find(asset => asset.type === 'image' || asset.type === 'video') || project.assets[0];
}

function css(direction, style = 'straightforward') {
  const colors = direction.palette || [];
  const bg = /^#[0-4][0-9a-f]{5}$/i.test(colors[0] || '') ? colors[0] : '#050505';
  const fg = /^#[b-f][0-9a-f]{5}$/i.test(colors[1] || '') ? colors[1] : '#f7f2ea';
  const hot = colors[2] || '#ff6b00';
  const green = colors[3] || '#9af27f';
  const blue = colors[4] || '#7bdff2';
  const parallax = style === 'parallax' ? `.site-parallax .hero{min-height:92vh;perspective:900px}.site-parallax .hero-media{width:min(52vw,760px);height:min(64vh,650px);opacity:.72;transform:translateZ(-60px) scale(1.08)}.site-parallax .hero h1{font-size:clamp(62px,13vw,188px);mix-blend-mode:difference}.site-parallax .work-grid{gap:clamp(14px,2.4vw,30px)}.site-parallax .work-card:nth-child(4n+1){aspect-ratio:3/4}.site-parallax .work-card:nth-child(5n+2){aspect-ratio:4/5}.site-parallax .work-card:nth-child(6n+4){aspect-ratio:1/1.18}` : `.site-straightforward .hero{min-height:70vh}.site-straightforward .hero-media{opacity:.34}.site-straightforward .work-grid{gap:18px}.site-straightforward .work-card{aspect-ratio:4/3}`;
  return `:root{--bg:${bg};--fg:${fg};--hot:${hot};--green:${green};--blue:${blue};--muted:color-mix(in srgb,var(--fg) 58%,transparent);--line:color-mix(in srgb,var(--fg) 16%,transparent)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:Inter,Arial,sans-serif}a{color:inherit}.nav{position:sticky;top:0;z-index:3;display:flex;justify-content:space-between;gap:18px;padding:18px clamp(18px,4vw,54px);background:color-mix(in srgb,var(--bg) 86%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(18px)}.nav a{text-decoration:none;font-weight:900}.nav span{color:var(--muted)}.nav-links{display:flex;gap:14px;align-items:center}.nav-links a{color:var(--muted);font-size:13px}.hero{position:relative;display:grid;align-content:end;gap:22px;overflow:hidden;padding:8vh clamp(18px,5vw,76px)}.hero>*:not(.hero-media){position:relative;z-index:1}.hero-media{position:absolute;right:clamp(18px,5vw,76px);bottom:7vh;width:min(42vw,620px);height:min(52vh,520px);filter:saturate(1.1);background:#111}.hero-media img,.hero-media video{width:100%;height:100%;object-fit:cover}.eyebrow{color:var(--green);font-size:12px;font-weight:950;text-transform:uppercase;letter-spacing:.14em}.hero h1{max-width:980px;margin:0;font-size:clamp(58px,11vw,154px);line-height:.82;letter-spacing:0}.hero h1 span{display:block;color:var(--hot);font-size:.42em;line-height:1.05;margin-top:.1em}.hero p{max-width:720px;margin:0;color:var(--muted);font-size:clamp(20px,2.3vw,32px);line-height:1.18}.work{padding:0 clamp(18px,5vw,76px) 96px}.work-head{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:18px;border-top:1px solid var(--line);padding-top:20px}.work-head h2{margin:0;font-size:clamp(38px,6vw,86px);line-height:.9}.work-head span{color:var(--muted);font-weight:900}.work-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));grid-auto-flow:dense;align-items:stretch}.work-card{position:relative;display:block;min-height:0;aspect-ratio:1;overflow:hidden;background:#111;text-decoration:none}.work-card .thumb{position:absolute;inset:0;min-height:0;max-height:none;background:#111}.work-card .thumb img,.work-card .thumb video{display:block;width:100%;height:100%;object-fit:cover;transition:transform .55s ease,filter .55s ease}.thumb-fallback{display:grid;place-items:center;width:100%;height:100%;background:linear-gradient(135deg,var(--hot),#20242c);color:var(--fg);font-weight:950}.work-card-overlay{position:absolute;inset:auto 0 0;z-index:2;display:grid;gap:8px;padding:18px;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.7) 34%,rgba(0,0,0,.92));transform:translateY(calc(100% - 72px));transition:transform .28s ease}.work-card:before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(0,0,0,0) 38%,rgba(0,0,0,.34));transition:background .28s ease}.work-card:hover:before,.work-card:focus-visible:before{background:rgba(0,0,0,.36)}.work-card:hover .work-card-overlay,.work-card:focus-visible .work-card-overlay{transform:translateY(0)}.work-card:hover .thumb img,.work-card:hover .thumb video,.work-card:focus-visible .thumb img,.work-card:focus-visible .thumb video{transform:scale(1.055);filter:saturate(1.08)}.work-card small{color:var(--green);font-weight:950;letter-spacing:.08em;text-transform:uppercase}.work-card h3{margin:0;color:#fff;font-size:clamp(24px,3vw,44px);line-height:.94;text-shadow:0 8px 28px rgba(0,0,0,.55)}.work-card p{margin:0;color:rgba(255,255,255,.78);font-size:14px}.project-page{padding:56px clamp(18px,5vw,76px) 90px}.project-head{display:grid;gap:14px;margin-bottom:50px}.project-head h1{margin:0;font-size:clamp(56px,11vw,150px);line-height:.82}.asset-stack{display:grid;gap:clamp(20px,5vw,58px)}figure{margin:0;display:grid;gap:10px}figure:nth-child(3n+1){max-width:1280px}figure:nth-child(3n+2){max-width:860px;margin-left:auto}figure:nth-child(3n){max-width:1040px;margin-inline:auto}figure img,figure video{display:block;width:100%;max-height:88vh;object-fit:contain;background:#111}figcaption{color:var(--muted);font-size:13px}.doc-card,.audio-card{display:grid;gap:12px;padding:30px;border:1px solid var(--line);background:color-mix(in srgb,var(--fg) 5%,transparent);text-decoration:none}.audio-card audio{width:100%}.about{padding:70px clamp(18px,5vw,76px);border-top:1px solid var(--line)}.about p{max-width:860px;color:var(--muted);font-size:24px;line-height:1.3}.foot{display:flex;justify-content:space-between;gap:18px;padding:30px clamp(18px,5vw,76px);border-top:1px solid var(--line);color:var(--muted)}.reveal{opacity:0;transform:translateY(16px);transition:.55s opacity,.55s transform}.reveal.on{opacity:1;transform:none}${parallax}@media(max-width:820px){.nav,.foot,.work-head{display:grid}.nav-links{justify-content:space-between}.hero{min-height:70vh}.hero-media{position:relative;right:auto;bottom:auto;width:100%;height:260px;order:-1}.work-grid{grid-template-columns:1fr}.work-card{min-height:280px}.site-parallax .work-card:nth-child(n){transform:none}}`;
}

function js() {
  return `const obs='IntersectionObserver'in window?new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('on');obs.unobserve(e.target)}}),{threshold:.1}):null;document.querySelectorAll('.reveal').forEach(el=>obs?obs.observe(el):el.classList.add('on'));document.querySelectorAll('.work-card video,.hero-media video').forEach(v=>v.play().catch(()=>{}));`;
}

function repairCss(issues = []) {
  if (!issues.length) return '';
  return `

/* Studio visual QA repairs */
.work-grid{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))!important;grid-auto-flow:row!important;gap:clamp(14px,2vw,24px)!important}
.work-card{opacity:1!important;transform:none!important;min-height:0!important;aspect-ratio:4/3!important}
.work-card .thumb,.hero-media{background:#151515!important}
.work-card-overlay{transform:translateY(calc(100% - 76px))!important;background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.72) 30%,rgba(0,0,0,.94))!important}
.work-card h3{color:#fff!important;text-shadow:0 8px 30px rgba(0,0,0,.72)!important}
.hero{min-height:72vh!important}
.hero h1{max-width:980px!important;overflow-wrap:anywhere!important}
@media(max-width:820px){.work-grid{grid-template-columns:1fr!important}.hero-media{position:relative!important;width:100%!important;height:260px!important;right:auto!important;bottom:auto!important}}
`;
}

async function evaluateRenderedSite(siteDir, reportsDir, label, viewport) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  const screenshot = path.join(reportsDir, `studio-qa-${label}.png`);
  try {
    await page.goto(`file://${path.join(siteDir, 'index.html')}`, { waitUntil: 'networkidle' });
    const metrics = await page.evaluate(() => {
      const rect = el => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const cards = [...document.querySelectorAll('.work-card')].map(rect);
      let realOverlaps = 0;
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          const a = cards[i];
          const b = cards[j];
          const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (x > 8 && y > 8 && x * y > 500) realOverlaps++;
        }
      }
      const hero = document.querySelector('.hero');
      const heroTitle = document.querySelector('.hero h1');
      const grid = document.querySelector('.work-grid');
      const bodyText = document.body.textContent || '';
      return {
        title: document.title,
        h1: heroTitle?.innerText || '',
        hasObjectObject: bodyText.includes('[object Object]'),
        hasWorkGrid: !!grid && getComputedStyle(grid).display === 'grid',
        cardCount: cards.length,
        cardOverlaps: realOverlaps,
        loadedImages: [...document.images].filter(img => img.naturalWidth > 0 && img.naturalHeight > 0).length,
        brokenImages: [...document.images].filter(img => img.complete && img.naturalWidth === 0).length,
        heroHeight: hero ? rect(hero).height : 0,
        heroTitleWidth: heroTitle ? rect(heroTitle).width : 0,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyHeight: document.documentElement.scrollHeight
      };
    });
    await page.screenshot({ path: screenshot, fullPage: false });
    return { label, viewport, screenshot: path.relative(path.dirname(siteDir), screenshot), metrics };
  } finally {
    await browser.close();
  }
}

function visualIssues(result = {}, projectCount = 0) {
  const metrics = result.metrics || {};
  const issues = [];
  if (metrics.hasObjectObject) issues.push('object-object-copy');
  if (!metrics.hasWorkGrid) issues.push('missing-work-grid');
  if ((metrics.cardCount || 0) < projectCount) issues.push('missing-work-cards');
  if ((metrics.loadedImages || 0) === 0 && projectCount > 0) issues.push('no-loaded-images');
  if ((metrics.brokenImages || 0) > 0) issues.push('broken-images');
  if ((metrics.cardOverlaps || 0) > 0) issues.push('overlapping-work-cards');
  if ((metrics.scrollWidth || 0) > (metrics.viewportWidth || 0) + 4) issues.push('horizontal-overflow');
  if ((metrics.heroHeight || 0) < 360) issues.push('weak-hero-height');
  return issues;
}

function safeAiRepairCss(value = '') {
  const css = String(value || '').replace(/<\/style/gi, '<\\/style').trim();
  if (!css || css.length > 7000) return '';
  if (/@import|javascript:|expression\s*\(|<script|url\s*\(\s*['"]?\s*https?:/i.test(css)) return '';
  return css;
}

async function aiVisualRepair({ outDir, latestDesktop, latestMobile, projectCount, style, progress }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (String(process.env.AI_VISUAL_QA || 'true').toLowerCase() === 'false') return null;
  const desktopPath = latestDesktop?.screenshot ? path.join(outDir, latestDesktop.screenshot) : '';
  const mobilePath = latestMobile?.screenshot ? path.join(outDir, latestMobile.screenshot) : '';
  if (!(await fs.pathExists(desktopPath)) || !(await fs.pathExists(mobilePath))) return null;

  progress('AI visual critique', 'Reviewing screenshots for design improvements');
  const desktop = await fs.readFile(desktopPath, 'base64');
  const mobile = await fs.readFile(mobilePath, 'base64');
  const system = `You are a senior digital design QA reviewer for advertising portfolio websites.
Return JSON only.
You are reviewing screenshots of a generated portfolio. The site must keep:
- identity-first hero with user's name and job title
- a mandatory Work grid with campaign thumbnail cards
- readable hover/card titles
- no corny generic marketing copy

Suggest only CSS improvements. Do not request HTML changes.
Do not use external URLs, @import, JavaScript, or fonts.
Keep the repair CSS small and targeted.
Schema: { "apply": true, "notes": [""], "repairCss": "" }`;
  const user = {
    selectedStyle: style,
    projectCount,
    desktopMetrics: latestDesktop?.metrics || {},
    mobileMetrics: latestMobile?.metrics || {},
    instruction: 'If the site is already strong, set apply false. If it feels bland, cramped, unreadable, or weak, provide CSS only.'
  };
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: JSON.stringify(user) },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${desktop}` } },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${mobile}` } }
            ]
          }
        ]
      })
    });
    if (!response.ok) return null;
    const parsed = jsonFromText((await response.json()).choices?.[0]?.message?.content || '{}');
    const repairCss = safeAiRepairCss(parsed.repairCss);
    return {
      apply: Boolean(parsed.apply && repairCss),
      notes: Array.isArray(parsed.notes) ? parsed.notes.map(text).filter(Boolean).slice(0, 6) : [],
      repairCss
    };
  } catch {
    return null;
  }
}

async function runVisualQualityLoop({ siteDir, outDir, projectCount, style, progress }) {
  const reportsDir = path.join(outDir, 'reports');
  await fs.ensureDir(reportsDir);
  const cssFile = path.join(siteDir, 'styles.css');
  const attempts = [];
  let ai = null;
  let repaired = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    progress('Visual QA', `Rendering desktop and mobile pass ${attempt}`);
    const desktop = await evaluateRenderedSite(siteDir, reportsDir, `desktop-${attempt}`, { width: 1440, height: 1000 });
    const mobile = await evaluateRenderedSite(siteDir, reportsDir, `mobile-${attempt}`, { width: 390, height: 844 });
    const issues = [...new Set([...visualIssues(desktop, projectCount), ...visualIssues(mobile, projectCount)])];
    attempts.push({ attempt, issues, desktop, mobile });
    if (!issues.length) break;
    if (attempt === 1) {
      progress('Applying visual repairs', issues.join(', '));
      await fs.appendFile(cssFile, repairCss(issues), 'utf8');
      repaired = true;
    }
  }
  let finalIssues = attempts.at(-1)?.issues || [];
  const latest = attempts.at(-1);
  ai = await aiVisualRepair({
    outDir,
    latestDesktop: latest?.desktop,
    latestMobile: latest?.mobile,
    projectCount,
    style,
    progress
  });
  if (ai?.apply) {
    progress('Applying AI visual repairs', ai.notes.join('; ') || 'Refining generated CSS');
    await fs.appendFile(cssFile, `\n\n/* Studio AI visual QA repairs */\n${ai.repairCss}\n`, 'utf8');
    repaired = true;
    const desktop = await evaluateRenderedSite(siteDir, reportsDir, 'desktop-ai', { width: 1440, height: 1000 });
    const mobile = await evaluateRenderedSite(siteDir, reportsDir, 'mobile-ai', { width: 390, height: 844 });
    finalIssues = [...new Set([...visualIssues(desktop, projectCount), ...visualIssues(mobile, projectCount)])];
    attempts.push({ attempt: 'ai', issues: finalIssues, desktop, mobile });
    if (finalIssues.length) {
      progress('Applying visual repairs', finalIssues.join(', '));
      await fs.appendFile(cssFile, repairCss(finalIssues), 'utf8');
      repaired = true;
      const repairedDesktop = await evaluateRenderedSite(siteDir, reportsDir, 'desktop-ai-repaired', { width: 1440, height: 1000 });
      const repairedMobile = await evaluateRenderedSite(siteDir, reportsDir, 'mobile-ai-repaired', { width: 390, height: 844 });
      finalIssues = [...new Set([...visualIssues(repairedDesktop, projectCount), ...visualIssues(repairedMobile, projectCount)])];
      attempts.push({ attempt: 'ai-repaired', issues: finalIssues, desktop: repairedDesktop, mobile: repairedMobile });
    }
  }
  const report = {
    ok: finalIssues.length === 0,
    repaired,
    finalIssues,
    ai,
    attempts
  };
  await fs.writeJson(path.join(reportsDir, 'studio-visual-qa.json'), report, { spaces: 2 });
  progress(report.ok ? 'Visual QA passed' : 'Visual QA warnings', report.ok ? 'Desktop and mobile render checks passed' : finalIssues.join(', '));
  return report;
}

function shell({ title, name, jobTitle, linkedin, body, depth = 0, style = 'straightforward' }) {
  const prefix = '../'.repeat(depth);
  const linkedinLink = linkedin ? `<a href="${html(linkedin)}" target="_blank" rel="noreferrer">LinkedIn</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(title)}</title><link rel="icon" href="${prefix}favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="${prefix}styles.css"></head><body class="site-${style}"><header class="nav"><a href="${prefix}index.html">${html(name)}</a><span class="nav-links"><span>${html(jobTitle)}</span>${linkedinLink}</span></header>${body}<script src="${prefix}site.js"></script></body></html>`;
}

function homePage({ name, jobTitle, linkedin, prompt, projects, direction, style }) {
  const heroAsset = previewAsset(projects[0] || {});
  const projectCards = projects.map((project, index) => {
    const asset = previewAsset(project);
    return `<a class="work-card" href="work/${project.slug}/index.html"><div class="thumb">${thumbnailMedia(asset)}</div><div class="work-card-overlay"><small>${String(index + 1).padStart(2, '0')}</small><h3>${html(project.title)}</h3><p>${project.assets.length} piece${project.assets.length === 1 ? '' : 's'}</p></div></a>`;
  }).join('');
  const sections = (direction.sections || []).map(item => `<span>${html(item)}</span>`).join(' / ');
  const contact = linkedin ? `<a href="${html(linkedin)}" target="_blank" rel="noreferrer">LinkedIn</a>` : '<span>Contact</span>';
  const body = `<main><section class="hero">${heroAsset ? `<div class="hero-media">${thumbnailMedia(heroAsset)}</div>` : ''}<span class="eyebrow">${sections || 'Selected work'}</span><h1>${html(name)}<span>${html(jobTitle)}</span></h1><p>${html(direction.intro || prompt || 'Selected advertising work built from one ZIP.')}</p></section><section class="work"><div class="work-head"><h2>Work</h2><span>${projects.length} project${projects.length === 1 ? '' : 's'}</span></div><div class="work-grid">${projectCards}</div></section><section class="about"><span class="eyebrow">About</span><p>${html(prompt || direction.tone || 'A focused advertising portfolio built around the uploaded work.')}</p></section></main><footer class="foot"><span>${html(name)}</span>${contact}</footer>`;
  return shell({ title: name, name, jobTitle, linkedin, body, style });
}

function projectPage({ name, jobTitle, linkedin, project, style }) {
  const figures = project.assets.map(asset => `<figure class="reveal">${media(asset, '../../')}<figcaption>${html(asset.originalName)}</figcaption></figure>`).join('');
  const body = `<main class="project-page"><section class="project-head"><span class="eyebrow">${project.assets.length} asset${project.assets.length === 1 ? '' : 's'}</span><h1>${html(project.title)}</h1></section><section class="asset-stack">${figures}</section></main><footer class="foot"><a href="../../index.html">All work</a><span>${html(name)}</span></footer>`;
  return shell({ title: `${project.title} - ${name}`, name, jobTitle, linkedin, body, depth: 2, style });
}

export async function runPortfolioStudioBuild({ zipPath, outDir, name = '', jobTitle = '', linkedin = '', style = 'straightforward', prompt = '', onProgress } = {}) {
  const progress = (stage, detail = '') => onProgress?.({ stage, detail, at: new Date().toISOString() });
  const cleanName = text(name) || 'Portfolio';
  const cleanTitle = text(jobTitle) || 'Advertising Creative';
  const cleanLinkedin = cleanUrl(linkedin);
  const cleanStyle = normalizeStyle(style);
  const cleanPrompt = text(prompt).slice(0, 4000);
  const scratchDir = path.join(outDir, '.studio');
  const siteDir = path.join(outDir, 'site');
  await fs.emptyDir(scratchDir);
  await fs.emptyDir(siteDir);

  progress('Reading upload', 'Unpacking ZIP and building a project inventory');
  const projects = await extractZip(zipPath, scratchDir, progress);
  progress('AI planning site', 'Interpreting the prompt and work inventory');
  const direction = await askForDirection({ name: cleanName, jobTitle: cleanTitle, prompt: cleanPrompt, projects, style: cleanStyle });
  progress('Creating code project', 'Writing a fresh portfolio codebase');
  await copyAssets(projects, siteDir);

  await fs.writeFile(path.join(siteDir, 'styles.css'), css(direction, cleanStyle), 'utf8');
  await fs.writeFile(path.join(siteDir, 'site.js'), js(), 'utf8');
  await fs.writeFile(path.join(siteDir, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#050505"/><path d="M15 45V16h10v12l12-12h13L35 31l17 14H38L25 33v12z" fill="#f7f2ea"/></svg>`, 'utf8');
  await fs.writeFile(path.join(siteDir, 'index.html'), homePage({ name: cleanName, jobTitle: cleanTitle, linkedin: cleanLinkedin, prompt: cleanPrompt, projects, direction, style: cleanStyle }), 'utf8');
  for (const project of projects) {
    const dir = path.join(siteDir, 'work', project.slug);
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'index.html'), projectPage({ name: cleanName, jobTitle: cleanTitle, linkedin: cleanLinkedin, project, style: cleanStyle }), 'utf8');
  }
  const visualQa = await runVisualQualityLoop({ siteDir, outDir, projectCount: projects.length, style: cleanStyle, progress });

  const manifest = {
    sourceUrl: 'portfolio-studio',
    sourcePlatform: 'portfolio-studio',
    buildMode: 'portfolio-studio',
    siteTitle: cleanName,
    ownerName: cleanName,
    homeIntro: cleanTitle,
    linkedin: cleanLinkedin,
    studioStyle: cleanStyle,
    builderPrompt: cleanPrompt,
    generatedAt: new Date().toISOString(),
    customCode: true,
    visualQa: {
      ok: visualQa.ok,
      repaired: visualQa.repaired,
      finalIssues: visualQa.finalIssues
    },
    studioDirection: direction,
    projects: projects.map(project => {
      const thumb = previewAsset(project);
      return {
        title: project.title,
        slug: project.slug,
        url: `work/${project.slug}/index.html`,
        thumbnail: thumb ? { src: thumb.sitePath, thumbSrc: thumb.sitePath } : null,
        images: project.assets.filter(asset => asset.type === 'image').map(asset => ({ src: asset.sitePath, alt: asset.originalName })),
        videos: project.assets.filter(asset => asset.type === 'video').map(asset => ({ src: asset.sitePath })),
        audios: project.assets.filter(asset => asset.type === 'audio').map(asset => ({ src: asset.sitePath })),
        documents: project.assets.filter(asset => asset.type === 'document').map(asset => ({ src: asset.sitePath, title: asset.originalName })),
        contentItems: []
      };
    })
  };
  await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });
  await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), manifest, { spaces: 2 });
  await fs.remove(scratchDir).catch(() => {});
  progress('Portfolio code ready', `${projects.length} page${projects.length === 1 ? '' : 's'} generated`);
  return { siteDir, manifest };
}

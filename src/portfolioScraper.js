import path from 'path';
import fs from 'fs-extra';
import { chromium } from 'playwright';

const MAX_IMAGES = 80;
const MIN_BYTE_SIZE = 3000;
const MAX_PROJECT_PAGES = 12;
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif']);
const MEDIA_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mov']);

async function launchBrowser() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (exe) return chromium.launch({ headless: true, executablePath: exe });
  return chromium.launch({ headless: true });
}

function slug(value = 'item') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function titleCase(value = '') {
  return String(value).replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

async function downloadAsset(url, destPath) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; portfolio-importer/1.0)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/') && !type.startsWith('video/')) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTE_SIZE) return false;
    await fs.writeFile(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

function mimeFromExt(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
  return map[ext] || 'application/octet-stream';
}

function assetType(ext) {
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  return 'image';
}

function extractImages(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[src]'));
    const bg = [];
    document.querySelectorAll('[style]').forEach(el => {
      const m = el.style.backgroundImage?.match(/url\(['"]?([^'"()]+)['"]?\)/);
      if (m) bg.push({ src: m[1], alt: el.getAttribute('aria-label') || '' });
    });
    return [
      ...imgs.map(i => ({ src: i.src, alt: i.alt || '', w: i.naturalWidth || i.width || 0 })),
      ...bg.map(i => ({ src: i.src, alt: i.alt, w: 0 }))
    ];
  });
}

function scoreWorkLink(href, text, hasImg) {
  const p = new URL(href).pathname.toLowerCase();
  let score = 0;
  if (/\/(work|project|case|campaign|portfolio|reel|client|ad|ads|brand)/.test(p)) score += 4;
  if (hasImg) score += 2;
  if (text && !/^(about|contact|home|blog|news|services|team|press|hire|faq|privacy|terms|info|studio|shop|cv|resume)$/i.test(text.trim())) score += 1;
  if (/\d{4}/.test(p)) score -= 1; // probably a blog post date
  return score;
}

export async function scrapePortfolioAssets({ url, workDir, onProgress = () => {} }) {
  const browser = await launchBrowser();
  const rawDir = path.join(workDir, 'raw');
  await fs.emptyDir(rawDir);
  const groups = new Map();
  let fileIndex = 0;

  try {
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 900 }
    });

    const baseUrl = new URL(url);
    const origin = baseUrl.origin;

    onProgress('Scraping portfolio', `Loading ${baseUrl.hostname}`);
    const mainPage = await ctx.newPage();
    await mainPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await mainPage.waitForTimeout(1200);

    // Collect meta
    const pageTitle = await mainPage.title().catch(() => '');
    const ogTitle = await mainPage.$eval('meta[property="og:title"]', el => el.content).catch(() => '');
    const metaDesc = await mainPage.$eval('meta[name="description"]', el => el.content).catch(() => '');

    // Find work/project links
    const rawLinks = await mainPage.evaluate((originUrl) => {
      return Array.from(document.querySelectorAll('a[href]')).map(a => ({
        href: (() => { try { return new URL(a.href).href; } catch { return ''; } })(),
        text: (a.textContent || '').trim().slice(0, 120),
        hasImg: !!a.querySelector('img')
      })).filter(l => {
        if (!l.href) return false;
        try {
          const u = new URL(l.href);
          return u.origin === originUrl && u.pathname.length > 1;
        } catch { return false; }
      });
    }, origin);

    const seen = new Set();
    const workLinks = rawLinks
      .map(l => ({ ...l, score: scoreWorkLink(l.href, l.text, l.hasImg) }))
      .filter(l => l.score > 0)
      .sort((a, b) => b.score - a.score)
      .filter(l => { if (seen.has(l.href)) return false; seen.add(l.href); return true; })
      .slice(0, MAX_PROJECT_PAGES);

    // Download homepage images as a group
    const homeImgs = await extractImages(mainPage);
    const homeAssets = [];
    for (const img of homeImgs.slice(0, 25)) {
      if (fileIndex >= MAX_IMAGES) break;
      try {
        const imgUrl = new URL(img.src, origin).href;
        const rawExt = path.extname(new URL(imgUrl).pathname.split('?')[0]).toLowerCase();
        const ext = IMG_EXTS.has(rawExt) ? rawExt : '.jpg';
        if (!MEDIA_EXTS.has(rawExt) && rawExt) continue;
        const fname = `${String(++fileIndex).padStart(4, '0')}-home${ext}`;
        const dest = path.join(rawDir, fname);
        const ok = await downloadAsset(imgUrl, dest);
        if (ok) homeAssets.push({ originalName: img.alt || fname, rawPath: dest, mime: mimeFromExt(ext), type: assetType(ext) });
      } catch {}
    }
    if (homeAssets.length) groups.set('Homepage', homeAssets);

    // Scrape project pages
    onProgress('Scraping portfolio', `Found ${workLinks.length} project page(s) — collecting assets`);
    for (const link of workLinks) {
      if (fileIndex >= MAX_IMAGES) break;
      const projPage = await ctx.newPage();
      try {
        await projPage.goto(link.href, { waitUntil: 'networkidle', timeout: 25000 });
        await projPage.waitForTimeout(800);

        const projImgs = await extractImages(projPage);
        const urlPath = new URL(link.href).pathname;
        const folderSlug = urlPath.split('/').filter(Boolean).pop() || `project-${fileIndex}`;
        const folderName = titleCase(folderSlug.replace(/[-_]/g, ' '));

        const assets = [];
        for (const img of projImgs.slice(0, 18)) {
          if (fileIndex >= MAX_IMAGES) break;
          try {
            const imgUrl = new URL(img.src, origin).href;
            const rawExt = path.extname(new URL(imgUrl).pathname.split('?')[0]).toLowerCase();
            const ext = IMG_EXTS.has(rawExt) ? rawExt : '.jpg';
            if (!MEDIA_EXTS.has(rawExt) && rawExt) continue;
            const fname = `${String(++fileIndex).padStart(4, '0')}-${slug(folderSlug)}${ext}`;
            const dest = path.join(rawDir, fname);
            const ok = await downloadAsset(imgUrl, dest);
            if (ok) assets.push({ originalName: img.alt || fname, rawPath: dest, mime: mimeFromExt(ext), type: assetType(ext) });
          } catch {}
        }

        if (assets.length) {
          groups.set(folderName, assets);
          onProgress('Scraping portfolio', `"${folderName}" — ${assets.length} asset(s)`);
        }
      } catch {
        // Skip failed project pages silently
      } finally {
        await projPage.close().catch(() => {});
      }
    }

    await mainPage.close().catch(() => {});

    if (!groups.size) throw new Error('No portfolio images could be collected from that URL. Try uploading a ZIP instead.');

    return {
      projects: [...groups.entries()].map(([folder, assets], i) => ({
        title: folder === 'Homepage' ? 'Selected Work' : folder,
        folder,
        slug: slug(folder === 'Homepage' ? 'selected-work' : folder),
        assets
      })),
      meta: { pageTitle: ogTitle || pageTitle, description: metaDesc }
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function scrapeLinkedInMeta(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    const get = (pattern) => html.match(pattern)?.[1]?.trim() || '';

    const ogTitle = get(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                    get(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    const ogDesc = get(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i) ||
                   get(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);
    const metaDesc = get(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i) ||
                     get(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);

    const rawName = (ogTitle || '').replace(/\s*[-|].*LinkedIn.*$/i, '').replace(/\s*on LinkedIn.*$/i, '').trim();
    const about = ogDesc || metaDesc || '';

    // Try to extract job title — usually the first fragment of og:description before a pipe/dash
    const jobTitleMatch = about.match(/^([^|·\-–—\n]{4,80}(?:Director|Manager|Designer|Creative|Officer|Lead|Head|VP|Principal|Senior|Junior|Executive|Strategist|Copywriter|Producer|Editor|Consultant|Photographer|Art Director)[^|·\n]{0,60})/i);
    const jobTitle = jobTitleMatch?.[1]?.trim() || '';

    return { name: rawName || '', jobTitle, about: about.slice(0, 600) };
  } catch {
    return null;
  }
}

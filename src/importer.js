import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import mime from 'mime-types';
import { fileURLToPath } from 'url';
import { cleanupManifestWithAI } from './ai.js';
import { safeSlug, hash, extFromUrl, normalizeUrl, canonicalImageKey, isBadMediaUrl, mediaType } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_PROJECTS = 80;
const EXCLUDED_DISCOVERY_PATHS = new Set([
  '/', '/about', '/about-us', '/art', '/contact', '/contact-us', '/shop', '/store',
  '/blog', '/journal', '/news', '/press', '/resume', '/cv', '/privacy', '/terms',
  '/work', '/portfolio', '/portfolios', '/projects', '/new-products', '/produce',
  '/cart', '/checkout', '/search', '/login', '/account'
]);
const EXCLUDED_DISCOVERY_SEGMENTS = new Set([
  'about', 'about-us', 'art', 'contact', 'contact-us', 'shop', 'store', 'blog',
  'journal', 'news', 'press', 'resume', 'cv', 'privacy', 'terms', 'cart',
  'checkout', 'search', 'login', 'account', 'category', 'tag', 'author'
]);

async function launchBrowser(progress) {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);
  for (const exe of candidates) {
    if (await fs.pathExists(exe)) {
      progress?.('Using installed browser', exe);
      return chromium.launch({ headless: true, executablePath: exe });
    }
  }
  progress?.('Using Playwright bundled browser', 'If this fails, install Chromium or set CHROME_PATH.');
  return chromium.launch({ headless: true });
}

function htmlEscape(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cleanTitle(title = '', owner = '') {
  let t = String(title || '').replace(/\s*[—|-]\s*Abdullah.*$/i, '').replace(/\s*—\s*Imported Portfolio$/i, '').trim();
  if (owner) t = t.replace(new RegExp(`\\s*[—|-]\\s*${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '').trim();
  return t || 'Untitled';
}

function titleFromSlug(slug = 'project') {
  return String(slug || 'project')
    .split('/')
    .filter(Boolean)
    .pop()
    ?.replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || 'Project';
}

function normalizeDiscoveryPath(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
}

function isLikelyProjectPath(pathname = '/') {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (EXCLUDED_DISCOVERY_PATHS.has(path)) return false;
  if (/\.(jpe?g|png|webp|gif|svg|pdf|zip|mp4|webm|mov|m3u8|css|js|json|xml|txt)$/i.test(path)) return false;
  const parts = path.split('/').filter(Boolean);
  if (!parts.length || parts.some(part => EXCLUDED_DISCOVERY_SEGMENTS.has(part.toLowerCase()))) return false;
  return parts.length <= 4;
}

function mergeProjectCandidates(candidates = []) {
  const bySlug = new Map();
  for (const candidate of candidates) {
    if (!candidate?.url) continue;
    const path = normalizeDiscoveryPath(candidate.url);
    if (!candidate.force && !isLikelyProjectPath(path)) continue;
    const slug = candidate.slug || path.replace(/^\/work\//, '').replace(/^\//, '').replace(/\/$/, '');
    if (!slug) continue;
    const current = bySlug.get(slug);
    const normalized = {
      slug,
      title: cleanTitle(candidate.title || titleFromSlug(slug)),
      url: candidate.url,
      thumbnailUrl: candidate.thumbnailUrl || '',
      description: candidate.description || '',
      strategy: candidate.strategy || 'unknown',
      score: Number(candidate.score || 0)
    };
    if (!current || normalized.score > current.score || (!current.thumbnailUrl && normalized.thumbnailUrl)) {
      bySlug.set(slug, normalized);
    }
  }
  return [...bySlug.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PROJECTS)
    .map(({ score, force, ...project }) => project);
}

function scoreAssetRef(ref = {}) {
  const visible = ref.visible === false ? 0 : 1;
  const area = Number(ref.area || 0);
  const width = Number(ref.width || 0);
  const height = Number(ref.height || 0);
  const order = Number(ref.order || 0);
  return (visible * 1e10) + (area * 1000) + (width * 10) + height - order;
}

function pickBestAssetRef(current, candidate) {
  if (!current) return candidate;
  return scoreAssetRef(candidate) > scoreAssetRef(current) ? candidate : current;
}

function submittedProjectCandidate(url) {
  const path = normalizeDiscoveryPath(url);
  const slug = path.replace(/^\/work\//, '').replace(/^\//, '').replace(/\/$/, '');
  return {
    slug: safeSlug(slug || titleFromSlug(path)),
    title: titleFromSlug(slug || path),
    url,
    thumbnailUrl: '',
    strategy: 'submitted-project',
    score: 1000,
    force: true
  };
}

async function extractPage(page, url, siteOrigin, progress) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);

  const data = await page.evaluate((siteOrigin) => {
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cleanLines = (s) => (s || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => clean(line))
      .filter(Boolean)
      .join('\n');
    const videoUrlPattern = /(https?:)?\/\/[^"'<>\\\s]+(?:youtube\.com|youtu\.be|vimeo\.com|\.m3u8|\.mp4|\.webm|\.mov)[^"'<>\\\s]*/ig;
    const removeSelectors = [
      'script','style','noscript','svg','header','footer','nav',
      '#header','#footer','#footerBlock','.Header','.Footer','.header','.footer','.site-header','.site-footer',
      '.absolute-cart-box',
      '[data-test="footer"]','[data-test="header"]',
      '.sqs-block-button','.pagination','.item-pagination','.blog-item-pagination',
      '.previous','.next','.prev-next','.collection-nav','.SocialLinks','.socialaccountlinks-v2-block',
      '[class*="pagination"]','[class*="Pager"]','[class*="Social"]'
    ];

    const pageTitle = clean(document.querySelector('h1')?.innerText) || clean(document.title).replace(/\s*[—|-]\s*Abdullah.*$/i, '') || 'Untitled';
    const main = document.querySelector('#canvas') || document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.Main') || document.body;
    main.querySelectorAll('*').forEach((node, index) => node.setAttribute('data-killerwork-node', String(index + 1)));
    const clone = main.cloneNode(true);
    removeSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(n => n.remove()));
    const bodyStyle = getComputedStyle(document.body);
    const mainStyle = getComputedStyle(main);

    const images = [];
    const videos = [];
    const copyBlocks = [];
    const contentItems = [];

    const pageStyle = {
      backgroundColor: clean(mainStyle.backgroundColor && mainStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ? mainStyle.backgroundColor : bodyStyle.backgroundColor),
      textColor: clean(mainStyle.color || bodyStyle.color),
      contentWidth: Math.round(main.getBoundingClientRect().width || 0)
    };

    function mediaMetaFrom(el) {
      const rect = el?.getBoundingClientRect?.() || { width: 0, height: 0 };
      const style = el ? getComputedStyle(el) : null;
      const width = Math.round(rect.width || 0);
      const height = Math.round(rect.height || 0);
      const visible = !!style
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0
        && !el.closest?.('[aria-hidden="true"], [hidden], .hidden, .visually-hidden')
        && width > 0
        && height > 0;
      return { width, height, area: width * height, visible };
    }

    function addImage(raw, alt, order, { content = true, meta = null } = {}) {
      const full = abs(raw);
      if (!full || full.startsWith('data:') || full.startsWith('blob:')) return;
      if (meta?.width && meta?.height && meta.width < 48 && meta.height < 48) return;
      const payload = { url: full, alt: clean(alt), order, ...(meta || {}) };
      images.push(payload);
      if (content) contentItems.push({ type: 'image', url: full, alt: clean(alt), order, ...(meta || {}) });
      return payload;
    }

    function addText(el, order) {
      const text = cleanLines(el.innerText);
      if (!text || text.length < 2) return;
      if (/^(previous|next|work|about|contact|review|original page)$/i.test(text)) return;
      if (/\|\s*work$/i.test(text) && el.tagName.match(/^H[23]$/)) return;
      const item = { tag: el.tagName.toLowerCase(), text, order };
      copyBlocks.push(item);
      contentItems.push({ type: 'text', ...item });
    }

    function addVideo(kind, raw, title, order, meta = null) {
      if (!raw) return;
      let value = String(raw).trim().replace(/&amp;/g, '&');
      let src = abs(value);
      if (!src) {
        try { src = abs(decodeURIComponent(value)); } catch {}
      }
      if (!src) return;
      videos.push({ kind, src, title: clean(title), order, ...(meta || {}) });
      contentItems.push({ type: 'video', kind, src, title: clean(title), order, ...(meta || {}) });
    }

    function addVideosFromText(raw, order, title = '', meta = null) {
      const text = String(raw || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const candidates = [text];
      try {
        const decoded = decodeURIComponent(text);
        if (decoded !== text) candidates.push(decoded);
      } catch {}
      for (const candidate of candidates) {
        for (const m of candidate.matchAll(videoUrlPattern)) {
          const kind = /\.(m3u8|mp4|webm|mov)(\?|$)/i.test(m[0]) ? 'video' : 'iframe';
          addVideo(kind, m[0], title, order, meta);
        }
      }
    }

    function addNativeVideoConfig(raw, order, title = '', meta = null) {
      if (!raw) return;
      let text = String(raw).replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try { text = decodeURIComponent(text); } catch {}
      try {
        const config = JSON.parse(text);
        const template = config.alexandriaUrl || '';
        if (template.includes('{variant}')) {
          addVideo('video', template.replace('{variant}', 'playlist.m3u8'), title || config.id || '', order, meta);
        }
      } catch {
        addVideosFromText(text, order, title, meta);
      }
    }

    function addGallery(el, order) {
      const imageScope = el.querySelector('[data-test="gallery-slideshow-list"], .gallery-slideshow-list') || el;
      const items = [...imageScope.querySelectorAll('img')]
        .map(img => {
          const raw = img.getAttribute('data-src') || img.getAttribute('data-image') || img.getAttribute('src') || img.currentSrc || img.src || '';
          const added = addImage(raw, img.getAttribute('alt') || pageTitle, order, { content: false, meta: mediaMetaFrom(img) });
          return added ? { url: added.url, alt: added.alt } : null;
        })
        .filter(Boolean);
      const unique = [];
      const seen = new Set();
      items.forEach(item => {
        const key = item.url.split('?')[0].toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(item);
      });
      if (unique.length > 1) contentItems.push({ type: 'gallery', order, images: unique });
    }

    let order = 0;
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      order += 1;
      const nodeId = el.getAttribute?.('data-killerwork-node');
      const liveEl = nodeId ? document.querySelector(`[data-killerwork-node="${nodeId}"]`) : null;
      const mediaMeta = mediaMetaFrom(liveEl);
      const tag = el.tagName.toLowerCase();
      const gallerySelector = '[data-test="gallery-slideshow-simple"], .gallery-slideshow-simple, .sqs-gallery-design-slideshow';
      const galleryRoot = el.matches?.(gallerySelector);
      if (galleryRoot && ![...el.querySelectorAll(gallerySelector)].some(child => child !== el)) {
        addGallery(liveEl || el, order);
        continue;
      }
      if (el.closest?.(gallerySelector)) continue;
      if (['p','h2','h3','li'].includes(tag)) addText(el, order);
      if (tag === 'img' || tag === 'source') {
        ['src','currentSrc','data-src','data-image','data-image-src','srcset','data-srcset'].forEach(a => {
          let v = a === 'currentSrc' ? el.currentSrc : el.getAttribute(a);
          if (!v) return;
          String(v).split(',').forEach(part => addImage(part.trim().split(/\s+/)[0], el.getAttribute('alt') || pageTitle, order, { meta: mediaMeta }));
        });
      }
      const style = el.getAttribute('style') || '';
      if (style.includes('background')) {
        [...style.matchAll(/url\(["']?([^"')]+)["']?\)/g)].forEach(m => addImage(m[1], pageTitle, order, { meta: mediaMeta }));
      }
      if (tag === 'iframe') {
        ['src','data-src','data-url','data-embed-url','data-video-url'].forEach(a => addVideo('iframe', el.getAttribute(a), el.getAttribute('title'), order, mediaMeta));
        addVideosFromText(el.getAttribute('srcdoc'), order, el.getAttribute('title'), mediaMeta);
      }
      if (tag === 'video' || (tag === 'source' && el.closest('video'))) {
        ['src','currentSrc','data-src','data-url','data-video-url'].forEach(a => addVideo('video', a === 'currentSrc' ? el.currentSrc : el.getAttribute(a), '', order, mediaMeta));
        if (tag === 'video') el.querySelectorAll('source[src],source[data-src]').forEach(source => addVideo('video', source.getAttribute('src') || source.getAttribute('data-src'), '', order, mediaMeta));
      }
      addNativeVideoConfig(el.getAttribute('data-config-video'), order, clean(el.getAttribute('title') || el.getAttribute('aria-label')), mediaMeta);
      ['data-html','data-url','data-video-url','data-embed-url','data-config','data-block-json','data-provider-url'].forEach(a => {
        const value = el.getAttribute(a);
        if (value) addVideosFromText(value, order, clean(el.getAttribute('title') || el.getAttribute('aria-label')), mediaMeta);
      });
    }

    clone.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]').forEach((script, i) => {
      addVideosFromText(script.textContent, order + i + 1, pageTitle);
    });

    function serializeStyle(style) {
      return Array.from(style || [])
        .map(prop => `${prop}:${style.getPropertyValue(prop)}${style.getPropertyPriority(prop) ? ' !important' : ''};`)
        .join('');
    }

    function canonicalSourceAsset(raw = '') {
      const value = String(raw || '').trim();
      if (!value) return '';
      try {
        const u = new URL(value, location.href);
        u.hash = '';
        u.searchParams.delete('format');
        return u.href.toLowerCase();
      } catch {
        return value.split('?')[0].toLowerCase();
      }
    }

    const styledClone = main.cloneNode(true);
    removeSelectors.forEach(sel => styledClone.querySelectorAll(sel).forEach(n => n.remove()));
    const originalsById = new Map(
      [...main.querySelectorAll('[data-killerwork-node]')].map(node => [node.getAttribute('data-killerwork-node'), node])
    );
    const bestImages = new Map();
    main.querySelectorAll('img').forEach(img => {
      const key = canonicalSourceAsset(img.currentSrc || img.getAttribute('data-image') || img.getAttribute('data-src') || img.getAttribute('src') || '');
      if (!key) return;
      const meta = mediaMetaFrom(img);
      if (meta.width < 48 && meta.height < 48) return;
      const current = bestImages.get(key);
      if (!current || meta.area > current.area) bestImages.set(key, { id: img.getAttribute('data-killerwork-node'), area: meta.area });
    });
    [styledClone, ...styledClone.querySelectorAll('*')].forEach(node => {
      const id = node.getAttribute?.('data-killerwork-node');
      const source = id ? originalsById.get(id) : main;
      if (!source) {
        node.remove?.();
        return;
      }
      const tag = node.tagName?.toLowerCase() || '';
      const meta = mediaMetaFrom(source);
      const className = String(node.getAttribute?.('class') || '');
      const textContent = clean(node.textContent || '');
      if (/tiny-thumb/i.test(className) || ((meta.width < 48 && meta.height < 48) && !textContent && !['img', 'video', 'iframe'].includes(tag))) {
        node.remove();
        return;
      }
      if (tag === 'img') {
        const resolved = source.currentSrc || source.getAttribute('data-image') || source.getAttribute('data-src') || source.getAttribute('src') || '';
        const key = canonicalSourceAsset(resolved);
        const best = bestImages.get(key);
        if ((meta.width < 48 && meta.height < 48) || (best && best.id !== id)) {
          node.remove();
          return;
        }
        node.setAttribute('src', resolved);
        node.removeAttribute('srcset');
        node.removeAttribute('sizes');
        if (meta.width) node.setAttribute('width', String(meta.width));
        if (meta.height) node.setAttribute('height', String(meta.height));
      }
      if (tag === 'source') {
        const resolved = source.currentSrc || source.getAttribute('src') || source.getAttribute('data-src') || '';
        if (resolved) node.setAttribute('src', resolved);
        node.removeAttribute('srcset');
        node.removeAttribute('sizes');
      }
      if (tag === 'video') {
        const resolved = source.currentSrc || source.getAttribute('src') || source.getAttribute('data-src') || '';
        if (resolved) node.setAttribute('src', resolved);
        node.setAttribute('controls', '');
        node.setAttribute('playsinline', '');
      }
      if (tag === 'iframe') {
        const resolved = source.getAttribute('src') || source.getAttribute('data-src') || source.getAttribute('data-embed-url') || source.getAttribute('data-video-url') || '';
        if (resolved) node.setAttribute('src', resolved);
      }
      node.setAttribute('style', serializeStyle(getComputedStyle(source)));
      [...(node.getAttributeNames?.() || [])].forEach(name => {
        if (name.startsWith('data-') && name !== 'data-killerwork-node') node.removeAttribute(name);
      });
      node.removeAttribute('data-killerwork-node');
      node.removeAttribute('loading');
      node.removeAttribute('decoding');
    });

    const links = [...document.querySelectorAll('a[href]')].map(a => ({ href: abs(a.getAttribute('href')), text: clean(a.innerText) }));
    return {
      title: pageTitle,
      copyBlocks,
      images,
      videos,
      contentItems,
      links,
      pageStyle,
      sourceCloneHtml: styledClone.innerHTML,
      sourceCloneStyle: serializeStyle(getComputedStyle(main))
    };
  }, siteOrigin);

  progress?.('Extracted page', `${data.title} — ${data.images.length} image refs, ${data.videos.length} video refs`);
  return data;
}

function looksLikeNotFoundPage(data = {}) {
  const text = (data.copyBlocks || []).map(block => block.text || '').join('\n').toLowerCase();
  return text.includes("we couldn't find the page you were looking for")
    || text.includes('the page you are looking for has been moved or deleted');
}

async function getHomepageProjects(page, url, progress) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);

  const domCandidates = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const cleanTitle = (s) => clean(String(s || '')
      .replace(/<img\b[^>]*>/ig, ' ')
      .replace(/^\d+\s+/, ' ')
      .replace(/^(view|open|see|watch)\s+(project|case study|work)\s*/i, ' ')
      .replace(/\s+/g, ' '));
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const origin = location.origin;
    const currentPath = location.pathname.replace(/\/$/, '') || '/';
    const excluded = new Set(['/', '/art', '/about', '/about-us', '/contact', '/contact-us', '/shop', '/store', '/blog', '/journal', '/news', '/press', '/resume', '/cv', '/privacy', '/terms', '/cart', '/checkout', '/search', '/login', '/account']);
    const excludedSegments = new Set(['about', 'about-us', 'art', 'contact', 'contact-us', 'shop', 'store', 'blog', 'journal', 'news', 'press', 'resume', 'cv', 'privacy', 'terms', 'cart', 'checkout', 'search', 'login', 'account', 'category', 'tag', 'author']);
    const map = new Map();
    const likelyProjectPath = (path) => {
      if (excluded.has(path)) return false;
      if (/\.(jpe?g|png|webp|gif|svg|pdf|zip|mp4|webm|mov|m3u8|css|js|json|xml|txt)$/i.test(path)) return false;
      const parts = path.split('/').filter(Boolean);
      if (!parts.length || parts.some(part => excludedSegments.has(part.toLowerCase()))) return false;
      return parts.length <= 4;
    };
    const bgImage = (el) => {
      const nodes = [el, ...el.querySelectorAll?.('*') || []].slice(0, 12);
      for (const node of nodes) {
        const style = node.getAttribute?.('style') || '';
        const m = style.match(/url\(["']?([^"')]+)["']?\)/i);
        if (m) return abs(m[1]);
      }
      return '';
    };
    const thumbFor = (el) => {
      const img = el.querySelector('img,picture source') || el.closest('article,section,div,li')?.querySelector('img,picture source');
      const raw = img?.currentSrc || img?.src || img?.getAttribute?.('data-src') || img?.getAttribute?.('data-image') || img?.getAttribute?.('data-image-src') || img?.getAttribute?.('srcset')?.split(',')[0]?.trim()?.split(/\s+/)[0] || '';
      return abs(raw) || bgImage(el.closest('article,section,div,li') || el);
    };
    const textFor = (el, slug) => {
      const scope = el.closest('article,section,li,[class*="card"],[class*="grid"],[class*="item"],[class*="project"],[class*="work"],[class*="portfolio"]') || el;
      const heading = scope.querySelector?.('h1,h2,h3,h4,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]');
      const img = el.querySelector('img') || scope.querySelector?.('img');
      return cleanTitle(heading?.textContent)
        || cleanTitle(el.innerText)
        || cleanTitle(el.textContent)
        || cleanTitle(el.getAttribute('aria-label'))
        || cleanTitle(el.getAttribute('title'))
        || cleanTitle(img?.getAttribute('alt'))
        || slug.replace(/-/g, ' ');
    };
    const descriptionFor = (el, title) => {
      const scope = el.closest('article,section,li,[class*="card"],[class*="grid"],[class*="item"],[class*="project"],[class*="work"],[class*="portfolio"]') || el;
      const descriptionNode = scope.querySelector?.('[class*="description"],[class*="Description"],[class*="summary"],[class*="Summary"],[class*="excerpt"],[class*="Excerpt"]');
      const text = clean(descriptionNode?.innerText || '');
      if (!text || text.toLowerCase() === String(title || '').toLowerCase()) return '';
      return text;
    };
    const addCandidate = (el, rawHref, forcedScore = 0) => {
      const href = abs(rawHref);
      if (!href || !href.startsWith(origin)) return;
      const u = new URL(href);
      const path = u.pathname.replace(/\/$/, '') || '/';
      if (u.hash && path === currentPath) return;
      if (!likelyProjectPath(path)) return;
      const thumbnailUrl = thumbFor(el);
      const hasThumb = !!thumbnailUrl;
      const isWorkPath = path.startsWith('/work/');
      const classText = `${el.className || ''} ${el.closest('article,section,div,li')?.className || ''}`;
      const looksLikePortfolioItem = /(project|portfolio|work|case|grid|gallery|thumb|card|item)/i.test(classText);
      if (!isWorkPath && !hasThumb && !looksLikePortfolioItem) return;
      const slug = path.replace(/^\/work\//, '').replace(/^\//, '').replace(/\/$/, '');
      if (!slug) return;
      const title = textFor(el, slug);
      const description = descriptionFor(el, title);
      const score = forcedScore + (isWorkPath ? 80 : 0) + (hasThumb ? 60 : 0) + (looksLikePortfolioItem ? 30 : 0) + (description ? 20 : 0) + (title ? 10 : 0);
      const current = map.get(slug);
      const next = { slug, title, description, url: href, thumbnailUrl, strategy: isWorkPath ? 'work-path' : hasThumb ? 'thumbnail-link' : 'portfolio-link', score };
      if (!current || next.score > current.score || (!current.description && next.description) || (!current.thumbnailUrl && next.thumbnailUrl)) map.set(slug, next);
    };
    document.querySelectorAll('a[href]').forEach(a => {
      addCandidate(a, a.getAttribute('href'));
    });
    document.querySelectorAll('[data-url]').forEach(el => {
      addCandidate(el, el.getAttribute('data-url'), 40);
    });
    return [...map.values()];
  });

  const projects = mergeProjectCandidates(domCandidates);
  progress?.('Project discovery', `${projects.length} homepage project candidate(s)`);
  return projects;
}

async function discoverSitemapProjects(url, progress) {
  const origin = new URL(url).origin;
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const visited = new Set();
  const urls = [];

  while (queue.length && visited.size < 8 && urls.length < MAX_PROJECTS * 3) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    try {
      const res = await fetch(sitemapUrl, { redirect: 'follow' });
      if (!res.ok || !/xml|text/i.test(res.headers.get('content-type') || '')) continue;
      const text = await res.text();
      const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1].trim().replace(/&amp;/g, '&'));
      for (const loc of locs) {
        let parsed;
        try { parsed = new URL(loc); } catch { continue; }
        if (parsed.origin !== origin) continue;
        if (/sitemap/i.test(parsed.pathname) && visited.size < 8) {
          queue.push(parsed.href);
          continue;
        }
        if (isLikelyProjectPath(parsed.pathname)) urls.push(parsed.href);
      }
    } catch (e) {
      progress?.('Sitemap discovery warning', `${sitemapUrl}: ${e.message}`);
    }
  }

  const candidates = urls.map(projectUrl => {
    const path = normalizeDiscoveryPath(projectUrl);
    const slug = path.replace(/^\/work\//, '').replace(/^\//, '');
    const parts = path.split('/').filter(Boolean);
    const score = (path.startsWith('/work/') ? 80 : 0) + (parts.length > 1 ? 25 : 10);
    return {
      slug,
      title: titleFromSlug(slug),
      url: projectUrl,
      thumbnailUrl: '',
      strategy: 'sitemap',
      score
    };
  });
  const projects = mergeProjectCandidates(candidates);
  progress?.('Sitemap discovery', `${projects.length} sitemap project candidate(s)`);
  return projects;
}

function singlePageProject(url, siteUrl) {
  const hostTitle = siteUrl.hostname.replace(/^www\./, '');
  return {
    slug: safeSlug(hostTitle || 'portfolio'),
    title: hostTitle || 'Portfolio',
    url,
    thumbnailUrl: '',
    strategy: 'single-page',
    force: true
  };
}

async function downloadAsset(url, assetsDir, progress, cache) {
  if (!url || isBadMediaUrl(url)) return null;
  const type = mediaType(url);
  if (type === 'hls') return { src: url, remote: true, type: 'hls' };
  if (type === 'youtube' || type === 'vimeo') return { src: url, remote: true, type: 'iframe' };
  if (cache.has(url)) return cache.get(url);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || mime.lookup(url) || 'application/octet-stream';
    if (/text\/html/i.test(contentType)) return null;
    if (!contentType.startsWith('image/') && !String(url).match(/\.(mp4|webm|mov)(\?|$)/i)) return null;
    const ext = extFromUrl(url, mime.extension(contentType) ? `.${mime.extension(contentType)}` : '.bin');
    const rawBase = path.basename(new URL(url).pathname).replace(/[^a-z0-9._-]/gi, '').slice(-80) || 'asset';
    const fileName = `${hash(url)}-${rawBase}${path.extname(rawBase) ? '' : ext}`;
    const dest = path.join(assetsDir, fileName);
    await fs.writeFile(dest, buf);
    const out = { src: `assets/imported/${fileName}`, localFile: fileName, type: contentType.startsWith('image/') ? 'image' : mediaType(url), bytes: buf.length };
    cache.set(url, out);
    return out;
  } catch (e) {
    progress?.('Asset skipped', `${url} — ${e.message}`);
    return null;
  }
}

function relFromPage(projectSlug, assetSrc) {
  if (!assetSrc) return '';
  if (/^https?:\/\//.test(assetSrc)) return assetSrc;
  if (assetSrc.startsWith('/')) assetSrc = assetSrc.slice(1);
  return projectSlug ? `../../${assetSrc}` : assetSrc;
}

function normalizedMetaLines(blocks = [], projectTitle = '') {
  const titleCore = cleanTitle(projectTitle);
  const out = [];
  const seen = new Set();
  const agencies = [
    'Ogilvy Sri Lanka',
    'Ogilvy Bahrain',
    'Ogilvy - Bahrain',
    'Y&R Sri Lanka',
    'Grey Doha',
    'Grey Global Creative Council'
  ];
  const clients = [
    'Headfast',
    'stc Bahrain',
    'Sri Lanka Cancer Society',
    'One Galle Face Residences',
    'Shangri-La',
    'Panadol Extra',
    'Goodyear',
    'Nestle',
    'Sri Lanka Tourism'
  ];
  const campaigns = [
    'Rub It Away',
    'Make the jump',
    'Testicular Cancer Awareness',
    'Some things are meant to be in pairs',
    'Silence The Road',
    'Remember who came 2nd?',
    '150th Anniversary',
    'Life is tough here'
  ];
  const push = (line) => {
    let t = String(line || '').replace(/\s+/g, ' ').trim();
    if (!t) return;
    if (/^(brand|campaign|agency|award|publication|date|client)$/i.test(t)) return;
    if (/^optional\b/i.test(t)) return;
    if (/^(work|about|review|original page|hls video stream preserved from source)$/i.test(t)) return;
    if (/^(previous|next)$/i.test(t)) return;
    if (/\|\s*work$/i.test(t)) return;
    if (titleCore && t.toLowerCase() === titleCore.toLowerCase()) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  const protectKnownPhrases = (text, phrases, options = {}) => {
    let out = text;
    for (const phrase of phrases) {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const flags = options.caseInsensitive ? 'gi' : 'g';
      out = out.replace(new RegExp(`\\s*(${escaped})\\s*`, flags), '\n$1\n');
    }
    return out;
  };
  for (const b of blocks) {
    let text = String(b.text || '')
      .replace(/\r/g, '\n')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/(APAC)(Grey)/g, '$1 $2')
      .replace(/[”"]?\s*(Winner at Cannes)[”"]?\s*-\s*/gi, '\n”$1” @@DASH@@ ')
      .replace(/\s*\+\s*/g, '\n')
      .replace(/\b(Top\s+\d+\s+in\s+APAC)\b/gi, '\n$1')
      .replace(/\b(Headache Blocker)\b/g, '\n$1')
      .replace(/\n{2,}/g, '\n');
    text = protectKnownPhrases(text, campaigns);
    text = text.replace(/\s+-\s+/g, '\n').replace(/@@DASH@@/g, '-');
    text = protectKnownPhrases(text, clients);
    text = protectKnownPhrases(text, agencies);
    text = text.replace(/\n{2,}/g, '\n');
    text.split('\n').map(x => x.trim()).filter(Boolean).forEach(push);
  }
  return out.slice(0, 20);
}

function renderMetaBlocks(project) {
  const lines = project.cleaned?.metadata?.length
    ? normalizedMetaLines(project.cleaned.metadata.map(text => ({ text })), project.title)
    : normalizedMetaLines(project.copyBlocks, project.title);
  if (!lines.length) return '';
  return `<section class="project-meta" aria-label="Project details">${lines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</section>`;
}

function renderVideo(v, projectSlug, posterAsset = null) {
  const src = relFromPage(projectSlug, v.src);
  const poster = posterAsset?.src ? relFromPage(projectSlug, posterAsset.src) : '';
  const posterAttr = poster ? ` poster="${htmlEscape(poster)}"` : '';
  const style = v?.width ? ` style="max-width:${Math.round(v.width)}px"` : '';
  if (!src || src.startsWith('blob:') || src.includes('mpegts-') || src.endsWith('.bin') || src.endsWith('.ts')) return '';
  if (v.kind === 'iframe' || v.type === 'iframe' || mediaType(src) === 'youtube' || mediaType(src) === 'vimeo') {
    return `<figure class="media video"${style}><iframe src="${htmlEscape(src)}" title="Video" loading="lazy" allowfullscreen></iframe></figure>`;
  }
  if (v.type === 'hls' || mediaType(src) === 'hls') {
    return `<figure class="media video"${style}><video class="hls-video" controls playsinline${posterAttr} data-hls-src="${htmlEscape(src)}"></video></figure>`;
  }
  return `<figure class="media video"${style}><video controls playsinline${posterAttr} src="${htmlEscape(src)}"></video></figure>`;
}

function canonicalVideoKey(src = '', kind = '') {
  let key = String(src || '').replace(/&amp;/g, '&').trim();
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(key);
      if (decoded === key) break;
      key = decoded;
    } catch {
      break;
    }
  }
  return `${kind}:${key.toLowerCase()}`;
}

function renderDocument(doc, projectSlug) {
  if (!doc?.src) return '';
  const src = relFromPage(projectSlug, doc.src);
  const title = doc.title || doc.original || 'PDF';
  const style = doc?.width ? ` style="max-width:${Math.round(doc.width)}px"` : '';
  return `<figure class="media document"${style}><iframe src="${htmlEscape(src)}" title="${htmlEscape(title)}" loading="lazy"></iframe><figcaption><a href="${htmlEscape(src)}" target="_blank" rel="noopener">Open PDF</a></figcaption></figure>`;
}

function renderAudio(audio, projectSlug) {
  if (!audio?.src) return '';
  const src = relFromPage(projectSlug, audio.src);
  const title = audio.title || audio.original || 'Audio';
  return `<figure class="media audio"><figcaption>${htmlEscape(title)}</figcaption><audio controls preload="metadata" src="${htmlEscape(src)}"></audio></figure>`;
}

function renderImage(img, projectSlug, title) {
  if (!img?.src) return '';
  const size = img?.width ? ` style="max-width:${Math.round(img.width)}px"` : '';
  const widthAttr = img?.width ? ` width="${Math.round(img.width)}"` : '';
  const heightAttr = img?.height ? ` height="${Math.round(img.height)}"` : '';
  return `<figure class="media image"${size}><img src="${htmlEscape(relFromPage(projectSlug, img.src))}" alt="${htmlEscape(img.alt || title)}" loading="eager"${widthAttr}${heightAttr}></figure>`;
}

function renderGallery(imageIndexes = [], project) {
  const slides = imageIndexes
    .map(index => project.images?.[index])
    .filter(Boolean)
    .map(img => `<figure class="gallery-slide"><img src="${htmlEscape(relFromPage(project.slug, img.src))}" alt="${htmlEscape(img.alt || project.title)}" loading="eager"></figure>`)
    .join('\n');
  if (!slides) return '';
  return `<section class="media gallery" data-gallery>
    <button class="gallery-nav gallery-prev" type="button" aria-label="Previous image">‹</button>
    <div class="gallery-track">${slides}</div>
    <button class="gallery-nav gallery-next" type="button" aria-label="Next image">›</button>
  </section>`;
}

function renderInlineText(text = '', projectTitle = '') {
  const lines = normalizedMetaLines([{ text }], projectTitle);
  if (!lines.length) return '';
  return `<div class="media-caption">${lines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</div>`;
}

function renderSectionMedia(ref, project, poster) {
  if (!ref) return '';
  if (ref.kind === 'video') return renderVideo(project.videos?.[ref.index], project.slug, poster);
  return renderImage(project.images?.[ref.index], project.slug, project.title);
}

function renderCleanedSections(project) {
  const cleaned = project.cleaned;
  if (!cleaned?.sections?.length) return '';
  const used = { image: new Set(), video: new Set() };
  const hasVideo = (project.videos || []).length > 0;
  const poster = hasVideo && project.images?.[0] ? project.images[0] : null;
  const html = cleaned.sections.map(section => {
    const media = (section.media || []).map(ref => {
      used[ref.kind]?.add(ref.index);
      return renderSectionMedia(ref, project, ref.kind === 'video' ? poster : null);
    }).join('\n');
    const body = (section.body || []).map(p => `<p>${htmlEscape(p)}</p>`).join('');
    return `<section class="content-section ${htmlEscape(section.layout || 'caseStudy')}">
      ${section.eyebrow ? `<div class="section-eyebrow">${htmlEscape(section.eyebrow)}</div>` : ''}
      ${section.heading ? `<h2>${htmlEscape(section.heading)}</h2>` : ''}
      ${section.subheading ? `<p class="section-subheading">${htmlEscape(section.subheading)}</p>` : ''}
      ${body ? `<div class="section-body">${body}</div>` : ''}
      <div class="section-media">${media}</div>
    </section>`;
  }).join('\n');
  return { html, used, poster };
}

function renderFallbackMedia(project) {
  const images = project.images || [];
  const videos = project.videos || [];
  const audios = project.audios || [];
  const documents = project.documents || [];
  const hasVideo = videos.length > 0;
  const poster = hasVideo && images[0] ? images[0] : null;
  const pageImages = hasVideo && poster ? images.slice(1) : images;
  const vids = videos.map((v, idx) => renderVideo(v, project.slug, idx === 0 ? poster : null)).join('\n');
  const imgs = pageImages.map(img => renderImage(img, project.slug, project.title)).join('\n');
  const audioHtml = audios.map(audio => renderAudio(audio, project.slug)).join('\n');
  const docs = documents.map(doc => renderDocument(doc, project.slug)).join('\n');
  return `<section class="media-stack">${vids}${imgs}${audioHtml}${docs}</section>`;
}

function renderOrderedContent(project) {
  const seen = new Set();
  const items = (project.contentItems || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .filter(item => {
      if (item.type === 'image') {
        const img = project.images?.[item.imageIndex];
        if ((project.videos || []).length && /video\.squarespace-cdn\.com\/.+\/thumbnail(?:\?|$)/i.test(img?.original || item.original || '')) return false;
      }
      const key = item.type === 'gallery'
        ? `gallery:${item.order}:${(item.imageIndexes || []).join(',')}`
        : item.type === 'image'
          ? `image:${item.imageIndex}`
          : item.type === 'video'
            ? `video:${item.videoIndex}`
            : item.type === 'document'
              ? `document:${item.documentIndex}`
              : item.type === 'audio'
                ? `audio:${item.audioIndex}`
              : `text:${item.order}:${String(item.text || '').toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!items.length) return renderFallbackMedia(project);
  const firstImage = (project.images || [])[0];
  const poster = (project.videos || []).length > 0 && firstImage ? firstImage : null;
  const html = items.map(item => {
    if (item.type === 'text') return renderInlineText(item.text, project.title);
    if (item.type === 'image') return renderImage(project.images?.[item.imageIndex], project.slug, project.title);
    if (item.type === 'video') return renderVideo(project.videos?.[item.videoIndex], project.slug, item.videoIndex === 0 ? poster : null);
    if (item.type === 'audio') return renderAudio(project.audios?.[item.audioIndex], project.slug);
    if (item.type === 'document') return renderDocument(project.documents?.[item.documentIndex], project.slug);
    if (item.type === 'gallery') return renderGallery(item.imageIndexes, project);
    return '';
  }).filter(Boolean).join('\n');
  return html ? `<section class="media-stack source-order">${html}</section>` : renderFallbackMedia(project);
}

function renderSourceClone(project) {
  if (!project.sourceCloneHtml) return '';
  const wrapperStyle = project.sourceCloneStyle ? ` style="${htmlEscape(project.sourceCloneStyle)}"` : '';
  return `<section class="source-clone"${wrapperStyle}>${project.sourceCloneHtml}</section>`;
}

function shouldUseOrderedContent(project) {
  const html = String(project.sourceCloneHtml || '');
  return /gallery-slideshow|sqs-gallery|sqs-active-slide|sqs-gallery-design/i.test(html);
}

function renderSourceDescription(project) {
  if (!project.description) return '';
  return `<section class="source-description">${String(project.description)
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${htmlEscape(line)}</p>`)
    .join('')}</section>`;
}

function renderProjectFooterGrid(manifest, currentProject) {
  if (manifest.sourceUrl === 'uploaded-files' || manifest.sourceUrl === 'campaign-builder') return '';
  const linkedProjectSlugs = new Set((manifest.projects || []).map(p => p.slug));
  const projects = linkedProjectSlugs.size > 1 ? manifest.projects : (manifest.relatedProjects || manifest.projects || []);
  const cards = projects.map(p => {
    const localThumb = p.thumbnail?.src ? relFromPage(currentProject.slug, p.thumbnail.src) : (p.images?.[0]?.src ? relFromPage(currentProject.slug, p.images[0].src) : '');
    const thumb = localThumb || p.thumbnailUrl || '';
    const href = p.slug === currentProject.slug ? '#' : linkedProjectSlugs.has(p.slug) ? `../${htmlEscape(p.slug)}/` : htmlEscape(p.url || '#');
    const media = thumb
      ? `<img src="${htmlEscape(thumb)}" alt="${htmlEscape(p.title)}" loading="eager">`
      : `<div class="work-card-placeholder">${(p.videos || []).length ? 'Video' : (p.documents || []).length ? 'PDF' : 'Work'}</div>`;
    return `<a class="work-card" href="${href}">${media}<span>${htmlEscape(p.title)}</span></a>`;
  }).join('\n');
  if (!cards) return '';
  return `<section class="project-footer-grid"><a class="back-link" href="../../index.html">Back to Work</a><div class="work-grid">${cards}</div></section>`;
}

function rewriteCloneAssetUrls(html, replacements = []) {
  let out = String(html || '');
  for (const { from, to } of replacements) {
    if (!from || !to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), to);
  }
  return out;
}

export async function generateSite(manifest, outDir, progress) {
  const siteDir = path.join(outDir, 'site');
  const stagingAssetsDir = path.join(outDir, 'assets-imported');
  await fs.remove(siteDir);
  await fs.ensureDir(path.join(siteDir, 'assets', 'imported'));
  // IMPORTANT: Assets are downloaded to a staging folder outside /site.
  // Older builds downloaded into /site/assets and then deleted /site during generation,
  // which produced HTML that referenced files that no longer existed.
  if (await fs.pathExists(stagingAssetsDir)) {
    await fs.copy(stagingAssetsDir, path.join(siteDir, 'assets', 'imported'), { overwrite: true });
  }
  await fs.writeFile(path.join(siteDir, 'favicon.ico'), '');
  const styles = await fs.readFile(path.join(__dirname, '..', 'public', 'portfolio.css'), 'utf8');
  await fs.writeFile(path.join(siteDir, 'styles.css'), styles);
  await fs.writeFile(path.join(siteDir, 'hls-player.js'), await fs.readFile(path.join(__dirname, '..', 'public', 'hls-player.js'), 'utf8'));
  await fs.writeFile(path.join(siteDir, 'portfolio.js'), await fs.readFile(path.join(__dirname, '..', 'public', 'portfolio.js'), 'utf8'));

  const cards = manifest.projects.map(p => {
    const thumb = p.thumbnail?.src ? relFromPage('', p.thumbnail.src) : (p.images?.[0]?.src ? relFromPage('', p.images[0].src) : '');
    const media = thumb
      ? `<img src="${htmlEscape(thumb)}" alt="${htmlEscape(p.title)}" loading="lazy">`
      : `<div class="work-card-placeholder">${(p.videos || []).length ? 'Video' : (p.documents || []).length ? 'PDF' : 'Work'}</div>`;
    return `<a class="work-card" href="work/${htmlEscape(p.slug)}/">${media}<span>${htmlEscape(p.title)}</span></a>`;
  }).join('\n');

  await fs.writeFile(path.join(siteDir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(manifest.siteTitle)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body><header class="site-header"><a class="brand" href="index.html">${htmlEscape(manifest.ownerName)}</a><nav><a href="index.html">Work</a><a href="about.html">About</a><a href="import-review.html">Review</a></nav></header><main class="home"><h1>${htmlEscape(manifest.ownerName)}</h1><section class="work-grid">${cards}</section></main></body></html>`);

  await fs.writeFile(path.join(siteDir, 'about.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About — ${htmlEscape(manifest.ownerName)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body><header class="site-header"><a class="brand" href="index.html">${htmlEscape(manifest.ownerName)}</a><nav><a href="index.html">Work</a><a href="about.html">About</a></nav></header><main class="project-page"><h1>About</h1></main></body></html>`);

  for (const p of manifest.projects) {
    const dir = path.join(siteDir, 'work', p.slug);
    await fs.ensureDir(dir);
    p.images = p.images || [];
    p.videos = p.videos || [];
    p.audios = p.audios || [];
    p.documents = p.documents || [];
    const cloneHtml = shouldUseOrderedContent(p) ? '' : renderSourceClone(p);
    const descriptionHtml = renderSourceDescription(p);
    const mediaHtml = `${descriptionHtml}${cloneHtml || renderOrderedContent(p)}`;
    const footerGrid = renderProjectFooterGrid(manifest, p);
    const meta = renderMetaBlocks(p);
    const hasInlineText = cloneHtml || (p.contentItems || []).some(item => item.type === 'text');
    const showMeta = !hasInlineText ? meta : '';
    const intro = '';
    const needsHls = !cloneHtml && p.videos.some(v => v.type === 'hls' || mediaType(v.src) === 'hls');
    const needsGallery = (p.contentItems || []).some(item => item.type === 'gallery');
    const sourceNote = p.url && p.url !== '#uploaded' ? `<footer class="source-note"><a href="${htmlEscape(p.url)}">Original page</a></footer>` : '';
    const pageVars = [
      p.pageStyle?.backgroundColor ? `--bg:${p.pageStyle.backgroundColor}` : '',
      p.pageStyle?.textColor ? `--fg:${p.pageStyle.textColor}` : '',
      p.pageStyle?.textColor ? `--muted:${p.pageStyle.textColor}` : ''
    ].filter(Boolean).join(';');
    const mainStyle = p.pageStyle?.contentWidth ? ` style="max-width:${Math.max(760, Math.round(p.pageStyle.contentWidth))}px"` : '';
    const headerHtml = cloneHtml
      ? ''
      : `<header class="project-header"><a class="back-link" href="../../index.html">← Work</a></header>`;
    await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(p.title)} — ${htmlEscape(manifest.ownerName)}</title><link rel="icon" href="../../favicon.ico"><link rel="stylesheet" href="../../styles.css"></head><body class="project"${pageVars ? ` style="${htmlEscape(pageVars)}"` : ''}><header class="site-header"><a class="brand" href="../../index.html">${htmlEscape(manifest.ownerName)}</a><nav><a href="../../index.html">Work</a><a href="../../about.html">About</a></nav></header><main class="project-page"${mainStyle}>${headerHtml}${mediaHtml}${showMeta}${footerGrid}${sourceNote}</main>${needsHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script><script src="../../hls-player.js"></script>' : ''}${needsGallery ? '<script src="../../portfolio.js"></script>' : ''}</body></html>`);
  }

  const rows = manifest.projects.map(p => `<tr><td><a href="work/${htmlEscape(p.slug)}/">${htmlEscape(p.title)}</a></td><td>${(p.images || []).length}</td><td>${(p.videos || []).length}</td><td>${(p.audios || []).length}</td><td>${(p.documents || []).length}</td><td>${p.cleaned ? htmlEscape(p.cleaned.pageType) : 'raw'}</td><td>${(p.warnings || []).map(htmlEscape).join('<br>')}</td></tr>`).join('');
  const sourceHtml = manifest.sourceUrl === 'uploaded-files' || manifest.sourceUrl === 'campaign-builder' ? 'Source: uploaded files' : `Source: <a href="${htmlEscape(manifest.sourceUrl)}">${htmlEscape(manifest.sourceUrl)}</a>`;
  await fs.writeFile(path.join(siteDir, 'import-review.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Import Review</title><link rel="stylesheet" href="styles.css"></head><body><header class="site-header"><a class="brand" href="index.html">${htmlEscape(manifest.ownerName)}</a><nav><a href="index.html">Work</a></nav></header><main class="project-page"><h1>Import Review</h1><p>${sourceHtml}</p><p>AI cleanup: ${manifest.aiCleanup ? 'On' : 'Off'}</p><table><thead><tr><th>Project</th><th>Images</th><th>Videos</th><th>Audio</th><th>PDFs</th><th>Type</th><th>Warnings</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`);

  progress?.('Generated static site', siteDir);
  return siteDir;
}

export async function validateSite(siteDir) {
  const errors = [];
  const htmlFiles = await globHtml(siteDir);
  for (const file of htmlFiles) {
    const html = await fs.readFile(file, 'utf8');
    if (html.includes('file://')) errors.push({ file: path.relative(siteDir, file), error: 'file:// reference found' });
    if (html.includes('blob:')) errors.push({ file: path.relative(siteDir, file), error: 'blob: reference found' });
    const refs = [...html.matchAll(/(?:src|href|poster)="([^"]+)"/g)].map(m => m[1]).filter(r => r && !r.startsWith('http') && !r.startsWith('#') && !r.startsWith('mailto:'));
    for (const ref of refs) {
      if (ref.startsWith('data:')) continue;
      const clean = ref.split('#')[0].split('?')[0];
      if (!clean || clean.endsWith('/')) continue;
      const target = path.resolve(path.dirname(file), clean);
      if (!(await fs.pathExists(target))) errors.push({ file: path.relative(siteDir,file), ref, error: 'Missing local asset/link' });
      if (/^[a-z0-9_-]+\.(webp|png|jpe?g|gif)$/i.test(ref)) errors.push({ file: path.relative(siteDir,file), ref, error: 'Bare image filename should not be used' });
    }
  }
  await fs.ensureDir(path.join(path.dirname(siteDir), 'reports'));
  await fs.writeJson(path.join(path.dirname(siteDir), 'reports', 'validation.json'), { ok: errors.length === 0, errors }, { spaces: 2 });
  return { ok: errors.length === 0, errors };
}

async function globHtml(dir) {
  const out = [];
  async function walk(d) {
    for (const item of await fs.readdir(d)) {
      const p = path.join(d, item);
      const st = await fs.stat(p);
      if (st.isDirectory()) await walk(p);
      else if (p.endsWith('.html')) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

export async function zipDir(sourceDir, outFile) {
  await fs.ensureDir(path.dirname(outFile));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function enrichContentItems(items, imageIndexByKey, videoIndexBySrc) {
  const enriched = (items || []).map(item => {
    if (item.type === 'image') {
      const key = canonicalImageKey(item.url);
      return {
        type: 'image',
        order: item.order,
        alt: item.alt || '',
        imageIndex: imageIndexByKey.get(key),
        original: item.url,
        width: Number(item.width || 0),
        height: Number(item.height || 0)
      };
    }
    if (item.type === 'video') {
      return {
        type: 'video',
        order: item.order,
        title: item.title || '',
        videoIndex: videoIndexBySrc.get(item.src),
        original: item.src,
        width: Number(item.width || 0),
        height: Number(item.height || 0)
      };
    }
    if (item.type === 'gallery') {
      const imageIndexes = (item.images || [])
        .map(img => imageIndexByKey.get(canonicalImageKey(img.url)))
        .filter(Number.isInteger);
      return { type: 'gallery', order: item.order, imageIndexes, originals: (item.images || []).map(img => img.url) };
    }
    return { type: 'text', order: item.order, tag: item.tag, text: item.text };
  }).filter(item => item.type === 'text' || Number.isInteger(item.imageIndex) || Number.isInteger(item.videoIndex) || (item.type === 'gallery' && item.imageIndexes.length));

  const out = [];
  const seen = new Set();
  const hasVideo = videoIndexBySrc.size > 0;
  const galleryIndexes = new Set(enriched.filter(item => item.type === 'gallery').flatMap(item => item.imageIndexes || []));
  const seenImageIndexes = new Set();
  const seenVideoIndexes = new Set();
  for (const item of enriched) {
    if (item.type === 'image' && hasVideo && /video\.squarespace-cdn\.com\/.+\/thumbnail(?:\?|$)/i.test(item.original || '')) {
      continue;
    }
    if (item.type === 'image' && galleryIndexes.has(item.imageIndex)) continue;
    if (item.type === 'image') {
      if (seenImageIndexes.has(item.imageIndex)) continue;
      seenImageIndexes.add(item.imageIndex);
    }
    if (item.type === 'video') {
      if (seenVideoIndexes.has(item.videoIndex)) continue;
      seenVideoIndexes.add(item.videoIndex);
    }
    const key = item.type === 'gallery'
      ? `gallery:${item.order}:${item.imageIndexes.join(',')}`
      : item.type === 'image'
        ? `image:${item.imageIndex}`
        : item.type === 'video'
          ? `video:${item.videoIndex}`
          : `text:${item.order}:${String(item.text || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function runImport({ url, outDir, onProgress, aiCleanup = undefined }) {
  const progress = (stage, detail = '') => onProgress?.({ stage, detail, at: new Date().toISOString() });
  await fs.ensureDir(outDir);
  // Download assets to a staging folder outside /site so generateSite() can safely
  // rebuild /site without deleting downloaded files.
  const assetsDir = path.join(outDir, 'assets-imported');
  await fs.ensureDir(assetsDir);

  progress('Starting import', url);
  const browser = await launchBrowser(progress);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, userAgent: 'Mozilla/5.0 KillerWorkImporter/0.8' });
  const page = await context.newPage();
  const siteUrl = new URL(url);
  const inputPath = normalizeDiscoveryPath(url);

  let projects = [];
  let relatedProjects = [];
  if (inputPath !== '/' && isLikelyProjectPath(inputPath)) {
    progress('Submitted project URL', url);
    projects = [submittedProjectCandidate(url)];
    relatedProjects = await getHomepageProjects(page, siteUrl.origin, progress).catch(() => []);
    const submittedPath = normalizeDiscoveryPath(url);
    const homepageMatch = relatedProjects.find(project => normalizeDiscoveryPath(project.url) === submittedPath);
    if (homepageMatch) projects = [{ ...projects[0], ...homepageMatch, strategy: projects[0].strategy, score: 1000 }];
  } else {
    progress('Scanning homepage', url);
    projects = await getHomepageProjects(page, url, progress);
    if (!projects.length) {
      progress('Scanning sitemap', siteUrl.origin);
      projects = await discoverSitemapProjects(url, progress);
    }
    if (!projects.length) {
      progress('Project discovery fallback', 'No project index detected; importing the submitted page as a portfolio page');
      projects = [singlePageProject(url, siteUrl)];
    }
  }
  projects = mergeProjectCandidates(projects);
  progress('Found projects', `${projects.length} project pages`);

  const cache = new Map();
  const rawManifest = { sourceUrl: url, siteTitle: 'Imported Portfolio', ownerName: siteUrl.hostname.replace(/^www\./, ''), relatedProjects, projects: [], generatedAt: new Date().toISOString() };

  for (let i = 0; i < projects.length; i++) {
    const base = { ...projects[i] };
    const pProgress = `${i + 1}/${projects.length}`;
    progress(`Crawling project ${pProgress}`, base.title);
    let data = await extractPage(page, base.url, siteUrl.origin, progress);
    if (base.strategy === 'submitted-project' && looksLikeNotFoundPage(data) && normalizeDiscoveryPath(base.url).startsWith('/work/')) {
      const fallbackSlug = normalizeDiscoveryPath(base.url).replace(/^\/work\//, '').replace(/\/$/, '');
      const fallbackUrl = `${siteUrl.origin}/${fallbackSlug}/`;
      progress(`Retrying project ${pProgress}`, fallbackUrl);
      const retried = await extractPage(page, fallbackUrl, siteUrl.origin, progress);
      if (!looksLikeNotFoundPage(retried) && (retried.images?.length || retried.videos?.length)) {
        base.url = fallbackUrl;
        base.slug = safeSlug(fallbackSlug || base.slug);
        data = retried;
      }
    }
    const slug = base.slug || safeSlug(data.title);
    const warnings = [];

    const imageMap = new Map();
    for (const img of data.images) {
      const u = normalizeUrl(img.url, base.url);
      if (!u || isBadMediaUrl(u)) continue;
      const key = canonicalImageKey(u);
      const next = {
        url: u,
        alt: img.alt || data.title,
        order: img.order || 0,
        key,
        width: Number(img.width || 0),
        height: Number(img.height || 0),
        area: Number(img.area || 0),
        visible: img.visible !== false
      };
      imageMap.set(key, pickBestAssetRef(imageMap.get(key), next));
    }
    let imageRefs = [...imageMap.values()].sort((a,b) => a.order - b.order).slice(0, 100);
    if (imageMap.size > 100) warnings.push(`Image list capped at 100 from ${imageMap.size} unique refs`);

    progress(`Downloading assets ${pProgress}`, `${imageRefs.length} unique image refs`);
    const downloadedImages = [];
    const imageIndexByKey = new Map();
    for (const img of imageRefs) {
      const dl = await downloadAsset(img.url, assetsDir, progress, cache);
      if (dl?.src && dl.type === 'image') {
        imageIndexByKey.set(img.key, downloadedImages.length);
        downloadedImages.push({
          src: dl.src,
          localFile: dl.localFile,
          alt: img.alt,
          original: img.url,
          order: img.order,
          width: img.width,
          height: img.height
        });
      }
    }

    let thumbnail = null;
    if (base.thumbnailUrl) {
      const dl = await downloadAsset(normalizeUrl(base.thumbnailUrl, base.url), assetsDir, progress, cache);
      if (dl?.src) thumbnail = { src: dl.src, original: base.thumbnailUrl };
    }
    if (!thumbnail && downloadedImages[0]) thumbnail = { src: downloadedImages[0].src, original: downloadedImages[0].original };

    const videos = [];
    const videoMap = new Map();
    const videoIndexBySrc = new Map();
    for (const v of data.videos) {
      const src = normalizeUrl(v.src, base.url);
      if (!src || isBadMediaUrl(src)) { if (String(v.src).startsWith('blob:')) warnings.push('Blob video ignored'); continue; }
      const type = mediaType(src);
      if (!['youtube','vimeo','hls','video'].includes(type) && v.kind !== 'iframe') continue;
      const key = canonicalVideoKey(src, v.kind);
      videoMap.set(key, pickBestAssetRef(videoMap.get(key), {
        ...v,
        src,
        type,
        width: Number(v.width || 0),
        height: Number(v.height || 0),
        area: Number(v.area || 0),
        visible: v.visible !== false
      }));
    }
    for (const v of [...videoMap.values()].sort((a, b) => (a.order || 0) - (b.order || 0))) {
      const src = v.src;
      const type = v.type;
      if (type === 'video') {
        const dl = await downloadAsset(src, assetsDir, progress, cache);
        if (dl?.src) {
          videoIndexBySrc.set(src, videos.length);
          videos.push({ kind: 'video', type: 'video', src: dl.src, original: src, order: v.order || 0, width: v.width, height: v.height });
        }
      } else if (type === 'hls') {
        videoIndexBySrc.set(src, videos.length);
        videos.push({ kind: 'video', type: 'hls', src, original: src, order: v.order || 0, width: v.width, height: v.height });
        warnings.push('HLS video stream preserved with player');
      } else {
        videoIndexBySrc.set(src, videos.length);
        videos.push({ kind: 'iframe', type: 'iframe', src, original: src, order: v.order || 0, width: v.width, height: v.height });
      }
    }

    const cloneReplacements = [
      ...downloadedImages.map(img => ({ from: img.original, to: relFromPage(slug, img.src) })),
      ...videos.filter(v => v.type === 'video' && v.original && v.src).map(v => ({ from: v.original, to: relFromPage(slug, v.src) }))
    ];
    const sourceCloneHtml = rewriteCloneAssetUrls(data.sourceCloneHtml || '', cloneReplacements);

    rawManifest.projects.push({
      title: cleanTitle(base.title || data.title),
      slug,
      url: base.url,
      description: base.description || '',
      pageStyle: data.pageStyle || {},
      sourceCloneHtml,
      sourceCloneStyle: data.sourceCloneStyle || '',
      thumbnail,
      copyBlocks: data.copyBlocks,
      contentItems: enrichContentItems(data.contentItems, imageIndexByKey, videoIndexBySrc),
      images: downloadedImages,
      videos,
      warnings
    });
  }
  await browser.close();

  await fs.writeJson(path.join(outDir, 'manifest.raw.json'), rawManifest, { spaces: 2 });
  progress('Raw manifest saved', 'manifest.raw.json');

  const finalManifest = await cleanupManifestWithAI(rawManifest, { enabled: aiCleanup, progress });
  await fs.writeJson(path.join(outDir, 'manifest.cleaned.json'), finalManifest, { spaces: 2 });
  await fs.writeJson(path.join(outDir, 'manifest.json'), finalManifest, { spaces: 2 });

  progress('Building static portfolio', 'Generating HTML/CSS');
  const siteDir = await generateSite(finalManifest, outDir, progress);
  progress('Validating output', 'Checking broken local links/assets');
  const validation = await validateSite(siteDir);
  progress(validation.ok ? 'Validation passed' : 'Validation warnings', `${validation.errors.length} issue(s)`);
  const zipPath = path.join(outDir, 'site.zip');
  await zipDir(siteDir, zipPath);
  progress('ZIP ready', zipPath);
  return { manifest: finalManifest, siteDir, zipPath, validation };
}

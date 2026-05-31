import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import archiver from 'archiver';
import mime from 'mime-types';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
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

function isBehanceUrl(value = '') {
  try {
    const host = new URL(value).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'behance.net';
  } catch {
    return false;
  }
}

function isBehanceGalleryPath(pathname = '/') {
  return /^\/gallery\/\d+(?:\/|$)/i.test(String(pathname || ''));
}

function isBehanceProfilePath(pathname = '/') {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (path === '/' || isBehanceGalleryPath(path)) return false;
  if (/^\/(?:search|joblist|galleries|gallery|prosite|onboarding|settings|messages|notifications)(?:\/|$)/i.test(path)) return false;
  const parts = path.split('/').filter(Boolean);
  return parts.length === 1 || (parts.length === 2 && parts[1].toLowerCase() === 'projects');
}

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

function styleTag(css = '') {
  const safeCss = String(css || '').replace(/<\/style/gi, '<\\/style');
  return safeCss ? `<style>${safeCss}</style>` : '';
}

function absolutizeCssUrls(css = '', cssUrl = '') {
  return String(css || '').replace(/url\((['"]?)(?!data:|https?:|\/\/|#)([^'")]+)\1\)/gi, (match, quote, raw) => {
    try {
      return `url("${new URL(raw.trim(), cssUrl).href}")`;
    } catch {
      return match;
    }
  });
}

async function localizeCssImports(css = '', pageDepth = 0, assetsDir = '', progress, cache = new Map()) {
  const input = String(css || '');
  const importPattern = /@import\s+url\((['"]?)(https?:\/\/[^'")]+)\1\)\s*;/gi;
  const imports = [...input.matchAll(importPattern)];
  if (!imports.length || !assetsDir) return input;
  let out = input;
  await fs.ensureDir(assetsDir);
  for (const match of imports) {
    const url = match[2];
    try {
      let fileName = cache.get(url);
      if (!fileName) {
        const res = await fetch(url, { redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || '';
        if (!/css|text\/plain/i.test(contentType)) throw new Error(`Unexpected ${contentType || 'content type'}`);
        const body = absolutizeCssUrls(await res.text(), url).replace(/<\/style/gi, '<\\/style');
        fileName = `${hash(url)}-${path.basename(new URL(url).pathname).replace(/[^a-z0-9._-]/gi, '').slice(-70) || 'source'}.css`;
        await fs.writeFile(path.join(assetsDir, fileName), body);
        cache.set(url, fileName);
      }
      const local = `${'../'.repeat(pageDepth)}assets/imported/${fileName}`;
      out = out.replace(match[0], `@import url("${local}");`);
    } catch (e) {
      progress?.('CSS import kept remote', `${url} — ${e.message}`);
    }
  }
  return out;
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

const SOURCE_AUTH_SELECTORS = [
  '.user-accounts-link',
  '.customerAccountLoginDesktop',
  '.customerAccountLoginMobile',
  '[data-controller="UserAccountLink"]',
  '[class*="user-accounts"]',
  '[class*="UserAccount"]',
  '.sqs-custom-cart',
  '.absolute-cart-box',
  '[data-test="cart"]',
  '[class*="Cart"]',
  'a[href*="/account"]',
  'a[href*="/login"]',
  'a[href*="/cart"]'
];

async function gotoWithRetry(page, url, options = {}, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await page.goto(url, options);
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await page.waitForTimeout(1200 * (i + 1)).catch(() => {});
    }
  }
  throw lastError;
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
  await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(900);

  const data = await page.evaluate(async ({ siteOrigin, sourceAuthSelectors }) => {
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
    const sourceRoot = document.querySelector('#siteWrapper') || document.querySelector('#page') || document.body;
    const main = document.querySelector('#canvas') || document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.Main') || sourceRoot;
    sourceRoot.querySelectorAll('*').forEach((node, index) => node.setAttribute('data-killerwork-node', String(index + 1)));
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

    function sourceFontCss() {
      const chunks = [];
      document.querySelectorAll('link[rel~="stylesheet"][href]').forEach(link => {
        const href = link.href || '';
        if (href) chunks.push(`@import url("${href.replace(/"/g, '\\"')}");`);
      });
      document.querySelectorAll('style').forEach(style => {
        const text = style.textContent || '';
        if (text.length <= 180000) chunks.push(text);
      });
      return [...new Set(chunks)].join('\n');
    }

    async function sourceSvgDefs() {
      const urls = [...new Set([...document.querySelectorAll('use')].map(use => {
        const href = use.href?.baseVal || use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!/\.svg#/i.test(href)) return '';
        return abs(href.split('#')[0]);
      }).filter(Boolean))];
      const defs = [];
      for (const spriteUrl of urls) {
        try {
          const res = await fetch(spriteUrl);
          if (!res.ok) continue;
          const text = await res.text();
          if (/<symbol[\s>]/i.test(text)) defs.push(text.replace(/<\?xml[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, ''));
        } catch {}
      }
      return defs.join('\n');
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

    const styledClone = sourceRoot.cloneNode(true);
    ['script','style','noscript','#sqs-cookie-banner','.sqs-cookie-banner-v2','.newsletter-block', ...sourceAuthSelectors]
      .forEach(sel => styledClone.querySelectorAll(sel).forEach(n => n.remove()));
    const originalsById = new Map(
      [...sourceRoot.querySelectorAll('[data-killerwork-node]')].map(node => [node.getAttribute('data-killerwork-node'), node])
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
      const source = id ? originalsById.get(id) : sourceRoot;
      if (!source) {
        node.remove?.();
        return;
      }
      const tag = node.tagName?.toLowerCase() || '';
      const meta = mediaMetaFrom(source);
      const className = String(node.getAttribute?.('class') || '');
      const textContent = clean(node.textContent || '');
      if (tag === 'use') {
        const href = node.href?.baseVal || node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || '';
        if (/^https?:\/\/|^\/\//i.test(href)) {
          const hash = href.includes('#') ? `#${href.split('#').pop()}` : '';
          if (!hash) {
            node.remove();
            return;
          }
          node.setAttribute('href', hash);
          node.setAttributeNS?.('http://www.w3.org/1999/xlink', 'xlink:href', hash);
        }
      }
      if (/tiny-thumb/i.test(className)) {
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
        if (resolved && !String(resolved).startsWith('blob:')) node.setAttribute('src', resolved);
        else node.removeAttribute('src');
        node.setAttribute('controls', '');
        node.setAttribute('playsinline', '');
      }
      if (tag === 'iframe') {
        const resolved = source.getAttribute('src') || source.getAttribute('data-src') || source.getAttribute('data-embed-url') || source.getAttribute('data-video-url') || '';
        if (resolved && !String(resolved).startsWith('blob:')) node.setAttribute('src', resolved);
        else node.removeAttribute('src');
      }
      const styleAttr = source.getAttribute?.('style') || '';
      if (styleAttr) node.setAttribute('style', styleAttr);
      else node.removeAttribute('style');
      [...(node.getAttributeNames?.() || [])].forEach(name => {
        const value = node.getAttribute(name) || '';
        if (value.includes('blob:')) node.removeAttribute(name);
        if (/\.svg#/i.test(value) && (/^https?:\/\//i.test(value) || value.startsWith('//'))) node.setAttribute(name, `#${value.split('#').pop()}`);
      });
      node.removeAttribute('data-killerwork-node');
      node.removeAttribute('loading');
      node.removeAttribute('decoding');
      node.removeAttribute('data-src');
      node.removeAttribute('data-image');
      node.removeAttribute('data-image-src');
    });

    const links = [...document.querySelectorAll('a[href]')].map(a => ({ href: abs(a.getAttribute('href')), text: clean(a.innerText) }));
    return {
      title: pageTitle,
      sourceBrand: clean(document.title.split(/\s+[—|-]\s+/).pop()) || '',
      copyBlocks,
      images,
      videos,
      contentItems,
      links,
      pageStyle,
      sourceCloneHtml: styledClone.innerHTML,
      sourceCloneStyle: sourceRoot.getAttribute('style') || '',
      sourceCss: sourceFontCss(),
      sourceSvgDefs: await sourceSvgDefs(),
      sourcePageTitle: clean(document.title),
      sourceHtmlClass: document.documentElement.className || '',
      sourceHtmlStyle: document.documentElement.getAttribute('style') || '',
      sourceHtmlId: document.documentElement.id || '',
      sourceBodyClass: document.body.className || '',
      sourceBodyStyle: document.body.getAttribute('style') || '',
      sourceBodyId: document.body.id || ''
    };
  }, { siteOrigin, sourceAuthSelectors: SOURCE_AUTH_SELECTORS });

  progress?.('Extracted page', `${data.title} — ${data.images.length} image refs, ${data.videos.length} video refs`);
  return data;
}

async function extractBehanceProject(page, url, progress) {
  await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await scrollBehancePage(page);

  const data = await page.evaluate(async (sourceAuthSelectors) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const comparable = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const cleanLines = (s) => (s || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => clean(line))
      .filter(Boolean)
      .join('\n');
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const rectMeta = (el) => {
      const rect = el?.getBoundingClientRect?.() || { width: 0, height: 0, top: 0 };
      const style = el ? getComputedStyle(el) : null;
      const width = Math.round(rect.width || 0);
      const height = Math.round(rect.height || 0);
      return {
        width,
        height,
        area: width * height,
        visible: !!style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && width > 0 && height > 0
      };
    };
    const title = clean(document.querySelector('h1')?.innerText)
      || clean(document.title.replace(/\s*::\s*Behance.*$/i, ''))
      || 'Untitled Behance Project';
    const titleKey = comparable(title);
    const thumbnailUrl = abs(document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.getAttribute('content') || '');
    const owner = clean(document.querySelector('a[href^="/"][title*="profile" i]')?.innerText)
      || clean(document.querySelector('[aria-label*="owner" i]')?.innerText)
      || '';

    const images = [];
    const videos = [];
    const copyBlocks = [];
    const contentItems = [];
    let order = 0;
    const addImage = (raw, alt, meta = {}) => {
      const src = abs(raw);
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;
      if (!/mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\/project_modules\//i.test(src)) return;
      if (meta.width && meta.height && (meta.width < 120 || meta.height < 80)) return;
      const item = { url: src, alt: clean(alt) || title, order: ++order, ...meta };
      images.push(item);
      contentItems.push({ type: 'image', ...item });
    };
    const addText = (el) => {
      let text = cleanLines(el.innerText);
      if (!text || text.length < 3) return;
      const textKey = comparable(text);
      if (textKey === titleKey) return;
      if (/^(follow|following|save|share|appreciate|owners|creative fields|more like this|built for creatives|find talent|behance|social)$/i.test(text)) return;
      if (/^\d+(?:\.\d+k|k)?$/i.test(text)) return;
      if (/no use is allowed|explicit permission|all rights reserved|published:|copyright/i.test(text)) return;
      if (/^(advertising|art direction|retouching|graphic design|photography|branding|illustration|copywriting|film|motion graphics|digital art|creative direction|editing|animation|ui\/ux|web design)$/i.test(text)) return;
      if (!text.includes(':') && text.length < 40) return;
      text = text
        .replace(/^Agency:/i, 'Ad Agency:')
        .replace(/^Role:/i, 'Role:');
      if (!/:/.test(text) && !/\b(award|winner|shortlist|cannes|d&ad|one show|clio|effie|andy|lia)\b/i.test(text)) return;
      const item = { type: 'text', tag: el.tagName.toLowerCase(), text, order: ++order };
      copyBlocks.push({ tag: item.tag, text, order: item.order });
      contentItems.push(item);
    };
    const addCreditTextBlock = (text) => {
      text = cleanLines(text);
      if (!text || text.length < 8 || !/:/.test(text)) return;
      const key = comparable(text);
      if (copyBlocks.some(block => comparable(block.text) === key)) return;
      const item = { type: 'text', tag: 'p', text, order: ++order };
      copyBlocks.push({ tag: item.tag, text, order: item.order });
      contentItems.push(item);
    };
    const addVideo = (el) => {
      const raw = el.getAttribute('src') || el.getAttribute('data-src') || '';
      const src = abs(raw);
      if (!src || (!/youtube|youtu\.be|vimeo|player|embed/i.test(src) && !/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(src))) return;
      const meta = rectMeta(el);
      const item = { kind: 'iframe', src, title, order: ++order, ...meta };
      videos.push(item);
      contentItems.push({ type: 'video', ...item });
    };

    const projectRoot = document.querySelector('main') || document.body;
    const nodes = [...projectRoot.querySelectorAll('h1,h2,h3,p,figcaption,img,iframe,video')];
    nodes.forEach(el => {
      const tag = el.tagName.toLowerCase();
      const className = String(el.className || '');
      const inRecommendations = !!el.closest('[class*="MoreLikeThis"], [class*="Recommendations"], [class*="ProjectCover"]');
      if (inRecommendations) return;
      if (tag === 'img') {
        addImage(el.currentSrc || el.src || el.getAttribute('src'), el.getAttribute('alt'), rectMeta(el));
      } else if (tag === 'iframe' || tag === 'video') {
        addVideo(el);
      } else if (!/PrimaryNav|Footer|Comments|Stats|Owner|CreativeFields/i.test(className)) {
        addText(el);
      }
    });

    const visibleLines = (projectRoot.innerText || document.body.innerText || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => clean(line))
      .filter(Boolean);
    const creditStart = visibleLines.findIndex(line => /^(agency|client|credits?(?:\s*\([^)]*\))?|production house|creative director)\s*:?/i.test(line));
    if (creditStart >= 0) {
      const creditLines = [];
      for (let i = creditStart; i < visibleLines.length && creditLines.length < 48; i++) {
        const line = visibleLines[i];
        if (i > creditStart && (
          /^(full alternate version|full version|multiple owners|follow all|appreciate|published:|creative fields|owners|more like this|you may also like)$/i.test(line)
          || comparable(line) === titleKey
        )) break;
        if (/^(follow|following|save|share|appreciate|owners|creative fields|more like this)$/i.test(line)) break;
        creditLines.push(line);
      }
      addCreditTextBlock(creditLines.join('\n'));
    }

    return {
      title,
      thumbnailUrl,
      sourceBrand: owner || 'Behance',
      copyBlocks,
      images,
      videos,
      contentItems,
      links: [],
      pageStyle: {
        backgroundColor: 'rgb(255, 255, 255)',
        textColor: 'rgb(17, 17, 17)',
        contentWidth: Math.max(980, ...images.map(img => img.width || 0))
      },
      sourceCloneHtml: '',
      sourceCloneStyle: '',
      sourceCss: ''
    };
  });

  if (!data.images.length && !data.videos.length) {
    const fallback = await extractBehanceProjectFromHtml(url, progress);
    if (fallback.images.length || fallback.videos.length) return fallback;
  }
  progress?.('Extracted Behance project', `${data.title} — ${data.images.length} image refs, ${data.videos.length} video refs`);
  return data;
}

function looksLikeNotFoundPage(data = {}) {
  const text = (data.copyBlocks || []).map(block => block.text || '').join('\n').toLowerCase();
  return text.includes("we couldn't find the page you were looking for")
    || text.includes('the page you are looking for has been moved or deleted');
}

async function getHomepageProjects(page, url, progress) {
  await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

async function scrollBehancePage(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let lastHeight = 0;
    for (let i = 0; i < 8; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await delay(900);
      const height = document.body.scrollHeight;
      if (Math.abs(height - lastHeight) < 24) break;
      lastHeight = height;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(600);
}

function textFromHtml(value = '') {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanProfileUrl(value = '') {
  try {
    const url = new URL(String(value || '').replace(/&amp;/g, '&'));
    if ((url.hostname.includes('duckduckgo.com') && url.searchParams.get('uddg')) || (url.hostname.includes('bing.com') && url.searchParams.get('u'))) {
      const raw = url.searchParams.get('uddg') || url.searchParams.get('u') || '';
      const decoded = raw.startsWith('a1') ? Buffer.from(raw.slice(2), 'base64').toString('utf8') : raw;
      return decodeURIComponent(decoded);
    }
    return url.href;
  } catch {
    return '';
  }
}

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function socialLabel(url = '') {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.includes('linkedin.com')) return 'LinkedIn';
    if (host.includes('instagram.com')) return 'Instagram';
    if (host.includes('twitter.com') || host.includes('x.com')) return 'X';
    if (host.includes('behance.net')) return 'Behance';
    return host.split('.')[0].replace(/\b\w/g, c => c.toUpperCase());
  } catch {
    return 'Link';
  }
}

function profileSlug(name = '') {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function hasProfileName(text = '', profileName = '') {
  const words = String(profileName || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const haystack = String(text || '').toLowerCase();
  return words.every(word => haystack.includes(word));
}

async function fetchLinkedInProfileHint(url, profileName, progress) {
  const href = cleanProfileUrl(url);
  if (!href || !/linkedin\.com\/in\//i.test(href)) return null;
  try {
    const res = await fetch(href, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = textFromHtml($('meta[property="og:title"]').attr('content') || $('title').text());
    const description = textFromHtml($('meta[property="og:description"], meta[name="description"]').first().attr('content'));
    const bodyText = textFromHtml($('body').text()).slice(0, 4000);
    const combined = `${title} ${description} ${bodyText}`;
    if (!hasProfileName(combined, profileName)) return null;
    if (/(authwall|sign in|join linkedin|login|checkpoint|profile unavailable|error page)/i.test(combined) && !description) return null;
    const snippet = description || bodyText.match(new RegExp(`${escapeRegExp(profileName)}.{0,500}`, 'i'))?.[0] || '';
    if (!snippet || /(authwall|sign in|join linkedin|login|checkpoint)/i.test(snippet)) return null;
    return {
      title: title || `${profileName} - LinkedIn`,
      url: href,
      snippet: snippet.slice(0, 520),
      source: 'LinkedIn'
    };
  } catch (e) {
    progress?.('LinkedIn profile warning', e.message);
    return null;
  }
}

async function fetchKnownCreativeProfileHints(profileName, progress) {
  const slug = profileSlug(profileName);
  if (!slug) return [];
  const urls = [
    `https://www.unblock.coffee/creatives/${slug}/`,
    `https://lbbonline.com/people/${slug}`
  ];
  const hints = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 KillerWorkImporter/0.8',
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const text = textFromHtml(html).replace(/\s+/g, ' ');
      if (!new RegExp(profileName.split(/\s+/).filter(Boolean).map(escapeRegExp).join('.*'), 'i').test(text)) continue;
      const windowText = text.match(new RegExp(`${escapeRegExp(profileName)}.{0,900}`, 'i'))?.[0] || text.slice(0, 900);
      hints.push({
        title: `${profileName} - ${socialLabel(url)}`,
        url,
        snippet: windowText,
        source: socialLabel(url)
      });
    } catch (e) {
      progress?.('Profile research warning', e.message);
    }
  }
  return hints;
}

async function searchPublicProfileHints(profileName, progress) {
  const name = String(profileName || '').trim();
  if (!name) return [];
  const queries = [
    `"${name}" LinkedIn creative advertising portfolio`,
    `"${name}" creative director agency awards`,
    `"${name}" awards advertising creative director`
  ];
  const seen = new Set();
  const hints = await fetchKnownCreativeProfileHints(name, progress);
  hints.forEach(hint => seen.add(hint.url));
  const nameWords = name.toLowerCase().split(/\s+/).filter(Boolean);
  const pushHint = (title, url, snippet) => {
    const href = cleanProfileUrl(url);
    if (!href || seen.has(href)) return;
    const haystack = `${title} ${snippet} ${href}`.toLowerCase();
    if (!nameWords.every(word => haystack.includes(word))) return;
    seen.add(href);
    hints.push({
      title: textFromHtml(title).slice(0, 180),
      url: href,
      snippet: textFromHtml(snippet).slice(0, 480),
      source: socialLabel(href)
    });
  };
  for (const query of queries) {
    try {
      const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 KillerWorkImporter/0.8',
          accept: 'text/html'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const resultRegex = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?<\/div>\s*<\/div>/gi;
      const linkRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const snippetRegex = /<(?:a|div)[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i;
      let match;
      while ((match = resultRegex.exec(html)) && hints.length < 8) {
        const link = match[0].match(linkRegex);
        if (!link) continue;
        const href = cleanProfileUrl(link[1]);
        if (!href || seen.has(href)) continue;
        seen.add(href);
        const snippet = match[0].match(snippetRegex);
        pushHint(link[2], href, snippet?.[1] || '');
      }
    } catch (e) {
      progress?.('Profile research warning', e.message);
    }
    if (hints.length >= 5) continue;
    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);
      $('li.b_algo').each((_, node) => {
        if (hints.length >= 10) return;
        const item = $(node);
        pushHint(item.find('h2 a').text(), item.find('h2 a').attr('href'), item.find('.b_caption p, .b_snippet').first().text());
      });
    } catch (e) {
      progress?.('Profile research warning', e.message);
    }
  }
  const linkedinUrls = hints
    .map(hint => hint.url)
    .filter(url => /linkedin\.com\/in\//i.test(url || ''))
    .slice(0, 2);
  for (const linkedinUrl of linkedinUrls) {
    const linkedinHint = await fetchLinkedInProfileHint(linkedinUrl, name, progress);
    if (!linkedinHint) continue;
    const existing = hints.findIndex(hint => hint.url === linkedinUrl);
    if (existing >= 0) hints[existing] = linkedinHint;
  }
  return hints;
}

function unescapeHtmlUrl(value = '') {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\\u0026/g, '&')
    .trim();
}

function bestSrcsetUrl(value = '') {
  const parts = String(value || '')
    .split(',')
    .map(part => unescapeHtmlUrl(part.trim().split(/\s+/)[0]))
    .filter(Boolean);
  return parts[0] || '';
}

async function extractBehanceProjectFromHtml(url, progress) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 KillerWorkImporter/0.8',
        accept: 'text/html'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const title = textFromHtml($('meta[property="og:title"]').attr('content'))
      || textFromHtml($('meta[name="twitter:title"]').attr('content'))
      || textFromHtml($('h1').first().text())
      || titleFromBehanceGalleryPath(url)
      || 'Untitled Behance Project';
    const thumbnailUrl = normalizeUrl(unescapeHtmlUrl($('meta[property="og:image"], meta[name="twitter:image"]').first().attr('content')), url);
    const owner = textFromHtml($('a[href^="/"][title*="profile" i]').first().text()) || 'Behance';
    const images = [];
    const videos = [];
    const contentItems = [];
    const copyBlocks = [];
    const seenImages = new Set();
    const seenVideos = new Set();
    let order = 0;

    const addImage = (raw, alt = '') => {
      const src = normalizeUrl(unescapeHtmlUrl(raw), url);
      if (!src || !/mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\/project_modules\//i.test(src)) return;
      const key = canonicalImageKey(src);
      if (seenImages.has(key)) return;
      seenImages.add(key);
      const item = { url: src, alt: textFromHtml(alt) || title, order: ++order, width: 0, height: 0, visible: true };
      images.push(item);
      contentItems.push({ type: 'image', ...item });
    };

    const addVideo = (raw) => {
      const src = normalizeUrl(unescapeHtmlUrl(raw), url);
      if (!src || (!/youtube|youtu\.be|vimeo|player|embed/i.test(src) && !/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(src))) return;
      const key = canonicalVideoKey(src, 'iframe');
      if (seenVideos.has(key)) return;
      seenVideos.add(key);
      const item = { kind: 'iframe', src, title, order: ++order, width: 0, height: 0, visible: true };
      videos.push(item);
      contentItems.push({ type: 'video', ...item });
    };

    $('img').each((_, node) => {
      const img = $(node);
      const scopeClass = String(img.closest('[class]').attr('class') || '');
      if (/MoreLikeThis|Recommendations|ProjectCover/i.test(scopeClass)) return;
      addImage(img.attr('src') || img.attr('data-src') || img.attr('data-image') || bestSrcsetUrl(img.attr('srcset') || img.attr('data-srcset')), img.attr('alt'));
    });
    $('iframe, video, source').each((_, node) => {
      const el = $(node);
      addVideo(el.attr('src') || el.attr('data-src') || el.attr('data-video-url'));
    });

    if (!images.length) {
      const matches = html.match(/https?:\\?\/\\?\/mir-s3[^"'<>\s,]+\/project_modules\/[^"'<>\s,]+/gi) || [];
      for (const match of matches) addImage(match, title);
    }
    if (!videos.length) {
      const matches = html.match(/https?:\\?\/\\?\/(?:player\.vimeo\.com|www\.youtube\.com|youtube\.com|youtu\.be)[^"'<>\s\\]+/gi) || [];
      for (const match of matches) addVideo(match);
    }

    $('p,h2,h3,figcaption').each((_, node) => {
      const text = textFromHtml($(node).text());
      if (!text || text.length < 8 || text.length > 1000) return;
      if (!/:/.test(text) && !/\b(award|winner|shortlist|cannes|d&ad|one show|clio|effie|andy|lia)\b/i.test(text)) return;
      const item = { type: 'text', tag: node.tagName?.toLowerCase?.() || 'p', text, order: ++order };
      copyBlocks.push({ tag: item.tag, text, order: item.order });
      contentItems.push(item);
    });

    const data = {
      title,
      thumbnailUrl,
      sourceBrand: owner || 'Behance',
      copyBlocks,
      images,
      videos,
      contentItems: contentItems.sort((a, b) => (a.order || 0) - (b.order || 0)),
      links: [],
      pageStyle: {
        backgroundColor: 'rgb(255, 255, 255)',
        textColor: 'rgb(17, 17, 17)',
        contentWidth: 1150
      },
      sourceCloneHtml: '',
      sourceCloneStyle: '',
      sourceCss: ''
    };
    progress?.('Behance project HTML fallback', `${data.title} — ${data.images.length} image refs, ${data.videos.length} video refs`);
    return data;
  } catch (e) {
    progress?.('Behance project HTML fallback warning', `${url} — ${e.message}`);
    return {
      title: titleFromBehanceGalleryPath(url) || 'Untitled Behance Project',
      thumbnailUrl: '',
      sourceBrand: 'Behance',
      copyBlocks: [],
      images: [],
      videos: [],
      contentItems: [],
      links: [],
      pageStyle: { backgroundColor: 'rgb(255, 255, 255)', textColor: 'rgb(17, 17, 17)', contentWidth: 1150 },
      sourceCloneHtml: '',
      sourceCloneStyle: '',
      sourceCss: ''
    };
  }
}

function behanceProjectsUrl(url = '') {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length && parts[1]?.toLowerCase() !== 'projects') {
      u.pathname = `/${parts[0]}/projects`;
    }
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

function titleFromBehanceGalleryPath(href = '') {
  try {
    const match = new URL(href, 'https://www.behance.net').pathname.match(/\/gallery\/\d+\/([^/]+)/i);
    return match ? cleanTitle(decodeURIComponent(match[1]).replace(/[-_]+/g, ' ')) : '';
  } catch {
    return '';
  }
}

async function getBehanceProjectsFromHtml(url, progress) {
  const projectsUrl = behanceProjectsUrl(url);
  try {
    const res = await fetch(projectsUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 KillerWorkImporter/0.8',
        accept: 'text/html'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const byId = new Map();
    $('a[href*="/gallery/"]').each((_, node) => {
      const a = $(node);
      const href = normalizeUrl(a.attr('href'), projectsUrl);
      const match = href.match(/\/gallery\/(\d+)\/([^?#]+)/i);
      if (!match) return;
      const scope = a.parents('article, li, div').filter((_, el) => $(el).find('img').filter((_, imgNode) => {
        const img = $(imgNode);
        const src = img.attr('src') || img.attr('data-src') || img.attr('data-image') || img.attr('srcset') || img.attr('data-srcset') || '';
        return /mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\/projects\//i.test(src);
      }).length > 0).first();
      const projectImgs = scope.find('img').filter((_, imgNode) => {
        const img = $(imgNode);
        const src = img.attr('src') || img.attr('data-src') || img.attr('data-image') || img.attr('srcset') || img.attr('data-srcset') || '';
        return /mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\/projects\//i.test(src);
      });
      const img = projectImgs.first();
      const srcset = img.attr('srcset') || img.attr('data-srcset') || '';
      const srcsetFirst = srcset.split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
      const rawTitle = textFromHtml(a.text())
        || textFromHtml(a.attr('title') || '').replace(/^Link to project\s*-\s*/i, '')
        || textFromHtml(img.attr('alt') || '')
        || titleFromBehanceGalleryPath(href);
      if (!rawTitle || /^search$/i.test(rawTitle)) return;
      const thumbnailUrl = normalizeUrl(img.attr('src') || img.attr('data-src') || img.attr('data-image') || srcsetFirst, projectsUrl);
      const current = byId.get(match[1]);
      if (current) {
        if (!current.thumbnailUrl && thumbnailUrl) current.thumbnailUrl = thumbnailUrl;
        return;
      }
      byId.set(match[1], {
        slug: `behance-${match[1]}-${rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
        title: rawTitle,
        url: href,
        thumbnailUrl,
        description: '',
        strategy: 'behance-gallery-html',
        score: 210,
        force: true
      });
    });
    const merged = mergeProjectCandidates([...byId.values()]);
    progress?.('Behance HTML fallback', `${merged.length} project(s) from ${projectsUrl}`);
    return merged;
  } catch (e) {
    progress?.('Behance HTML fallback warning', e.message);
    return [];
  }
}

async function getBehanceProfileImageFromHtml(url, profileName = '', progress) {
  try {
    const res = await fetch(behanceProjectsUrl(url), {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 KillerWorkImporter/0.8',
        accept: 'text/html',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const candidates = $('img').map((_, node) => {
      const img = $(node);
      return {
        src: normalizeUrl(img.attr('src') || img.attr('data-src') || img.attr('data-image') || bestSrcsetUrl(img.attr('srcset') || img.attr('data-srcset')), behanceProjectsUrl(url)),
        alt: textFromHtml(img.attr('alt') || '')
      };
    }).get();
    return candidates.find(img => img.src && !/\/projects\//i.test(img.src) && (/pps\.services\.adobe\.com|profile|avatar|portrait/i.test(`${img.src} ${img.alt}`) || (profileName && img.alt.toLowerCase().includes(profileName.toLowerCase()))))?.src || '';
  } catch (e) {
    progress?.('Profile image fallback warning', e.message);
    return '';
  }
}

function composeGeneratedCareerParagraphs(profile = {}) {
  const firstName = String(profile.name || '').split(/\s+/)[0] || 'This creative';
  const role = profile.role || 'creative';
  const location = profile.location || '';
  const awards = Array.isArray(profile.awards) ? profile.awards.filter(Boolean) : [];
  const brandName = (value = '') => {
    const normalized = String(value || '').trim();
    const known = new Map([
      ['ikea', 'IKEA'],
      ['kfc', 'KFC'],
      ['hsbc', 'HSBC'],
      ['scholl', 'Scholl']
    ]);
    return known.get(normalized.toLowerCase()) || normalized;
  };
  const brands = Array.isArray(profile.brands) ? profile.brands.filter(Boolean).map(brandName) : [];
  const place = location ? ` Based in ${location},` : '';
  const brandLine = brands.length > 2
    ? `${place} the work moves through ${brands.slice(0, 6).join(', ')}${brands.length > 6 ? ' and a few other brave clients' : ''}: big-brand rooms, small human truths, and ideas that know when to shut up.`
    : `${place} the work sits in that useful corner of advertising where a thought has to be simple enough to travel and sharp enough to leave a mark.`;
  const achievementLine = awards.length > 1
    ? `Some of it has picked up metal at ${awards.join(', ')} and other shows. Useful, because applause is nice. Better, because it means the work got noticed outside the meeting room.`
    : `I like the bit where a headline earns its space, art direction remembers its manners, and commercial thinking gets dressed well enough to pass as culture.`;
  return [
    `I'm ${firstName}, ${/^[aeiou]/i.test(role) ? 'an' : 'a'} ${role}.${brandLine}`,
    achievementLine
  ];
}

function composeBehanceAboutProfile(profile = {}, hints = []) {
  const links = new Map();
  for (const link of profile.links || []) {
    if (link?.url) links.set(link.url, { ...link, label: link.label || socialLabel(link.url) });
  }
  for (const hint of hints) {
    if (/linkedin\.com|adforum|campaignbrief|lbbonline|thework|oneclub|dandad|clios|cannes/i.test(hint.url || '')) {
      links.set(hint.url, { label: hint.source || socialLabel(hint.url), url: hint.url });
    }
  }

  const rejectProfileNoise = (value = '') => !/(project views|appreciations|followers|following|member since|report|adobe express|do not sell|go to adobe|free trial|sign in|navigate to)/i.test(value);
  const cleanRole = rejectProfileNoise(profile.role || '') ? profile.role : '';
  const cleanLocation = rejectProfileNoise(profile.location || '') ? profile.location : '';
  const cleanBio = rejectProfileNoise(profile.bio || '') ? profile.bio : '';
  const evidenceText = [
    cleanBio,
    cleanRole,
    cleanLocation,
    ...(profile.fields || []),
    ...hints.map(h => `${h.title} ${h.snippet}`)
  ].filter(Boolean).join(' ');
  const firstName = String(profile.name || '').split(/\s+/)[0] || 'This creative';
  const roleMatch = evidenceText.match(/\b(Chief Creative Officer|Executive Creative Director|Creative Director|Senior Creative Director|Art Director|Copywriter|Designer)\b/i)?.[1] || '';
  const agencyMatch = evidenceText.match(/\b(Memac Ogilvy|Ogilvy|Saatchi\s*&\s*Saatchi|J\.?\s*Walter Thompson|JWT(?: Dubai)?|Impact BBDO|BBDO|FP7(?: Bahrain)?|Leo Burnett|Publicis|TBWA|DDB|McCann|VML|Grey|Wieden\+Kennedy|AKQA)\b/i)?.[1] || '';
  const role = roleMatch || cleanRole || 'creative';
  const agency = agencyMatch;
  const location = cleanLocation || (/\bUAE|United Arab Emirates|Dubai\b/i.test(evidenceText) ? 'United Arab Emirates' : '');
  const fields = (profile.fields || []).filter(rejectProfileNoise).slice(0, 4);
  const awards = [
    'Cannes Lions',
    'One Show',
    'Clios',
    'New York Festivals',
    'LIA',
    'Communication Arts',
    'Dubai Lynx',
    'Effies',
    'D&AD',
    'TED'
  ].filter(award => new RegExp(escapeRegExp(award), 'i').test(evidenceText)).slice(0, 8);
  const brands = [
    'IKEA',
    'Visa',
    'Oreo',
    'Coca-Cola',
    'HSBC',
    'Expo 2020',
    'KFC',
    'Batelco',
    'Mercedes-Benz',
    'Kinokuniya',
    'Listerine',
    'Snickers'
  ].filter(brand => new RegExp(escapeRegExp(brand), 'i').test(evidenceText)).slice(0, 8);
  const sourceSentences = hints
    .flatMap(hint => textFromHtml(hint.snippet || hint.title).split(/(?<=[.!?])\s+/).map(sentence => sentence.trim()))
    .filter(sentence => sentence.length > 45 && sentence.length < 260)
    .filter(sentence => hasProfileName(sentence, profile.name || firstName) || /(creative director|art director|copywriter|agency|campaign|awards?|cannes|lynx|clios|effies|one show|clients?|brands?)/i.test(sentence))
    .filter(sentence => !/(behance|followers|appreciations|project views|sign in|join linkedin|authwall|cookie|privacy policy)/i.test(sentence));
  const publicProof = sourceSentences.find(sentence => /(executive creative director|chief creative officer|creative director|art director|copywriter|agency|track record|winner|awarded|recognised|recognized)/i.test(sentence));
  const sourceParagraph = publicProof
    ? publicProof.replace(/\s+-\s+LinkedIn.*$/i, '').replace(/\s+/g, ' ')
    : '';
  const generatedBase = { name: profile.name || '', role, agency, location, awards, brands };
  const careerLine = sourceParagraph || composeGeneratedCareerParagraphs(generatedBase)[0];
  const achievementLine = awards.length > 1
    ? `${firstName}'s work has been recognised across ${awards.join(', ')} and other advertising shows.`
    : composeGeneratedCareerParagraphs(generatedBase)[1];
  const paragraphs = [careerLine, achievementLine];

  return {
    name: profile.name || '',
    role,
    agency,
    location,
    bio: cleanBio,
    image: profile.image || null,
    imageUrl: profile.imageUrl || '',
    email: profile.email || '',
    phone: profile.phone || '',
    fields,
    honours: [
      role && agencyMatch ? `${role}, ${agencyMatch}` : role,
      location,
      /three countries/i.test(evidenceText) ? 'Creative track record across three countries' : '',
      /jury/i.test(evidenceText) ? 'Award-show jury experience' : ''
    ].filter(Boolean).slice(0, 5),
    awards: awards.length > 1 ? awards : [],
    brands,
    links: [...links.values()].slice(0, 8),
    paragraphs,
    sources: hints.slice(0, 6),
    copyGenerated: !sourceParagraph
  };
}

async function getBehanceProjects(page, url, progress) {
  const projectsUrl = behanceProjectsUrl(url);
  await gotoWithRetry(page, projectsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('a[href*="/gallery/"]', { timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await scrollBehancePage(page);

  const data = await page.evaluate(async (sourceAuthSelectors) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const profileName = clean(document.querySelector('h1')?.innerText)
      || clean(document.title.replace(/\s+-\s+.*$/i, '').replace(/\s+::\s+Behance.*$/i, ''));
    const bodyText = clean(document.body?.innerText || '');
    const bodyLines = (document.body?.innerText || '').split('\n').map(clean).filter(Boolean);
    const nameIndex = bodyLines.findIndex(line => line === profileName);
    const profileLines = nameIndex >= 0 ? bodyLines.slice(nameIndex + 1, nameIndex + 8) : [];
    const isChromeLine = (line = '') => /^(follow|message|project views|appreciations|followers|following|member since|report|work|appreciations|skip to|navigate to|explore|jobs|resources|hire|start free trial|sign in)$/i.test(line)
      || /adobe express|go to adobe|do not sell|free trial/i.test(line);
    const email = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
    const phone = bodyText.match(/(?:\+?\d[\d\s().-]{7,}\d)/)?.[0] || '';
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ url: abs(a.getAttribute('href')), label: clean(a.innerText) || clean(a.getAttribute('aria-label')) }))
      .filter(link => link.url && /(linkedin\.com|instagram\.com|twitter\.com|x\.com|dribbble\.com|personal website|mailto:)/i.test(`${link.url} ${link.label}`))
      .slice(0, 10);
    const fields = [...new Set([...document.querySelectorAll('a[href*="/search/projects/"], a[href*="/galleries/"], a[href*="field="]')]
      .map(a => clean(a.innerText))
      .filter(text => text && text.length <= 42 && !/^(search|projects|galleries)$/i.test(text)))].slice(0, 6);
    const profileImage = [...document.querySelectorAll('img')].map(img => ({
      src: abs(img.currentSrc || img.src || img.getAttribute('src') || ''),
      alt: clean(img.getAttribute('alt')),
      width: img.naturalWidth || img.width || 0,
      height: img.naturalHeight || img.height || 0
    })).find(img => img.src && !/\/projects\//i.test(img.src) && (/(avatar|user|profile|owners|portrait)/i.test(`${img.src} ${img.alt}`) || (profileName && img.alt.toLowerCase().includes(profileName.toLowerCase()))));
    const usefulProfileLines = profileLines.filter(line => line.length > 2 && line.length < 90 && !isChromeLine(line));
    const role = usefulProfileLines.find(line => /\b(creative|director|copywriter|writer|designer|art director)\b/i.test(line)) || '';
    const location = usefulProfileLines.find(text => !/\b(Ogilvy|Saatchi|Thompson|JWT|BBDO|FP7|Burnett)\b/i.test(text) && /,\s*[A-Z][a-z]+|United|Bahrain|Dubai|London|New York|India|Sri Lanka|Canada|Australia|Germany|France|Spain|Singapore|Qatar|Saudi/i.test(text)) || '';
    const bio = clean([...document.querySelectorAll('p, [class*="bio"], [class*="Bio"], [class*="about"], [class*="About"]')]
      .map(el => clean(el.innerText))
      .find(text => text.length > 40 && text.length < 700 && !/^(follow|following|save|share|appreciate)/i.test(text)) || '');
    const projects = [];
    const seen = new Set();

    const imageFrom = (scope) => {
      const imgs = [
        ...scope?.querySelectorAll?.('img') || [],
        ...scope?.closest?.('article,li,div')?.querySelectorAll?.('img') || []
      ];
      const img = imgs.find(candidate => {
        const src = candidate.currentSrc || candidate.src || candidate.getAttribute('src') || '';
        return /mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\/projects\//i.test(src);
      }) || imgs.find(candidate => {
        const src = candidate.currentSrc || candidate.src || candidate.getAttribute('src') || '';
        return /mir-s3(?:-cdn|-cdn-cf)?\.behance\.net\//i.test(src);
      });
      const src = img?.currentSrc || img?.src || img?.getAttribute?.('src') || '';
      if (src) return abs(src);
      const video = scope?.querySelector?.('video[poster]') || scope?.closest?.('article,li,div')?.querySelector?.('video[poster]');
      const poster = video?.getAttribute?.('poster') || '';
      if (poster) return abs(poster);
      const bgNode = [scope, ...scope?.querySelectorAll?.('*') || []].find(node => /url\(/i.test(node.getAttribute?.('style') || ''));
      const bg = bgNode?.getAttribute?.('style')?.match(/url\(["']?([^"')]+)["']?\)/i)?.[1] || '';
      return abs(bg);
    };

    document.querySelectorAll('a[href*="/gallery/"]').forEach(a => {
      const href = abs(a.getAttribute('href'));
      const match = href.match(/\/gallery\/(\d+)\/([^?#]+)/i);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);
      const scope = a.closest('[class*="ProjectCover"], article, li, div') || a;
      const img = scope.querySelector?.('img') || a.querySelector?.('img');
      const rawTitle = clean(a.innerText)
        || clean(a.getAttribute('title') || '').replace(/^Link to project\s*-\s*/i, '')
        || clean(img?.getAttribute('alt'))
        || clean(decodeURIComponent(match[2]).replace(/[-_]+/g, ' '));
      if (!rawTitle || /^search$/i.test(rawTitle)) return;
      projects.push({
        slug: `behance-${match[1]}-${rawTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
        title: rawTitle,
        url: href,
        thumbnailUrl: imageFrom(scope),
        description: '',
        strategy: 'behance-gallery',
        score: 220,
        force: true
      });
    });

    return {
      profileName,
      profile: {
        name: profileName,
        role,
        location,
        bio,
        imageUrl: profileImage?.src || '',
        email,
        phone,
        fields,
        links
      },
      projects
    };
  }, SOURCE_AUTH_SELECTORS);

  let projects = mergeProjectCandidates(data.projects || []);
  if (!projects.length) {
    projects = await getBehanceProjectsFromHtml(projectsUrl, progress);
  }
  progress?.('Behance project discovery', `${projects.length} Behance project(s)`);
  if (!data.profile?.imageUrl) {
    data.profile.imageUrl = await getBehanceProfileImageFromHtml(projectsUrl, data.profileName || '', progress);
  }
  const hints = await searchPublicProfileHints(data.profileName || '', progress);
  progress?.('Profile research', `${hints.length} public result snippet(s)`);
  return {
    profileName: data.profileName || '',
    profile: composeBehanceAboutProfile(data.profile || { name: data.profileName || '' }, hints),
    profileImageUrl: data.profile?.imageUrl || '',
    projects
  };
}

async function extractHomePage(page, url, progress) {
  await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(700);

  const data = await page.evaluate(async (sourceAuthSelectors) => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const abs = (v) => { try { return new URL(v, location.href).href; } catch { return ''; } };
    const root = document.querySelector('#siteWrapper') || document.querySelector('#page') || document.querySelector('#canvas') || document.querySelector('main') || document.body;
    const removeSelectors = [
      'script','style','noscript',
      ...sourceAuthSelectors,
      '#sqs-cookie-banner','.sqs-cookie-banner-v2','.newsletter-block'
    ];
    const sourceFontCss = () => {
      const chunks = [];
      document.querySelectorAll('link[rel~="stylesheet"][href]').forEach(link => {
        const href = link.href || '';
        if (href) chunks.push(`@import url("${href.replace(/"/g, '\\"')}");`);
      });
      document.querySelectorAll('style').forEach(style => {
        const text = style.textContent || '';
        if (text.length <= 180000) chunks.push(text);
      });
      return [...new Set(chunks)].join('\n');
    };
    const sourceSvgDefs = async () => {
      const urls = [...new Set([...document.querySelectorAll('use')].map(use => {
        const href = use.href?.baseVal || use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!/\.svg#/i.test(href)) return '';
        return abs(href.split('#')[0]);
      }).filter(Boolean))];
      const defs = [];
      for (const spriteUrl of urls) {
        try {
          const res = await fetch(spriteUrl);
          if (!res.ok) continue;
          const text = await res.text();
          if (/<symbol[\s>]/i.test(text)) defs.push(text.replace(/<\?xml[^>]*>/gi, '').replace(/<!doctype[^>]*>/gi, ''));
        } catch {}
      }
      return defs.join('\n');
    };
    const assetFrom = (el) => {
      if (!el) return '';
      return el.currentSrc
        || el.getAttribute('data-image')
        || el.getAttribute('data-src')
        || el.getAttribute('data-image-src')
        || el.getAttribute('src')
        || el.getAttribute('srcset')?.split(',')[0]?.trim()?.split(/\s+/)[0]
        || '';
    };
    const assets = [];
    const addAsset = (raw) => {
      const full = abs(raw);
      if (!full || full.startsWith('data:') || full.startsWith('blob:')) return;
      if (!assets.includes(full)) assets.push(full);
    };

    root.querySelectorAll('*').forEach((node, index) => node.setAttribute('data-killerwork-home-node', String(index + 1)));
    const clone = root.cloneNode(true);
    removeSelectors.forEach(sel => clone.querySelectorAll(sel).forEach(node => node.remove()));
    const originalsById = new Map(
      [...root.querySelectorAll('[data-killerwork-home-node]')].map(node => [node.getAttribute('data-killerwork-home-node'), node])
    );

    [clone, ...clone.querySelectorAll('*')].forEach(node => {
      const id = node.getAttribute?.('data-killerwork-home-node');
      const source = id ? originalsById.get(id) : root;
      if (!source) {
        node.remove?.();
        return;
      }
      const tag = node.tagName?.toLowerCase() || '';
      if (tag === 'use') {
        const href = node.href?.baseVal || node.getAttribute('href') || node.getAttribute('xlink:href') || node.getAttributeNS?.('http://www.w3.org/1999/xlink', 'href') || '';
        if (/^https?:\/\/|^\/\//i.test(href)) {
          const hash = href.includes('#') ? `#${href.split('#').pop()}` : '';
          if (!hash) {
            node.remove();
            return;
          }
          node.setAttribute('href', hash);
          node.setAttributeNS?.('http://www.w3.org/1999/xlink', 'xlink:href', hash);
        }
      }
      if (tag === 'img' || tag === 'source') {
        const resolved = assetFrom(source);
        if (resolved) {
          node.setAttribute(tag === 'img' ? 'src' : 'src', resolved);
          addAsset(resolved);
        }
        node.removeAttribute('srcset');
        node.removeAttribute('sizes');
        node.removeAttribute('loading');
        node.removeAttribute('decoding');
      }
      const styleAttr = source.getAttribute?.('style') || '';
      for (const match of styleAttr.matchAll(/url\(["']?([^"')]+)["']?\)/g)) addAsset(match[1]);
      if (styleAttr) node.setAttribute('style', styleAttr);
      else node.removeAttribute('style');
      [...(node.getAttributeNames?.() || [])].forEach(name => {
        const value = node.getAttribute(name) || '';
        if (value.includes('blob:')) node.removeAttribute(name);
        if (/\.svg#/i.test(value) && (/^https?:\/\//i.test(value) || value.startsWith('//'))) node.setAttribute(name, `#${value.split('#').pop()}`);
      });
      node.removeAttribute('data-killerwork-home-node');
    });

    root.querySelectorAll('[data-killerwork-home-node]').forEach(node => node.removeAttribute('data-killerwork-home-node'));

    const bodyStyle = getComputedStyle(document.body);
    const rootStyle = getComputedStyle(root);
    return {
      title: clean(document.title) || clean(document.querySelector('h1')?.innerText) || 'Imported Portfolio',
      style: root.getAttribute('style') || '',
      backgroundColor: clean(rootStyle.backgroundColor && rootStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' ? rootStyle.backgroundColor : bodyStyle.backgroundColor),
      textColor: clean(rootStyle.color || bodyStyle.color),
      html: clone.innerHTML,
      sourceCss: sourceFontCss(),
      sourceSvgDefs: await sourceSvgDefs(),
      sourceHtmlClass: document.documentElement.className || '',
      sourceHtmlStyle: document.documentElement.getAttribute('style') || '',
      sourceHtmlId: document.documentElement.id || '',
      sourceBodyClass: document.body.className || '',
      sourceBodyStyle: document.body.getAttribute('style') || '',
      sourceBodyId: document.body.id || '',
      assets
    };
  }, SOURCE_AUTH_SELECTORS);

  progress?.('Extracted homepage', `${data.assets.length} homepage asset ref(s)`);
  return data;
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
  }, SOURCE_AUTH_SELECTORS);
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
    if (out.type === 'image') {
      const thumb = await createImageThumbnail(buf, fileName, assetsDir, progress);
      if (thumb) Object.assign(out, thumb);
    }
    cache.set(url, out);
    return out;
  } catch (e) {
    progress?.('Asset skipped', `${url} — ${e.message}`);
    return null;
  }
}

async function createImageThumbnail(buf, fileName, assetsDir, progress) {
  const ext = path.extname(fileName).toLowerCase();
  if (['.svg', '.gif'].includes(ext)) return null;
  try {
    const thumbName = `${path.basename(fileName, ext)}-thumb.webp`;
    const thumbDest = path.join(assetsDir, thumbName);
    const info = await sharp(buf)
      .rotate()
      .resize({ width: 900, withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toFile(thumbDest);
    return {
      thumbSrc: `assets/imported/${thumbName}`,
      thumbLocalFile: thumbName,
      thumbWidth: info.width,
      thumbHeight: info.height
    };
  } catch (e) {
    progress?.('Thumbnail skipped', `${fileName} — ${e.message}`);
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

function renderMetaBlocks(project, { includeTitle = false } = {}) {
  const lines = project.cleaned?.metadata?.length
    ? normalizedMetaLines(project.cleaned.metadata.map(text => ({ text })), project.title)
    : normalizedMetaLines(project.copyBlocks, project.title);
  const displayLines = includeTitle ? [project.title, ...lines] : lines;
  if (!displayLines.length) return '';
  return `<section class="project-meta" aria-label="Project details">${displayLines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</section>`;
}

function behanceDetailLines(blocks = [], projectTitle = '') {
  const titleCore = cleanTitle(projectTitle).toLowerCase();
  const seen = new Set();
  const lines = [];
  for (const block of blocks || []) {
    String(block.text || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .forEach(line => {
        const cleaned = line.replace(/:\s*(?=\S)/g, ': ');
        if (!cleaned || cleaned.toLowerCase() === titleCore) return;
        if (/^(follow|following|save|share|appreciate|owners|creative fields|more like this|published:)$/i.test(cleaned)) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        lines.push(cleaned);
      });
  }
  return lines.slice(0, 36);
}

function renderBehanceCampaignDetails(project) {
  const rawLines = behanceDetailLines(project.copyBlocks, project.title);
  const cleanedLines = project.cleaned?.metadata?.length
    ? normalizedMetaLines(project.cleaned.metadata.map(text => ({ text })), project.title)
    : [];
  const lines = rawLines.length ? rawLines : cleanedLines;
  if (!lines.length) return '';
  return `<section class="project-meta behance-campaign-details" aria-label="Campaign details">${lines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</section>`;
}

function treatmentClass(item = {}) {
  return ['hero', 'full-width', 'contained'].includes(item.treatment) ? ` ${item.treatment}` : '';
}

function renderVideo(v, projectSlug, posterAsset = null, item = {}) {
  const src = relFromPage(projectSlug, v.src);
  const poster = posterAsset?.src ? relFromPage(projectSlug, posterAsset.src) : '';
  const posterAttr = poster ? ` poster="${htmlEscape(poster)}"` : '';
  const style = v?.width ? ` style="max-width:${Math.round(v.width)}px"` : '';
  if (!src || src.startsWith('blob:') || src.includes('mpegts-') || src.endsWith('.bin') || src.endsWith('.ts')) return '';
  if (v.kind === 'iframe' || v.type === 'iframe' || mediaType(src) === 'youtube' || mediaType(src) === 'vimeo') {
    return `<figure class="media video${treatmentClass(item)}"${style}><iframe src="${htmlEscape(src)}" title="Video" loading="lazy" allowfullscreen></iframe></figure>`;
  }
  if (v.type === 'hls' || mediaType(src) === 'hls') {
    return `<figure class="media video${treatmentClass(item)}"${style}><video class="hls-video" controls playsinline${posterAttr} data-hls-src="${htmlEscape(src)}"></video></figure>`;
  }
  return `<figure class="media video${treatmentClass(item)}"${style}><video controls playsinline${posterAttr} src="${htmlEscape(src)}"></video></figure>`;
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

function renderDocument(doc, projectSlug, item = {}) {
  if (!doc?.src) return '';
  const src = relFromPage(projectSlug, doc.src);
  const title = doc.title || doc.original || 'PDF';
  const style = doc?.width ? ` style="max-width:${Math.round(doc.width)}px"` : '';
  return `<figure class="media document${treatmentClass(item)}"${style}><iframe src="${htmlEscape(src)}" title="${htmlEscape(title)}" loading="lazy"></iframe><figcaption><a href="${htmlEscape(src)}" target="_blank" rel="noopener">Open PDF</a></figcaption></figure>`;
}

function renderAudio(audio, projectSlug) {
  if (!audio?.src) return '';
  const src = relFromPage(projectSlug, audio.src);
  const title = audio.title || audio.original || 'Audio';
  return `<figure class="media audio"><figcaption>${htmlEscape(title)}</figcaption><audio controls preload="metadata" src="${htmlEscape(src)}"></audio></figure>`;
}

function renderImage(img, projectSlug, title, item = {}) {
  if (!img?.src) return '';
  const size = img?.width ? ` style="max-width:${Math.round(img.width)}px"` : '';
  const widthAttr = img?.width ? ` width="${Math.round(img.width)}"` : '';
  const heightAttr = img?.height ? ` height="${Math.round(img.height)}"` : '';
  const loading = Number(img.order || 0) > 2 ? 'lazy' : 'eager';
  return `<figure class="media image${treatmentClass(item)}"${size}><img src="${htmlEscape(relFromPage(projectSlug, img.src))}" alt="${htmlEscape(img.alt || title)}" loading="${loading}" decoding="async"${widthAttr}${heightAttr}></figure>`;
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

function textStyleAttr(item = {}) {
  const styles = [];
  if (item.fontFamily) styles.push(`font-family:${String(item.fontFamily).replace(/[;"<>]/g, '')}`);
  if (item.fontSize) styles.push(`font-size:${Math.max(12, Math.min(96, Number(item.fontSize) || 20))}px`);
  if (item.bold) styles.push('font-weight:800');
  if (item.italic) styles.push('font-style:italic');
  if (item.align) styles.push(`text-align:${['left', 'center', 'right'].includes(item.align) ? item.align : 'center'}`);
  return styles.length ? ` style="${htmlEscape(styles.join(';'))}"` : '';
}

function renderInlineText(text = '', projectTitle = '', item = {}) {
  if (item.preserveLineBreaks) {
    const lines = String(text || '').replace(/\r/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    return `<div class="media-caption"${textStyleAttr(item)}>${lines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</div>`;
  }
  const lines = normalizedMetaLines([{ text }], projectTitle);
  if (!lines.length) return '';
  return `<div class="media-caption"${textStyleAttr(item)}>${lines.map(line => `<div>${htmlEscape(line)}</div>`).join('')}</div>`;
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

function renderOrderedContent(project, options = {}) {
  const skipText = !!options.skipText;
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
    if (skipText && item.type === 'text') return '';
    if (item.type === 'text') return renderInlineText(item.text, project.title, item);
    if (item.type === 'image') return renderImage(project.images?.[item.imageIndex], project.slug, project.title, item);
    if (item.type === 'video') return renderVideo(project.videos?.[item.videoIndex], project.slug, item.videoIndex === 0 ? poster : null, item);
    if (item.type === 'audio') return renderAudio(project.audios?.[item.audioIndex], project.slug);
    if (item.type === 'document') return renderDocument(project.documents?.[item.documentIndex], project.slug, item);
    if (item.type === 'gallery') return renderGallery(item.imageIndexes, project);
    return '';
  }).filter(Boolean).join('\n');
  return html ? `<section class="media-stack source-order">${html}</section>` : renderFallbackMedia(project);
}

function renderSourceClone(project) {
  if (!project.sourceCloneHtml) return '';
  const wrapperStyle = project.sourceCloneStyle ? ` style="${htmlEscape(project.sourceCloneStyle)}"` : '';
  return `<section class="source-clone"${wrapperStyle}>${hydrateSourceCloneMedia(project.sourceCloneHtml, project)}</section>`;
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
  if (manifest.sourcePlatform === 'behance') return '';
  const linkedProjectSlugs = new Set((manifest.projects || []).map(p => p.slug));
  const projects = linkedProjectSlugs.size > 1 ? manifest.projects : (manifest.relatedProjects || manifest.projects || []);
  const cards = projects.map(p => {
    const localThumb = p.thumbnail?.thumbSrc
      ? relFromPage(currentProject.slug, p.thumbnail.thumbSrc)
      : p.thumbnail?.src
        ? relFromPage(currentProject.slug, p.thumbnail.src)
        : (p.images?.[0]?.thumbSrc ? relFromPage(currentProject.slug, p.images[0].thumbSrc) : (p.images?.[0]?.src ? relFromPage(currentProject.slug, p.images[0].src) : ''));
    const thumb = localThumb || p.thumbnailUrl || '';
    const href = p.slug === currentProject.slug ? '#' : linkedProjectSlugs.has(p.slug) ? `../${htmlEscape(p.slug)}/` : htmlEscape(p.url || '#');
    const media = thumb
      ? `<img src="${htmlEscape(thumb)}" alt="${htmlEscape(p.title)}" loading="lazy" decoding="async">`
      : `<div class="work-card-placeholder">${(p.videos || []).length ? 'Video' : (p.documents || []).length ? 'PDF' : 'Work'}</div>`;
    return `<a class="work-card" href="${href}">${media}<span>${htmlEscape(p.title)}</span></a>`;
  }).join('\n');
  if (!cards) return '';
  return `<section class="project-footer-grid"><a class="back-link" href="../../index.html">Back to Work</a><div class="work-grid">${cards}</div></section>`;
}

function renderImportedSourceContent(project, cloneHtml) {
  if (cloneHtml) return cloneHtml;
  const description = renderSourceDescription(project);
  if (project.sourcePlatform === 'behance') {
    const ordered = renderOrderedContent(project, { skipText: true });
    const details = renderBehanceCampaignDetails(project);
    return `${ordered}${details}`;
  }
  const ordered = renderOrderedContent(project, { skipText: !!description });
  if (!description) return ordered;
  return `<section class="source-replica-layout"><div class="source-replica-main">${ordered}</div>${description}</section>`;
}

function renderSourceHeader(project) {
  const brand = cleanTitle(project.sourceBrand || '').replace(/^Untitled$/i, '') || '';
  if (!brand) return '';
  return `<header class="source-import-header"><a href="../../index.html">${htmlEscape(brand)}</a><nav><a href="../../index.html">Work</a><span>Art</span><a href="../../about.html">About</a></nav></header>`;
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

function addLazyMediaAttributes(html, eagerImageCount = 2) {
  const $ = cheerio.load(String(html || ''), { decodeEntities: false }, false);
  $('img').each((index, el) => {
    const img = $(el);
    if (!img.attr('loading')) img.attr('loading', index < eagerImageCount ? 'eager' : 'lazy');
    if (!img.attr('decoding')) img.attr('decoding', 'async');
    if (index < eagerImageCount && !img.attr('fetchpriority')) img.attr('fetchpriority', 'high');
  });
  $('iframe').each((_, el) => {
    const frame = $(el);
    if (!frame.attr('loading')) frame.attr('loading', 'lazy');
  });
  return $.root().html();
}

function parseVideoConfig(value = '') {
  try {
    return JSON.parse(String(value || '').replace(/&quot;/g, '"'));
  } catch {
    return null;
  }
}

function matchingExtractedVideo(config = {}, videos = []) {
  const alexandriaUrl = String(config.alexandriaUrl || '').replace('{variant}', 'playlist.m3u8');
  const systemDataId = String(config.systemDataId || config.id || '');
  return videos.find(video => {
    const haystack = `${video.original || ''} ${video.src || ''}`;
    return (alexandriaUrl && haystack.includes(alexandriaUrl)) || (systemDataId && haystack.includes(systemDataId));
  }) || videos.find(video => video.type === 'hls' || video.type === 'video');
}

function sourceCloneVideoHtml(video, projectSlug, poster = '') {
  if (!video?.src) return '';
  const src = relFromPage(projectSlug, video.src);
  const posterAttr = poster ? ` poster="${htmlEscape(poster)}"` : '';
  if (video.kind === 'iframe' || video.type === 'iframe' || mediaType(src) === 'youtube' || mediaType(src) === 'vimeo') {
    return `<div class="killerwork-source-video"><iframe src="${htmlEscape(src)}" title="Video" loading="lazy" allowfullscreen></iframe></div>`;
  }
  if (video.type === 'hls' || mediaType(src) === 'hls') {
    return `<div class="killerwork-source-video"><video class="hls-video" controls playsinline preload="metadata"${posterAttr} data-hls-src="${htmlEscape(src)}"></video></div>`;
  }
  return `<div class="killerwork-source-video"><video controls playsinline preload="metadata"${posterAttr} src="${htmlEscape(src)}"></video></div>`;
}

function hydrateSourceCloneMedia(html, project) {
  const $ = cheerio.load(addLazyMediaAttributes(html, 2), { decodeEntities: false }, false);
  $('.sqs-native-video[data-config-video]').each((_, el) => {
    const node = $(el);
    const config = parseVideoConfig(node.attr('data-config-video'));
    const video = matchingExtractedVideo(config, project.videos || []);
    if (!video) return;
    const poster = node.find('video[poster]').attr('poster') || node.find('video').attr('data-poster') || '';
    const replacement = sourceCloneVideoHtml(video, project.slug, poster);
    if (replacement) node.replaceWith(replacement);
  });
  $('video').each((_, el) => {
    const video = $(el);
    if (!video.attr('src') && !video.attr('data-hls-src') && !video.find('source[src]').length) {
      const native = video.closest('.sqs-native-video[data-config-video]');
      const config = parseVideoConfig(native.attr('data-config-video'));
      const extracted = matchingExtractedVideo(config, project.videos || []);
      if (extracted?.src) {
        if (extracted.type === 'hls' || mediaType(extracted.src) === 'hls') {
          video.addClass('hls-video');
          video.attr('data-hls-src', relFromPage(project.slug, extracted.src));
        } else {
          video.attr('src', relFromPage(project.slug, extracted.src));
        }
        video.attr('controls', '');
        video.attr('playsinline', '');
        video.attr('preload', 'metadata');
      }
    }
  });
  return $.root().html();
}

function rewriteHomeLinks(html, projects = [], sourceUrl = '') {
  let out = String(html || '');
  const byPath = new Map();
  let sourceOrigin = '';
  try { sourceOrigin = new URL(sourceUrl).origin; } catch {}
  for (const project of projects || []) {
    if (!project?.url || !project?.slug) continue;
    try {
      const path = new URL(project.url).pathname.replace(/\/$/, '') || '/';
      byPath.set(path, `work/${project.slug}/`);
    } catch {}
  }
  const localTarget = (rawPath = '/', suffix = '') => {
    const normalized = `/${String(rawPath || '').replace(/^\/+/, '')}`.replace(/\/$/, '') || '/';
    if (normalized === '/' || normalized === '/work' || normalized === '/portfolio' || normalized === '/projects') return 'index.html';
    if (/^\/(?:about|about-us|contact|contact-us)(?:\/|$)/i.test(normalized)) return 'about.html';
    const local = byPath.get(normalized);
    if (local) return local;
    return sourceOrigin ? `${sourceOrigin}${normalized}${suffix || ''}` : '';
  };
  if (sourceOrigin) {
    const escapedOrigin = sourceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b(href|data-url)="${escapedOrigin}(/[^"#?]*)?([^"]*)"`, 'g'), (match, attr, rawPath = '/', suffix = '') => {
      const target = localTarget(rawPath, suffix);
      return target ? `${attr}="${target}"` : match;
    });
  }
  out = out.replace(/\b(href|data-url)="\/([^"#?]*)([^"]*)"/g, (match, attr, path, suffix) => {
    const target = localTarget(`/${path}`, suffix);
    return target ? `${attr}="${target}"` : match;
  });
  return out;
}

function rewriteProjectCloneLinks(html, projects = [], sourceUrl = '') {
  let out = String(html || '');
  const byPath = new Map();
  let sourceOrigin = '';
  try { sourceOrigin = new URL(sourceUrl).origin; } catch {}
  for (const project of projects || []) {
    if (!project?.url || !project?.slug) continue;
    try {
      const path = new URL(project.url).pathname.replace(/\/$/, '') || '/';
      byPath.set(path, `../${project.slug}/`);
    } catch {}
  }
  const localTarget = (rawPath = '/', suffix = '') => {
    const normalized = `/${String(rawPath || '').replace(/^\/+/, '')}`.replace(/\/$/, '') || '/';
    if (normalized === '/' || normalized === '/work' || normalized === '/portfolio' || normalized === '/projects') return '../../index.html';
    if (/^\/(?:about|about-us|contact|contact-us)(?:\/|$)/i.test(normalized)) return '../../about.html';
    const local = byPath.get(normalized);
    if (local) return local;
    return sourceOrigin ? `${sourceOrigin}${normalized}${suffix || ''}` : '';
  };
  if (sourceOrigin) {
    const escapedOrigin = sourceOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b(href|data-url)="${escapedOrigin}(/[^"#?]*)?([^"]*)"`, 'g'), (match, attr, rawPath = '/', suffix = '') => {
      const target = localTarget(rawPath, suffix);
      return target ? `${attr}="${target}"` : match;
    });
  }
  return out.replace(/\b(href|data-url)="\/([^"#?]*)([^"]*)"/g, (match, attr, path, suffix) => {
    const target = localTarget(`/${path}`, suffix);
    return target ? `${attr}="${target}"` : match;
  });
}

function rewriteCrossOriginSvgSprites(html) {
  return String(html || '').replace(/(\s(?:xlink:href|href)=["'])(?:https?:)?\/\/[^"']+\.svg#([^"']+)(["'])/gi, '$1#$2$3');
}

function hiddenSvgDefs(defs = '') {
  return defs ? `<div hidden style="display:none">${defs}</div>` : '';
}

function findSourceAboutUrl(sourceHome = {}, sourceUrl = '') {
  if (!sourceHome?.html || !sourceUrl) return '';
  const $ = cheerio.load(sourceHome.html);
  const candidates = [];
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '');
    const text = String($(el).text() || '').trim();
    const score = /about/i.test(text) ? 4 : /contact/i.test(text) ? 3 : /about|contact/i.test(href) ? 2 : 0;
    if (!score) return;
    try {
      const resolved = new URL(href, sourceUrl);
      if (resolved.origin !== new URL(sourceUrl).origin) return;
      candidates.push({ url: resolved.href, score });
    } catch {}
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

function mergeStyle(...parts) {
  return parts
    .map(part => String(part || '').trim().replace(/;+$/, ''))
    .filter(Boolean)
    .join(';');
}

function highContrastTextColor(backgroundColor = '', fallback = '') {
  const value = String(backgroundColor || '').trim();
  let channels = null;
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const normalized = hex.length === 3 ? hex.split('').map(char => `${char}${char}`).join('') : hex;
    channels = [0, 2, 4].map(offset => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  } else {
    const rgb = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
    if (rgb) channels = rgb.slice(1, 4).map(Number);
  }
  if (!channels) return fallback;
  const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
  return luminance >= 160 ? '#111111' : '#ffffff';
}

function renderCampaignBuilderHeader(manifest, prefix = '') {
  const title = manifest.homeTitle || manifest.ownerName || 'Portfolio';
  const intro = manifest.homeIntro ? `<span>${htmlEscape(manifest.homeIntro)}</span>` : '';
  return `<header class="site-header campaign-builder-site-header"><a class="campaign-builder-brand" href="${prefix}index.html"><strong>${htmlEscape(title)}</strong>${intro}</a><nav><a href="${prefix}index.html">Work</a><a href="${prefix}about.html">About</a></nav></header>`;
}

function renderStandardSiteHeader(manifest, prefix = '', includeReview = false) {
  const owner = manifest.ownerName || manifest.homeTitle || 'Portfolio';
  const reviewLink = includeReview ? `<a href="${prefix}import-review.html">Review</a>` : '';
  return `<header class="site-header"><a class="brand" href="${prefix}index.html">${htmlEscape(owner)}</a><nav><a href="${prefix}index.html">Work</a><a href="${prefix}about.html">About</a>${reviewLink}</nav></header>`;
}

function parseBrandCampaignFromTitle(project = {}) {
  const title = cleanTitle(project.title || '');
  const aiBrand = cleanTitle(project?.cleaned?.brand || '');
  const aiCampaign = cleanTitle(project?.cleaned?.campaign || '');
  if (aiBrand && aiCampaign) return { brand: aiBrand, campaign: aiCampaign };
  const metadata = Array.isArray(project?.cleaned?.metadata) ? project.cleaned.metadata.map(item => String(item || '').trim()) : [];
  const joined = metadata.join(' | ');
  const brandMatch = joined.match(/\bbrand\s*[:\-]\s*([^|]+?)(?=\s+\b(?:campaign|agency|role)\b\s*[:\-]|$)/i);
  const campaignMatch = joined.match(/\bcampaign\s*[:\-]\s*([^|]+?)(?=\s+\b(?:brand|agency|role)\b\s*[:\-]|$)/i);
  const fromMetaBrand = cleanTitle(brandMatch?.[1] || '');
  const fromMetaCampaign = cleanTitle(campaignMatch?.[1] || '');
  if (fromMetaBrand && fromMetaCampaign) return { brand: fromMetaBrand, campaign: fromMetaCampaign };
  const split = title.match(/^\s*([^:|\-–—]+?)\s*[:|\-–—]\s+(.+?)\s*$/);
  if (split) {
    return {
      brand: cleanTitle(split[1] || ''),
      campaign: cleanTitle(split[2] || '')
    };
  }
  return { brand: '', campaign: title };
}

function renderHomePage(manifest, cards) {
  const sourceHome = manifest.sourceHome || {};
  const ownerTitle = manifest.ownerName || manifest.homeTitle || 'Portfolio';
  if (sourceHome.html && !manifest.homeOverride) {
    const pageVars = [
      sourceHome.backgroundColor ? `--bg:${sourceHome.backgroundColor}` : '',
      sourceHome.textColor ? `--fg:${sourceHome.textColor}` : '',
      sourceHome.textColor ? `--muted:${sourceHome.textColor}` : ''
    ].filter(Boolean).join(';');
    const wrapperStyle = sourceHome.style ? ` style="${htmlEscape(sourceHome.style)}"` : '';
    const html = rewriteCrossOriginSvgSprites(rewriteHomeLinks(sourceHome.html, manifest.projects, manifest.sourceUrl));
    const htmlClass = sourceHome.sourceHtmlClass ? ` class="${htmlEscape(sourceHome.sourceHtmlClass)}"` : '';
    const htmlStyle = sourceHome.sourceHtmlStyle ? ` style="${htmlEscape(sourceHome.sourceHtmlStyle)}"` : '';
    const htmlId = sourceHome.sourceHtmlId ? ` id="${htmlEscape(sourceHome.sourceHtmlId)}"` : '';
    const bodyClass = ['source-home', sourceHome.sourceBodyClass].filter(Boolean).join(' ');
    const bodyStyle = mergeStyle(pageVars, sourceHome.sourceBodyStyle);
    const bodyId = sourceHome.sourceBodyId ? ` id="${htmlEscape(sourceHome.sourceBodyId)}"` : '';
    return `<!doctype html><html lang="en"${htmlId}${htmlClass}${htmlStyle}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(ownerTitle)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico">${styleTag(sourceHome.sourceCss)}</head><body${bodyId} class="${htmlEscape(bodyClass)}"${bodyStyle ? ` style="${htmlEscape(bodyStyle)}"` : ''}>${hiddenSvgDefs(sourceHome.sourceSvgDefs)}<main class="source-home-page"${wrapperStyle}>${html}</main><script>document.querySelectorAll('[data-url]').forEach(function(el){el.tabIndex=0;el.style.cursor='pointer';function go(){var u=el.getAttribute('data-url');if(u) location.href=u;}el.addEventListener('click',go);el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});});</script></body></html>`;
  }
  const homeClass = manifest.sourcePlatform === 'behance' ? 'home behance-home' : 'home';
  const title = manifest.homeTitle || manifest.ownerName;
  const intro = manifest.homeIntro ? `<p class="intro">${htmlEscape(manifest.homeIntro)}</p>` : '';
  if (manifest.sourceUrl === 'campaign-builder') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body class="campaign-builder-home">${renderCampaignBuilderHeader(manifest)}<main class="${homeClass}"><section class="work-grid">${cards}</section></main></body></html>`;
  }
  const hero = manifest.sourcePlatform === 'behance' ? '' : `<h1>${htmlEscape(title)}</h1>`;
  const bodyClass = manifest.sourcePlatform === 'behance' ? ' class="behance-site"' : '';
  const includeReview = manifest.sourcePlatform !== 'behance';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(ownerTitle)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body${bodyClass}>${renderStandardSiteHeader(manifest, '', includeReview)}<main class="${homeClass}">${hero}${intro}<section class="work-grid">${cards}</section></main></body></html>`;
}

function renderAboutPage(manifest) {
  const sourceAbout = manifest.sourceAbout || {};
  if (sourceAbout.html) {
    const html = rewriteCrossOriginSvgSprites(rewriteHomeLinks(sourceAbout.html, manifest.projects, manifest.sourceUrl));
    const htmlClass = sourceAbout.sourceHtmlClass ? ` class="${htmlEscape(sourceAbout.sourceHtmlClass)}"` : '';
    const htmlStyle = sourceAbout.sourceHtmlStyle ? ` style="${htmlEscape(sourceAbout.sourceHtmlStyle)}"` : '';
    const htmlId = sourceAbout.sourceHtmlId ? ` id="${htmlEscape(sourceAbout.sourceHtmlId)}"` : '';
    const bodyClass = ['source-home', sourceAbout.sourceBodyClass].filter(Boolean).join(' ');
    const bodyId = sourceAbout.sourceBodyId ? ` id="${htmlEscape(sourceAbout.sourceBodyId)}"` : '';
    return `<!doctype html><html lang="en"${htmlId}${htmlClass}${htmlStyle}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(sourceAbout.title || `About — ${manifest.ownerName}`)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico">${styleTag(sourceAbout.sourceCss)}</head><body${bodyId} class="${htmlEscape(bodyClass)}"${sourceAbout.sourceBodyStyle ? ` style="${htmlEscape(sourceAbout.sourceBodyStyle)}"` : ''}>${hiddenSvgDefs(sourceAbout.sourceSvgDefs)}<main class="source-home-page"${sourceAbout.style ? ` style="${htmlEscape(sourceAbout.style)}"` : ''}>${html}</main><script>document.querySelectorAll('[data-url]').forEach(function(el){el.tabIndex=0;el.style.cursor='pointer';function go(){var u=el.getAttribute('data-url');if(u) location.href=u;}el.addEventListener('click',go);el.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});});</script></body></html>`;
  }
  const profile = manifest.aboutProfile || {};
  const name = profile.name || manifest.ownerName || 'About';
  const image = profile.image?.src ? relFromPage('', profile.image.src) : '';
  const roleLine = [profile.role, profile.agency, profile.location].filter(Boolean).join(' / ');
  const paragraphHtml = (profile.paragraphs || [])
    .filter(Boolean)
    .map(text => `<p>${htmlEscape(text)}</p>`)
    .join('');
  const contactHtml = [
    profile.email ? `<a href="mailto:${htmlEscape(profile.email)}">${htmlEscape(profile.email)}</a>` : '',
    profile.phone ? `<a href="tel:${htmlEscape(String(profile.phone).replace(/[^+\d]/g, ''))}">${htmlEscape(profile.phone)}</a>` : ''
  ].filter(Boolean).join('');
  const linkHtml = (profile.links || [])
    .map(link => `<a href="${htmlEscape(link.url)}" target="_blank" rel="noopener">${htmlEscape(link.label || socialLabel(link.url))}</a>`)
    .join('');
  if (!manifest.aboutProfile) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About — ${htmlEscape(manifest.ownerName)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body><header class="site-header"><a class="brand" href="index.html">${htmlEscape(manifest.ownerName)}</a><nav><a href="index.html">Work</a><a href="about.html">About</a></nav></header><main class="project-page"><h1>About</h1></main></body></html>`;
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About — ${htmlEscape(name)}</title><link rel="stylesheet" href="styles.css"><link rel="icon" href="favicon.ico"></head><body>${renderStandardSiteHeader(manifest)}<main class="about-page">
    <section class="about-editorial">
      <div class="about-image-wrap">${image ? `<img class="about-portrait" src="${htmlEscape(image)}" alt="${htmlEscape(name)}" loading="eager">` : '<div class="about-portrait about-portrait-placeholder">About</div>'}</div>
      <div class="about-copy">
        <p class="about-kicker">About</p>
        <h1>${htmlEscape(name)}</h1>
        <p class="about-role">${htmlEscape(roleLine || 'Creative profile')}</p>
        <div class="about-story">${paragraphHtml}</div>
      </div>
    </section>
    ${(contactHtml || linkHtml) ? `<section class="about-contact"><div>${contactHtml}</div><nav>${linkHtml}</nav></section>` : ''}
  </main></body></html>`;
}

export async function generateSite(manifest, outDir, progress) {
  const siteDir = path.join(outDir, 'site');
  const jobId = path.basename(outDir);
  const stagingAssetsDir = path.join(outDir, 'assets-imported');
  await fs.ensureDir(stagingAssetsDir);
  const cssCache = new Map();
  if (manifest.sourceHome?.sourceCss) manifest.sourceHome.sourceCss = await localizeCssImports(manifest.sourceHome.sourceCss, 0, stagingAssetsDir, progress, cssCache);
  if (manifest.sourceAbout?.sourceCss) manifest.sourceAbout.sourceCss = await localizeCssImports(manifest.sourceAbout.sourceCss, 0, stagingAssetsDir, progress, cssCache);
  for (const project of manifest.projects || []) {
    if (project.sourceCss) project.sourceCss = await localizeCssImports(project.sourceCss, 2, stagingAssetsDir, progress, cssCache);
  }
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
    const thumb = p.thumbnail?.thumbSrc
      ? relFromPage('', p.thumbnail.thumbSrc)
      : p.thumbnail?.src
        ? relFromPage('', p.thumbnail.src)
        : (p.images?.[0]?.thumbSrc ? relFromPage('', p.images[0].thumbSrc) : (p.images?.[0]?.src ? relFromPage('', p.images[0].src) : ''));
    const media = thumb
      ? `<img src="${htmlEscape(thumb)}" alt="${htmlEscape(p.title)}" loading="lazy" decoding="async">`
      : `<div class="work-card-placeholder">${(p.videos || []).length ? 'Video' : (p.documents || []).length ? 'PDF' : 'Work'}</div>`;
    return `<a class="work-card" href="work/${htmlEscape(p.slug)}/">${media}<span>${htmlEscape(p.title)}</span></a>`;
  }).join('\n');

  await fs.writeFile(path.join(siteDir, 'index.html'), renderHomePage(manifest, cards));

  await fs.writeFile(path.join(siteDir, 'about.html'), renderAboutPage(manifest));

  for (const p of manifest.projects) {
    const dir = path.join(siteDir, 'work', p.slug);
    await fs.ensureDir(dir);
    p.images = p.images || [];
    p.videos = p.videos || [];
    p.audios = p.audios || [];
    p.documents = p.documents || [];
    const cloneHtml = p.sourcePlatform === 'behance' ? '' : renderSourceClone(p);
    const isSourceReplica = !!(cloneHtml || p.sourceCloneHtml);
    if (cloneHtml) {
      const pageVars = [
        p.pageStyle?.backgroundColor ? `--bg:${p.pageStyle.backgroundColor}` : '',
        p.pageStyle?.textColor ? `--fg:${p.pageStyle.textColor}` : '',
        p.pageStyle?.textColor ? `--muted:${p.pageStyle.textColor}` : ''
      ].filter(Boolean).join(';');
      const title = p.sourcePageTitle || `${p.title} — ${manifest.ownerName}`;
      const rewrittenClone = rewriteCrossOriginSvgSprites(rewriteProjectCloneLinks(cloneHtml, manifest.projects, manifest.sourceUrl));
      const htmlClass = p.sourceHtmlClass ? ` class="${htmlEscape(p.sourceHtmlClass)}"` : '';
      const htmlStyle = p.sourceHtmlStyle ? ` style="${htmlEscape(p.sourceHtmlStyle)}"` : '';
      const htmlId = p.sourceHtmlId ? ` id="${htmlEscape(p.sourceHtmlId)}"` : '';
      const bodyClass = ['source-exact', p.sourceBodyClass].filter(Boolean).join(' ');
      const bodyStyle = mergeStyle(pageVars, p.sourceBodyStyle);
      const bodyId = p.sourceBodyId ? ` id="${htmlEscape(p.sourceBodyId)}"` : '';
      const needsHls = p.videos.some(v => v.type === 'hls' || mediaType(v.src) === 'hls') || /class=["'][^"']*\bhls-video\b/i.test(rewrittenClone);
      await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"${htmlId}${htmlClass}${htmlStyle}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><link rel="icon" href="../../favicon.ico"><link rel="stylesheet" href="../../styles.css">${styleTag(p.sourceCss)}</head><body${bodyId} class="${htmlEscape(bodyClass)}"${bodyStyle ? ` style="${htmlEscape(bodyStyle)}"` : ''}>${hiddenSvgDefs(p.sourceSvgDefs)}<main class="source-exact-page">${rewrittenClone}</main>${needsHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script><script src="../../hls-player.js"></script>' : ''}</body></html>`);
      continue;
    }
    const mediaHtml = renderImportedSourceContent(p, cloneHtml);
    const footerGrid = renderProjectFooterGrid(manifest, p);
    const meta = renderMetaBlocks(p, { includeTitle: manifest.sourceUrl === 'campaign-builder' });
    const hasInlineText = cloneHtml || (p.contentItems || []).some(item => item.type === 'text');
    const showMeta = !hasInlineText ? meta : '';
    const intro = '';
    const needsHls = p.videos.some(v => v.type === 'hls' || mediaType(v.src) === 'hls');
    const needsGallery = (p.contentItems || []).some(item => item.type === 'gallery');
    const rightsNote = `<footer class="source-note">&copy; ${htmlEscape(manifest.ownerName || p.title || 'Portfolio')}. All rights reserved.</footer>`;
    const textColor = manifest.sourcePlatform === 'behance'
      ? highContrastTextColor(p.pageStyle?.backgroundColor, p.pageStyle?.textColor)
      : p.pageStyle?.textColor;
    const pageVars = [
      p.pageStyle?.backgroundColor ? `--bg:${p.pageStyle.backgroundColor}` : '',
      textColor ? `--fg:${textColor}` : '',
      textColor ? `--muted:${textColor}` : ''
    ].filter(Boolean).join(';');
    const layoutClass = p.aiLayout ? ` ai-layout-${String(p.aiLayout).replace(/[^a-z-]/g, '')}` : '';
    const mainStyle = p.pageStyle?.contentWidth ? ` style="max-width:${Math.max(760, Math.round(p.pageStyle.contentWidth))}px"` : '';
    const sourceHeader = renderSourceHeader(p);
    const subtitleHtml = p.subtitle ? `<p class="project-subhead">${htmlEscape(p.subtitle)}</p>` : '';
    const titleStyle = p.titleFontSize ? ` style="font-size:${Math.max(28, Math.min(120, Number(p.titleFontSize) || 82))}px"` : '';
    const parsedTitle = parseBrandCampaignFromTitle(p);
    const campaignTitleHtml = manifest.sourcePlatform === 'behance' && parsedTitle.brand
      ? `<h1 class="campaign-title-split"${titleStyle}><span>${htmlEscape(parsedTitle.brand)}</span><small>${htmlEscape(parsedTitle.campaign)}</small></h1>`
      : `<h1${titleStyle}>${htmlEscape(p.title)}</h1>`;
    const backLink = manifest.sourcePlatform === 'behance' ? '' : '<a class="back-link" href="../../index.html">← Work</a>';
    const headerHtml = isSourceReplica
      ? sourceHeader
      : manifest.sourceUrl === 'campaign-builder'
        ? ''
        : `<header class="project-header">${backLink}${campaignTitleHtml}${subtitleHtml}</header>`;
    const campaignHeader = manifest.sourceUrl === 'campaign-builder' ? renderCampaignBuilderHeader(manifest, '../../') : '';
    const defaultHeader = manifest.sourcePlatform === 'behance' ? renderStandardSiteHeader(manifest, '../../') : '';
    await fs.writeFile(path.join(dir, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(p.title)} — ${htmlEscape(manifest.ownerName)}</title><link rel="icon" href="../../favicon.ico"><link rel="stylesheet" href="../../styles.css">${styleTag(p.sourceCss)}</head><body class="project${isSourceReplica ? ' source-replica' : ''}${manifest.sourceUrl === 'campaign-builder' ? ' campaign-builder-project' : ''}${manifest.sourcePlatform === 'behance' ? ' behance-project' : ''}"${pageVars ? ` style="${htmlEscape(pageVars)}"` : ''}>${campaignHeader || defaultHeader}<main class="project-page${layoutClass}"${mainStyle}>${headerHtml}${mediaHtml}${showMeta}${footerGrid}${rightsNote}</main>${needsHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script><script src="../../hls-player.js"></script>' : ''}${needsGallery ? '<script src="../../portfolio.js"></script>' : ''}<script src="/portfolio-loader.js?v=20260531-behance-spacing"></script></body></html>`);
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
    if (/(?:href|xlink:href)="(?:https?:)?\/\/[^"]+\.svg#[^"]+"/i.test(html)) errors.push({ file: path.relative(siteDir, file), error: 'cross-origin SVG sprite reference found' });
    const refs = [...html.matchAll(/(?:src|href|poster)="([^"]+)"/g)].map(m => m[1]).filter(r => r && !r.startsWith('http') && !r.startsWith('//') && !r.startsWith('#') && !r.startsWith('mailto:') && !r.startsWith('tel:'));
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
  const behance = isBehanceUrl(url);

  let projects = [];
  let relatedProjects = [];
  let sourceHome = null;
  let sourceAbout = null;
  let sourceOwnerName = siteUrl.hostname.replace(/^www\./, '');
  let aboutProfile = null;
  let aboutProfileImageUrl = '';
  if (behance && isBehanceProfilePath(inputPath)) {
    progress('Scanning Behance profile', url);
    const behanceData = await getBehanceProjects(page, url, progress);
    projects = behanceData.projects;
    sourceOwnerName = behanceData.profileName || sourceOwnerName;
    aboutProfile = behanceData.profile || null;
    aboutProfileImageUrl = behanceData.profileImageUrl || behanceData.profile?.imageUrl || '';
  } else if (inputPath !== '/' && isLikelyProjectPath(inputPath)) {
    progress('Submitted project URL', url);
    projects = [submittedProjectCandidate(url)];
    relatedProjects = behance
      ? (await getBehanceProjects(page, siteUrl.origin, progress).catch(() => ({ projects: [] }))).projects
      : await getHomepageProjects(page, siteUrl.origin, progress).catch(() => []);
    const submittedPath = normalizeDiscoveryPath(url);
    const homepageMatch = relatedProjects.find(project => normalizeDiscoveryPath(project.url) === submittedPath);
    if (homepageMatch) projects = [{ ...projects[0], ...homepageMatch, strategy: projects[0].strategy, score: 1000 }];
  } else {
    progress('Scanning homepage', url);
    projects = await getHomepageProjects(page, url, progress);
    sourceHome = await extractHomePage(page, url, progress).catch((e) => {
      progress('Homepage clone warning', e.message);
      return null;
    });
    const aboutUrl = findSourceAboutUrl(sourceHome, url);
    if (aboutUrl) {
      progress('Scanning about page', aboutUrl);
      sourceAbout = await extractHomePage(page, aboutUrl, progress).catch((e) => {
        progress('About clone warning', e.message);
        return null;
      });
    }
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
  const rawManifest = {
    sourceUrl: url,
    sourcePlatform: behance ? 'behance' : 'website',
    siteTitle: sourceHome?.title || (behance && sourceOwnerName ? `${sourceOwnerName} Portfolio` : 'Imported Portfolio'),
    ownerName: sourceOwnerName,
    relatedProjects,
    sourceHome: null,
    sourceAbout: null,
    aboutProfile,
    projects: [],
    generatedAt: new Date().toISOString()
  };

  if (aboutProfile && aboutProfileImageUrl) {
    progress('Downloading profile image', aboutProfileImageUrl);
    const dl = await downloadAsset(normalizeUrl(aboutProfileImageUrl, url), assetsDir, progress, cache);
    if (dl?.src && dl.type === 'image') {
      rawManifest.aboutProfile.image = { src: dl.src, original: aboutProfileImageUrl };
    }
  }

  if (sourceHome?.html) {
    const replacements = [];
    const uniqueAssets = [...new Set(sourceHome.assets || [])].slice(0, 160);
    progress('Downloading homepage assets', `${uniqueAssets.length} unique image refs`);
    for (const assetUrl of uniqueAssets) {
      const dl = await downloadAsset(normalizeUrl(assetUrl, url), assetsDir, progress, cache);
      if (dl?.src && dl.type === 'image') replacements.push({ from: assetUrl, to: relFromPage('', dl.thumbSrc || dl.src) });
    }
    rawManifest.sourceHome = {
      title: sourceHome.title,
      style: sourceHome.style,
      backgroundColor: sourceHome.backgroundColor,
      textColor: sourceHome.textColor,
      sourceCss: sourceHome.sourceCss || '',
      sourceSvgDefs: sourceHome.sourceSvgDefs || '',
      sourceHtmlClass: sourceHome.sourceHtmlClass || '',
      sourceHtmlStyle: sourceHome.sourceHtmlStyle || '',
      sourceHtmlId: sourceHome.sourceHtmlId || '',
      sourceBodyClass: sourceHome.sourceBodyClass || '',
      sourceBodyStyle: sourceHome.sourceBodyStyle || '',
      sourceBodyId: sourceHome.sourceBodyId || '',
      html: addLazyMediaAttributes(rewriteCloneAssetUrls(sourceHome.html, replacements), 2)
    };
  }

  if (sourceAbout?.html) {
    const replacements = [];
    const uniqueAssets = [...new Set(sourceAbout.assets || [])].slice(0, 160);
    progress('Downloading about assets', `${uniqueAssets.length} unique image refs`);
    for (const assetUrl of uniqueAssets) {
      const dl = await downloadAsset(normalizeUrl(assetUrl, sourceAbout.url || url), assetsDir, progress, cache);
      if (dl?.src && dl.type === 'image') replacements.push({ from: assetUrl, to: relFromPage('', dl.src) });
    }
    rawManifest.sourceAbout = {
      title: sourceAbout.title,
      style: sourceAbout.style,
      backgroundColor: sourceAbout.backgroundColor,
      textColor: sourceAbout.textColor,
      sourceCss: sourceAbout.sourceCss || '',
      sourceSvgDefs: sourceAbout.sourceSvgDefs || '',
      sourceHtmlClass: sourceAbout.sourceHtmlClass || '',
      sourceHtmlStyle: sourceAbout.sourceHtmlStyle || '',
      sourceHtmlId: sourceAbout.sourceHtmlId || '',
      sourceBodyClass: sourceAbout.sourceBodyClass || '',
      sourceBodyStyle: sourceAbout.sourceBodyStyle || '',
      sourceBodyId: sourceAbout.sourceBodyId || '',
      html: addLazyMediaAttributes(rewriteCloneAssetUrls(sourceAbout.html, replacements), 2)
    };
  }

  for (let i = 0; i < projects.length; i++) {
    const base = { ...projects[i] };
    const pProgress = `${i + 1}/${projects.length}`;
    progress(`Crawling project ${pProgress}`, base.title);
    let data = behance && isBehanceGalleryPath(normalizeDiscoveryPath(base.url))
      ? await extractBehanceProject(page, base.url, progress)
      : await extractPage(page, base.url, siteUrl.origin, progress);
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
          thumbSrc: dl.thumbSrc || '',
          thumbLocalFile: dl.thumbLocalFile || '',
          thumbWidth: dl.thumbWidth || 0,
          thumbHeight: dl.thumbHeight || 0,
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
      if (dl?.src) thumbnail = { src: dl.src, thumbSrc: dl.thumbSrc || '', original: base.thumbnailUrl };
    }
    if (!thumbnail && data.thumbnailUrl) {
      const dl = await downloadAsset(normalizeUrl(data.thumbnailUrl, base.url), assetsDir, progress, cache);
      if (dl?.src) thumbnail = { src: dl.src, thumbSrc: dl.thumbSrc || '', original: data.thumbnailUrl };
    }
    if (!thumbnail && downloadedImages[0]) thumbnail = { src: downloadedImages[0].src, thumbSrc: downloadedImages[0].thumbSrc || '', original: downloadedImages[0].original };

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
      description: base.description || (data.copyBlocks || []).map(block => block.text || '').filter(Boolean).join('\n\n'),
      pageStyle: data.pageStyle || {},
      sourceBrand: data.sourceBrand || '',
      sourcePlatform: behance ? 'behance' : '',
      sourceCloneHtml,
      sourceCloneStyle: data.sourceCloneStyle || '',
      sourceCss: data.sourceCss || '',
      sourceSvgDefs: data.sourceSvgDefs || '',
      sourcePageTitle: data.sourcePageTitle || '',
      sourceHtmlClass: data.sourceHtmlClass || '',
      sourceHtmlStyle: data.sourceHtmlStyle || '',
      sourceHtmlId: data.sourceHtmlId || '',
      sourceBodyClass: data.sourceBodyClass || '',
      sourceBodyStyle: data.sourceBodyStyle || '',
      sourceBodyId: data.sourceBodyId || '',
      thumbnail,
      copyBlocks: data.copyBlocks,
      contentItems: enrichContentItems(data.contentItems, imageIndexByKey, videoIndexBySrc),
      images: downloadedImages,
      videos,
      warnings
    });
  }
  if (rawManifest.aboutProfile) {
    const existingBrands = new Set((rawManifest.aboutProfile.brands || []).map(value => String(value).toLowerCase()));
    const importedBrands = rawManifest.projects
      .map(project => String(project.title || '').split(/\s[-–—:]/)[0].trim())
      .filter(value => value && value.length > 2 && value.length < 32 && !existingBrands.has(value.toLowerCase()));
    rawManifest.aboutProfile.brands = [...(rawManifest.aboutProfile.brands || []), ...new Set(importedBrands)].slice(0, 10);
    if (rawManifest.aboutProfile.copyGenerated) {
      rawManifest.aboutProfile.paragraphs = composeGeneratedCareerParagraphs(rawManifest.aboutProfile);
    }
    delete rawManifest.aboutProfile.copyGenerated;
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

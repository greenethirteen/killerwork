import crypto from 'crypto';
import path from 'path';
import slugify from 'slugify';

export function safeSlug(input = 'project') {
  const s = slugify(String(input).replace(/—.*$/,'').trim(), { lower: true, strict: true });
  return s || 'project';
}

export function hash(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 12);
}

export function extFromUrl(url, fallback = '.jpg') {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname).split('?')[0].toLowerCase();
    if (ext && ext.length <= 8) return ext;
  } catch {}
  return fallback;
}

export function normalizeUrl(raw, base) {
  if (!raw) return '';
  let s = String(raw).trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:')) return '';
  if (s.startsWith('//')) s = 'https:' + s;
  try { return new URL(s, base).href; } catch { return ''; }
}

export function canonicalImageKey(url) {
  try {
    const u = new URL(url);
    let p = decodeURIComponent(u.pathname).toLowerCase();
    // Squarespace variants often use ?format=... or same filename at different sizes.
    p = p.replace(/\/content\/v1\/[^/]+\//, '/content/v1/site/');
    p = p.replace(/\/\d{10,}\//g, '/stamp/');
    p = p.replace(/\.(jpg|jpeg|png|webp|gif)$/i, m => m.toLowerCase());
    const parts = p.split('/').filter(Boolean);
    const file = parts.at(-1) || p;
    if (/^(image-asset|asset|thumbnail|untitled)\.(jpe?g|png|webp|gif)$/i.test(file)) {
      return parts.slice(-2).join('/') || file;
    }
    return file;
  } catch {
    return String(url).toLowerCase();
  }
}

export function isBadMediaUrl(url) {
  const s = String(url || '').toLowerCase();
  return !s || s.startsWith('blob:') || s.startsWith('data:') || s.includes('social-accounts') || s.endsWith('.svg') || s.includes('mpegts-') || s.endsWith('.bin') || s.endsWith('.ts') || s.includes('/segments/');
}

export function mediaType(url) {
  const s = String(url || '').toLowerCase();
  if (s.includes('youtube.com') || s.includes('youtu.be')) return 'youtube';
  if (s.includes('vimeo.com')) return 'vimeo';
  if (s.endsWith('.m3u8') || s.includes('.m3u8?')) return 'hls';
  if (s.match(/\.(mp4|webm|mov)(\?|$)/)) return 'video';
  return 'unknown';
}

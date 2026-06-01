import path from 'path';
import fs from 'fs-extra';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import { safeSlug } from './utils.js';

const MAX_ZIP_ENTRIES = 240;
const MAX_EXPANDED_BYTES = 600 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif',
  '.mp4', '.mov', '.webm', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac',
  '.pdf'
]);

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function titleCase(value = '') {
  return cleanText(String(value).replace(/[-_]+/g, ' '))
    .replace(/\b\w/g, char => char.toUpperCase());
}

function safeEntryName(value = '') {
  const normalized = String(value).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return '';
  const safe = path.posix.normalize(normalized);
  if (safe === '..' || safe.startsWith('../') || path.posix.isAbsolute(safe)) return '';
  return safe;
}

function campaignKey(relativePath = '') {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length > 1) return parts[0];
  return 'Uploaded work';
}

function alphaLabel(index = 0) {
  let number = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (number % 26)) + label;
    number = Math.floor(number / 26) - 1;
  } while (number >= 0);
  return `Campaign ${label}`;
}

function normalizeCampaign(raw = {}, fallback = {}) {
  return {
    id: cleanText(raw.id || fallback.id),
    label: cleanText(fallback.label),
    campaign: cleanText(raw.campaign || fallback.campaign),
    brand: cleanText(raw.brand || fallback.brand),
    agency: cleanText(raw.agency || fallback.agency),
    notes: cleanText(raw.notes || fallback.notes),
    files: fallback.files || []
  };
}

function jsonFromText(text = '') {
  const cleaned = String(text).trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error('AI did not return valid JSON');
}

async function publicSearchSnippets(campaigns = []) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY || '';
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID || '';
  if (!apiKey || !engineId) return [];
  const results = [];
  for (const campaign of campaigns.slice(0, 12)) {
    const query = [campaign.campaign, campaign.brand, campaign.files.slice(0, 4).map(file => file.name).join(' ')].filter(Boolean).join(' ');
    if (!query) continue;
    try {
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.searchParams.set('key', apiKey);
      url.searchParams.set('cx', engineId);
      url.searchParams.set('q', query);
      url.searchParams.set('num', '3');
      const response = await fetch(url);
      if (!response.ok) continue;
      const body = await response.json();
      results.push({
        id: campaign.id,
        snippets: (body.items || []).map(item => ({
          title: cleanText(item.title),
          snippet: cleanText(item.snippet),
          link: cleanText(item.link)
        })).slice(0, 3)
      });
    } catch {}
  }
  return results;
}

async function enrichCampaignsWithAI(campaigns = []) {
  if (!process.env.OPENAI_API_KEY) return campaigns;
  const search = await publicSearchSnippets(campaigns);
  const prompt = `Organize ZIP files into editable advertising portfolio campaign metadata.
Return JSON only: { "campaigns": [{ "id": "", "campaign": "", "brand": "", "agency": "", "notes": "" }] }

Rules:
- Keep every supplied id unchanged and return every campaign once.
- Fill a field only when the filename, folder name, or supplied public-search snippet clearly supports it.
- Leave uncertain fields blank.
- Notes are only for grounded descriptions or award claims. Do not invent awards or claims.
- Do not repeat campaign, brand, or agency inside notes.
- Keep wording concise and suitable for user approval before a site is built.`;
  const payload = campaigns.map(campaign => ({
    id: campaign.id,
    folder: campaign.folder,
    suggestedCampaign: campaign.campaign,
    files: campaign.files.map(file => file.name).slice(0, 30),
    publicSearch: search.find(result => result.id === campaign.id)?.snippets || []
  }));
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.05,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!response.ok) return campaigns;
    const body = await response.json();
    const parsed = jsonFromText(body.choices?.[0]?.message?.content || '{}');
    const byId = new Map((parsed.campaigns || []).map(item => [String(item.id), item]));
    return campaigns.map(campaign => normalizeCampaign(byId.get(campaign.id), campaign));
  } catch {
    return campaigns;
  }
}

export async function analyzePortfolioZip(zipPath, sessionDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (!entries.length) throw new Error('The ZIP is empty.');
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error(`The ZIP has too many files. Keep it under ${MAX_ZIP_ENTRIES} entries.`);

  const filesDir = path.join(sessionDir, 'files');
  await fs.emptyDir(filesDir);
  const groups = new Map();
  let expandedBytes = 0;
  let fileIndex = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const relativePath = safeEntryName(entry.entryName);
    if (!relativePath || relativePath.startsWith('__MACOSX/') || path.basename(relativePath) === '.DS_Store') continue;
    const ext = path.extname(relativePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
    expandedBytes += Number(entry.header?.size || 0);
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new Error('The ZIP expands beyond the 600MB test-builder limit.');

    const storedName = `${safeSlug(path.basename(relativePath, ext)) || 'asset'}-${fileIndex++}-${expandedBytes}${ext}`;
    const outputPath = path.join(filesDir, storedName);
    await fs.writeFile(outputPath, entry.getData());
    const key = campaignKey(relativePath);
    const file = {
      name: path.basename(relativePath),
      originalPath: relativePath,
      path: outputPath,
      size: Number(entry.header?.size || 0),
      mimetype: mime.lookup(ext) || 'application/octet-stream'
    };
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  if (!groups.size) throw new Error('No supported portfolio files were found. Add images, videos, audio, or PDFs to the ZIP.');

  const campaigns = [...groups.entries()].map(([folder, files], index) => ({
    id: `campaign-${index + 1}`,
    label: alphaLabel(index),
    folder,
    campaign: folder === 'Uploaded work' ? '' : titleCase(folder),
    brand: '',
    agency: '',
    notes: '',
    files
  }));
  return enrichCampaignsWithAI(campaigns);
}

export function stagedFilesForBuild(session, approvedCampaigns = []) {
  const originalById = new Map((session.campaigns || []).map(campaign => [campaign.id, campaign]));
  const files = [];
  const campaigns = approvedCampaigns.map((approved, index) => {
    const original = originalById.get(String(approved.id));
    if (!original) throw new Error('One of the approved campaigns was not found in the ZIP session.');
    for (const file of original.files || []) {
      files.push({
        fieldname: `campaignFiles-${index}`,
        originalname: file.name,
        mimetype: file.mimetype,
        path: file.path,
        size: file.size
      });
    }
    return {
      title: cleanText(approved.campaign) || `Campaign ${index + 1}`,
      campaign: cleanText(approved.campaign) || `Campaign ${index + 1}`,
      brand: cleanText(approved.brand),
      agency: cleanText(approved.agency),
      role: '',
      notes: cleanText(approved.notes)
    };
  });
  return { files, campaigns };
}

import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';
import { cleanupManifestWithAI } from './ai.js';
import { generateSite, validateSite, zipDir } from './importer.js';
import { hash, safeSlug } from './utils.js';

const IMAGE_ANALYSIS_LIMIT = 8 * 1024 * 1024;

function envTrue(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function jsonFromText(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('AI did not return valid JSON');
}

function titleFromFilename(fileName = 'Uploaded work') {
  const base = path.basename(fileName, path.extname(fileName));
  return cleanText(base.replace(/[-_]+/g, ' ')) || 'Uploaded work';
}

function safeAssetFileName(file) {
  const rawExt = path.extname(file.originalname || '').toLowerCase();
  const guessedExt = mime.extension(file.mimetype || '') ? `.${mime.extension(file.mimetype)}` : '';
  const ext = rawExt && rawExt.length <= 8 ? rawExt : guessedExt;
  const base = safeSlug(path.basename(file.originalname || 'asset', rawExt)) || 'asset';
  return `${hash(`${file.originalname}:${file.size}:${file.path}`)}-${base.slice(0, 70)}${ext || ''}`;
}

function kindForMime(type = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'document';
  return 'file';
}

function normalizeAnalysis(asset, analysis = {}) {
  const title = cleanText(analysis.title) || titleFromFilename(asset.originalName);
  const campaign = cleanText(analysis.campaign);
  const client = cleanText(analysis.client);
  const agency = cleanText(analysis.agency);
  const medium = cleanText(analysis.medium) || asset.kind;
  const description = cleanText(analysis.description);
  const visibleText = Array.isArray(analysis.visibleText) ? analysis.visibleText.map(cleanText).filter(Boolean).slice(0, 8) : [];
  const captionLines = Array.isArray(analysis.captionLines) ? analysis.captionLines.map(cleanText).filter(Boolean).slice(0, 8) : [];
  return {
    title,
    campaign,
    client,
    agency,
    medium,
    description,
    visibleText,
    captionLines,
    confidence: Number.isFinite(Number(analysis.confidence)) ? Number(analysis.confidence) : 0.35
  };
}

function fallbackAnalysis(asset) {
  return normalizeAnalysis(asset, {
    title: titleFromFilename(asset.originalName),
    medium: asset.kind === 'document' ? 'PDF' : asset.kind,
    captionLines: [titleFromFilename(asset.originalName), asset.kind === 'document' ? 'PDF' : asset.kind === 'audio' ? 'Audio' : asset.kind]
  });
}

async function analyzeImageAsset(asset, progress) {
  if (!process.env.OPENAI_API_KEY || !envTrue(process.env.AI_UPLOAD_ANALYSIS ?? 'true')) return fallbackAnalysis(asset);
  if (asset.size > IMAGE_ANALYSIS_LIMIT) {
    return {
      ...fallbackAnalysis(asset),
      description: `Image was larger than ${Math.round(IMAGE_ANALYSIS_LIMIT / 1024 / 1024)}MB, so AI visual analysis was skipped.`
    };
  }

  progress?.('AI analyzing asset', asset.originalName);
  const data = await fs.readFile(asset.absPath, 'base64');
  const prompt = `You are analyzing uploaded advertising portfolio work.

Return JSON only. Do not use markdown.
Describe only what is visible or strongly implied by the file name. Do not invent agencies, awards, clients, years, or campaign names.
If the work looks like an ad, poster, storyboard, case board, social post, or outdoor execution, identify the likely medium.
Prefer clean advertising portfolio metadata over long commentary.

Schema:
{
  "title": "short work title",
  "campaign": "campaign name if visible or filename implies it",
  "client": "brand/client if visible",
  "agency": "agency if visible",
  "medium": "Print | Film | Outdoor | Social | Design | Case Board | PDF | Video | Other",
  "visibleText": ["exact visible text fragments"],
  "captionLines": ["short lines suitable below the work"],
  "description": "one grounded sentence about the idea/execution",
  "confidence": 0.0
}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Filename: ${asset.originalName}` },
            { type: 'image_url', image_url: { url: `data:${asset.mime};base64,${data}` } }
          ]
        }
      ]
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${txt.slice(0, 500)}`);
  }
  const body = await res.json();
  return normalizeAnalysis(asset, jsonFromText(body.choices?.[0]?.message?.content || '{}'));
}

async function groupAssetsWithAI(assets, progress) {
  const fallback = assets.map((asset, index) => ({
    title: asset.analysis.campaign || asset.analysis.title || titleFromFilename(asset.originalName),
    assetIndexes: [index],
    captionLines: asset.analysis.captionLines?.length ? asset.analysis.captionLines : [asset.analysis.title, asset.analysis.medium].filter(Boolean),
    description: asset.analysis.description || ''
  }));
  if (!process.env.OPENAI_API_KEY || !envTrue(process.env.AI_UPLOAD_ANALYSIS ?? 'true')) return fallback;

  progress?.('AI organizing portfolio', `${assets.length} uploaded asset(s)`);
  const payload = assets.map((asset, index) => ({
    index,
    filename: asset.originalName,
    kind: asset.kind,
    title: asset.analysis.title,
    campaign: asset.analysis.campaign,
    client: asset.analysis.client,
    agency: asset.analysis.agency,
    medium: asset.analysis.medium,
    visibleText: asset.analysis.visibleText,
    description: asset.analysis.description
  }));

  const prompt = `You are building a minimalist advertising portfolio from uploaded work, in the style of senior creative portfolios such as abdullahfarouk.com and kapilbhimekar.com: work-first pages, restrained typography, a grid home page, media shown large, and compact caption lines near each execution.

Return JSON only. Do not use markdown.
Use every asset index exactly once.
Group assets into the same project only when they clearly belong to the same campaign/client/concept.
Do not invent awards, agencies, clients, or dates. Unknown fields should be omitted, not guessed.
Project titles should be concise, for example "Campaign | Client" when both are known.
Caption lines should be short metadata lines, not marketing filler.

Schema:
{
  "ownerName": "Portfolio",
  "siteTitle": "Portfolio",
  "projects": [
    {
      "title": "",
      "assetIndexes": [0],
      "captionLines": [],
      "description": ""
    }
  ]
}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI API error ${res.status}: ${txt.slice(0, 500)}`);
  }
  const body = await res.json();
  const parsed = jsonFromText(body.choices?.[0]?.message?.content || '{}');
  const projects = Array.isArray(parsed.projects) ? parsed.projects : fallback;
  return { ownerName: cleanText(parsed.ownerName), siteTitle: cleanText(parsed.siteTitle), projects };
}

function normalizeGroups(groupResult, assets) {
  const rawProjects = Array.isArray(groupResult) ? groupResult : groupResult.projects;
  const used = new Set();
  const projects = [];
  for (const raw of rawProjects || []) {
    const indexes = Array.isArray(raw.assetIndexes)
      ? raw.assetIndexes.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n < assets.length && !used.has(n))
      : [];
    if (!indexes.length) continue;
    indexes.forEach(n => used.add(n));
    const first = assets[indexes[0]];
    projects.push({
      title: cleanText(raw.title) || first.analysis.campaign || first.analysis.title || titleFromFilename(first.originalName),
      assetIndexes: indexes,
      captionLines: Array.isArray(raw.captionLines) ? raw.captionLines.map(cleanText).filter(Boolean).slice(0, 10) : [],
      description: cleanText(raw.description)
    });
  }
  assets.forEach((asset, index) => {
    if (used.has(index)) return;
    projects.push({
      title: asset.analysis.campaign || asset.analysis.title || titleFromFilename(asset.originalName),
      assetIndexes: [index],
      captionLines: asset.analysis.captionLines || [],
      description: asset.analysis.description || ''
    });
  });
  return {
    ownerName: !Array.isArray(groupResult) && cleanText(groupResult.ownerName) ? cleanText(groupResult.ownerName) : 'Uploaded Portfolio',
    siteTitle: !Array.isArray(groupResult) && cleanText(groupResult.siteTitle) ? cleanText(groupResult.siteTitle) : 'Uploaded Portfolio',
    projects
  };
}

function uniqueLines(lines = []) {
  const seen = new Set();
  const out = [];
  for (const line of lines.map(cleanText).filter(Boolean)) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

function assetCaption(asset, group) {
  return uniqueLines([
    ...(asset.analysis.captionLines || []),
    asset.analysis.campaign,
    asset.analysis.client,
    asset.analysis.agency,
    asset.analysis.medium
  ]).filter(line => line.toLowerCase() !== cleanText(group.title).toLowerCase()).slice(0, 8);
}

function buildManifestFromGroups(groups, assets, { title, userTextOnly = false } = {}) {
  const projects = groups.projects.map((group, projectIndex) => {
    const slugBase = group.title || `Project ${projectIndex + 1}`;
    const images = [];
    const videos = [];
    const audios = [];
    const documents = [];
    const contentItems = [];
    let order = 1;

    for (const globalIndex of group.assetIndexes) {
      const asset = assets[globalIndex];
      if (!asset) continue;
      const src = `assets/imported/${asset.fileName}`;
      if (asset.kind === 'image') {
        const imageIndex = images.length;
        images.push({ src, localFile: asset.fileName, alt: asset.analysis.title || group.title, original: asset.originalName, order });
        contentItems.push({ type: 'image', order: order++, imageIndex, original: asset.originalName });
      } else if (asset.kind === 'video') {
        const videoIndex = videos.length;
        videos.push({ kind: 'video', type: 'video', src, localFile: asset.fileName, title: asset.analysis.title || group.title, original: asset.originalName, order });
        contentItems.push({ type: 'video', order: order++, videoIndex, original: asset.originalName });
      } else if (asset.kind === 'audio') {
        const audioIndex = audios.length;
        audios.push({ kind: 'audio', type: 'audio', src, localFile: asset.fileName, title: asset.analysis.title || group.title, original: asset.originalName, order });
        contentItems.push({ type: 'audio', order: order++, audioIndex, original: asset.originalName });
      } else if (asset.kind === 'document') {
        const documentIndex = documents.length;
        documents.push({ src, localFile: asset.fileName, title: asset.analysis.title || group.title, original: asset.originalName, order });
        contentItems.push({ type: 'document', order: order++, documentIndex, original: asset.originalName });
      }
      const lines = userTextOnly ? [] : assetCaption(asset, group);
      if (lines.length) contentItems.push({ type: 'text', order: order++, tag: 'p', text: lines.join('\n') });
    }

    const groupLines = uniqueLines([...(group.captionLines || []), group.description]).filter(Boolean);
    if (groupLines.length && contentItems.length === group.assetIndexes.length) {
      contentItems.push({ type: 'text', order: order++, tag: 'p', text: groupLines.join('\n') });
    }

    return {
      title: group.title,
      slug: safeSlug(`${projectIndex + 1}-${group.title}`),
      url: '#uploaded',
      thumbnail: images[0] ? { src: images[0].src, original: images[0].original } : null,
      copyBlocks: groupLines.length ? [{ tag: 'p', text: groupLines.join('\n') }] : [],
      contentItems,
      images,
      videos,
      audios,
      documents,
      warnings: []
    };
  });

  return {
    sourceUrl: 'uploaded-files',
    siteTitle: cleanText(title) || groups.siteTitle || 'Uploaded Portfolio',
    ownerName: cleanText(title) || groups.ownerName || 'Uploaded Portfolio',
    projects,
    generatedAt: new Date().toISOString(),
    buildMode: 'uploads'
  };
}

function normalizeCampaignInput(campaign = {}, index = 0) {
  const campaignTitle = cleanText(campaign.campaign || campaign.title);
  const brand = cleanText(campaign.brand || campaign.client);
  const agency = cleanText(campaign.agency);
  const pageTitle = campaignTitle || [brand, agency].filter(Boolean).join(' | ') || `Campaign ${index + 1}`;
  const lines = uniqueLines([
    brand,
    campaignTitle,
    agency,
    cleanText(campaign.notes)
  ]);
  return {
    index,
    title: pageTitle,
    assetIndexes: [],
    captionLines: lines,
    description: cleanText(campaign.notes)
  };
}

async function saveUploadedAssets(files, outDir, progress, stage = 'Saving uploaded assets') {
  const assetsDir = path.join(outDir, 'assets-imported');
  await fs.ensureDir(assetsDir);
  progress(stage, `${files.length} file(s)`);

  const assets = [];
  for (const file of files) {
    const kind = kindForMime(file.mimetype || '');
    if (!['image', 'video', 'audio', 'document'].includes(kind)) {
      await fs.remove(file.path).catch(() => {});
      continue;
    }
    const fileName = safeAssetFileName(file);
    const absPath = path.join(assetsDir, fileName);
    await fs.move(file.path, absPath, { overwrite: true });
    assets.push({
      originalName: file.originalname,
      fieldName: file.fieldname,
      fileName,
      absPath,
      src: `assets/imported/${fileName}`,
      mime: file.mimetype,
      size: file.size,
      kind
    });
  }
  if (!assets.length) throw new Error('No supported files were uploaded. Use images, videos, audio files, or PDFs.');
  return assets;
}

async function analyzeAssets(assets, progress) {
  progress('Analyzing uploaded work', `${assets.length} supported asset(s)`);
  for (const asset of assets) {
    try {
      asset.analysis = asset.kind === 'image' ? await analyzeImageAsset(asset, progress) : fallbackAnalysis(asset);
    } catch (e) {
      asset.analysis = fallbackAnalysis(asset);
      asset.analysis.description = `AI analysis failed: ${e.message}`;
      progress('AI analysis warning', `${asset.originalName}: ${e.message}`);
    }
  }
}

function groupsFromCampaigns(campaigns, assets) {
  const groups = campaigns.map(normalizeCampaignInput);
  assets.forEach((asset, assetIndex) => {
    const match = String(asset.fieldName || '').match(/^campaignFiles-(\d+)$/);
    const campaignIndex = match ? Number(match[1]) : 0;
    const group = groups[campaignIndex] || groups[0];
    if (group) group.assetIndexes.push(assetIndex);
  });
  return {
    ownerName: 'Uploaded Portfolio',
    siteTitle: 'Uploaded Portfolio',
    projects: groups.filter(group => group.assetIndexes.length)
  };
}

export async function runUploadBuild({ files, outDir, title = '', aiCleanup = false, onProgress } = {}) {
  const progress = (stage, detail = '') => onProgress?.({ stage, detail, at: new Date().toISOString() });
  if (!files?.length) throw new Error('Upload at least one image, video, or PDF.');

  await fs.ensureDir(outDir);
  const assets = await saveUploadedAssets(files, outDir, progress);
  await analyzeAssets(assets, progress);

  let groups;
  try {
    groups = normalizeGroups(await groupAssetsWithAI(assets, progress), assets);
  } catch (e) {
    progress('AI organizing warning', e.message);
    groups = normalizeGroups(assets.map((asset, index) => ({
      title: asset.analysis.campaign || asset.analysis.title || titleFromFilename(asset.originalName),
      assetIndexes: [index],
      captionLines: asset.analysis.captionLines || [],
      description: asset.analysis.description || ''
    })), assets);
  }

  const rawManifest = buildManifestFromGroups(groups, assets, { title });
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

export async function runCampaignBuild({ files, campaigns = [], outDir, title = '', subtitle = '', aiCleanup = true, onProgress } = {}) {
  const progress = (stage, detail = '') => onProgress?.({ stage, detail, at: new Date().toISOString() });
  if (!files?.length) throw new Error('Upload at least one image, video, audio file, or PDF.');
  if (!Array.isArray(campaigns) || !campaigns.length) throw new Error('Add at least one campaign.');

  await fs.ensureDir(outDir);
  const assets = await saveUploadedAssets(files, outDir, progress, 'Saving campaign assets');
  await analyzeAssets(assets, (stage, detail) => {
    progress(stage === 'AI analyzing asset' ? 'AI analyzing campaign asset' : stage, detail);
  });

  const groups = groupsFromCampaigns(campaigns, assets);
  if (!groups.projects.length) throw new Error('Add at least one asset to a campaign.');

  progress('Building campaign pages', `${groups.projects.length} campaign page(s)`);
  const rawManifest = buildManifestFromGroups(groups, assets, { title, userTextOnly: true });
  rawManifest.sourceUrl = 'campaign-builder';
  rawManifest.siteTitle = cleanText(title) || 'Uploaded Portfolio';
  rawManifest.ownerName = cleanText(title) || 'Uploaded Portfolio';
  rawManifest.homeTitle = cleanText(title) || 'Your Name';
  rawManifest.homeIntro = cleanText(subtitle);
  rawManifest.buildMode = 'campaign-builder';
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

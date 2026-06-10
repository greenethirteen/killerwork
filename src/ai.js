import 'dotenv/config';

function envTrue(v) {
  return ['1','true','yes','on'].includes(String(v || '').toLowerCase());
}

function cleanPortfolioLine(value = '') {
  return String(value || '').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

function uniquePortfolioLines(lines = [], title = '') {
  const titleKey = cleanPortfolioLine(title).toLowerCase();
  const seen = new Set();
  return lines
    .flatMap(line => String(line || '').replace(/\r/g, '\n').split('\n'))
    .map(cleanPortfolioLine)
    .filter(line => {
      const key = line.toLowerCase();
      if (!line || key === titleKey || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function portfolioTextKey(value = '') {
  return cleanPortfolioLine(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCampaignFieldFragments(value = '', project = {}, title = '') {
  const input = project.builderInput || {};
  let text = String(value || '').replace(/\r/g, '\n');
  text = text.replace(/\b(?:brand|client|campaign(?:\s+name)?|agency|ad\s+agency|role)\s*:\s*/gi, '');
  const fieldValues = [title, input.campaign, input.brand, input.agency, input.role]
    .map(cleanPortfolioLine)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const fieldValue of fieldValues) {
    text = text.replace(new RegExp(`(^|[^a-z0-9])${escapeRegExp(fieldValue)}(?=$|[^a-z0-9])`, 'gi'), '$1');
  }
  return text
    .split(/\n+/)
    .map(line => cleanPortfolioLine(line).replace(/^[\s,.;:|/+-]+|[\s,;:|/+-]+$/g, ''))
    .filter(Boolean)
    .join('\n\n');
}

function cleanCampaignDescription(value = '', project = {}, title = '') {
  const input = project.builderInput || {};
  if (!stripCampaignFieldFragments(input.notes, project, title)) return '';
  const reserved = [title, input.campaign, input.brand, input.agency, input.role]
    .map(portfolioTextKey)
    .filter(Boolean);
  return stripCampaignFieldFragments(value, project, title)
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(cleanPortfolioLine)
    .filter(line => {
      const key = portfolioTextKey(line);
      if (!key || reserved.includes(key)) return false;
      const withoutLabels = portfolioTextKey(line.replace(/\b(brand|client|agency|ad agency|role)\s*:/gi, ' '));
      return !reserved.includes(withoutLabels);
    })
    .filter((line, index, lines) => lines.findIndex(other => portfolioTextKey(other) === portfolioTextKey(line)) === index)
    .join('\n\n')
    .slice(0, 1200);
}

function fallbackCampaignBuilderText(project = {}) {
  const input = project.builderInput || {};
  const title = cleanPortfolioLine(input.campaign || project.title);
  const metadata = uniquePortfolioLines(project.cleaned?.metadata?.length ? project.cleaned.metadata : [input.brand, input.agency, input.role], title);
  const description = cleanCampaignDescription(project.builderNarrative || input.notes, project, title);
  return { title: title || project.title || 'Untitled campaign', metadata, description };
}

function normalizeCampaignBuilderText(result = {}, project = {}) {
  const fallback = fallbackCampaignBuilderText(project);
  const title = cleanPortfolioLine(result.title || fallback.title).slice(0, 180);
  const metadata = uniquePortfolioLines(Array.isArray(result.metadata) ? result.metadata : fallback.metadata, title);
  const description = cleanCampaignDescription(result.description || fallback.description, project, title);
  return { title, metadata, description };
}

export async function cleanupCampaignBuilderManifestWithAI(manifest, { progress, enabled = true, model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}) {
  const projects = [];
  for (const project of manifest.projects || []) {
    const fallback = fallbackCampaignBuilderText(project);
    let cleaned = fallback;
    if (enabled && process.env.OPENAI_API_KEY && fallback.description) {
      progress?.('AI checking portfolio text', project.title || 'campaign');
      const system = `You write polished copy for an advertising portfolio campaign page.
Return JSON only:
{ "title": "", "metadata": [""], "description": "" }

Rules:
- "title": Concise campaign name. Use "Campaign — Brand" format when both are known. Never exceed 8 words. Never include a colon.
- "metadata": Short standalone credential lines. One entry per field: brand, agency, role. Never combine into one line. Never include the title in metadata.
- "description": 1–3 sentences of sharp, factual narrative from the user's notes. Write in a confident creative voice ("The brief was...", "We created...", "This campaign..."). Fix all grammar and remove filler. Return "" if the notes are empty or just repeat the field data without meaningful creative context.
  - Never include field label words (brand, agency, role, campaign) in the description.
  - Never repeat the title, brand name, agency name, or role verbatim.
  - Do not invent facts, awards, or claims not in the input.
- Remove all duplicate lines and label prefixes like "Brand:", "Agency:", "Role:".`;
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.05,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify({ title: project.title, fields: project.builderInput || {}, fallback }) }
            ]
          })
        });
        if (res.ok) {
          const data = await res.json();
          cleaned = normalizeCampaignBuilderText(jsonFromText(data.choices?.[0]?.message?.content || '{}'), project);
        } else {
          progress?.('AI portfolio text warning', `${project.title}: cleanup request failed`);
        }
      } catch (e) {
        progress?.('AI portfolio text warning', `${project.title}: ${e.message}`);
      }
    }
    const metadata = uniquePortfolioLines(cleaned.metadata, cleaned.title);
    projects.push({
      ...project,
      title: cleaned.title,
      description: cleanCampaignDescription(cleaned.description, project, cleaned.title),
      builderNarrative: cleanCampaignDescription(cleaned.description, project, cleaned.title),
      copyBlocks: metadata.map(text => ({ tag: 'p', text })),
      contentItems: (project.contentItems || []).filter(item => item.type !== 'text'),
      cleaned: {
        ...(project.cleaned || {}),
        metadata,
        intro: cleanCampaignDescription(cleaned.description, project, cleaned.title)
      }
    });
  }
  return { ...manifest, projects };
}

function compactProjectForAI(project) {
  return {
    title: project.title,
    slug: project.slug,
    url: project.url,
    rawTextBlocks: (project.copyBlocks || []).map((b, i) => ({ i, tag: b.tag, text: b.text })).slice(0, 80),
    media: [
      ...(project.videos || []).map((v, i) => ({ kind: 'video', i, type: v.type || v.kind, src: v.original || v.src })),
      ...(project.audios || []).map((a, i) => ({ kind: 'audio', i, type: a.type || a.kind, src: a.original || a.src, title: a.title || '' })),
      ...(project.images || []).map((img, i) => ({ kind: 'image', i, alt: img.alt || '', filename: img.localFile || (img.src || '').split('/').pop(), original: img.original || '' }))
    ].slice(0, 140),
    contentItems: (project.contentItems || []).slice(0, 160)
  };
}

function jsonFromText(text) {
  const cleaned = String(text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error('AI did not return valid JSON');
}

function splitTitleParts(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/^(.+?)\s*(?:[-–—|:])\s*(.+)$/);
  if (!match) return null;
  const title = match[1].trim();
  const subtitle = match[2].trim();
  if (!title || !subtitle || title.length > 90 || subtitle.length > 140) return null;
  return { title, subtitle };
}

function fallbackPageEdit(prompt = '', page = {}) {
  const text = String(prompt || '');
  const splitSource = splitTitleParts(text.match(/["“']([^"”']+?\s*(?:[-–—|:])\s*[^"”']+)["”']/)?.[1] || page.title || '');
  if (/\b(break|split|separate|line break|new line)\b/i.test(text) && splitSource) {
    return {
      message: `I split "${splitSource.title}" and "${splitSource.subtitle}" into a headline and subhead.`,
      title: splitSource.title,
      subtitle: splitSource.subtitle,
      replaceText: [{ find: `${splitSource.title} - ${splitSource.subtitle}`, replace: `${splitSource.title}\n${splitSource.subtitle}` }]
    };
  }
  const titleMatch = text.match(/\b(?:change|rename|make)\s+(?:the\s+)?(?:title|headline)\s+(?:to|as)\s+["“']?([^"”'\n]+)["”']?/i);
  if (titleMatch?.[1]) {
    return {
      message: `I changed the page headline to "${titleMatch[1].trim()}".`,
      title: titleMatch[1].trim()
    };
  }
  return {
    message: 'I added your prompt as an editable text block because this request needs more specific page instructions.',
    prependText: text.replace(/\s+/g, ' ').slice(0, 900)
  };
}

function normalizePageEdit(result = {}, prompt = '', page = {}) {
  const edit = {
    message: String(result.message || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    title: String(result.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    subtitle: String(result.subtitle || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    homeTitle: String(result.homeTitle || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    homeIntro: String(result.homeIntro || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    prependText: String(result.prependText || '').replace(/\r/g, '\n').trim().slice(0, 4000),
    replaceText: Array.isArray(result.replaceText)
      ? result.replaceText.map(item => ({
        find: String(item?.find || '').trim().slice(0, 500),
        replace: String(item?.replace || '').trim().slice(0, 1000)
      })).filter(item => item.find && item.replace)
      : []
  };
  if (!edit.message) edit.message = 'I updated the page and refreshed the live preview.';
  if (!edit.title && !edit.subtitle && !edit.homeTitle && !edit.homeIntro && !edit.prependText && !edit.replaceText.length) {
    return fallbackPageEdit(prompt, page);
  }
  return edit;
}

export async function planPageEditWithAI({ prompt, page, manifest }, { model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}) {
  const fallback = () => fallbackPageEdit(prompt, page);
  if (!process.env.OPENAI_API_KEY) return fallback();

  const payload = {
    prompt,
    page: {
      kind: page.kind || 'project',
      title: page.title || '',
      subtitle: page.subtitle || '',
      contentItems: (page.contentItems || []).filter(item => item.type === 'text').slice(0, 30),
      visibleHomeCards: page.kind === 'home' ? (page.contentItems || []).slice(0, 40) : []
    },
    portfolio: {
      ownerName: manifest.ownerName || '',
      siteTitle: manifest.siteTitle || '',
      sourcePlatform: manifest.sourcePlatform || ''
    }
  };
  const system = `You are the edit planner for KillaWork, a portfolio website editor.
Return JSON only. Do not include markdown.

Schema:
{
  "message": "short human summary of the change",
  "title": "optional new project title/headline",
  "subtitle": "optional project subhead",
  "homeTitle": "optional home title",
  "homeIntro": "optional home intro",
  "prependText": "optional text block to add at the top",
  "replaceText": [{ "find": "exact visible text to replace", "replace": "replacement text" }]
}

Rules:
- Apply the user's requested edit directly to the current page.
- If the user asks to split a campaign line such as "Ikea - Sustainability", set title to "Ikea" and subtitle to "Sustainability".
- Use title/subtitle for headline formatting requests. Do not add that request as body copy.
- Use replaceText for exact copy changes inside existing text blocks.
- Do not invent awards, clients, facts, links, or media.
- Keep message concise and specific.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    return normalizePageEdit(jsonFromText(data.choices?.[0]?.message?.content || '{}'), prompt, page);
  } catch {
    return fallback();
  }
}

function normalizeOperations(result = {}, prompt = '', page = {}) {
  const rawOps = Array.isArray(result.operations) ? result.operations : [];
  const operations = rawOps.map(op => {
    const type = String(op?.op || op?.type || '').trim();
    if (!type) return null;
    return {
      op: type,
      title: String(op.title || '').trim().slice(0, 200),
      subtitle: String(op.subtitle || '').trim().slice(0, 220),
      text: String(op.text || '').replace(/\r/g, '\n').trim().slice(0, 4000),
      find: String(op.find || '').trim().slice(0, 800),
      replace: String(op.replace || '').trim().slice(0, 4000),
      layout: String(op.layout || '').trim(),
      treatment: String(op.treatment || '').trim(),
      target: String(op.target || '').trim(),
      blockIndex: Number.isInteger(op.blockIndex) ? op.blockIndex : Number.isInteger(op.index) ? op.index : null,
      scale: Number.isFinite(Number(op.scale)) ? Number(op.scale) : null,
      size: Number.isFinite(Number(op.size)) ? Number(op.size) : null,
      align: String(op.align || '').trim(),
      backgroundColor: String(op.backgroundColor || '').trim(),
      textColor: String(op.textColor || '').trim()
    };
  }).filter(Boolean).slice(0, 12);
  if (!operations.length) return fallbackOperations(prompt, page);
  return {
    message: String(result.message || 'Applied the requested page edits.').replace(/\s+/g, ' ').trim().slice(0, 500),
    operations
  };
}

function fallbackOperations(prompt = '', page = {}) {
  const text = String(prompt || '');
  const operations = [];
  const splitSource = splitTitleParts(text.match(/["“']([^"”']+?\s*(?:[-–—|:])\s*[^"”']+)["”']/)?.[1] || page.title || '');
  if (/\b(break|split|separate|line break|new line)\b/i.test(text) && splitSource && /\b(headline|title|subhead|subhead)\b/i.test(text)) {
    operations.push({ op: 'updateTitle', title: splitSource.title, subtitle: splitSource.subtitle });
  }
  if (/\b(headline|title)\b/i.test(text) && /\b(reduce|smaller|decrease|lower|shrink)\b/i.test(text) && /\b(font|size)\b/i.test(text)) {
    operations.push({ op: 'resizeHeadline', scale: 0.78 });
  }
  if (/\b(agency|creative director|credits|producer|dop|production house)\b/i.test(text) && (/\b(break|separate|split|line by line|vertically|format|credits?)\b/i.test(text) || text.includes(':'))) {
    operations.push({ op: 'splitCredits', text });
  }
  if (/\b(premium|portfolio-ready|beautiful|polish|high.end|better design)\b/i.test(text)) {
    operations.push({ op: 'setPageLayout', layout: 'editorial' });
    operations.push({ op: 'setMediaTreatment', target: 'first-media', treatment: 'hero' });
  }
  if (/\b(reorder|strongest|best|first)\b/i.test(text)) operations.push({ op: 'reorderBlocks', target: 'strongest-first' });
  if (!operations.length && text.trim()) operations.push({ op: 'insertText', text: text.trim(), align: 'center' });
  return {
    message: operations.length === 1 && operations[0].op === 'insertText'
      ? 'Added your prompt as an editable text block.'
      : 'Applied the requested page edits.',
    operations
  };
}

export async function planPageOperationsWithAI({ prompt, page, manifest }, { model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}) {
  const fallback = () => fallbackOperations(prompt, page);
  if (!process.env.OPENAI_API_KEY) return fallback();

  const payload = {
    prompt,
    page: {
      kind: page.kind || 'project',
      title: page.title || '',
      subtitle: page.subtitle || '',
      layout: page.aiLayout || '',
      titleFontSize: page.titleFontSize || 0,
      contentItems: (page.contentItems || []).map((item, index) => ({
        index,
        type: item.type,
        text: item.type === 'text' ? item.text : '',
        treatment: item.treatment || '',
        imageIndex: item.imageIndex,
        videoIndex: item.videoIndex
      })).slice(0, 80)
    },
    portfolio: {
      ownerName: manifest.ownerName || '',
      siteTitle: manifest.siteTitle || '',
      sourcePlatform: manifest.sourcePlatform || ''
    }
  };
  const system = `You are KillaWork AI, a professional portfolio webpage editor.
Return JSON only. Do not include markdown.

Return:
{
  "message": "short summary of what will change",
  "operations": [
    { "op": "updateTitle", "title": "", "subtitle": "" },
    { "op": "resizeHeadline", "scale": 0.8 },
    { "op": "replaceText", "find": "exact text", "replace": "replacement" },
    { "op": "splitCredits", "text": "credits text from prompt or page" },
    { "op": "insertText", "text": "", "align": "left|center|right" },
    { "op": "setPageLayout", "layout": "editorial|gallery|case-study|video-led|minimal" },
    { "op": "setMediaTreatment", "target": "first-media|all-images|all-media", "treatment": "hero|full-width|contained" },
    { "op": "reorderBlocks", "target": "strongest-first" },
    { "op": "groupImagesIntoSlider" },
    { "op": "setColors", "backgroundColor": "#000000", "textColor": "#ffffff" }
  ]
}

Rules:
- Use operations, not prose, to make changes.
- Never claim a change unless it is represented by an operation.
- Prefer specific operations over insertText.
- For credits, use splitCredits.
- For visual polish, use setPageLayout plus setMediaTreatment.
- For headline size, use resizeHeadline.
- Do not invent facts, awards, clients, or media.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.12,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    return normalizeOperations(jsonFromText(data.choices?.[0]?.message?.content || '{}'), prompt, page);
  } catch {
    return fallback();
  }
}

function sitewidePrompt(prompt = '') {
  return /\b(all pages|whole site|sitewide|site-wide|global|every page|common|header|nav|navigation|browser title|page title|portfolio site|main portfolio|site headline|portfolio headline|brand|name|role)\b/i.test(String(prompt || ''));
}

function normalizeSiteEditPlan(result = {}, prompt = '') {
  const rawOps = Array.isArray(result.operations) ? result.operations : [];
  const operations = rawOps.map(op => {
    const type = String(op?.op || op?.type || '').trim();
    const filePath = String(op?.path || op?.file || '').replace(/^\/+/, '').trim();
    if (!type) return null;
    if (type !== 'replaceAll' && !filePath) return null;
    return {
      op: type,
      path: filePath,
      content: typeof op.content === 'string' ? op.content : '',
      find: typeof op.find === 'string' ? op.find : '',
      replace: typeof op.replace === 'string' ? op.replace : '',
      to: typeof op.to === 'string' ? op.to.replace(/^\/+/, '').trim() : ''
    };
  }).filter(Boolean).slice(0, 40);
  if (sitewidePrompt(prompt)) {
    for (const operation of operations) {
      if (operation.op === 'replace' && operation.find && operation.replace) operation.op = 'replaceAll';
    }
  }
  return {
    message: String(result.message || 'Applied the requested file edits.').replace(/\s+/g, ' ').trim().slice(0, 700),
    operations
  };
}

function fallbackSiteEditPlan(prompt = '', files = []) {
  const text = String(prompt || '').trim();
  const firstFile = files.find(file => /\.html?$/i.test(file.path)) || files[0];
  if (!firstFile || !text) return { message: 'I need a prompt and at least one editable file.', operations: [] };
  const replaceMatch =
    text.match(/\bfrom\s+["“']([^"”']+)["”']\s+to\s+["“']([^"”']+)["”']/i) ||
    text.match(/(?:change|replace)\s+["“']([^"”']+)["”']\s+(?:to|with)\s+["“']([^"”']+)["”']/i);
  if (replaceMatch) {
    const sitewide = sitewidePrompt(text);
    return {
      message: sitewide
        ? `Replaced "${replaceMatch[1]}" with "${replaceMatch[2]}" across the site.`
        : `Replaced "${replaceMatch[1]}" with "${replaceMatch[2]}".`,
      operations: [{ op: sitewide ? 'replaceAll' : 'replace', path: firstFile.path, find: replaceMatch[1], replace: replaceMatch[2] }]
    };
  }
  return { message: 'AI editing needs OPENAI_API_KEY for this request.', operations: [] };
}

export async function planSiteFileEditsWithAI(
  { prompt, files = [], fileTree = [], uploadedAssets = [], pagePath = '' },
  { model = process.env.OPENAI_MODEL || 'gpt-4o-mini' } = {}
) {
  const fallback = () => fallbackSiteEditPlan(prompt, files);
  if (!process.env.OPENAI_API_KEY) return fallback();

  const payload = {
    prompt,
    pagePath,
    uploadedAssets,
    fileTree: fileTree.slice(0, 500),
    files: files.map(file => ({
      path: file.path,
      content: String(file.content || '').slice(0, 70000)
    })),
    contextNote: 'The provided files include the current page, requested/open files, linked editable CSS/JS, common site assets, the home page, and when available a campaign page that can be used as a template.'
  };
  const system = `You are KillaWork AI, a senior front-end engineer editing a static portfolio website.
You edit real site files. You are not editing a grid, template, manifest, or block system.

Return JSON only:
{
  "message": "short clear summary",
  "operations": [
    { "op": "replace", "path": "index.html", "find": "exact text or markup", "replace": "replacement" },
    { "op": "replaceAll", "find": "exact repeated sitewide text", "replace": "replacement" },
    { "op": "writeFile", "path": "styles.css", "content": "complete new file content" },
    { "op": "createFile", "path": "work/new-campaign/index.html", "content": "complete file content" },
    { "op": "deleteFile", "path": "old.html" },
    { "op": "renameFile", "path": "old.html", "to": "new.html" }
  ]
}

Rules:
- Make the requested change directly in HTML/CSS/JS.
- Preserve the imported site's design unless the user asks to change it.
- Prefer small exact replace operations when safe.
- Use replaceAll when changing site identity, the main portfolio headline, the browser title, header/nav branding, footer branding, or any common text that should stay consistent across every page.
- Use writeFile only when a broader rewrite is necessary.
- If uploaded assets are provided, reference them by their provided relative paths.
- For new campaign pages, create a complete local page at work/descriptive-slug/index.html, copy the structure and styling conventions from an existing campaign page in context, reference every relevant uploaded asset, use relative links that work from the new folder, and update the home page, navigation, or project grid so the new page is reachable.
- When creating a page from uploaded assets, choose a clear title from the prompt or filenames, put the strongest visual first, add concise editable copy only from the user's prompt/filenames, and avoid placeholder sections.
- Keep links local to the generated site when possible.
- Do not invent factual claims, awards, clients, or credits.
- If the user asks to delete text, remove editable copy while preserving the page structure, media, navigation, links, scripts, and CSS.
- Never return a blank HTML file, empty body, or operation that removes the whole page unless the user explicitly asks to delete the file.
- For broad design or layout requests, edit CSS and the current page structure like a senior front-end engineer. Do not answer with a token placeholder or a tiny text insertion.
- If the request needs linked CSS or JS, edit those files too instead of adding large inline styles/scripts to one page.
- Make your message describe the concrete edits, including new pages, navigation/home updates, and assets used.
- Do not return prose outside JSON.`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.08,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    return normalizeSiteEditPlan(jsonFromText(data.choices?.[0]?.message?.content || '{}'), prompt);
  } catch {
    return fallback();
  }
}

function normalizeCleaned(cleaned, project) {
  const isPlaceholder = (value) => /^(optional|brand|campaign|agency|award|publication|date|client)$/i.test(String(value || '').trim());
  const imgMax = (project.images || []).length;
  const vidMax = (project.videos || []).length;
  const sections = Array.isArray(cleaned.sections) ? cleaned.sections : [];
  const safeSections = sections.map((s, idx) => {
    const media = Array.isArray(s.media) ? s.media : [];
    const safeMedia = media.map(m => {
      const kind = m.kind === 'video' ? 'video' : 'image';
      const index = Number.isInteger(m.index) ? m.index : parseInt(m.index, 10);
      if (!Number.isFinite(index)) return null;
      if (kind === 'image' && (index < 0 || index >= imgMax)) return null;
      if (kind === 'video' && (index < 0 || index >= vidMax)) return null;
      return { kind, index };
    }).filter(Boolean);
    return {
      heading: String(s.heading || '').trim(),
      eyebrow: String(s.eyebrow || '').trim(),
      subheading: String(s.subheading || '').trim(),
      body: Array.isArray(s.body) ? s.body.map(x => String(x).trim()).filter(Boolean) : (s.body ? [String(s.body).trim()] : []),
      media: safeMedia,
      layout: ['editorial','video','gallery','caseStudy'].includes(s.layout) ? s.layout : 'caseStudy',
      order: Number.isFinite(Number(s.order)) ? Number(s.order) : idx
    };
  }).filter(s => s.heading || s.subheading || s.body.length || s.media.length);

  const metadata = Array.isArray(cleaned.metadata) ? cleaned.metadata.map(x => String(x).trim()).filter(x => x && !isPlaceholder(x)) : [];
  const pageType = ['video_case_study','editorial_pr','gallery','case_study'].includes(cleaned.pageType) ? cleaned.pageType : (project.videos?.length ? 'video_case_study' : 'case_study');
  return {
    pageType,
    cleanTitle: String(cleaned.cleanTitle || project.title || '').trim(),
    brand: isPlaceholder(cleaned.brand) ? '' : String(cleaned.brand || '').trim(),
    campaign: isPlaceholder(cleaned.campaign) ? '' : String(cleaned.campaign || '').trim(),
    intro: isPlaceholder(cleaned.intro) ? '' : String(cleaned.intro || '').trim(),
    metadata,
    sections: safeSections.sort((a,b) => a.order - b.order),
    aiWarnings: Array.isArray(cleaned.warnings) ? cleaned.warnings.map(x => String(x).trim()).filter(Boolean) : []
  };
}

function normalizeAboutBio(result, currentProfile = {}) {
  const clichePattern = /(vibrant pulse|push boundaries|boundaries|resonate|resonant|passion|journey|storytelling|leave a mark|let's create|i'm here to|iconic brands|flashy ads|mundane|remarkable|compelling narratives|challenge norms|spark conversations|diverse tapestry|elevate campaigns|deeper level|connections that matter|thriv(?:e|ing) on)/i;
  const paragraphs = Array.isArray(result.paragraphs)
    ? result.paragraphs.map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  const safeParagraphs = paragraphs
    .filter(text => text.length >= 35 && text.length <= 520)
    .filter(text => !/(linkedin|behance|followers|appreciations|project views|as an ai|i cannot|i can't)/i.test(text))
    .filter(text => !clichePattern.test(text))
    .slice(0, 2);
  if (safeParagraphs.length < 2) return currentProfile;
  return {
    ...currentProfile,
    paragraphs: safeParagraphs,
    aiBio: true
  };
}

export async function rewriteAboutProfileWithAI(manifest, { model = process.env.OPENAI_MODEL || 'gpt-4o-mini', progress } = {}) {
  if (!process.env.OPENAI_API_KEY || !manifest.aboutProfile) return manifest;
  const profile = manifest.aboutProfile;
  const payload = {
    profile: {
      name: profile.name,
      role: profile.role,
      agency: profile.agency,
      location: profile.location,
      fields: profile.fields || [],
      awards: profile.awards || [],
      brands: profile.brands || [],
      sources: (profile.sources || []).map(source => ({
        title: source.title,
        source: source.source,
        snippet: source.snippet
      })).slice(0, 5)
    },
    projects: (manifest.projects || []).map(project => ({
      title: project.title,
      metadata: project.cleaned?.metadata || [],
      intro: project.cleaned?.intro || project.description || ''
    })).slice(0, 24)
  };
  const prompt = `You write short portfolio About-page copy for advertising creatives.

Return JSON only:
{ "paragraphs": ["", ""] }

Style:
- First person, confident, witty, and human.
- It should sound like the creative is selling themselves, not like software describing an archive.
- Two short paragraphs only, 35-70 words each.
- Poetic is good. Grandiose, motivational, and startup-founder language is not.
- Use dry charm and specific advertising craft language, not jokes for the sake of jokes.
- No bullet points. No quotes. No headings.
- Avoid cliches such as vibrant pulse, boundaries, resonate, passion, journey, storytelling, leave a mark, let's create, and I'm here to.
- Also avoid: iconic brands, flashy ads, mundane, remarkable, compelling narratives, challenge norms, spark conversations, thrive, tapestry, elevate, deeper level, and connections that matter.
- Do not end with a call to action.

Truth rules:
- Use only the provided profile, sources, and project titles.
- Do not invent exact jobs, agencies, awards, ages, clients, countries, emails, phone numbers, or LinkedIn claims.
- If awards are not clearly present, talk about craft and reputation without naming awards.
- Do not mention Behance, scraping, imports, public snippets, or LinkedIn.`;

  progress?.('AI about bio', profile.name || manifest.ownerName || 'profile');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: attempt ? 0.55 : 0.75,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(payload) },
          ...(attempt ? [{ role: 'user', content: 'Rewrite again. The previous style was rejected for sounding generic or using banned portfolio cliches. Be sharper, plainer, drier, and more specific.' }] : [])
        ]
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${txt.slice(0, 500)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const aboutProfile = normalizeAboutBio(jsonFromText(content), profile);
    if (aboutProfile.aiBio || attempt === 1) return { ...manifest, aboutProfile };
  }
  return manifest;
}

export async function cleanupProjectWithAI(project, { model = process.env.OPENAI_MODEL || 'gpt-4o-mini', progress } = {}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing. Add it to .env or turn off AI cleanup.');
  const payload = compactProjectForAI(project);
  const prompt = `You are cleaning text from an imported advertising portfolio page. The static exporter keeps the original scraped media/text order. Your job is only to format existing text into clean metadata lines.

STRICT RULES:
- Return JSON only. No markdown.
- Do not invent projects, clients, awards, publications, agencies, dates, or media.
- Use only text and media provided in the input.
- Remove navigation/footer/review/original-page/social junk.
- Do not create intros, headings, sections, or body copy.
- Do not move text above media. The exporter preserves source order.
- If confidence is low, keep the item but add a warning.
- Metadata such as campaign, brand, agency, award, publication, date should be clean separate lines.
- Extract the advertising brand and campaign name into separate "brand" and "campaign" fields when the source text supports that distinction.
- For a title like "Kinokuniya - Lean on a book", return "brand": "Kinokuniya" and "campaign": "Lean on a book".
- If raw metadata is collapsed together, split it into separate values. For example, "CampaignClientAgency" should become ["Campaign", "Client", "Agency"], not one long string.
- If a value is not clearly present, omit it. Never return placeholder words like Brand, Campaign, Agency, Award, or "optional one-line intro".

Return this schema:
{
  "pageType": "case_study" | "video_case_study" | "editorial_pr" | "gallery",
  "cleanTitle": "",
  "brand": "",
  "campaign": "",
  "intro": "",
  "metadata": ["only exact values present in source text"],
  "sections": [],
  "warnings": []
}`;

  progress?.('AI cleanup', `${project.title}`);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
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
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  return normalizeCleaned(jsonFromText(content), project);
}

export async function cleanupManifestWithAI(manifest, { enabled, progress } = {}) {
  const active = enabled ?? envTrue(process.env.AI_CLEANUP);
  if (!active) return manifest;
  let nextManifest = manifest;
  try {
    nextManifest = await rewriteAboutProfileWithAI(nextManifest, { progress });
  } catch (e) {
    progress?.('AI about bio warning', e.message);
  }
  const projects = [];
  for (const project of nextManifest.projects || []) {
    try {
      const cleaned = await cleanupProjectWithAI(project, { progress });
      projects.push({ ...project, cleaned, title: project.title, warnings: [...(project.warnings || []), ...(cleaned.aiWarnings || [])] });
    } catch (e) {
      projects.push({ ...project, cleaned: null, warnings: [...(project.warnings || []), `AI cleanup failed: ${e.message}`] });
      progress?.('AI cleanup warning', `${project.title}: ${e.message}`);
    }
  }
  return { ...nextManifest, aiCleanup: true, aiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini', projects };
}

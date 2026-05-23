import 'dotenv/config';

function envTrue(v) {
  return ['1','true','yes','on'].includes(String(v || '').toLowerCase());
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
- If raw metadata is collapsed together, split it into separate values. For example, "CampaignClientAgency" should become ["Campaign", "Client", "Agency"], not one long string.
- If a value is not clearly present, omit it. Never return placeholder words like Brand, Campaign, Agency, Award, or "optional one-line intro".

Return this schema:
{
  "pageType": "case_study" | "video_case_study" | "editorial_pr" | "gallery",
  "cleanTitle": "",
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

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
  const projects = [];
  for (const project of manifest.projects || []) {
    try {
      const cleaned = await cleanupProjectWithAI(project, { progress });
      projects.push({ ...project, cleaned, title: project.title, warnings: [...(project.warnings || []), ...(cleaned.aiWarnings || [])] });
    } catch (e) {
      projects.push({ ...project, cleaned: null, warnings: [...(project.warnings || []), `AI cleanup failed: ${e.message}`] });
      progress?.('AI cleanup warning', `${project.title}: ${e.message}`);
    }
  }
  return { ...manifest, aiCleanup: true, aiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini', projects };
}

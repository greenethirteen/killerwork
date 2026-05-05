# OnlyPortfolios Squarespace Importer Web v8 — AI Cleanup

A local SaaS-style MVP that imports Squarespace-style advertising portfolios, downloads accessible assets, preserves video embeds/HLS streams, runs an optional AI cleanup pass, generates a review page, validates output, and packages a ZIP.

## Run

```bash
cd ~/Downloads
unzip -o onlyportfolios-squarespace-importer-web-v8-ai.zip
cd onlyportfolios-importer-web-v8
cp .env.example .env
# Add your OpenAI key to .env if you want AI cleanup
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
npm run web
```

Open:

```text
http://localhost:8787
```

Paste your portfolio URL and turn on **AI cleanup** in the UI.

## AI cleanup

Set this in `.env`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
AI_CLEANUP=true
```

The AI pass does not scrape the web. It only reorganises the raw content already extracted by the importer. It is instructed not to invent projects, titles, awards, clients, or media.

## Output

Each import creates:

```text
generated/<job-id>/
  manifest.raw.json
  manifest.cleaned.json
  manifest.json
  reports/validation.json
  site/
  site.zip
```

## Notes

- Uses installed Chrome where possible to avoid Playwright's large browser download.
- Filters Squarespace social SVGs, HLS segment chunks, blob URLs, duplicate responsive image variants, and bare image paths.
- For video pages, the first image becomes a poster frame instead of being repeated below the video.
- AI cleanup creates structured sections so title blocks can sit above relevant images/articles.


## v8 fix
Assets are now downloaded to `generated/<job>/assets-imported` first, then copied into `generated/<job>/site/assets/imported` after the site folder is regenerated. This prevents missing images in downloaded ZIPs and previews.

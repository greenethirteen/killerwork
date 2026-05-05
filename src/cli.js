import path from 'path';
import { runImport } from './importer.js';

const args = process.argv.slice(2);
const cmd = args[0] || 'import';
function arg(name, fallback='') { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i+1] : fallback; }

if (cmd === 'import') {
  const url = arg('url');
  const out = arg('out', './imports/site');
  if (!url) throw new Error('Use --url https://example.com');
  await runImport({ url, outDir: path.resolve(out), onProgress: e => console.log(`[${e.stage}] ${e.detail || ''}`) });
} else {
  console.log('Unknown command');
}

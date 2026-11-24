// Renders public/icons/icon.svg to the PNG sizes the manifest and iOS need.
// Usage: npm run icons   (requires Playwright's Chromium)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Playwright is not a project dependency: use a local or globally installed copy.
const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(execSync('npm root -g').toString().trim() + '/playwright');
}
const { chromium } = playwright;

const svg = readFileSync('public/icons/icon.svg', 'utf8');
const square = svg.replace('rx="96"', 'rx="0"');
const targets = [
  { file: 'icon-192.png', size: 192, source: svg, pad: 0 },
  { file: 'icon-512.png', size: 512, source: svg, pad: 0 },
  // Maskable and iOS icons are full-bleed; the art sits inside the safe zone.
  { file: 'maskable-512.png', size: 512, source: square, pad: 0.1 },
  { file: 'apple-touch-icon.png', size: 180, source: square, pad: 0.04 },
];

const browser = await chromium.launch();
for (const t of targets) {
  const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
  const inner = Math.round(t.size * (1 - t.pad * 2));
  await page.setContent(
    `<body style="margin:0;background:#0f1a30;display:grid;place-items:center;height:100vh">
       <div style="width:${inner}px;height:${inner}px">${t.source.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
     </body>`,
  );
  await page.screenshot({ path: `public/icons/${t.file}`, omitBackground: t.pad === 0 });
  await page.close();
  console.log('wrote', t.file);
}
await browser.close();

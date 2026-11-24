import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Writes dist/sw.js from src/client/sw.js with the list of every built file,
 * so the whole app (code, fonts, icons, phrase packs) is precached for offline play.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return {
    name: 'smuggled-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = walk(outDir)
        .map((path) => '/' + relative(outDir, path).split('\\').join('/'))
        .filter((path) => path !== '/sw.js' && !path.endsWith('.map') && !path.endsWith('.woff'))
        .sort();
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update(readFileSync(join(outDir, file)));
      const source = readFileSync('src/client/sw.js', 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace("'__FILES__'", JSON.stringify(files.map((f) => (f === '/index.html' ? '/' : f))));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorker()],
  server: {
    host: true,
    // `npm run dev:worker` serves rooms on :8787.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
  build: { target: 'es2020' },
  test: { include: ['tests/**/*.test.ts'] },
});

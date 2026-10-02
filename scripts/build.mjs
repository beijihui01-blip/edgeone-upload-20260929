import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
for (const path of ['index.html', 'favicon.svg', 'og.png', 'assets']) {
  cpSync(path, `dist/${path}`, { recursive: true });
}

console.log('Cloudflare Pages static assets are ready in dist/');

// Copies third-party browser files from node_modules into www/vendor, so the app
// needs no CDN: the native apps and the offline web app load everything locally.
// Run with: npm run vendor (also runs after npm install)
import { copyFileSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const files = {
  'node_modules/@capacitor/core/dist/capacitor.js': 'www/vendor/capacitor.js',
  'node_modules/qrcode-generator/qrcode.js': 'www/vendor/qrcode.js',
  'node_modules/jsqr/dist/jsQR.js': 'www/vendor/jsQR.js',
  'node_modules/zxing-wasm/dist/iife/reader/index.js': 'www/vendor/zxing/zxing-reader.js',
  'node_modules/zxing-wasm/dist/reader/zxing_reader.wasm': 'www/vendor/zxing/zxing_reader.wasm',
  'node_modules/@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-600-normal.woff2': 'www/vendor/fonts/bricolage-grotesque-600.woff2',
  'node_modules/@fontsource/bricolage-grotesque/files/bricolage-grotesque-latin-700-normal.woff2': 'www/vendor/fonts/bricolage-grotesque-700.woff2',
  'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2': 'www/vendor/fonts/ibm-plex-sans-400.woff2',
  'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2': 'www/vendor/fonts/ibm-plex-sans-500.woff2',
  'node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2': 'www/vendor/fonts/ibm-plex-sans-600.woff2',
  'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2': 'www/vendor/fonts/ibm-plex-mono-400.woff2',
  'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2': 'www/vendor/fonts/ibm-plex-mono-500.woff2',
};

mkdirSync(new URL('www/vendor/fonts/', root), { recursive: true });
mkdirSync(new URL('www/vendor/zxing/', root), { recursive: true });
for (const [from, to] of Object.entries(files)) copyFileSync(new URL(from, root), new URL(to, root));
console.log(`Copied ${Object.keys(files).length} files into www/vendor`);

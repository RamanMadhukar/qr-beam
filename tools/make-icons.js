// Generates the web icons in www/icons and the launcher icons and splash images for
// the iOS and Android apps (when those projects exist).
// Run with: npm run icons
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [0x0b, 0x6e, 0x69];
const FG = [0xff, 0xff, 0xff];
const N = 21; // a version-1 QR grid

// Three finder patterns plus an arrow "beaming" out of the bottom-right corner.
const grid = Array.from({ length: N }, () => new Array(N).fill(false));
function finder(r0, c0) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6;
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[r0 + r][c0 + c] = ring || core;
    }
  }
}
finder(0, 0);
finder(0, 14);
finder(14, 0);
for (let c = 9; c <= 19; c++) grid[17][c] = true;
for (let i = 1; i <= 3; i++) {
  grid[17 - i][19 - i] = true;
  grid[17 + i][19 - i] = true;
}
for (const [r, c] of [[9, 9], [9, 11], [10, 10], [11, 9], [11, 12], [8, 12], [12, 10], [10, 13]]) grid[r][c] = true;

// Fraction of the icon the grid fills. 0.64 keeps it inside the 80% safe area of
// maskable web icons; Android adaptive foregrounds must fit a 66dp circle in 108dp.
const ICON_FILL = 0.64;
const ADAPTIVE_FILL = 0.42;
const SPLASH_FILL = 0.2;

function svg() {
  const size = 512;
  const cell = (size * ICON_FILL) / N;
  const off = (size * (1 - ICON_FILL)) / 2;
  let rects = '';
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (grid[r][c]) rects += `<rect x="${(off + c * cell).toFixed(2)}" y="${(off + r * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="112" fill="${hex(BG)}"/><g fill="${hex(FG)}" shape-rendering="crispEdges">${rects}</g></svg>\n`;
}

function hex(rgb) {
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// shape: 'square' fills the whole image, 'circle' is a disc with transparent corners,
// 'none' draws only the white modules on a transparent background.
function png(width, height, { fill, shape = 'square' }) {
  const alpha = shape !== 'square';
  const ch = alpha ? 4 : 3;
  const stride = width * ch + 1;
  const raw = Buffer.alloc(height * stride);
  const side = Math.min(width, height) * fill;
  const cell = side / N;
  const offX = (width - side) / 2;
  const offY = (height - side) / 2;
  const radius = Math.min(width, height) / 2;
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const r = Math.floor((y + 0.5 - offY) / cell);
      const c = Math.floor((x + 0.5 - offX) / cell);
      const on = r >= 0 && r < N && c >= 0 && c < N && grid[r][c];
      const inside = shape !== 'circle' || Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) <= radius;
      const opaque = on || (shape !== 'none' && inside);
      const rgb = on ? FG : BG;
      const i = y * stride + 1 + x * ch;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
      if (alpha) raw[i + 3] = opaque && inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA or RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = new URL('../', import.meta.url);
const written = [];
function write(path, data) {
  const url = new URL(path, root);
  mkdirSync(new URL('.', url), { recursive: true });
  writeFileSync(url, data);
  written.push(path);
}

// Web app
write('www/icons/icon.svg', svg());
write('www/icons/icon-192.png', png(192, 192, { fill: ICON_FILL }));
write('www/icons/icon-512.png', png(512, 512, { fill: ICON_FILL }));

// iOS
if (existsSync(new URL('ios/App/App/Assets.xcassets', root))) {
  const assets = 'ios/App/App/Assets.xcassets';
  write(`${assets}/AppIcon.appiconset/AppIcon-512@2x.png`, png(1024, 1024, { fill: ICON_FILL }));
  const splash = png(2732, 2732, { fill: SPLASH_FILL });
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    write(`${assets}/Splash.imageset/${name}`, splash);
  }
}

// Android
if (existsSync(new URL('android/app/src/main/res', root))) {
  const res = 'android/app/src/main/res';
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(densities)) {
    write(`${res}/mipmap-${d}/ic_launcher.png`, png(48 * k, 48 * k, { fill: ICON_FILL }));
    write(`${res}/mipmap-${d}/ic_launcher_round.png`, png(48 * k, 48 * k, { fill: ICON_FILL, shape: 'circle' }));
    write(`${res}/mipmap-${d}/ic_launcher_foreground.png`, png(108 * k, 108 * k, { fill: ADAPTIVE_FILL, shape: 'none' }));
  }
  const splashSizes = {
    drawable: [480, 320],
    'drawable-port-mdpi': [320, 480],
    'drawable-port-hdpi': [480, 800],
    'drawable-port-xhdpi': [720, 1280],
    'drawable-port-xxhdpi': [960, 1600],
    'drawable-port-xxxhdpi': [1280, 1920],
    'drawable-land-mdpi': [480, 320],
    'drawable-land-hdpi': [800, 480],
    'drawable-land-xhdpi': [1280, 720],
    'drawable-land-xxhdpi': [1600, 960],
    'drawable-land-xxxhdpi': [1920, 1280],
  };
  for (const [dir, [w, h]] of Object.entries(splashSizes)) {
    write(`${res}/${dir}/splash.png`, png(w, h, { fill: SPLASH_FILL * 1.4 }));
  }
  const bgXml = `${res}/values/ic_launcher_background.xml`;
  const xml = readFileSync(new URL(bgXml, root), 'utf8').replace(/#[0-9A-Fa-f]{6}/, hex(BG).toUpperCase());
  write(bgXml, xml);
}

console.log(`Wrote ${written.length} files:\n  ${written.join('\n  ')}`);

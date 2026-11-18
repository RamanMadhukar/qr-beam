// QR Beam transfer protocol.
//
// Pure functions only (no DOM), so the same file runs in the browser and in
// Node for tests.
//
// Pipeline (sender):
//   items -> bundle (manifest + bytes) -> gzip -> payload (version, flags, sha256, body)
//   payload -> K source blocks of S bytes -> fountain-coded frames -> QR text
//
// Each QR holds one frame, written only with QR "alphanumeric" characters so the
// code can use the denser alphanumeric mode:
//   QX1:<session>:<K>:<payloadLength>:<seq>:<base45 block>
// Numbers are base36. Frames with seq < K carry source block `seq` as-is; later
// frames XOR a pseudo-random set of blocks (LT fountain code), so the receiver can
// fill gaps from whatever frames it happens to catch instead of waiting a full loop.

export const FRAME_PREFIX = 'QX1';
const PAYLOAD_VERSION = 1;
const FLAG_GZIP = 1;
const HASH_BYTES = 32;

// ---------- Base45 (RFC 9285) ----------

const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const B45_INDEX = new Map([...B45].map((c, i) => [c, i]));

export function base45Encode(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const n = bytes[i] * 256 + bytes[i + 1];
    out += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
  }
  if (bytes.length % 2) {
    const n = bytes[bytes.length - 1];
    out += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return out;
}

export function base45Decode(text) {
  const rem = text.length % 3;
  if (rem === 1) throw new Error('Invalid base45 length');
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (rem ? 1 : 0));
  let o = 0;
  const val = (c) => {
    const v = B45_INDEX.get(c);
    if (v === undefined) throw new Error('Invalid base45 character');
    return v;
  };
  for (let i = 0; i < text.length; i += 3) {
    if (i + 2 < text.length) {
      const n = val(text[i]) + val(text[i + 1]) * 45 + val(text[i + 2]) * 2025;
      if (n > 0xffff) throw new Error('Invalid base45 triplet');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      const n = val(text[i]) + val(text[i + 1]) * 45;
      if (n > 0xff) throw new Error('Invalid base45 pair');
      out[o++] = n;
    }
  }
  return out;
}

// ---------- Small helpers ----------

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function xorInto(target, src) {
  for (let i = 0; i < target.length; i++) target[i] ^= src[i];
}

async function sha256(bytes) {
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return sha256Js(bytes);
}

// Plain-JS SHA-256 for pages served over http:// (e.g. a phone on the local
// network), where browsers hide crypto.subtle.
let SHA_K = null;
let SHA_H = null;
export function sha256Js(bytes) {
  if (!SHA_K) {
    SHA_K = new Uint32Array(64);
    SHA_H = new Uint32Array(8);
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
    for (let n = 2, found = 0; found < 64; n++) {
      let prime = true;
      for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false;
      if (!prime) continue;
      if (found < 8) SHA_H[found] = frac(Math.sqrt(n));
      SHA_K[found++] = frac(Math.cbrt(n));
    }
  }
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);
  const h = SHA_H.slice();
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function streamThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function newSessionId() {
  const n = globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  return n.toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

// ---------- Bundle + payload ----------

// items: [{ kind: 'file' | 'text', name, type, data: Uint8Array }]
export async function packItems(items) {
  const manifest = {
    v: 1,
    items: items.map(({ kind, name, type, data }) => ({ kind, name, type, size: data.length })),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, manifestBytes.length);
  const bundle = concatBytes([header, manifestBytes, ...items.map((i) => i.data)]);
  const hash = await sha256(bundle);

  let flags = 0;
  let body = bundle;
  if (typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined') {
    const gz = await streamThrough(bundle, new CompressionStream('gzip'));
    if (gz.length < bundle.length) {
      flags |= FLAG_GZIP;
      body = gz;
    }
  }
  return {
    payload: concatBytes([new Uint8Array([PAYLOAD_VERSION, flags]), hash, body]),
    rawSize: bundle.length,
    compressed: Boolean(flags & FLAG_GZIP),
  };
}

export async function unpackPayload(payload) {
  if (payload[0] !== PAYLOAD_VERSION) throw new Error('This code was made by a newer version of the app.');
  const flags = payload[1];
  const hash = payload.subarray(2, 2 + HASH_BYTES);
  let bundle = payload.subarray(2 + HASH_BYTES);
  if (flags & FLAG_GZIP) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed data.');
    bundle = await streamThrough(bundle, new DecompressionStream('gzip'));
  }
  if (!bytesEqual(await sha256(bundle), hash)) throw new Error('Data check failed. Ask the sender to start again.');

  const manifestLen = new DataView(bundle.buffer, bundle.byteOffset, 4).getUint32(0);
  const manifest = JSON.parse(new TextDecoder().decode(bundle.subarray(4, 4 + manifestLen)));
  let offset = 4 + manifestLen;
  const items = manifest.items.map((meta) => {
    const data = bundle.slice(offset, offset + meta.size);
    offset += meta.size;
    return { ...meta, data };
  });
  return items;
}

// ---------- Fountain code (LT, systematic) ----------

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cumulative robust soliton distribution for K blocks.
const cdfCache = new Map();
function degreeCdf(K) {
  if (cdfCache.has(K)) return cdfCache.get(K);
  const c = 0.1;
  const delta = 0.5;
  const R = Math.max(1, c * Math.log(K / delta) * Math.sqrt(K));
  const spike = Math.min(K, Math.max(1, Math.floor(K / R)));
  const weights = new Float64Array(K + 1);
  for (let d = 1; d <= K; d++) {
    const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
    let tau = 0;
    if (d < spike) tau = R / (d * K);
    else if (d === spike) tau = (R * Math.log(R / delta)) / K;
    weights[d] = rho + Math.max(0, tau);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += weights[d] / total;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  cdfCache.set(K, cdf);
  return cdf;
}

// Which source blocks frame `seq` combines. Sender and receiver must agree exactly.
export function blockIndices(sessionId, K, seq) {
  if (seq < K) return [seq];
  const rand = mulberry32((fnv1a(sessionId) ^ Math.imul(seq, 0x9e3779b1)) >>> 0);
  const cdf = degreeCdf(K);
  const r = rand();
  let d = 1;
  while (d < K && cdf[d] < r) d++;
  const picked = new Set();
  while (picked.size < d) picked.add(Math.floor(rand() * K));
  return [...picked];
}

export class FountainEncoder {
  // maxBlockSize caps the bytes per QR code; blocks are then evened out so the
  // last one isn't mostly padding (a 189-byte note gets one 189-byte code).
  constructor(sessionId, payload, maxBlockSize) {
    this.sessionId = sessionId;
    this.length = payload.length;
    this.K = Math.max(1, Math.ceil(payload.length / maxBlockSize));
    const blockSize = Math.max(1, Math.ceil(payload.length / this.K));
    this.blockSize = blockSize;
    this.blocks = [];
    for (let i = 0; i < this.K; i++) {
      const block = new Uint8Array(blockSize);
      block.set(payload.subarray(i * blockSize, (i + 1) * blockSize));
      this.blocks.push(block);
    }
  }

  block(seq) {
    const out = new Uint8Array(this.blockSize);
    for (const i of blockIndices(this.sessionId, this.K, seq)) xorInto(out, this.blocks[i]);
    return out;
  }

  frame(seq) {
    return formatFrame({ sessionId: this.sessionId, K: this.K, length: this.length, seq, data: this.block(seq) });
  }
}

export class FountainDecoder {
  constructor(sessionId, K, length) {
    this.sessionId = sessionId;
    this.K = K;
    this.length = length;
    this.blockSize = null;
    this.blocks = new Array(K).fill(null);
    this.known = 0;
    this.seen = new Set();
    this.refs = new Map(); // block index -> Set of pending equations that include it
  }

  get done() {
    return this.known === this.K;
  }

  // Returns true when the frame was new (not a repeat of one already seen).
  add(seq, data) {
    if (this.done || this.seen.has(seq)) return false;
    if (this.blockSize === null) this.blockSize = data.length;
    if (data.length !== this.blockSize) return false;
    this.seen.add(seq);

    const block = data.slice();
    const unknown = new Set();
    for (const i of blockIndices(this.sessionId, this.K, seq)) {
      if (this.blocks[i]) xorInto(block, this.blocks[i]);
      else unknown.add(i);
    }
    if (unknown.size === 1) {
      this.#resolve(unknown.values().next().value, block);
    } else if (unknown.size > 1) {
      const eq = { idx: unknown, data: block };
      for (const i of unknown) {
        if (!this.refs.has(i)) this.refs.set(i, new Set());
        this.refs.get(i).add(eq);
      }
    }
    return true;
  }

  #resolve(index, data) {
    const queue = [[index, data]];
    while (queue.length) {
      const [b, d] = queue.pop();
      if (this.blocks[b]) continue;
      this.blocks[b] = d;
      this.known++;
      const eqs = this.refs.get(b);
      if (!eqs) continue;
      this.refs.delete(b);
      for (const eq of eqs) {
        xorInto(eq.data, d);
        eq.idx.delete(b);
        if (eq.idx.size === 1) {
          const last = eq.idx.values().next().value;
          this.refs.get(last)?.delete(eq);
          queue.push([last, eq.data]);
        }
      }
    }
  }

  isKnown(i) {
    return this.blocks[i] !== null;
  }

  payload() {
    if (!this.done) throw new Error('Transfer is not complete yet');
    return concatBytes(this.blocks).subarray(0, this.length);
  }
}

// ---------- Frame text ----------

export function formatFrame({ sessionId, K, length, seq, data }) {
  const b36 = (n) => n.toString(36).toUpperCase();
  return `${FRAME_PREFIX}:${sessionId}:${b36(K)}:${b36(length)}:${b36(seq)}:${base45Encode(data)}`;
}

const FRAME_RE = /^QX1:([0-9A-Z]+):([0-9A-Z]+):([0-9A-Z]+):([0-9A-Z]+):([0-9A-Z $%*+\-./:]+)$/;

// Returns null for anything that is not one of our frames (e.g. a random QR code).
export function parseFrame(text) {
  const m = FRAME_RE.exec(text);
  if (!m) return null;
  try {
    return {
      sessionId: m[1],
      K: parseInt(m[2], 36),
      length: parseInt(m[3], 36),
      seq: parseInt(m[4], 36),
      data: base45Decode(m[5]),
    };
  } catch {
    return null;
  }
}

// ---------- Planning helpers for the UI ----------

// Transfer modes: bytes per QR code, codes on screen at once, and QR error
// correction. Bigger, denser codes move more per frame but need a steadier hand
// and a sharper camera. Screen-to-camera links don't suffer the physical damage
// QR's stronger error correction is for, so the fast modes use level L.
export const MODES = {
  easy: { label: 'Easy scan', blockSize: 300, codes: 1, ecc: 'M' },
  balanced: { label: 'Balanced', blockSize: 700, codes: 1, ecc: 'L' },
  fast: { label: 'Fast', blockSize: 700, codes: 2, ecc: 'L' },
  max: { label: 'Max', blockSize: 1100, codes: 2, ecc: 'L' },
};

// Rough time to receive, assuming about a fifth of codes are missed or redundant.
export function estimateSeconds(payloadLength, mode, fps) {
  const K = Math.max(1, Math.ceil(payloadLength / mode.blockSize));
  return (K * 1.2) / (fps * mode.codes);
}

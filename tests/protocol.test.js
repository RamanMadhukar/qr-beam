// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base45Encode,
  base45Decode,
  packItems,
  unpackPayload,
  FountainEncoder,
  FountainDecoder,
  parseFrame,
  newSessionId,
  sha256Js,
} from '../www/js/protocol.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const randomBytes = (n) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, i + 65536));
  return out;
};

test('base45 matches RFC 9285 examples', () => {
  assert.equal(base45Encode(enc('AB')), 'BB8');
  assert.equal(base45Encode(enc('Hello!!')), '%69 VD92EX0');
  assert.equal(base45Encode(enc('base-45')), 'UJCLQE7W581');
  assert.equal(dec(base45Decode('QED8WEX0')), 'ietf!');
  assert.throws(() => base45Decode('GGW'));
  assert.throws(() => base45Decode('A'));
});

test('base45 round-trips random bytes', () => {
  for (let n = 0; n < 50; n++) {
    const bytes = crypto.getRandomValues(new Uint8Array(n * 7 + (n % 2)));
    assert.deepEqual(base45Decode(base45Encode(bytes)), bytes);
  }
});

test('pack/unpack keeps files and text intact', async () => {
  const items = [
    { kind: 'text', name: 'Note', type: 'text/plain', data: enc('Wi-Fi password is on the fridge ✓') },
    { kind: 'file', name: 'photo.bin', type: 'application/octet-stream', data: crypto.getRandomValues(new Uint8Array(5000)) },
    { kind: 'file', name: 'empty.txt', type: 'text/plain', data: new Uint8Array(0) },
  ];
  const { payload } = await packItems(items);
  const out = await unpackPayload(payload);
  assert.equal(out.length, 3);
  for (let i = 0; i < items.length; i++) {
    assert.equal(out[i].name, items[i].name);
    assert.equal(out[i].kind, items[i].kind);
    assert.deepEqual(out[i].data, items[i].data);
  }
});

test('text compresses', async () => {
  const { payload, rawSize, compressed } = await packItems([
    { kind: 'text', name: 'Note', type: 'text/plain', data: enc('hello '.repeat(2000)) },
  ]);
  assert.ok(compressed);
  assert.ok(payload.length < rawSize / 10);
});

test('corrupted payload is rejected', async () => {
  const { payload } = await packItems([
    { kind: 'file', name: 'a', type: '', data: crypto.getRandomValues(new Uint8Array(300)) },
  ]);
  payload[payload.length - 1] ^= 1;
  await assert.rejects(unpackPayload(payload));
});

// Simulates a receiver that starts late, misses frames at random and sees repeats.
function transfer(payload, blockSize, lossRate, startSeq) {
  const sid = newSessionId();
  const encoder = new FountainEncoder(sid, payload, blockSize);
  let decoder = null;
  let shown = 0;
  for (let seq = startSeq; shown < encoder.K * 20; seq++, shown++) {
    if (Math.random() < lossRate) continue;
    const text = encoder.frame(seq);
    const f = parseFrame(text);
    assert.ok(f, 'frame should parse');
    decoder ??= new FountainDecoder(f.sessionId, f.K, f.length);
    decoder.add(f.seq, f.data);
    decoder.add(f.seq, f.data); // duplicate scans are ignored
    if (decoder.done) return { payload: decoder.payload(), shown, K: encoder.K };
  }
  throw new Error(`did not finish: ${decoder?.known}/${encoder.K}`);
}

test('fountain transfer survives loss, late start and repeats', async () => {
  const sizes = [1, 159, 160, 161, 2000, 30000, 120000];
  for (const size of sizes) {
    const { payload } = await packItems([
      { kind: 'file', name: 'f', type: '', data: randomBytes(size) },
    ]);
    for (const [loss, start] of [[0, 0], [0.3, 0], [0.3, 7], [0.5, 1000]]) {
      const r = transfer(payload, 320, loss, start);
      assert.deepEqual(r.payload, payload, `size ${size} loss ${loss} start ${start}`);
    }
  }
});

test('missing a few systematic frames costs only a few extra frames', async () => {
  const payload = randomBytes(320 * 200);
  const sid = newSessionId();
  const encoder = new FountainEncoder(sid, payload, 320);
  const decoder = new FountainDecoder(sid, encoder.K, payload.length);
  const missed = new Set([3, 50, 51, 120, 199]);
  for (let seq = 0; seq < encoder.K; seq++) if (!missed.has(seq)) decoder.add(seq, encoder.block(seq));
  let extra = 0;
  for (let seq = encoder.K; !decoder.done; seq++, extra++) decoder.add(seq, encoder.block(seq));
  assert.deepEqual(decoder.payload(), payload);
  assert.ok(extra < encoder.K / 2, `needed ${extra} extra frames`);
});

test('non-app QR codes are ignored', () => {
  assert.equal(parseFrame('https://example.com'), null);
  assert.equal(parseFrame('QX1:ABC:1:1:0:'), null);
  assert.equal(parseFrame('QX1:ABC:1:1:0:A'), null);
});

test('plain-JS SHA-256 matches WebCrypto', async () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
    const bytes = randomBytes(n);
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    assert.deepEqual(sha256Js(bytes), expected, `length ${n}`);
  }
});

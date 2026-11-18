import {
  packItems,
  unpackPayload,
  FountainEncoder,
  FountainDecoder,
  parseFrame,
  newSessionId,
  MODES,
  estimateSeconds,
} from './protocol.js';
import { saveTransfer, listTransfers, deleteTransfer } from './store.js';
import { createScanner } from './scanner.js';
import { isNative, keepScreenOn, copyText, saveFile, shareFile, shareText, canShareNatively } from './native.js';

const $ = (id) => document.getElementById(id);
const MAX_SEND_BYTES = 10 * 1024 * 1024;
const SLOW_SECONDS = 120;

// ---------- Formatting ----------

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function formatDuration(sec) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} min ${s} s` : `${m} min`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function fileBadge(name, type) {
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (ext && ext.length <= 4) return ext;
  if (type.startsWith('image/')) return 'img';
  return 'file';
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>';

// Object URLs for previews and downloads, grouped so each view can free its own.
const urlGroups = new Map();
function objectUrl(group, blob) {
  const url = URL.createObjectURL(blob);
  if (!urlGroups.has(group)) urlGroups.set(group, []);
  urlGroups.get(group).push(url);
  return url;
}
function revokeUrls(group) {
  for (const url of urlGroups.get(group) ?? []) URL.revokeObjectURL(url);
  urlGroups.delete(group);
}

// ---------- Preferences (this device only) ----------

const MIN_FPS = 2;
const MAX_FPS = 20;
const prefs = { mode: 'fast', fps: 10 };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem('qr-beam-prefs') || '{}'));
} catch {
  // Storage blocked; defaults are fine.
}
if (!MODES[prefs.mode]) prefs.mode = 'fast';
prefs.fps = Math.min(MAX_FPS, Math.max(MIN_FPS, Number(prefs.fps) || 10));
const currentMode = () => MODES[prefs.mode];

function savePrefs() {
  try {
    localStorage.setItem('qr-beam-prefs', JSON.stringify(prefs));
  } catch {
    // Not critical.
  }
}

// ---------- State ----------

const send = { files: [], packed: null, packVersion: 0, packTimer: 0, active: false, paused: false, encoder: null, mode: null, feed: null, seq: 0, nextAt: 0, raf: 0 };
const recv = { active: false, finishing: false, stream: null, scanner: null, decoder: null, firstAt: 0, newTimes: [], scanTimes: [], renderQueued: false, toastTimer: 0, lastToastAt: 0, tick: 0 };
let unseen = 0;

// ---------- Keep the screen on while sending or receiving ----------

const keepAwake = keepScreenOn;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ((send.active && !send.paused) || recv.active)) keepAwake(true);
});

// ---------- Views ----------

const VIEWS = ['send', 'receive', 'inbox'];
let currentView = null;

function showView(name) {
  if (!VIEWS.includes(name)) name = 'send';
  if (name === currentView) return;
  if (currentView === 'send') stopSending();
  if (currentView === 'receive') stopReceiving();
  currentView = name;
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (name === 'inbox') {
    unseen = 0;
    renderInbox();
  }
  renderInboxCount();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ---------- Send: choosing what to send ----------

function addFiles(fileList) {
  for (const file of fileList) send.files.push(file);
  renderSendItems();
  schedulePack();
}

function renderSendItems() {
  revokeUrls('send');
  const list = $('send-items');
  list.replaceChildren(
    ...send.files.map((file, index) => {
      const icon = el('span', { class: 'file-icon', text: fileBadge(file.name, file.type) });
      if (file.type.startsWith('image/')) {
        icon.textContent = '';
        icon.append(el('img', { src: objectUrl('send', file), alt: '' }));
      }
      const remove = el('button', {
        type: 'button',
        class: 'icon-button',
        'aria-label': `Remove ${file.name}`,
        onclick: () => {
          send.files.splice(index, 1);
          renderSendItems();
          schedulePack();
        },
      });
      remove.innerHTML = ICON_X;
      return el('li', { class: 'file-row' }, [
        icon,
        el('div', { class: 'file-meta' }, [
          el('div', { class: 'file-name', text: file.name }),
          el('div', { class: 'file-size', text: formatBytes(file.size) }),
        ]),
        remove,
      ]);
    }),
  );
}

function schedulePack() {
  clearTimeout(send.packTimer);
  send.packTimer = setTimeout(repack, 250);
}

async function repack() {
  const version = ++send.packVersion;
  const note = $('note').value;
  const hasNote = note.trim().length > 0;
  if (!hasNote && !send.files.length) {
    send.packed = null;
    renderSummary();
    return;
  }
  const rawSize = send.files.reduce((n, f) => n + f.size, 0) + (hasNote ? note.length * 3 : 0);
  if (rawSize > MAX_SEND_BYTES) {
    send.packed = { tooBig: true, rawSize };
    renderSummary();
    return;
  }
  $('start-send').disabled = true;
  $('sum-size').textContent = '…';
  try {
    const items = [];
    if (hasNote) items.push({ kind: 'text', name: 'Note', type: 'text/plain', data: new TextEncoder().encode(note) });
    for (const file of send.files) {
      items.push({
        kind: 'file',
        name: file.name,
        type: file.type || 'application/octet-stream',
        data: new Uint8Array(await file.arrayBuffer()),
      });
    }
    const packed = await packItems(items);
    if (version !== send.packVersion) return;
    send.packed = packed;
  } catch {
    if (version !== send.packVersion) return;
    send.packed = { error: 'One of the files could not be read. Remove it and try again.' };
  }
  renderSummary();
}

function renderSummary() {
  const p = send.packed;
  const mode = currentMode();
  const warning = $('sum-warning');
  const start = $('start-send');
  $('fps-out').textContent = $('fps-live-out').textContent = `${prefs.fps} frames/s`;
  warning.hidden = true;
  start.disabled = true;

  if (!p) {
    $('sum-size').textContent = $('sum-frames').textContent = $('sum-time').textContent = '—';
    return;
  }
  if (p.tooBig || p.error) {
    $('sum-size').textContent = p.tooBig ? formatBytes(p.rawSize) : '—';
    $('sum-frames').textContent = $('sum-time').textContent = '—';
    warning.textContent = p.error ?? `That is more than QR codes can carry in a reasonable time. Keep the total under ${formatBytes(MAX_SEND_BYTES)}.`;
    warning.hidden = false;
    return;
  }

  const len = p.payload.length;
  const secs = estimateSeconds(len, mode, prefs.fps);
  $('sum-size').textContent = formatBytes(len);
  $('sum-size').title = p.compressed ? `Compressed from ${formatBytes(p.rawSize)}` : '';
  $('sum-frames').textContent = String(Math.ceil(len / mode.blockSize));
  $('sum-time').textContent = `~${formatDuration(secs)}`;
  if (secs > SLOW_SECONDS) {
    warning.textContent =
      prefs.mode === 'max' && prefs.fps >= 15
        ? 'This will take a few minutes even at full speed. QR codes carry a few dozen KB per second at most.'
        : 'This will take a few minutes. For big files, choose Max and raise the speed if both devices are steady.';
    warning.hidden = false;
  }
  start.disabled = false;
}

function initSendControls() {
  $('add-files').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  const dz = $('dropzone');
  for (const type of ['dragenter', 'dragover']) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    dz.addEventListener(type, (e) => {
      e.preventDefault();
      dz.classList.remove('over');
    });
  }
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  $('note').addEventListener('input', schedulePack);

  $(`mode-${prefs.mode}`).checked = true;
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', () => {
      prefs.mode = radio.value;
      savePrefs();
      renderSummary();
    });
  }

  for (const id of ['fps', 'fps-live']) {
    const slider = $(id);
    slider.min = MIN_FPS;
    slider.max = MAX_FPS;
    slider.value = prefs.fps;
    slider.addEventListener('input', () => {
      prefs.fps = Number(slider.value);
      $('fps').value = $('fps-live').value = prefs.fps;
      savePrefs();
      renderSummary();
    });
  }

  $('start-send').addEventListener('click', startSending);
  $('stop-send').addEventListener('click', stopSending);
  $('pause-send').addEventListener('click', () => {
    send.paused = !send.paused;
    $('pause-send').textContent = send.paused ? 'Resume' : 'Pause';
    keepAwake(!send.paused);
    if (!send.paused) {
      send.nextAt = 0;
      send.raf = requestAnimationFrame(sendTick);
    }
  });
  window.addEventListener('resize', () => {
    if (send.active) layoutCodes();
  });

  renderSummary();
}

// ---------- Send: broadcasting ----------

function buildCodeMatrix(text, ecc) {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const n = qr.getModuleCount();
  const bits = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) bits[r * n + c] = qr.isDark(r, c) ? 1 : 0;
  }
  return { n, bits };
}

// Builds upcoming QR codes in background workers, since building one large code
// takes longer than a frame lasts on a phone. Falls back to the main thread.
class CodeFeed {
  constructor(encoder, ecc) {
    this.encoder = encoder;
    this.ecc = ecc;
    this.ready = new Map();
    this.requested = 0;
    this.workers = [];
    this.failed = false;
    const count = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
    try {
      for (let i = 0; i < count; i++) {
        const worker = new Worker(new URL('./qr-worker.js', import.meta.url));
        worker.onmessage = (e) => this.ready.set(e.data.seq, e.data);
        worker.onerror = (e) => {
          e.preventDefault();
          this.failed = true;
        };
        this.workers.push(worker);
      }
    } catch {
      this.failed = true;
    }
  }

  // Keeps the codes from `seq` to `seq + ahead` on order.
  prefetch(seq, ahead) {
    if (this.failed) return;
    this.requested = Math.max(this.requested, seq);
    while (this.requested < seq + ahead) {
      const next = this.requested++;
      this.workers[next % this.workers.length].postMessage({ seq: next, text: this.encoder.frame(next), ecc: this.ecc });
    }
  }

  has(seq) {
    return this.failed || this.ready.has(seq);
  }

  take(seq) {
    const matrix = this.ready.get(seq);
    if (matrix) {
      this.ready.delete(seq);
      return matrix;
    }
    return buildCodeMatrix(this.encoder.frame(seq), this.ecc);
  }

  close() {
    for (const worker of this.workers) worker.terminate();
  }
}

// Draws a QR code with crisp, whole-pixel modules and the standard 4-module quiet
// zone, writing pixels directly rather than one fillRect per module.
function drawMatrix(canvas, { n, bits }) {
  const total = n + 8;
  const target = Math.round((canvas.clientWidth || 480) * (window.devicePixelRatio || 1));
  const scale = Math.max(1, Math.floor(target / total));
  const size = total * scale;
  if (canvas.width !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const px = new Uint32Array(image.data.buffer);
  px.fill(0xffffffff);
  const black = 0xff000000;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!bits[r * n + c]) continue;
      const x0 = (c + 4) * scale;
      for (let y = (r + 4) * scale, yEnd = y + scale; y < yEnd; y++) px.fill(black, y * size + x0, y * size + x0 + scale);
    }
  }
  ctx.putImageData(image, 0, 0);
}

// One canvas per code on screen, as large as the screen allows: stacked on a tall
// screen, side by side on a wide one.
function layoutCodes() {
  const stage = $('qr-stage');
  const n = send.mode.codes;
  while (stage.children.length < n) stage.append(el('canvas', { class: 'qr-canvas', 'aria-label': 'Animated QR code' }));
  while (stage.children.length > n) stage.lastChild.remove();
  const gap = n > 1 ? 12 : 0;
  const css = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  const height = stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
  const stacked = height >= width;
  const size = Math.floor(stacked ? Math.min(width, (height - gap * (n - 1)) / n) : Math.min((width - gap * (n - 1)) / n, height));
  stage.classList.toggle('stacked', stacked);
  stage.style.gap = `${gap}px`;
  for (const canvas of stage.children) {
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
  }
}

function startSending() {
  const p = send.packed;
  if (!p?.payload) return;
  if (typeof qrcode !== 'function') {
    const warning = $('sum-warning');
    warning.textContent = 'The QR code maker did not load. Check your connection and reload the page.';
    warning.hidden = false;
    return;
  }
  send.mode = currentMode();
  send.encoder = new FountainEncoder(newSessionId(), p.payload, send.mode.blockSize);
  send.feed = new CodeFeed(send.encoder, send.mode.ecc);
  send.seq = 0;
  send.nextAt = 0;
  send.active = true;
  send.paused = false;
  $('pause-send').textContent = 'Pause';
  $('send-compose').hidden = true;
  $('send-live').hidden = false;
  document.body.classList.add('broadcasting');
  layoutCodes();
  keepAwake(true);
  send.raf = requestAnimationFrame(sendTick);
}

// Paced by the display's refresh so every frame is shown for the same time. If the
// next codes aren't built yet the frame waits, so a slow phone sends a little slower
// instead of stuttering.
function sendTick(now) {
  if (!send.active || send.paused) return;
  send.raf = requestAnimationFrame(sendTick);
  const { encoder, mode, feed } = send;
  feed.prefetch(send.seq, mode.codes * 6);
  if (send.nextAt && now < send.nextAt - 2) return;
  for (let i = 0; i < mode.codes; i++) if (!feed.has(send.seq + i)) return;
  send.nextAt = Math.max((send.nextAt || now) + 1000 / prefs.fps, now);

  let modules = 0;
  for (const canvas of $('qr-stage').children) {
    const matrix = feed.take(send.seq++);
    drawMatrix(canvas, matrix);
    modules = matrix.n;
  }
  const shown = send.seq;
  const phase = encoder.K === 1 ? 'SINGLE CODE' : shown <= encoder.K ? `PASS 1 · ${shown}/${encoder.K}` : `REPAIR · ${shown - encoder.K}`;
  $('send-readout').textContent = `${encoder.sessionId} · ${phase} · ${mode.codes}×${encoder.blockSize} B · v${(modules - 17) / 4}-${mode.ecc}`;
}

function stopSending() {
  if (!send.active) return;
  send.active = false;
  cancelAnimationFrame(send.raf);
  send.feed?.close();
  send.feed = null;
  document.body.classList.remove('broadcasting');
  $('send-live').hidden = true;
  $('send-compose').hidden = false;
  keepAwake(false);
}

// ---------- Receive ----------

function cameraErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this site in your browser settings, then tap Start camera again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'Another app is using the camera. Close it and try again.';
    default:
      return `The camera could not start (${e?.name || 'unknown error'}). Reload the page and try again.`;
  }
}

function showRecvError(message) {
  $('recv-error').textContent = message;
  $('recv-error').hidden = false;
}

async function startReceiving() {
  $('recv-error').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    showRecvError(
      window.isSecureContext
        ? 'This browser cannot use the camera.'
        : 'The camera only works on a secure page. Open this app from an https:// address (or localhost) to receive.',
    );
    return;
  }
  const button = $('start-recv');
  button.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    recv.scanner ??= await createScanner();
  } catch (e) {
    stream?.getTracks().forEach((t) => t.stop());
    button.disabled = false;
    showRecvError(cameraErrorMessage(e));
    return;
  }
  button.disabled = false;
  if (currentView !== 'receive') {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  recv.stream = stream;
  const video = $('video');
  video.srcObject = stream;
  video.play().catch(() => {});
  // Show the whole camera frame, since all of it is scanned (two codes may be on screen).
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (video.videoWidth) document.querySelector('.viewfinder').style.setProperty('--ar', video.videoWidth / video.videoHeight);
    },
    { once: true },
  );

  recv.decoder = null;
  recv.newTimes = [];
  recv.scanTimes = [];
  recv.active = true;
  recv.finishing = false;
  document.querySelector('.viewfinder').classList.remove('locked');
  $('recv-idle').hidden = true;
  $('recv-done').hidden = true;
  $('recv-live').hidden = false;
  keepAwake(true);
  renderProgress();
  clearInterval(recv.tick);
  recv.tick = setInterval(queueRender, 1000);
  scanLoop();
}

// Hands each new camera frame to the scanner whenever it has a free decoder, without
// waiting for earlier frames to finish, so several frames decode in parallel.
function scanLoop() {
  const video = $('video');
  const nextFrame = (fn) => (video.requestVideoFrameCallback ? video.requestVideoFrameCallback(fn) : requestAnimationFrame(fn));
  const step = () => {
    if (!recv.active) return;
    const { scanner } = recv;
    if (scanner.dead) {
      stopReceiving();
      showRecvError('The QR reader could not start. Reload the page and try again.');
      return;
    }
    if (video.readyState >= 2 && video.videoWidth && scanner.hasCapacity()) {
      scanner
        .decode(video)
        .then((texts) => {
          recv.scanTimes.push(performance.now());
          for (const text of texts) handleCode(text);
        })
        .catch((e) => {
          if (scanner.kind === 'jsqr-main' && recv.active) {
            stopReceiving();
            showRecvError(e.message);
          }
        });
    }
    nextFrame(step);
  };
  step();
}

function toast(message) {
  const now = performance.now();
  if (now - recv.lastToastAt < 4000) return;
  recv.lastToastAt = now;
  const node = $('recv-toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(recv.toastTimer);
  recv.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2600);
}

function handleCode(text) {
  if (!recv.active || recv.finishing) return;
  const frame = parseFrame(text);
  if (!frame) {
    toast('That QR code is not from QR Beam.');
    return;
  }
  let d = recv.decoder;
  if (!d || d.sessionId !== frame.sessionId || d.K !== frame.K || d.length !== frame.length) {
    if (d?.known) toast('The sender started a new transfer. Starting over.');
    d = recv.decoder = new FountainDecoder(frame.sessionId, frame.K, frame.length);
    recv.firstAt = performance.now();
    recv.newTimes = [];
    document.querySelector('.viewfinder').classList.add('locked');
  }
  if (d.add(frame.seq, frame.data)) {
    recv.newTimes.push(performance.now());
    queueRender();
    if (d.done) finishReceiving();
  }
}

function queueRender() {
  if (recv.renderQueued) return;
  recv.renderQueued = true;
  requestAnimationFrame(renderProgress);
}

function renderProgress() {
  recv.renderQueued = false;
  const d = recv.decoder;
  const now = performance.now();
  recv.scanTimes = recv.scanTimes.filter((t) => now - t < 2000);
  const scanRate = recv.scanTimes.length / 2;
  const engine = `${recv.scanner?.kind ?? ''} · ${scanRate.toFixed(0)} SCANS/s`.toUpperCase();
  if (!d) {
    $('recv-status').textContent = 'Looking for a QR Beam code…';
    $('recv-percent').textContent = '0%';
    $('recv-readout').textContent = `FIT THE WHOLE SENDING SCREEN IN VIEW · ${engine}`;
    drawBlockMap(null);
    return;
  }
  recv.newTimes = recv.newTimes.filter((t) => now - t < 4000);
  const span = Math.min(4, Math.max(1, (now - recv.firstAt) / 1000));
  const rate = recv.newTimes.length / span;
  const remaining = d.K - d.known;
  const bytesPerSecond = (rate * d.length) / d.K;
  $('recv-status').textContent = d.done ? 'Checking and saving…' : `Receiving ${formatBytes(d.length)}`;
  $('recv-percent').textContent = `${Math.floor((d.known / d.K) * 100)}%`;
  let readout = `${d.known}/${d.K} BLOCKS · ${d.seen.size} CODES`;
  if (rate > 0 && remaining > 0) readout += ` · ${formatBytes(Math.round(bytesPerSecond))}/s · ~${formatDuration((remaining * 1.2) / rate)} LEFT`;
  $('recv-readout').textContent = `${readout} · ${engine}`;
  drawBlockMap(d);
}

// One cell per block of the payload, filled in as blocks are recovered.
function drawBlockMap(d) {
  const canvas = $('block-map');
  const width = canvas.clientWidth || 300;
  const dpr = window.devicePixelRatio || 1;
  const K = d?.K ?? 48;
  const cell = Math.min(16, Math.max(3, Math.floor(Math.sqrt((width * 44) / K))));
  const gap = cell >= 6 ? 2 : 1;
  const cols = Math.max(1, Math.floor((width + gap) / (cell + gap)));
  const rows = Math.ceil(K / cols);
  const height = rows * (cell + gap) - gap;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const on = css.getPropertyValue('--accent').trim();
  const off = css.getPropertyValue('--cell-empty').trim();
  for (let i = 0; i < K; i++) {
    ctx.fillStyle = d?.isKnown(i) ? on : off;
    ctx.fillRect((i % cols) * (cell + gap), Math.floor(i / cols) * (cell + gap), cell, cell);
  }
}

async function finishReceiving() {
  recv.finishing = true;
  renderProgress();
  const d = recv.decoder;
  const seconds = (performance.now() - recv.firstAt) / 1000;
  stopCamera();
  navigator.vibrate?.(60);

  let record;
  try {
    const items = await unpackPayload(d.payload());
    record = {
      id: globalThis.crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      receivedAt: Date.now(),
      bytes: items.reduce((n, i) => n + i.size, 0),
      items: items.map(({ kind, name, type, size, data }) => ({
        kind,
        name,
        type,
        size,
        blob: new Blob([data], { type: type || 'application/octet-stream' }),
      })),
    };
  } catch (e) {
    stopReceiving();
    showRecvError(e.message || 'The received data could not be read. Ask the sender to start again.');
    return;
  }

  let saved = true;
  try {
    await saveTransfer(record);
    if (currentView !== 'inbox') unseen++;
  } catch {
    saved = false;
  }
  recv.finishing = false;
  renderInboxCount();

  $('recv-live').hidden = true;
  $('recv-done').hidden = false;
  $('done-title').textContent = saved ? 'Saved to Inbox' : 'Received';
  $('done-detail').textContent = `${plural(record.items.length, 'item')} · ${formatBytes(record.bytes)} · took ${formatDuration(seconds)}`;
  $('done-error').textContent = 'This browser would not store the data, so it is only here until you leave this page. Save the files now.';
  $('done-error').hidden = saved;
  revokeUrls('done');
  $('done-transfer').replaceChildren(renderTransfer(record, 'done'));
}

function stopCamera() {
  recv.active = false;
  clearInterval(recv.tick);
  recv.stream?.getTracks().forEach((t) => t.stop());
  recv.stream = null;
  $('video').srcObject = null;
  keepAwake(false);
}

function stopReceiving() {
  stopCamera();
  recv.decoder = null;
  recv.finishing = false;
  $('recv-live').hidden = true;
  $('recv-done').hidden = true;
  $('recv-idle').hidden = false;
}

$('start-recv').addEventListener('click', startReceiving);
$('stop-recv').addEventListener('click', stopReceiving);
$('recv-again').addEventListener('click', () => {
  stopReceiving();
  startReceiving();
});

// ---------- Received items (done view + inbox) ----------

// A button that runs an async action and reports the outcome under the item.
function actionButton(label, status, run) {
  const button = el('button', { type: 'button', class: 'button small', text: label });
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const message = await run();
      if (message) {
        status.textContent = message;
        status.hidden = false;
      }
    } catch (e) {
      // Closing the share sheet without picking anything is not an error.
      if (!/cancel/i.test(e?.message ?? '')) {
        status.textContent = e?.message || 'That did not work. Try again.';
        status.hidden = false;
      }
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

// The iOS and Android apps save and share through the OS instead of browser downloads.
function renderNativeItem(item, group) {
  const node = renderItemHeader(item, group);
  const actions = el('div', { class: 'item-actions' });
  const status = el('p', { class: 'item-status', 'aria-live': 'polite' });
  status.hidden = true;
  if (item.kind === 'text') {
    actions.append(
      actionButton('Copy', status, async () => {
        await copyText(await item.blob.text());
        return 'Copied';
      }),
    );
    if (canShareNatively) actions.append(actionButton('Share', status, async () => shareText(await item.blob.text(), item.name)));
  } else {
    actions.append(
      actionButton('Save', status, async () => {
        try {
          return await saveFile(item.blob, item.name);
        } catch {
          // e.g. Android 10 and older without storage access: let the person pick a place.
          await shareFile(item.blob, item.name, item.name);
          return '';
        }
      }),
    );
    if (canShareNatively) actions.append(actionButton('Share', status, () => shareFile(item.blob, item.name, item.name)));
  }
  node.append(actions, status);
  return node;
}

// Icon, name, size, plus the note text or image preview.
function renderItemHeader(item, group) {
  const top = el('div', { class: 'item-top' });
  const node = el('li', { class: 'item' }, [top]);
  const isText = item.kind === 'text';
  top.append(
    el('span', { class: 'file-icon', text: isText ? 'txt' : fileBadge(item.name, item.type) }),
    el('div', { class: 'file-meta' }, [
      el('div', { class: 'file-name', text: item.name }),
      el('div', { class: 'file-size', text: isText ? formatBytes(item.size) : `${formatBytes(item.size)} · ${item.type || 'file'}` }),
    ]),
  );
  if (isText) {
    const pre = el('pre', { class: 'note-text' });
    item.blob.text().then((t) => {
      pre.textContent = t;
    });
    node.append(pre);
  } else if (item.type.startsWith('image/')) {
    node.append(el('img', { class: 'preview', src: objectUrl(group, item.blob), alt: item.name }));
  }
  return node;
}

function renderItem(item, group) {
  if (isNative) return renderNativeItem(item, group);
  const actions = el('div', { class: 'item-actions' });
  const top = el('div', { class: 'item-top' });
  const node = el('li', { class: 'item' }, [top]);

  if (item.kind === 'text') {
    top.append(
      el('span', { class: 'file-icon', text: 'txt' }),
      el('div', { class: 'file-meta' }, [
        el('div', { class: 'file-name', text: item.name }),
        el('div', { class: 'file-size', text: formatBytes(item.size) }),
      ]),
    );
    const pre = el('pre', { class: 'note-text' });
    item.blob.text().then((t) => {
      pre.textContent = t;
    });
    node.append(pre);
    const copy = el('button', { type: 'button', class: 'button small', text: 'Copy' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        copy.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        copy.textContent = 'Selected. Copy it now';
      }
      setTimeout(() => {
        copy.textContent = 'Copy';
      }, 2000);
    });
    actions.append(copy);
  } else {
    const url = objectUrl(group, item.blob);
    const isImage = item.type.startsWith('image/');
    const icon = el('span', { class: 'file-icon', text: fileBadge(item.name, item.type) });
    top.append(
      icon,
      el('div', { class: 'file-meta' }, [
        el('div', { class: 'file-name', text: item.name }),
        el('div', { class: 'file-size', text: `${formatBytes(item.size)} · ${item.type || 'file'}` }),
      ]),
    );
    if (isImage) node.append(el('img', { class: 'preview', src: url, alt: item.name }));
    actions.append(el('a', { class: 'button small', href: url, download: item.name, text: 'Save' }));
    actions.append(el('a', { class: 'button small', href: url, target: '_blank', rel: 'noopener', text: 'Open' }));
  }

  const shareFile = new File([item.blob], item.kind === 'text' ? 'note.txt' : item.name, { type: item.blob.type });
  if (navigator.canShare?.({ files: [shareFile] })) {
    actions.append(
      el('button', {
        type: 'button',
        class: 'button small',
        text: 'Share',
        onclick: () => navigator.share({ files: [shareFile], title: item.name }).catch(() => {}),
      }),
    );
  }
  node.append(actions);
  return node;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function renderTransfer(record, group, onDelete) {
  const head = el('div', { class: 'transfer-head' }, [
    el('div', {}, [
      el('div', { class: 'transfer-when', text: dateFormat.format(record.receivedAt) }),
      el('div', { class: 'transfer-sub', text: `${plural(record.items.length, 'item')} · ${formatBytes(record.bytes)}` }),
    ]),
  ]);
  if (onDelete) {
    const del = el('button', { type: 'button', class: 'button small danger', text: 'Delete' });
    let armTimer = 0;
    del.addEventListener('click', () => {
      if (del.classList.contains('armed')) {
        clearTimeout(armTimer);
        onDelete();
        return;
      }
      del.classList.add('armed');
      del.textContent = 'Tap again to delete';
      armTimer = setTimeout(() => {
        del.classList.remove('armed');
        del.textContent = 'Delete';
      }, 3000);
    });
    head.append(del);
  }
  return el('li', { class: 'transfer' }, [head, el('ul', { class: 'items' }, record.items.map((i) => renderItem(i, group)))]);
}

async function renderInbox() {
  let records = [];
  try {
    records = await listTransfers();
  } catch {
    // Storage unavailable (private mode); show the empty state.
  }
  revokeUrls('inbox');
  $('inbox-list').replaceChildren(
    ...records.map((r) =>
      renderTransfer(r, 'inbox', async () => {
        await deleteTransfer(r.id).catch(() => {});
        renderInbox();
      }),
    ),
  );
  $('inbox-empty').hidden = records.length > 0;
}

function renderInboxCount() {
  const badge = $('inbox-count');
  badge.textContent = String(unseen);
  badge.hidden = unseen === 0;
}

// ---------- Start ----------

initSendControls();
showView(location.hash.slice(1) || 'send');

// The native apps already ship every file inside the app, so they skip the service worker.
if (!isNative && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register('./sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      $('offline-badge').hidden = false;
    })
    .catch(() => {});
}

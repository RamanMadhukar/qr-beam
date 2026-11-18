// Finds QR codes in camera frames, several frames at once so the receiver keeps
// up with fast senders.
//
// - The browser's own BarcodeDetector where it has one (Chrome on Android, macOS).
// - Otherwise a pool of workers running ZXing (WebAssembly), which also finds two
//   or more codes in one frame (Safari on iPhone, the app WebViews).
// - If workers can't start at all, jsQR on the main thread, one code per frame.
//
// Every scanner has the same shape:
//   kind          short name, for the receiver's readout
//   hasCapacity() true when another frame can be handed over right now
//   decode(video) resolves to the QR texts found in the current video frame

const JSQR_URL = new URL('../vendor/jsQR.js', import.meta.url).href;

export async function createScanner() {
  if ('BarcodeDetector' in globalThis) {
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) return createNativeScanner();
    } catch {
      // Fall through to the worker pool.
    }
  }
  try {
    return await createWorkerPool();
  } catch {
    return createMainThreadScanner();
  }
}

function createNativeScanner() {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let inFlight = 0;
  return {
    kind: 'native',
    hasCapacity: () => inFlight < 2,
    async decode(source) {
      inFlight++;
      try {
        const codes = await detector.detect(source);
        return codes.map((c) => c.rawValue);
      } finally {
        inFlight--;
      }
    },
  };
}

// Copies the current video frame for a worker. An ImageBitmap moves to the worker
// without copying pixels on the main thread; older browsers get raw pixels instead.
const canTransferBitmaps = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
let grab = null;
let grabCtx = null;

async function captureFrame(source) {
  if (canTransferBitmaps) {
    const bitmap = await createImageBitmap(source);
    return { message: { bitmap }, transfer: [bitmap] };
  }
  const width = source.videoWidth ?? source.width;
  const height = source.videoHeight ?? source.height;
  if (!grab) {
    grab = document.createElement('canvas');
    grabCtx = grab.getContext('2d', { willReadFrequently: true });
  }
  if (grab.width !== width || grab.height !== height) {
    grab.width = width;
    grab.height = height;
  }
  grabCtx.drawImage(source, 0, 0, width, height);
  const img = grabCtx.getImageData(0, 0, width, height);
  return { message: { width, height, data: img.data.buffer }, transfer: [img.data.buffer] };
}

async function createWorkerPool() {
  const size = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  const slots = [];
  let nextId = 0;
  let engine = 'zxing';

  for (let i = 0; i < size; i++) {
    const worker = new Worker(new URL('./scan-worker.js', import.meta.url));
    const slot = { worker, busy: false, pending: null };
    worker.onmessage = (e) => {
      if (e.data.engine) engine = e.data.engine;
      else if (e.data.error) slot.dead = true; // neither decoder could load
      const done = slot.pending;
      slot.pending = null;
      slot.busy = false;
      done?.(e.data.texts ?? []);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      const done = slot.pending;
      slot.pending = null;
      slot.busy = false;
      slot.dead = true;
      done?.([]);
    };
    slots.push(slot);
  }

  const pool = {
    get kind() {
      return `${engine}×${slots.filter((s) => !s.dead).length}`;
    },
    get dead() {
      return slots.every((s) => s.dead);
    },
    hasCapacity: () => slots.some((s) => !s.busy && !s.dead),
    async decode(source) {
      const slot = slots.find((s) => !s.busy && !s.dead);
      if (!slot) return [];
      slot.busy = true;
      let frame;
      try {
        frame = await captureFrame(source);
      } catch {
        slot.busy = false;
        return [];
      }
      return new Promise((resolve) => {
        slot.pending = resolve;
        slot.worker.postMessage({ id: nextId++, ...frame.message }, frame.transfer);
      });
    },
  };

  // Load the decoder now so the first camera frames aren't spent waiting for it.
  const warmUp = new ImageData(8, 8);
  await Promise.all(
    slots.map(
      (slot) =>
        new Promise((resolve) => {
          slot.busy = true;
          slot.pending = resolve;
          slot.worker.postMessage({ id: nextId++, width: 8, height: 8, data: warmUp.data.slice().buffer });
        }),
    ),
  );
  if (pool.dead) throw new Error('Workers unavailable');
  return pool;
}

function loadJsQR() {
  if (typeof globalThis.jsQR === 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = JSQR_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error('The QR reader could not load. Reload the page and try again.'));
    document.head.append(script);
  });
}

async function createMainThreadScanner() {
  await loadJsQR();
  let busy = false;
  return {
    kind: 'jsqr-main',
    hasCapacity: () => !busy,
    async decode(source) {
      busy = true;
      try {
        const { message } = await captureFrameAsPixels(source);
        const result = globalThis.jsQR(new Uint8ClampedArray(message.data), message.width, message.height, {
          inversionAttempts: 'dontInvert',
        });
        return result ? [result.data] : [];
      } finally {
        busy = false;
      }
    },
  };
}

function captureFrameAsPixels(source) {
  const width = Math.min(source.videoWidth ?? source.width, 960);
  const height = Math.round(((source.videoHeight ?? source.height) * width) / (source.videoWidth ?? source.width));
  if (!grab) {
    grab = document.createElement('canvas');
    grabCtx = grab.getContext('2d', { willReadFrequently: true });
  }
  grab.width = width;
  grab.height = height;
  grabCtx.drawImage(source, 0, 0, width, height);
  const img = grabCtx.getImageData(0, 0, width, height);
  return { message: { width, height, data: img.data.buffer } };
}

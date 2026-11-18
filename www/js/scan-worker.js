// Decodes camera frames off the main thread. Uses ZXing (WebAssembly), which is
// fast and finds every code in a frame; falls back to jsQR (one code per frame)
// if WebAssembly can't load.

const VENDOR = new URL('../vendor/', self.location.href);
let engine = null;
let ready = null;
let canvas = null;
let ctx = null;

function load() {
  ready ??= (async () => {
    try {
      importScripts(new URL('zxing/zxing-reader.js', VENDOR).href);
      await ZXingWASM.prepareZXingModule({
        overrides: { locateFile: (path) => new URL(`zxing/${path}`, VENDOR).href },
        fireImmediately: true,
      });
      engine = 'zxing';
    } catch {
      importScripts(new URL('jsQR.js', VENDOR).href);
      engine = 'jsqr';
    }
  })();
  return ready;
}

const ZXING_OPTIONS = {
  formats: ['QRCode'],
  maxNumberOfSymbols: 4,
  tryHarder: false,
  tryRotate: false,
  tryInvert: false,
};

function pixels(message) {
  if (!message.bitmap) return new ImageData(new Uint8ClampedArray(message.data), message.width, message.height);
  const { bitmap } = message;
  if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

self.onmessage = async (e) => {
  const { id } = e.data;
  try {
    await load();
    const image = pixels(e.data);
    let texts;
    if (engine === 'zxing') {
      const results = await ZXingWASM.readBarcodes(image, ZXING_OPTIONS);
      texts = results.filter((r) => r.isValid).map((r) => r.text);
    } else {
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
      texts = result ? [result.data] : [];
    }
    self.postMessage({ id, texts, engine });
  } catch (err) {
    self.postMessage({ id, texts: [], engine, error: String(err?.message || err) });
  }
};

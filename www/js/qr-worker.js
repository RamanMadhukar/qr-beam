// Builds QR codes off the main thread, so the sender can show large codes at
// 20 frames/s without stutter. Replies with the module grid: 1 = dark.
importScripts(new URL('../vendor/qrcode.js', self.location.href).href);

self.onmessage = (e) => {
  const { seq, text, ecc } = e.data;
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Alphanumeric');
  qr.make();
  const n = qr.getModuleCount();
  const bits = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) bits[r * n + c] = qr.isDark(r, c) ? 1 : 0;
  }
  self.postMessage({ seq, n, bits }, [bits.buffer]);
};

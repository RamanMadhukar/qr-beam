// Device features for the iOS and Android apps (Capacitor), with browser fallbacks.
// In a plain browser `isNative` is false and every helper uses web APIs instead.

const cap = globalThis.Capacitor;
export const isNative = Boolean(cap?.isNativePlatform?.());
export const platform = cap?.getPlatform?.() ?? 'web';

function plugin(name) {
  return isNative && cap.isPluginAvailable(name) ? cap.registerPlugin(name) : null;
}

const Filesystem = plugin('Filesystem');
const Share = plugin('Share');
const Clipboard = plugin('Clipboard');
const KeepAwake = plugin('KeepAwake');

// ---------- Keep the screen on ----------

let wakeLock = null;

export async function keepScreenOn(on) {
  try {
    if (KeepAwake) {
      await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep());
    } else if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}

// ---------- Clipboard ----------

export async function copyText(text) {
  if (Clipboard) await Clipboard.write({ string: text });
  else await navigator.clipboard.writeText(text);
}

// ---------- Files (native only) ----------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function safeName(name) {
  return name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'file';
}

// "photo.jpg" -> "photo (2).jpg" until the name is free.
async function freePath(folder, name, directory) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const path = `${folder}${n === 1 ? name : `${stem} (${n})${ext}`}`;
    try {
      await Filesystem.stat({ path, directory });
    } catch {
      return path;
    }
  }
  return `${folder}${stem} ${Date.now()}${ext}`;
}

// Saves into the device's storage where the Files app can see it.
// Returns a short description of where it went.
export async function saveFile(blob, name) {
  const data = await blobToBase64(blob);
  if (platform === 'ios') {
    // The app's Documents folder shows in Files › On My iPhone › QR Beam.
    const path = await freePath('', safeName(name), 'DOCUMENTS');
    await Filesystem.writeFile({ path, data, directory: 'DOCUMENTS' });
    return 'Saved to Files › On My iPhone › QR Beam';
  }
  const path = await freePath('QR Beam/', safeName(name), 'DOCUMENTS');
  await Filesystem.writeFile({ path, data, directory: 'DOCUMENTS', recursive: true });
  return 'Saved to Documents › QR Beam';
}

// Opens the system share sheet for a file (AirDrop, Photos, Drive, mail…).
export async function shareFile(blob, name, title) {
  const data = await blobToBase64(blob);
  const { uri } = await Filesystem.writeFile({
    path: `share/${safeName(name)}`,
    data,
    directory: 'CACHE',
    recursive: true,
  });
  await Share.share({ title, files: [uri], dialogTitle: title });
}

export async function shareText(text, title) {
  await Share.share({ title, text, dialogTitle: title });
}

export const canShareNatively = Boolean(Share && Filesystem);

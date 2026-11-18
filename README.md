# QR Beam

Move files and text from one device to another with nothing but a screen and a camera.
The sending device plays a loop of QR codes; the receiving device scans them with its
camera, rebuilds the data, checks it, and stores it in its Inbox. No network, pairing
or accounts are involved in the transfer itself.

The same code ships three ways:

- **Web app (PWA)** in `www/`: runs in Safari and Chrome, installable from the browser, works offline.
- **Android app** in `android/` and **iOS app** in `ios/`: built with [Capacitor](https://capacitorjs.com) 8,
  which wraps `www/` in a native shell and adds camera permission, saving to the
  device's Files, the system share sheet and keep-screen-on.

## Setup

```bash
npm install        # also copies libraries and fonts into www/vendor
npm test           # protocol tests (Node 20+)
npm start          # web version on http://localhost:8080
```

## Deploying the web app to GitHub Pages

`www/` is a static site, so GitHub Pages can host it as-is. Pages serves over HTTPS,
which lets phones use the camera without the local certificate from `npm run phone`.

1. Push this folder to a GitHub repository, with `main` as the default branch.
2. In the repository, open *Settings › Pages* and set *Source* to **GitHub Actions**.
3. Every push to `main` runs `.github/workflows/pages.yml`, which runs the tests and
   publishes `www/`. The address appears under *Settings › Pages*, typically
   `https://<your-username>.github.io/<repository>/`.

`www/vendor/` is committed on purpose, so the site needs no build step. After changing
dependencies, run `npm install` (which refreshes `www/vendor/`) and commit the result.
When you change web files, bump `VERSION` in `www/sw.js` so phones that installed the
app pick up the update.

## Building the apps

After any change in `www/`, run `npx cap sync` to copy it into both native projects.

### Android

Needs Android Studio (it includes the Android SDK and JDK 21). The app runs on
Android 7.0 and later.

```bash
npm run android    # sync, then open the project in Android Studio
```

Press Run with a phone connected (USB debugging on), or build a test APK from the
command line with `npm run apk`. The APK appears at
`android/app/build/outputs/apk/debug/app-debug.apk`.

### iOS

Needs a Mac with a current Xcode from the App Store. The app runs on iOS 15 and later.
CocoaPods is not needed, because the project uses Swift Package Manager.

```bash
npm run ios        # sync, then open the project in Xcode
```

In Xcode, select the **App** target. Under *Signing & Capabilities*, pick your team,
then choose your iPhone and press Run. The camera does not work in the iOS Simulator,
so test receiving on a real phone.

### Before publishing

- The app ID is `com.qrbeam.app`. Change it to your own reverse-domain ID in
  `capacitor.config.json`, in `android/app/build.gradle` (`applicationId`) and in
  Xcode (*Bundle Identifier*).
- Bump the version in `android/app/build.gradle` (`versionCode`, `versionName`)
  and in Xcode (*Version*, *Build*).
- Regenerate icons and splash screens after a design change with `npm run icons`.

## Using it

1. **Send**: add files and/or type a note, pick a mode and speed, tap *Start sending*.
   The screen switches to full-screen codes.
2. **Receive**: on the other device tap *Start camera* and fit the whole sending screen in
   view. You can start at any point in the loop. The block map fills in as data arrives,
   and the readout shows the live speed in KB/s.
3. When it finishes, the transfer is checked (SHA-256) and saved to the **Inbox**.

What *Save* does on each platform:

| | Save | Share |
| --- | --- | --- |
| iPhone app | Files › On My iPhone › QR Beam | System share sheet (AirDrop, Photos, …) |
| Android app | Documents › QR Beam (Android 11+; older versions open the share sheet) | System share sheet |
| Browser | Browser download | Web Share, where the browser supports it |

### Modes and speed

| Mode | Codes on screen | Per code | QR version | Best for |
| --- | --- | --- | --- | --- |
| Easy scan | 1 | 300 B | v13, ECC M | Older phones, shaky hands |
| Balanced | 1 | 700 B | v19, ECC L | Most transfers |
| Fast | 2 | 700 B | v19, ECC L | Phones held close and steady |
| Max | 2 | 1,100 B | v24, ECC L | Largest files |

Speed sets frames per second (2–20). At 20 frames/s, Max shows 40 codes, about 44 KB,
every second. In a browser test with simulated camera blur, Max at 20 frames/s delivered
a 200 KB file at about 39 KB/s. Real phones are slower, depending on camera focus and
processor, so expect roughly 15–40 KB/s: a 4.5 MB file in about 2–5 minutes.

QR codes cannot get much faster than this. The largest QR code holds about 2.9 KB, and
phone cameras capture 30–60 frames per second, so tens of KB/s is the practical
ceiling. Multi-megabyte files in seconds would need a network link.

### Trying the web version on two devices

Browsers only allow the camera on secure pages (`https://` or `localhost`), so a phone
opening `http://<your-Mac-IP>:8080` can send but not receive. The native apps don't have
this limit.

- **Phones on your Wi-Fi:** run `npm run phone`. It serves `www/` over HTTPS on port 8443
  with a self-signed certificate (made on first run, kept in `.cert/`) and prints the
  address to open, e.g. `https://192.168.1.20:8443/#receive`. Each phone warns once that
  the connection is not private. On iPhone tap *Show Details › visit this website*; on
  Android tap *Advanced › Proceed*. After that the camera works.
- **Anywhere:** put `www/` on any HTTPS static host, such as GitHub Pages, Netlify or
  Cloudflare Pages.

## How it works

```
items ─► bundle (manifest + bytes) ─► gzip ─► payload [version, flags, sha256, body]
payload ─► K blocks ─► fountain-coded frames ─► one QR code per frame, looped
```

- **Frame format** (all QR *alphanumeric* characters, so codes use the denser mode):
  `QX1:<session>:<K>:<payloadLength>:<seq>:<base45 block>`, numbers in base36.
- **Fountain code (LT, systematic):** frames `0…K-1` carry the blocks as-is. Later
  frames each XOR a pseudo-random set of blocks, chosen from `session + seq` with a
  robust-soliton degree distribution. The receiver never has to wait for one exact
  missed code to come around again. Almost any extra frames fill the gaps, and it can
  join mid-stream.
- **Sending:** upcoming QR codes are built ahead of time in Web Workers, so the
  screen only paints pixels and holds a steady frame rate.
- **Scanning:** the native `BarcodeDetector` where the browser has one. Otherwise a
  pool of Web Workers runs [ZXing](https://github.com/zxing-cpp/zxing-cpp) compiled to
  WebAssembly ([zxing-wasm](https://github.com/Sec-ant/zxing-wasm)), which reads every
  code in a camera frame. That covers iPhone and both app WebViews. Each new camera
  frame goes to whichever worker is free, so several frames decode in parallel. If
  WebAssembly can't load, [jsQR](https://github.com/cozmo/jsQR) takes over at a lower
  speed.
- **Storage:** received transfers live in IndexedDB on the receiving device.

## Files

| Path | What it does |
| --- | --- |
| `www/index.html`, `www/styles.css` | The three screens: Send, Receive, Inbox |
| `www/js/protocol.js` | Packing, compression, checksum, base45, fountain encoder/decoder, frame format. No DOM, so it is shared with the tests |
| `www/js/app.js` | UI, QR playback, camera loop, progress and Inbox rendering |
| `www/js/native.js` | Save, share, clipboard and keep-awake through Capacitor plugins, with browser fallbacks |
| `www/js/scanner.js`, `www/js/scan-worker.js` | QR detection: native, a pool of ZXing workers, or jsQR as a fallback |
| `www/js/qr-worker.js` | Builds upcoming QR codes for the sender off the main thread |
| `www/js/store.js` | IndexedDB storage for received transfers |
| `www/sw.js`, `www/manifest.webmanifest` | Offline support and install for the web version |
| `www/vendor/` | Local copies of qrcode-generator, zxing-wasm, jsQR, Capacitor core and the fonts (made by `npm run vendor`) |
| `capacitor.config.json` | App ID, name and native settings |
| `.github/workflows/pages.yml` | Tests and publishes `www/` to GitHub Pages on every push to `main` |
| `android/`, `ios/` | Native projects. Permissions: `AndroidManifest.xml`, `Info.plist` |
| `tests/protocol.test.js` | Round trips with lost, late and duplicate frames; base45 and SHA-256 checks |
| `tools/make-icons.js` | Web icons, app icons and splash screens |

When you change web files, bump `VERSION` in `www/sw.js` so installed web copies update.
The native apps don't use the service worker.

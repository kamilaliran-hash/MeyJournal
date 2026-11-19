# MeyJournal

Turn your trip photos into a travel timeline, a route map and a print-ready photo book.
One codebase builds both apps: **Android (APK)** with Capacitor and **Windows (EXE)** with Electron.

## Features

- **Trip details** — when you create a trip you set name, destination, dates (from → to), who you're travelling with, trip type and notes. Edit them any time with ✎.
- **Two ways to add photos** — *Whole trip at once* (grouped by photo date & GPS) or *Day by day*: each day of the trip gets a card with “Add photos for day N”, a place and a caption. Photos land on the day you choose even when they have no date (common on Android/WhatsApp). Move a photo to another day with ⇄.
- **Auto story with music** — when you add photos, captions are written automatically and a “Your story is ready” screen lets you pick music (Calm, Upbeat, Adventure, Tropical — generated on-device, royalty-free) or your own song. The story plays as a full-screen slideshow with title, route map, stop cards and photos, and can be **saved as a video** (MP4/WebM).
- **Manage trips** — rename ✎ or delete 🗑 any trip from its card on the home screen or from the trip page.
- **About** — tap ⓘ in the top bar. MeyJournal is created and owned by **Kamil**.

- **Import up to 1,200 photos per trip.** Photos are resized and stored on the device (IndexedDB), and nothing is uploaded.
- **Automatic timeline.** MeyJournal reads the EXIF date and GPS of each photo, then groups the photos into stops by time gaps, day changes and distance. Each stop is named after the nearest town from a built-in offline list of about 250 places, weighted toward Malaysia and Southeast Asia.
- **Route map.** Shows the numbered stops, the dotted route, and totals for days, km, stops and photos.
- **Story mode.** Writes a first-draft caption for every stop. You can edit any of them, and your own edits are never overwritten.
- **Photo book builder.**
  - Cover types: Softcover, Hardcover or Layflat. The preview shows each type's spread style.
  - Sizes: Square 20×20 cm, Landscape 28×21 cm or Portrait 21×28 cm.
  - Styles: Classic, Minimal or Night.
  - The book is laid out for you: cover, route map, a chapter opener for each stop, mixed photo layouts, a notes page and a back page. The page count is always even, so it is ready to print.
  - On any page you can change the layout (9 options), add a caption, shuffle, split or join pages, move pages and delete pages.
- **Export a print-ready PDF** at 200 dpi.
  - On Windows a "Save as" dialog opens.
  - On Android the PDF is saved to Documents and the share sheet opens, so you can save it to Drive or send it to a print shop.
- **Demo trip.** A built-in Malaysia road trip (Melaka → KL → Cameron Highlands → Penang → Langkawi), so you can try the app without photos.

## Get the APK and EXE (easiest: GitHub builds them)

1. Create a GitHub repository and push this folder to it.
2. GitHub Actions runs `.github/workflows/build.yml` automatically. It takes about 10 minutes.
3. Open the repo's **Actions** tab, click the latest run and download:
   - **MeyJournal-Android** → `MeyJournal.apk`
   - **MeyJournal-Windows** → `MeyJournal-Setup-1.0.0.exe` (installer) and `MeyJournal-Portable-1.0.0.exe`
4. Optional: push a tag such as `git tag v1.0.0 && git push --tags`. The files are then attached to a GitHub Release.

**Notes on signing:**
- **Android:** Without signing secrets, the APK is debug-signed. You can install it on any phone ("Install unknown apps"), but you can't put it on Play Store. To get a release-signed APK, add these repo secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
- **Windows:** The EXE is not code-signed, so SmartScreen will say "Windows protected your PC". Click **More info → Run anyway**.

## Build on your own PC

You need Node.js 20 or newer.

```bash
npm install
npm start                 # run the Windows/desktop app right away
npm run build:win         # → dist/MeyJournal-Setup-1.0.0.exe   (run on Windows)
```

For Android you also need Android Studio (SDK) and JDK 21:

```bash
npm run android:init      # once: creates android/ project + MJ icons & splash
npm run build:apk         # → android/app/build/outputs/apk/debug/app-debug.apk
                          #   (on Windows use: npm run build:apk:win)
npx cap open android      # or open in Android Studio to run on a phone
```

## Project layout

```
www/            the app (index.html, app.js, pdf-lib) — shared by both platforms
electron/       Windows desktop shell
assets/         MJ logo + Android icon/splash sources
build/          Windows icon (icon.ico)
capacitor.config.json, package.json, .github/workflows/build.yml
```

## Good to know

- **Photo formats.** JPEG keeps its date and GPS. HEIC and RAW files can't be read by the app's engine. On iPhone, set Camera → Formats → *Most Compatible*, or export the photos as JPEG first.
- **Missing GPS.** Some Android galleries and messaging apps strip GPS when they share photos. If that happens, MeyJournal groups the photos by time only, and you can rename the stops in the Timeline.
- **Printing.** MeyJournal does not run a print shop. Upload the exported PDF to any photo-book printer that accepts PDF, choosing the same size and cover type you picked in the app.

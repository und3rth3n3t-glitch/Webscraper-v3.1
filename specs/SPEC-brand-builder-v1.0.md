# SPEC-brand-builder-v1.0

**Feature:** Brand Builder — web form + Node server that generates a branded extension ZIP  
**Scope:** lean v1 — no auth, no DB, no signing; local-first, single concurrent build  
**Target branch:** v3.1 → merge into master

---

## Context

A BBWT3 admin wants to produce a custom-branded Blueberry extension without touching source code. They fill in a form (app name, 2 brand colors, 3 icons, optional backend URL), click Build, wait ~10 s, download a ZIP. Unzip + Load unpacked in Chrome — done.

The form submits to a small Express server that lives in `builder/` inside the blueberry-v3 repo. The server writes a brand TS file + icons into `src/themes/`, runs `BLUEBERRY_THEME=<id> pnpm build`, zips `.output/chrome-mv3`, and streams the ZIP back.

**Existing infrastructure this relies on (must not change):**
- `src/themes/types.ts` — `BrandConfig` / `BrandPalette` interfaces
- `src/build/brandPlugin.ts` — reads `src/themes/<id>.ts` + icons at build time
- `wxt.config.ts` — reads `BLUEBERRY_THEME` env var, calls brandPlugin

---

## Files to create

```
builder/
  package.json
  tsconfig.json
  server.ts
  palette.ts
  form.html
```

## Files to modify

- `.gitignore` — add `builder/node_modules/`
- `package.json` (root) — add `builder:dev` and `builder:start` scripts

---

## 1. builder/package.json

```json
{
  "name": "blueberry-brand-builder",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch server.ts",
    "start": "tsx server.ts"
  },
  "dependencies": {
    "archiver": "^7.0.1",
    "express": "^4.19.2",
    "multer": "^1.4.5-lts.1",
    "tinycolor2": "^1.6.0"
  },
  "devDependencies": {
    "@types/archiver": "^6.0.2",
    "@types/express": "^4.17.21",
    "@types/multer": "^1.4.11",
    "@types/tinycolor2": "^1.4.6",
    "tsx": "^4.19.0",
    "typescript": "^5.4.5"
  }
}
```

---

## 2. builder/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["*.ts"],
  "exclude": ["node_modules"]
}
```

---

## 3. builder/palette.ts

Full file — complete:

```typescript
import tinycolor from 'tinycolor2';

export interface DerivedPalette {
  primary: string;
  primaryRgb: string;
  primaryLight: string;
  secondary: string;
  bgTint: string;
  bgLight: string;
  bgHover: string;
  border: string;
  infoLight: string;
}

export function hexToRgbCsv(hex: string): string {
  const { r, g, b } = tinycolor(hex).toRgb();
  return `${r}, ${g}, ${b}`;
}

// tinycolor.mix(a, b, amount): amount = weight of b (0–100).
// mix(primary, white, 95) → 5% primary, 95% white → very pale.
export function derivePalette(primary: string, secondary: string): DerivedPalette {
  return {
    primary,
    primaryRgb: hexToRgbCsv(primary),
    primaryLight: tinycolor(primary).lighten(15).toHexString(),
    secondary,
    bgTint:  tinycolor.mix(primary, '#ffffff', 95).toHexString(),
    bgLight: tinycolor.mix(primary, '#ffffff', 98).toHexString(),
    bgHover: tinycolor.mix(primary, '#ffffff', 87).toHexString(),
    border:  tinycolor.mix(primary, '#ffffff', 80).toHexString(),
    infoLight: tinycolor.mix(primary, '#ffffff', 95).toHexString(),
  };
}
```

---

## 4. builder/server.ts

Full file — complete:

```typescript
import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePalette } from './palette.js';
import type { DerivedPalette } from './palette.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BLUEBERRY_ROOT = resolve(__dirname, '..');
const THEMES_DIR = join(BLUEBERRY_ROOT, 'src', 'themes');
const PORT = 3000;

const app = express();
app.use(express.urlencoded({ extended: true }));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

// Single-build mutex — v1 is single-user, concurrent builds corrupt the shared source tree.
let building = false;

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'form.html'));
});

app.post('/build', (req, res) => {
  const mw = upload.fields([
    { name: 'icon16', maxCount: 1 },
    { name: 'icon48', maxCount: 1 },
    { name: 'icon128', maxCount: 1 },
  ]);

  mw(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      res.status(400).json({ error: `Upload error: ${err.message}` });
      return;
    }
    if (err) {
      res.status(500).json({ error: String(err) });
      return;
    }

    if (building) {
      res.status(503).json({ error: 'A build is already in progress. Please wait and try again.' });
      return;
    }

    const body = req.body as Record<string, string>;
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    const appName = body.appName?.trim() ?? '';
    const description = body.description?.trim() ?? '';
    const primaryColor = body.primaryColor?.trim() ?? '';
    const secondaryColor = body.secondaryColor?.trim() ?? '';
    const defaultServerUrl = body.defaultServerUrl?.trim() || undefined;

    const errors: string[] = [];
    if (!appName) errors.push('App name is required.');
    if (!description) errors.push('Description is required.');
    if (!isValidHex(primaryColor)) errors.push('Primary color must be a valid hex color (e.g. #5F259F).');
    if (!isValidHex(secondaryColor)) errors.push('Secondary color must be a valid hex color.');
    if (!files?.icon16?.[0]) errors.push('16×16 icon PNG is required.');
    if (!files?.icon48?.[0]) errors.push('48×48 icon PNG is required.');
    if (!files?.icon128?.[0]) errors.push('128×128 icon PNG is required.');
    if (defaultServerUrl && !isValidHttpsUrl(defaultServerUrl)) errors.push('Default URL must start with https://.');
    if (errors.length) {
      res.status(400).json({ errors });
      return;
    }

    building = true;
    try {
      const brandId = slugify(appName);
      const palette = derivePalette(primaryColor, secondaryColor);

      // Write brand TS into src/themes/<brandId>.ts
      writeFileSync(join(THEMES_DIR, `${brandId}.ts`), renderBrandTs({ brandId, appName, description, palette, defaultServerUrl }), 'utf8');

      // Write icons into src/themes/<brandId>/icons/
      const iconDir = join(THEMES_DIR, brandId, 'icons');
      mkdirSync(iconDir, { recursive: true });
      for (const [field, size] of [['icon16', 16], ['icon48', 48], ['icon128', 128]] as [string, number][]) {
        writeFileSync(join(iconDir, `icon${size}.png`), files![field][0].buffer);
      }

      // Run the WXT build
      await execAsync('pnpm build', {
        cwd: BLUEBERRY_ROOT,
        env: { ...process.env, BLUEBERRY_THEME: brandId },
        timeout: 180_000,
      });

      const outputDir = join(BLUEBERRY_ROOT, '.output', 'chrome-mv3');
      if (!existsSync(outputDir)) {
        throw new Error('Build output directory not found — the pnpm build may have failed.');
      }

      // Stream ZIP back to browser
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${brandId}.zip"`);

      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', (e) => { throw e; });
      archive.pipe(res);
      archive.directory(outputDir, false);
      await archive.finalize();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        res.status(500).json({ error: `Build failed: ${message}` });
      }
    } finally {
      building = false;
    }
  });
});

function isValidHex(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function isValidHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function renderBrandTs(opts: {
  brandId: string;
  appName: string;
  description: string;
  palette: DerivedPalette;
  defaultServerUrl?: string;
}): string {
  const { brandId, appName, description, palette, defaultServerUrl } = opts;
  const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const urlLine = defaultServerUrl ? `  defaultServerUrl: '${q(defaultServerUrl)}',\n` : '';
  return `import type { BrandConfig } from './types';

export default {
  appName: '${q(appName)}',
  appDescription: '${q(description)}',
  actionTitle: 'Open ${q(appName)}',
  welcomeHeading: 'Welcome to ${q(appName)}',
  notificationTitle: '${q(appName)}',
  logPrefix: '[${q(appName)}]',
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  iconDir: '${brandId}/icons',
${urlLine}  palette: {
    primary: '${palette.primary}',
    primaryRgb: '${palette.primaryRgb}',
    primaryLight: '${palette.primaryLight}',
    secondary: '${palette.secondary}',
    bgTint: '${palette.bgTint}',
    textDark: '#474747',
    textLight: '#969696',
    bgWhite: '#FFFFFF',
    bgLight: '${palette.bgLight}',
    bgHover: '${palette.bgHover}',
    border: '${palette.border}',
    danger: '#D32F2F',
    dangerLight: '#FFEBEE',
    success: '#2E7D32',
    successLight: '#E8F5E9',
    warning: '#F57F17',
    warningLight: '#FFF8E1',
    infoLight: '${palette.infoLight}',
  },
} satisfies BrandConfig;
`;
}

app.listen(PORT, () => {
  console.log(`Brand Builder at http://localhost:${PORT}`);
});
```

---

## 5. builder/form.html

Full file — complete:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brand Builder</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8f8f8;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 2rem 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,.10);
      padding: 2rem;
      width: 100%;
      max-width: 480px;
    }
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1.5rem; color: #1a1a1a; }
    label { display: block; font-size: .85rem; font-weight: 600; color: #444; margin-bottom: .3rem; margin-top: 1rem; }
    input[type="text"], input[type="url"] {
      width: 100%;
      padding: .55rem .75rem;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      font-size: .95rem;
      background: #fafafa;
      color: #1a1a1a;
    }
    input:focus { outline: none; border-color: #7b4db5; box-shadow: 0 0 0 2px rgba(123,77,181,.2); }
    .color-row { display: flex; align-items: center; gap: .5rem; }
    input[type="color"] {
      width: 42px; height: 38px;
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      padding: 2px;
      cursor: pointer;
      background: #fafafa;
      flex-shrink: 0;
    }
    .color-hex { flex: 1; }
    .icon-row { display: flex; gap: .75rem; flex-wrap: wrap; }
    .icon-input { flex: 1; min-width: 110px; }
    .icon-input label { margin-top: .5rem; }
    .icon-drop {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      border: 1.5px dashed #c0c0c0;
      border-radius: 6px;
      padding: .6rem;
      cursor: pointer;
      font-size: .8rem;
      color: #888;
      text-align: center;
      min-height: 60px;
      position: relative;
      background: #fafafa;
    }
    .icon-drop:hover { border-color: #7b4db5; color: #5f259f; }
    .icon-drop.has-file { border-color: #2e7d32; color: #2e7d32; }
    .icon-drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    button[type="submit"] {
      margin-top: 1.5rem;
      width: 100%;
      padding: .7rem;
      background: #5f259f;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button[type="submit"]:hover:not(:disabled) { background: #7b4db5; }
    button[type="submit"]:disabled { background: #b0a0c0; cursor: not-allowed; }
    .status { margin-top: 1rem; font-size: .9rem; display: none; }
    .status.show { display: block; }
    .status.error { color: #c0392b; white-space: pre-wrap; }
    .building-row { display: flex; align-items: center; gap: .5rem; color: #555; }
    .spinner {
      width: 16px; height: 16px;
      border: 2px solid #ccc;
      border-top-color: #5f259f;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status.success { color: #2e7d32; }
    .download-btn {
      display: inline-block;
      margin-top: .75rem;
      padding: .5rem 1.25rem;
      background: #2e7d32;
      color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: .9rem;
    }
    .install-hint {
      margin-top: 1rem;
      font-size: .8rem;
      color: #555;
      background: #f5f5f5;
      border-radius: 6px;
      padding: .75rem;
      line-height: 1.6;
    }
    .install-hint ol { padding-left: 1.2rem; }
    .optional { color: #999; font-weight: 400; font-size: .8rem; }
    hr { border: none; border-top: 1px solid #eee; margin: 1.25rem 0 .25rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Brand Builder</h1>
    <form id="form">
      <label for="appName">App name</label>
      <input type="text" id="appName" name="appName" required maxlength="80" placeholder="Acme Web Scraper">

      <label for="description">Description</label>
      <input type="text" id="description" name="description" required maxlength="160" placeholder="Record and execute web scraping flows">

      <label>Primary color</label>
      <div class="color-row">
        <input type="color" id="primaryPicker" value="#5F259F">
        <input type="text" class="color-hex" id="primaryColor" name="primaryColor"
               value="#5F259F" pattern="^#[0-9A-Fa-f]{6}$" maxlength="7" placeholder="#5F259F">
      </div>

      <label>Secondary color</label>
      <div class="color-row">
        <input type="color" id="secondaryPicker" value="#BB16A3">
        <input type="text" class="color-hex" id="secondaryColor" name="secondaryColor"
               value="#BB16A3" pattern="^#[0-9A-Fa-f]{6}$" maxlength="7" placeholder="#BB16A3">
      </div>

      <label>Icons <span class="optional">(16×16, 48×48, 128×128 — PNG)</span></label>
      <div class="icon-row">
        <div class="icon-input">
          <label>16×16</label>
          <div class="icon-drop" id="drop16">
            <span>Click to upload</span>
            <input type="file" name="icon16" id="icon16" accept="image/png" required>
          </div>
        </div>
        <div class="icon-input">
          <label>48×48</label>
          <div class="icon-drop" id="drop48">
            <span>Click to upload</span>
            <input type="file" name="icon48" id="icon48" accept="image/png" required>
          </div>
        </div>
        <div class="icon-input">
          <label>128×128</label>
          <div class="icon-drop" id="drop128">
            <span>Click to upload</span>
            <input type="file" name="icon128" id="icon128" accept="image/png" required>
          </div>
        </div>
      </div>

      <hr>
      <label for="defaultServerUrl">Default backend URL <span class="optional">(optional)</span></label>
      <input type="url" id="defaultServerUrl" name="defaultServerUrl" placeholder="https://scraper.acme.com">

      <button type="submit" id="buildBtn">Build Extension</button>
    </form>

    <div class="status" id="buildingStatus">
      <div class="building-row">
        <div class="spinner"></div>
        <span>Building… this takes about 10 seconds</span>
      </div>
    </div>
    <div class="status error" id="errorStatus"></div>
    <div class="status success" id="successStatus">
      Extension built!
      <div><a class="download-btn" id="downloadLink" href="#">Download ZIP</a></div>
      <div class="install-hint">
        <strong>How to install:</strong>
        <ol>
          <li>Unzip the downloaded file</li>
          <li>Open Chrome → <code>chrome://extensions</code></li>
          <li>Enable <strong>Developer mode</strong> (top-right toggle)</li>
          <li>Click <strong>Load unpacked</strong> → select the unzipped folder</li>
        </ol>
      </div>
    </div>
  </div>

  <script>
    // Sync color picker ↔ hex text input
    function wireColor(pickerId, textId) {
      const picker = document.getElementById(pickerId);
      const text = document.getElementById(textId);
      picker.addEventListener('input', () => { text.value = picker.value.toUpperCase(); });
      text.addEventListener('input', () => {
        if (/^#[0-9A-Fa-f]{6}$/.test(text.value)) picker.value = text.value;
      });
    }
    wireColor('primaryPicker', 'primaryColor');
    wireColor('secondaryPicker', 'secondaryColor');

    // Update icon drop-zone label on file select
    for (const size of [16, 48, 128]) {
      const input = document.getElementById('icon' + size);
      const drop = document.getElementById('drop' + size);
      input.addEventListener('change', () => {
        const name = input.files[0]?.name ?? '';
        drop.querySelector('span').textContent = name || 'Click to upload';
        drop.classList.toggle('has-file', !!name);
      });
    }

    const form = document.getElementById('form');
    const buildBtn = document.getElementById('buildBtn');
    const buildingStatus = document.getElementById('buildingStatus');
    const errorStatus = document.getElementById('errorStatus');
    const successStatus = document.getElementById('successStatus');
    const downloadLink = document.getElementById('downloadLink');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      buildBtn.disabled = true;
      show(buildingStatus);
      hide(errorStatus);
      hide(successStatus);

      try {
        const resp = await fetch('/build', { method: 'POST', body: new FormData(form) });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
          throw new Error(body.errors ? body.errors.join('\n') : (body.error ?? `HTTP ${resp.status}`));
        }
        const blob = await resp.blob();
        const cd = resp.headers.get('content-disposition') ?? '';
        const filename = (cd.match(/filename="([^"]+)"/) ?? [])[1] ?? 'extension.zip';
        const url = URL.createObjectURL(blob);
        downloadLink.href = url;
        downloadLink.download = filename;
        downloadLink.click();
        hide(buildingStatus);
        show(successStatus);
      } catch (err) {
        hide(buildingStatus);
        errorStatus.textContent = err.message;
        show(errorStatus);
      } finally {
        buildBtn.disabled = false;
      }
    });

    function show(el) { el.classList.add('show'); }
    function hide(el) { el.classList.remove('show'); }
  </script>
</body>
</html>
```

---

## 6. Modify .gitignore

Add one line after `src/public/icons/`:

```
builder/node_modules/
```

---

## 7. Modify package.json (root)

Add to the `"scripts"` block:

```json
"builder:dev": "cd builder && npm run dev",
"builder:start": "cd builder && npm run start"
```

(Run `pnpm install` inside `builder/` once before using these scripts — they're convenience wrappers only.)

---

## Verification

### Install
```bash
cd builder
npm install     # or pnpm install — separate from the root pnpm workspace
```

### Run
```bash
cd builder
npm run dev     # tsx watch server.ts → http://localhost:3000
```

### Manual test — happy path
1. Open `http://localhost:3000`
2. Fill in: name "Test Brand", description "A test brand", pick any two colors, upload any 3 PNGs (can be the same file three times), leave URL blank
3. Click Build Extension
4. Spinner appears for ~10 s
5. Browser auto-downloads `test-brand.zip`
6. Check ZIP contains manifest.json, sidepanel/index.html, icons/icon16.png, icons/icon48.png, icons/icon128.png
7. Unzip → Load unpacked in Chrome → extension loads with correct name in manifest

### Manual test — error path
- Submit with no icons → should see validation error list, no build triggered
- Submit with `http://` URL (not https) → should see URL validation error
- While a build is running, open a second tab and submit → 503 "already in progress"

### Type-check (optional)
```bash
cd builder
npx tsc --noEmit
```

---

## What this does NOT do (deferred)
- No auth (add HTTP Basic when deployed to a public URL — ~10 lines)
- No saved brands (each submit is one-shot)
- No build queue (concurrent requests get 503)
- No cleanup of generated `src/themes/<brandId>.ts` files (accumulate harmlessly)
- No .crx signing, no update XML, no enterprise install flow

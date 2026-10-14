# Theme scene renderer
`render.cjs` draws a theme's procedural scene and writes its background JPEG.
Usage: `node scripts/themes/render.cjs <id> [--png <path>]`
- Opens `scripts/themes/<id>/scene.html` in headless Chromium at 1440x900, DPR 2 (2880x1800). `DOJO_SCENE_DIR` overrides the scene folder.
- Waits up to 20 s for `window.__ready === true`, which the scene sets once it is drawn.
- Captures a PNG in the OS temp folder, then converts it with `sips` to JPEG, quality 88 down to 60, until it is at most 900 KB.
- Writes `src/themes/<id>/background.jpg`; `--png <path>` also keeps the PNG.
- Browser: `CHROME_PATH`, else Chrome, Chromium, Edge or Playwright's Chromium. `PLAYWRIGHT_CORE` points to playwright-core when it is not in node_modules.
- Needs macOS (`sips`). Exits 1 and writes nothing if no quality meets the size limit.
- A scene is a self-contained page that draws itself and sets `window.__ready = true` when done.

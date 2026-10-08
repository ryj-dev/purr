// Renders PuRR's icons from build/logo.svg with Electron's own renderer: `npm run icons`, then commit build/icon.icns,
// build/icon.png and build/tray/*. The in-app <Logo> (web/src/components/ui.tsx) reads the same file.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const OUT = join(__dirname, '..', 'build');
// the geometry lives in build/logo.svg; pull out the two shapes and recolour them per icon
const LOGO = readFileSync(join(OUT, 'logo.svg'), 'utf8');
const attr = (id, name) => LOGO.match(new RegExp(`id="${id}"[^>]*?\\s${name}="([^"]*)"`, 's'))?.[1]
  ?? LOGO.match(new RegExp(`${name}="([^"]*)"[^>]*?id="${id}"`, 's'))?.[1];
const CAT = attr('cat', 'd').replace(/\s+/g, ' ');
const WHISKERS = attr('whiskers', 'd').replace(/\s+/g, ' ');
const WHISKER_W = Number(attr('whiskers', 'stroke-width'));
const mark = (catFill, whiskerColour, whiskerWidth = WHISKER_W) =>
  `<path d="${CAT}" fill="${catFill}"/><path d="${WHISKERS}" fill="none" stroke="${whiskerColour}" stroke-width="${whiskerWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;

// macOS app icon grid: an 824px rounded square centred on a 1024 canvas. A light tile with the ink cat, as in the
// reference sketch; the whiskers show the tile through the cat.
const TILE = '#f4f4f2', INK = '#141518';
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="d" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-opacity=".28"/></filter>
  </defs>
  <g filter="url(#d)"><rect x="100" y="100" width="824" height="824" rx="185" fill="${TILE}"/></g>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#s)"/>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" fill="none" stroke="#000" stroke-opacity=".10"/>
  <g transform="translate(112 85.2) scale(8)">${mark(INK, TILE)}</g>
</svg>`;

// menu-bar template: black on transparent with the whiskers cut out, so macOS can tint it for light and dark bars.
// The cat is drawn larger than in the app icon (it fills the 18pt slot), and the whiskers thicker so they survive 18px.
const trayIcon = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="15 18.5 70 70">
  <defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
    <rect width="100" height="100" fill="#fff"/>
    <path d="${WHISKERS}" fill="none" stroke="#000" stroke-width="${WHISKER_W * 1.45}" stroke-linecap="round" stroke-linejoin="round"/>
  </mask></defs>
  <path d="${CAT}" fill="#000" mask="url(#m)"/></svg>`;

async function render(win, svg, size) {
  await win.setContentSize(size, size);
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`));
  await new Promise((r) => setTimeout(r, 150));
  return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size }).toPNG();
}

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, width: 64, height: 64,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  win.webContents.setZoomFactor(1);
  mkdirSync(join(OUT, 'tray'), { recursive: true });
  const iconset = join(OUT, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${s}x${s}.png`), await render(win, appIcon, s));
    writeFileSync(join(iconset, `icon_${s}x${s}@2x.png`), await render(win, appIcon, s * 2));
  }
  writeFileSync(join(OUT, 'icon.png'), await render(win, appIcon, 1024));
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')]);
  rmSync(iconset, { recursive: true, force: true });
  writeFileSync(join(OUT, 'tray', 'trayTemplate.png'), await render(win, trayIcon(18), 18));
  writeFileSync(join(OUT, 'tray', 'trayTemplate@2x.png'), await render(win, trayIcon(36), 36));
  console.log('wrote build/icon.icns, build/icon.png, build/tray/trayTemplate{,@2x}.png');
  app.quit();
});

// Builds the app icon from the brand's "m¢" mark (D:/brud/mooch/assets/mooch icon.svg, or MOOCH_ICON_SVG):
// the mark in ink on a ground-colored tile with a blurple outline, rendered at each Windows size and packed
// into build/icon.ico (PNG entries), plus build/icon.png at 512px.
// Usage: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const source = process.env.MOOCH_ICON_SVG ?? 'D:/brud/mooch/assets/mooch icon.svg';
const outDir = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function tile(size) {
  const mark = fs.readFileSync(source, 'utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(mark)[1].split(/\s+/).map(Number);
  const paths = [...mark.matchAll(/<path d="([^"]+)"/g)].map((m) => `<path d="${m[1]}"/>`).join('');
  // Small sizes get a heavier outline and a slightly larger mark so they stay readable.
  const small = size <= 32;
  const markWidth = small ? 176 : 156;
  const scale = markWidth / viewBox[2];
  const x = (256 - viewBox[2] * scale) / 2;
  const y = (256 - viewBox[3] * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262a60"/><stop offset="1" stop-color="#161826"/></linearGradient></defs>
    <rect x="${small ? 6 : 10}" y="${small ? 6 : 10}" width="${small ? 244 : 236}" height="${small ? 244 : 236}" rx="${small ? 48 : 56}" fill="url(#g)" stroke="#9184d9" stroke-opacity="${small ? 0.9 : 0.7}" stroke-width="${small ? 12 : 6}"/>
    <g fill="#e9e9ed" transform="translate(${x} ${y}) scale(${scale})">${paths}</g>
  </svg>`;
}

/** An .ico holding PNG images (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const render = async (size) => {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:transparent">${tile(size)}</body></html>`)}`);
    await new Promise((r) => setTimeout(r, 150));
    return (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size, quality: 'best' }).toPNG();
  };
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: await render(size) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico(pngs));
  win.setSize(512, 512);
  fs.writeFileSync(path.join(outDir, 'icon.png'), await render(512));
  console.log('wrote', path.join(outDir, 'icon.ico'), SIZES.join(','));
  app.quit();
});

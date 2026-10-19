// Launches the real app, waits, saves a screenshot of the main window, prints renderer console output, quits.
// Usage: npm run build && npx electron scripts/smoke-electron.cjs [folder]
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.setName('mooch');
const outDir = path.join(__dirname, '..', '.smoke-data');
fs.mkdirSync(outDir, { recursive: true });
const shot = process.env.SMOKE_OUT || path.join(outDir, 'screenshot.png');
const waitMs = Number(process.env.SMOKE_WAIT || 10000);

app.on('browser-window-created', (_event, win) => {
  if (win.getParentWindow()) {
    // Child windows (e.g. the FCC admin) get their own screenshot.
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        const file = path.join(outDir, 'child-window.png');
        fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
        console.log('[smoke] child window:', win.webContents.getURL().replace(/\/\/[^/]+/, '//<local>'), file);
      }, 3000),
    );
    return;
  }
  win.webContents.on('console-message', (event, level, message) => {
    console.log('[renderer]', event.message ?? message);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (process.env.SMOKE_STEPS) {
        // A JSON list of {script, shot, wait}: run each script, wait, and save a screenshot named `shot`.
        // {emit: [events]} sends agent events to the window as if the main process had (for states that
        // are hard to cause on demand, such as a model hitting its limit).
        for (const step of JSON.parse(process.env.SMOKE_STEPS)) {
          try {
            for (const event of step.emit ?? []) win.webContents.send('agent:event', event);
            const result = step.script ? await win.webContents.executeJavaScript(step.script) : undefined;
            if (result !== undefined) console.log('[smoke step]', step.shot ?? '', JSON.stringify(result));
          } catch (error) {
            console.log('[smoke step failed]', step.shot ?? '', error.message);
          }
          await new Promise((resolve) => setTimeout(resolve, step.wait ?? 800));
          if (step.shot) {
            const file = path.join(outDir, `${step.shot}.png`);
            fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
            console.log('[smoke] screenshot saved:', file);
          }
        }
      }
      if (process.env.SMOKE_SCRIPT) {
        try {
          console.log('[smoke script]', JSON.stringify(await win.webContents.executeJavaScript(process.env.SMOKE_SCRIPT)));
        } catch (error) {
          console.log('[smoke script failed]', error.message);
        }
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.SMOKE_AFTER || 1500)));
      }
      const image = await win.webContents.capturePage();
      fs.writeFileSync(shot, image.toPNG());
      console.log('[smoke] screenshot saved:', shot);
      app.quit();
    }, waitMs);
  });
});

require('../out/main/index.js');

// Electron entry: play a scenario against the pet's Live2D wrapper and save the requested frames.
// usage: electron.exe --user-data-dir=<dir> preview_main.cjs <character.json> <scenario.json> <outDir>
//   scenario.json = [{ "motion": [body, angleZ, swing, dragVelX], "frames": 30, "shot": "name", "hit": [[x, y]] }, ...]
//   (fields: see preview.html); hits are printed as JSON lines, shots go to <outDir>/<shot>.png
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const args = process.argv.slice(process.argv.findIndex((a) => a.endsWith('preview_main.cjs')) + 1);
const [charPath, scenarioPath, outDir] = args;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, x: -4000, y: -4000, frame: false, focusable: false, skipTaskbar: true, width: 640, height: 640, useContentSize: true,
    webPreferences: { backgroundThrottling: false } });
  const page = pathToFileURL(path.join(__dirname, 'preview.html')).href + '?c=' + encodeURIComponent(pathToFileURL(path.resolve(charPath)).href);
  await win.loadURL(page);
  for (let i = 0; i < 300; i++) {
    const st = await win.webContents.executeJavaScript('({ready: !!window.__ready, error: window.__error || null})');
    if (st.error) { console.error('page error:', st.error); app.exit(1); return; }
    if (st.ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const log = await win.webContents.executeJavaScript('window.__log');
  for (const l of log) if (/drawables|pivot|pointer params|缺/.test(l)) console.log('[log] ' + l);
  const steps = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const st of steps) {
    const r = await win.webContents.executeJavaScript(`window.__step(${JSON.stringify(st)})`, true);
    if (r.hit) console.log('hit ' + JSON.stringify(r.hit));
    if (st.shot && r.png) fs.writeFileSync(path.join(outDir, st.shot + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));
  }
  console.log('done', steps.length);
  app.exit(0);
});

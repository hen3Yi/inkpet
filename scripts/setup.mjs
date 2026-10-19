// 装上 Live2D 运行库：从你自己下载的官方 Cubism SDK for Web 里取出 Core 和着色器，并把驱动打包好。
//
//   用法：npm run setup -- <SDK 的 zip 或解压出来的目录>
//         不写路径时，依次找：环境变量 CUBISM_SDK_WEB、项目目录、「下载」目录里的 CubismSdkForWeb-*.zip / 目录。
//
//   为什么要自己下载：Live2D 的 Core 和 Framework 是 Live2D 公司的软件，本项目不随仓库分发；
//   下载时你要同意 Live2D 的许可协议（https://www.live2d.com/en/sdk/download/web/）。
//   这个脚本只在你的电脑上拷文件、打包，什么都不上传。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLive2d } from './build-live2d.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'renderer', 'vendor', 'live2d');
const CACHE = path.join(ROOT, '.cache', 'cubism-sdk');
const TESTED = '5-r.5';

function isSdkRoot(dir) {
  return fs.existsSync(path.join(dir, 'Core', 'live2dcubismcore.min.js')) &&
    fs.existsSync(path.join(dir, 'Framework', 'src', 'live2dcubismframework.ts'));
}
// 在目录里往下找两层，找到 SDK 根目录（解压后常多套一层文件夹）
function findSdkRoot(dir, depth = 0) {
  if (isSdkRoot(dir)) return dir;
  if (depth >= 2) return null;
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const r = findSdkRoot(path.join(dir, d.name), depth + 1);
    if (r) return r;
  }
  return null;
}
function unzip(zip) {
  const out = path.join(CACHE, path.basename(zip).replace(/\.zip$/i, ''));
  const already = findSdkRoot(out);
  if (already) return already;
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  console.log('解压 ' + zip + ' …');
  // Windows 10 以上自带 bsdtar（System32\tar.exe），能解 zip。点名用它：PATH 里排在前面的可能是 Git 带的 GNU tar，
  //   它把「E:\…」里的「E:」当成远程主机，解不了。还不行就换 PowerShell 的 Expand-Archive（路径经环境变量传，不拼命令行）
  const sysTar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '';
  let r = spawnSync(sysTar && fs.existsSync(sysTar) ? sysTar : 'tar', ['-xf', zip, '-C', out], { stdio: 'inherit' });
  if (r.status !== 0 && process.platform === 'win32') {
    r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:SETUP_ZIP -DestinationPath $env:SETUP_OUT -Force'],
      { stdio: 'inherit', env: Object.assign({}, process.env, { SETUP_ZIP: zip, SETUP_OUT: out }) });
  }
  if (r.status !== 0) throw new Error('解压失败（可以先手动解压，再把解压出来的目录传给我）');
  const root = findSdkRoot(out);
  if (!root) throw new Error('解压出来的东西里没找到 Core/ 和 Framework/：' + zip + ' 是 Cubism SDK for Web 吗？');
  return root;
}
function resolveSdk(arg) {
  const tries = [];
  if (arg) tries.push(arg);
  if (process.env.CUBISM_SDK_WEB) tries.push(process.env.CUBISM_SDK_WEB);
  for (const dir of [ROOT, path.join(os.homedir(), 'Downloads')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names.filter((x) => /^CubismSdkForWeb-/i.test(x)).sort().reverse()) tries.push(path.join(dir, n));
  }
  for (const t of tries) {
    const p = path.resolve(t);
    if (!fs.existsSync(p)) { if (t === arg) throw new Error('找不到：' + p); continue; }
    if (fs.statSync(p).isFile() && /\.zip$/i.test(p)) return unzip(p);
    const root = findSdkRoot(p);
    if (root) return root;
    if (t === arg) throw new Error('这里没找到 Cubism SDK for Web（要有 Core/ 和 Framework/）：' + p);
  }
  return null;
}
function sdkVersion(root) {
  try {
    const m = /^version:\s*(\S+)/m.exec(fs.readFileSync(path.join(root, 'cubism-info.yml'), 'utf8'));
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const d of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, d.name), t = path.join(dst, d.name);
    if (d.isDirectory()) copyDir(s, t); else fs.copyFileSync(s, t);
  }
}

async function main() {
  const root = resolveSdk(process.argv[2]);
  if (!root) {
    console.log([
      '没找到 Cubism SDK for Web。',
      '1. 打开 https://www.live2d.com/en/sdk/download/web/ ，读完并同意许可协议后下载（得到 CubismSdkForWeb-x-r.x.zip）',
      '2. 再跑一次：npm run setup -- "zip 的路径"（或者把 zip 放进「下载」目录，直接 npm run setup）',
    ].join('\n'));
    process.exit(2);
  }
  const ver = sdkVersion(root);
  console.log('用这个 SDK：' + root + (ver ? '（' + ver + '）' : ''));
  if (ver && ver !== TESTED) console.log('提醒：本项目是照 ' + TESTED + ' 写的，别的版本多半也行；出问题请换 ' + TESTED + ' 试试。');

  fs.mkdirSync(VENDOR, { recursive: true });
  fs.copyFileSync(path.join(root, 'Core', 'live2dcubismcore.min.js'), path.join(VENDOR, 'live2dcubismcore.min.js'));
  const shaders = path.join(root, 'Framework', 'Shaders', 'WebGL');
  if (fs.existsSync(shaders)) copyDir(shaders, path.join(VENDOR, 'Shaders', 'WebGL'));
  else console.log('提醒：这个 SDK 里没有 Framework/Shaders/WebGL（老版本的着色器写在代码里，可以不管）');
  await buildLive2d(path.join(root, 'Framework', 'src'), { quiet: true });
  fs.writeFileSync(path.join(VENDOR, 'SDK_VERSION.txt'), (ver || 'unknown') + '\n' + root + '\n');
  console.log('Live2D 运行库装好了：renderer/vendor/live2d/（这个目录不进仓库）');

  const toolDir = path.join(ROOT, 'tools', 'psd2live');
  const native = path.join(toolDir, process.platform === 'win32' ? 'PSD2Live.exe' : 'PSD2Live');
  if (!fs.existsSync(native) && !fs.existsSync(path.join(toolDir, 'PSD2Live.jar'))) {
    console.log('（可选）要用「改 PSD 自动重新生成模型」，把 PSD2Live 的免安装包（官方版或我们改过的版本）解压到 tools/psd2live/，见 README「从 PSD 生成模型」。');
  }
  console.log('下一步：npm start');
}

main().catch((e) => { console.error('没装成：' + e.message); process.exit(1); });

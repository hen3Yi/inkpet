// 把 live2d/driver.js 和官方 Cubism Web Framework 的源码打包成 renderer/vendor/live2d/pet-live2d.js。
//   用法：node scripts/build-live2d.mjs <Cubism SDK for Web 的 Framework/src 目录>
//   一般不用直接跑：npm run setup 找到 SDK 以后会调它。
//   产物里含 Live2D 的代码（Live2D Open Software License），只放在你自己电脑上，不要提交进仓库（.gitignore 已排除）。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildLive2d(frameworkSrc, { quiet = false } = {}) {
  const fw = path.resolve(frameworkSrc);
  if (!fs.existsSync(path.join(fw, 'live2dcubismframework.ts'))) {
    throw new Error('这里不是 Cubism Web Framework 的 src 目录：' + fw);
  }
  const outfile = path.join(ROOT, 'renderer', 'vendor', 'live2d', 'pet-live2d.js');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [path.join(ROOT, 'live2d', 'driver.js')],
    bundle: true,
    format: 'esm',
    target: 'es2020',
    outfile,
    alias: { '@framework': fw },
    legalComments: 'inline',
    logLevel: quiet ? 'warning' : 'info',
  });
  return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fw = process.argv[2];
  if (!fw) {
    console.error('用法：node scripts/build-live2d.mjs <CubismSdkForWeb-x-r.x/Framework/src>');
    process.exit(2);
  }
  buildLive2d(fw).then((out) => console.log('好了：' + path.relative(ROOT, out)))
    .catch((e) => { console.error(e.message); process.exit(1); });
}

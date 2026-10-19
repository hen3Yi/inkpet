import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fileSha1, readStamp, stampCurrent } = require('../src/model-stamp.js');

const opts = { skip: ['mouth close'] };

test('有内容指纹：内容和选项都对得上就不重新生成，修改时间不管', () => {
  const stamp = { sha1: 'abc', opts };
  assert.equal(stampCurrent({ stamp, opts, psdSha1: 'abc', modelMtime: 1, psdMtime: 2 }), true);
  assert.equal(stampCurrent({ stamp, opts, psdSha1: 'def', modelMtime: 2, psdMtime: 1 }), false);
});

test('选项变了（psdSkipLayers 改过）就要重新生成', () => {
  const stamp = { sha1: 'abc', opts };
  assert.equal(stampCurrent({ stamp, opts: { skip: [] }, psdSha1: 'abc', modelMtime: 2, psdMtime: 1 }), false);
});

test('老记录没有指纹：退回比修改时间', () => {
  const stamp = { psd: '1:1', opts };
  assert.equal(stampCurrent({ stamp, opts, psdSha1: 'abc', modelMtime: 2, psdMtime: 1 }), true);
  assert.equal(stampCurrent({ stamp, opts, psdSha1: 'abc', modelMtime: 1, psdMtime: 2 }), false);
});

test('没有记录：档案没设选项时按修改时间，设了选项就重新生成', () => {
  assert.equal(stampCurrent({ stamp: null, opts: { skip: [] }, psdSha1: 'abc', modelMtime: 2, psdMtime: 1 }), true);
  assert.equal(stampCurrent({ stamp: null, opts, psdSha1: 'abc', modelMtime: 2, psdMtime: 1 }), false);
});

test('fileSha1 / readStamp：读不到返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpet-stamp-'));
  const f = path.join(dir, 'a.psd');
  fs.writeFileSync(f, 'abc');
  assert.equal(fileSha1(f), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(fileSha1(path.join(dir, 'nope.psd')), null);
  assert.equal(readStamp(path.join(dir, 'nope.build.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('仓库里苏墨的生成记录和 PSD 对得上（改了 PSD 却没重新生成模型时，这一项会失败）', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const prof = JSON.parse(fs.readFileSync(path.join(root, 'characters', 'sumo.json'), 'utf8'));
  const stamp = readStamp(path.join(root, 'assets', 'live2d', 'sumo', 'sumo.build.json'));
  assert.ok(stamp && stamp.sha1, '缺 assets/live2d/sumo/sumo.build.json');
  assert.deepEqual(stamp.opts, { skip: prof.psdSkipLayers || [] });
  assert.equal(stamp.sha1, fileSha1(path.join(root, 'assets', 'sumo', 'src', 'sumo.psd')));
});

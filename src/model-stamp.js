// 模型的生成记录 <名字>.build.json：{ psd: "大小:修改时间", sha1: PSD 内容的 SHA-1, opts: 生成选项, at: 生成时刻 }
// 启动时用它判断「模型是不是就是这份 PSD、按这些选项生成的」，是就不用重新生成。
'use strict';
const crypto = require('crypto');
const fs = require('fs');

function fileSha1(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch (e) { return null; }
}

function readStamp(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function sameOpts(stamp, opts) {
  // 没有记录（老模型）：档案没设生成选项就当是同一版
  if (!stamp) return JSON.stringify(opts) === JSON.stringify({ skip: [] });
  return JSON.stringify(stamp.opts) === JSON.stringify(opts);
}

// 模型是不是这份 PSD 生成的：
//   1. 记录里有内容指纹：只比内容和选项（刚 clone 下来、拷过目录时修改时间不可信）；
//   2. 老记录没有指纹：退回比修改时间，模型不比 PSD 旧就算。
function stampCurrent({ stamp, opts, psdSha1, modelMtime, psdMtime }) {
  if (!sameOpts(stamp, opts)) return false;
  if (stamp && stamp.sha1) return stamp.sha1 === psdSha1;
  return modelMtime >= psdMtime;
}

module.exports = { fileSha1, readStamp, sameOpts, stampCurrent };

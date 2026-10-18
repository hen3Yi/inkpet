// 念稿处理：把要念的话清成适合念的样子（只用于念，气泡里显示照原文）。
'use strict';

/**
 * 去掉代码块、行内代码、网址、Markdown 记号、括号里的动作描写、表情、文件路径，空白收拢。
 */
function speechText(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/```[\s\S]*?(```|$)/g, ' ');            // 代码块（没收尾的也去掉）
  s = s.replace(/`[^`\n]*`/g, ' ');                       // 行内代码
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');        // [文字](链接) → 文字；图片去掉地址
  s = s.replace(/https?:\/\/\S+/g, ' ');                  // 网址
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');                 // 注释
  s = s.replace(/[A-Za-z]:\\[^\s，。！？；、]+/g, ' ');    // Windows 路径
  s = s.replace(/(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+/g, ' '); // a/b/c.ts 这类路径
  s = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, ''); // 动作描写、补充说明
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');               // 标题
  s = s.replace(/^\s*(?:[-*+•]|\d+[.、)])\s+/gm, '');      // 列表记号
  s = s.replace(/^\s*>\s?/gm, '');                        // 引用
  s = s.replace(/\|/g, '，');                             // 表格竖线
  s = s.replace(/\*\*|__|~~|\*/g, '');                    // 加粗、斜体、删除线
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ''); // 表情
  s = s.replace(/[—–―─]+|-{2,}/g, '，');                  // 破折号念出来像「减减」
  s = s.replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').replace(/[ \t　]{2,}/g, ' ');
  s = s.replace(/(^|[\n，。！？；])[，、\s]+/g, '$1').replace(/，{2,}/g, '，');
  return s.trim();
}

module.exports = { speechText };

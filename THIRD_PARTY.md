# 第三方组件

## 不在仓库里、要你自己下载的

### Live2D Cubism SDK for Web

- 下载：<https://www.live2d.com/en/sdk/download/web/>（本项目照 5-r.5 写）
- 用到的部分：
  - Cubism Core：`live2dcubismcore.min.js`。
  - Cubism Framework：打包进 `pet-live2d.js`。
  - WebGL 着色器。
- 许可：
  - Core 按 [Live2D Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)。
  - Framework 按 [Live2D Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)。
  - 拿去发布要看 [SDK 发布许可](https://www.live2d.com/en/sdk/license/)。
- `npm run setup` 从你下载的 SDK 里取出这几样，放在 `renderer/vendor/live2d/`。这个目录已写进 `.gitignore`，不进仓库。
- 别把 `renderer/vendor/` 提交到公开的地方，也别把它和程序一起打包给别人，除非你已经确认这样做符合 Live2D 的许可。

### PSD2Live

只有从 PSD 生成模型时才用到。

- 上游：<https://github.com/tsunehimatoi/psd2live>，GPL-3.0。它依赖 [umamo](https://github.com/umamoorg/umamo)，也是 GPL-3.0。
- 我们改过的版本：还没发布；发布时同样是 GPL-3.0，附源码。仓库里苏墨的模型是用它生成的。
  - 加了尾巴物理：生成 `ParamTail` 和 `ParamTailWag`。
  - 加了头发网格兜底。
- 桌宠只是另起一个进程运行 PSD2Live（官方版的 `PSD2Live.exe`，或者 `java -jar PSD2Live.jar`），两者是分开的程序。PSD2Live 不随本仓库分发。
- 官方 3.x 版（<https://github.com/tsunehimatoi/psd2live/releases>）可以直接用；我们改过的版本基于 0.1。
- PSD2Live 和 umamo 是按 Live2D 文件格式自己实现的第三方工具，和 Live2D Inc. 没有关系。

### See-through

只有拆图层时才用到。

- ComfyUI 插件：[ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through)，MIT。
- 原项目：[See-through](https://github.com/shitagaki-lab/see-through)，Apache-2.0。
- 模型由插件下载，许可以模型页上写的为准。
- 在线版由 See-through 的作者提供：[Hugging Face](https://huggingface.co/spaces/24yearsold/see-through-demo)、[魔搭 ModelScope](https://modelscope.cn/studios/ljsabc/See-Through)。用在线版时，立绘会上传到这两家的服务器上处理。

### Python 包

只有从 PSD 生成模型、拆图层时才用到。

| 包 | 许可 |
| --- | --- |
| psd-tools | MIT |
| NumPy | BSD-3-Clause |
| Pillow | MIT-CMU |
| SciPy | BSD-3-Clause |

SciPy 只有 `pipeline/make_psd.py` 用。

## npm 依赖

| 包 | 许可 |
| --- | --- |
| Electron | MIT |
| esbuild | MIT |

## 借鉴了代码的项目

### Petra

- <https://github.com/Wumiu/Petra>，MIT。
- `renderer/actions.js` 的动作关键帧和插值，是照 Petra 的 `src/live2d/actions.ts` 改写的。
- 下面这些也来自 Petra：
  - 摇晃、眨眼、按住眯眼、拖动摆动的参数口径（`renderer/pet.js`）；
  - 拖动时交给独立进程跟随鼠标、按角色的包围盒夹边的做法（`tools/drag-helper.ps1`、`main.js`）。

```
MIT License

Copyright (c) 2026 Wumiu(FengLing)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

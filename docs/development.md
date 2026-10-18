# 开发和调试

## 命令

| 命令 | 做什么 |
| --- | --- |
| `npm run setup -- <SDK 的 zip 或目录>` | 从 Cubism SDK for Web 里取出 Core 和着色器，打包驱动（见 README） |
| `npm run build:live2d -- <SDK>/Framework/src` | 只重新打包驱动：改了 `live2d/driver.js` 以后跑这个，或者再跑一次 `npm run setup` |
| `npm start` | 启动桌宠 |
| `npm test` | 单元测试（`test/*.test.mjs`，用 Node 自带的测试框架，不用启动 Electron） |

## 程序的结构

- **主进程 `main.js`** 管这些事：
  - 透明窗口；
  - 命中：按渲染端报上来的角色轮廓，决定鼠标是落到角色上，还是穿过去；
  - 拖动和贴边；
  - 角色档案、设置和统计；
  - 语音的排队和播放推送；
  - 本机接口；
  - 盯着 PSD、重新生成模型；
  - 托盘、右键菜单窗口、控制中心窗口。
- **桌宠窗口 `renderer/index.html` + `pet.js`**：
  - 每帧算好眨眼、呼吸、摇晃、视线、拖动摆动、口型、尾巴，交给 Live2D 驱动去画；
  - 画完把角色的轮廓缩成一张小位图报给主进程，当作命中区域；
  - 收到语音片段就边收边播，按音量对口型。
- **Live2D 驱动 `live2d/driver.js`**：建在官方 Cubism Framework 上，加了这几样东西：
  - rig：部件分组、弹簧肢体、跟随摆动、抖耳；
  - 衣服开关、口型；
  - 按部件判断点中了哪里。
  - `npm run setup` 把它和 Framework 打包成 `renderer/vendor/live2d/pet-live2d.js`。
- **拖动助手 `tools/drag-helper.ps1`**：一个常驻的 PowerShell 进程。
  - 拖动时以 8 毫秒的周期移动窗口，不经过渲染端。
  - 负责贴边的计算，按物理像素。
  - 兜底的输入轮询：有时按下事件送不到页面，靠它补一次点击。
- **语音 `src/voice/`**：不依赖 Electron，可以单独测。
- **本机接口 `src/local-api.js`**：不依赖 Electron，可以单独测。
- **控制中心 `renderer/center.*`、右键菜单 `renderer/menu.*`**：各自是一个小窗口，经 IPC 和主进程说话（见各自的 preload）。

## 起一个测试用的实例

不想动自己正在用的桌宠时，可以另开一个实例。数据目录、Electron 的用户目录都要换，否则会被「只开一只」的锁挡住：

```powershell
$env:PET_DATA_DIR = "$env:TEMP\pet-test\data"   # 设置、统计、日志、令牌都写到这里
$env:PET_POS = "-3000,100"                      # 窗口放到屏幕外，不挡你干活
$env:PET_NO_SHELL = "1"                         # 「打开 PSD / 数据目录」不真的打开
npx electron . --user-data-dir="$env:TEMP\pet-test\electron" --remote-debugging-port=9333
```

加了 `--remote-debugging-port` 以后，可以用 Chrome DevTools 协议连上去，读页面状态、截图。比如在 Chrome 里打开 `chrome://inspect`。

## 调试用的环境变量

| 变量 | 作用 |
| --- | --- |
| `PET_DATA_DIR` | 换用户数据目录 |
| `PET_POS` | `x,y`：窗口放在这里，不记位置；菜单和控制中心贴在它旁边 |
| `PET_NO_SHELL` | `1`：「打开 PSD」「打开数据目录」不真的打开 |
| `PET_SAY` | `1`：启动 3.5 秒后说一句 |
| `PET_HEART` | `1`：启动时就开着爱心眼 |
| `PET_HOTKEY` | 换「停下说话」的快捷键，默认 `Control+Alt+U` |
| `PET_CURSOR_FILE` | 一个 JSON 文件，写着 `{"x":…, "y":…}`（DIP）。主进程把它当作鼠标位置，不用动真鼠标就能测命中 |
| `PET_HELPER_INJECT` | 一个文件，每行一条拖动助手的输出（比如 `EVT CLICK x y 按住毫秒`），读完就删，当作拖动助手说的 |

## 日志

用户数据目录下的 `main.log`（主进程）和 `renderer.log`（桌宠窗口的控制台）。启动时超过 5 MB 的，会换成 `*.old.log` 再重新记。

## 离屏预览

`tools/preview/` 能在一个放到屏幕外的窗口里，按角色档案载入模型，喂给它一串输入，然后截图或测命中。用法见 [characters.md](characters.md#怎么量坐标)。改 rig 时先用它看，比反复重启桌宠快。

## 踩过的坑

- **隐藏的窗口里 WebGL 不出图**：预览窗口要「显示着、放在屏幕外」，不能 `show: false`。
- **按下事件有时送不到页面**：移动、松开、右键都到得了，偶尔只有左右键的按下丢了（息屏唤醒后出现过）。点击靠拖动助手的输入轮询补：松手时报一次 `EVT CLICK`，渲染端在那一刻前后 150 毫秒内没报过点击，主进程就补一次。
- **坐标**：Electron 的 `screen` API 和窗口坐标都是 DIP，屏幕缩放 150% 时，DIP 是物理像素的 2/3。拖动助手和贴边按物理像素算。
- **PSD2Live 认图层名**：只认老式的图层名字段，不认 Unicode 名字块。用 psd-tools 写中文图层名时，两个字段都要写（`tools/model_build/psd_prepare.py` 已经处理）。
- **PSD 里隐藏的图层**：PSD2Live 只把可见图层做成部件，而画的时候闭眼、闭嘴这类图层多半是隐藏的。所以整理时把全部图层设成可见；不想进模型的图层，名字用 `#` 开头，或者写进 `psdSkipLayers`。

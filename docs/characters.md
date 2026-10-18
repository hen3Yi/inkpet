# 角色档案

每个角色一份 JSON：`characters/<id>.json`。桌宠启动时从两个地方读：

1. 程序目录的 `characters/`：随程序带的，比如苏墨。档案里的相对路径按**程序目录**算。
2. 用户数据目录的 `characters/`，也就是 `%APPDATA%\inkpet\characters\`：你自己加的。档案里的相对路径按**档案所在的目录**算。和程序目录里同 id 的档案，以这里的为准。

改了档案要重新启动桌宠才生效。`order` 最小的角色是默认角色；在右键菜单或控制中心「角色」页可以换别的。

## 最小的档案

```json
{
  "id": "mychar",
  "name": "小明",
  "model": "mychar/mychar.model3.json"
}
```

把它存成 `%APPDATA%\inkpet\characters\mychar.json`，模型放在同一个目录下的 `mychar\` 里，就能用了。没写 `rig` 时，按 PSD2Live 生成的模型的部件名来驱动；别的工具做的模型，要在 `rig` 里写上自己的部件名，见下面的「rig」一节。

## 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 只能用小写字母、数字、连字符 |
| `model` | 是 | `*.model3.json` 的路径 |
| `name` | | 名字，显示在菜单、控制中心、托盘提示里 |
| `title` | | 头衔，比如「墨龙执事」 |
| `callUser` | | 怎么称呼你，默认「主人」 |
| `order` | | 排序，小的在前；不写算 99 |
| `theme` | | 默认主题，见下 |
| `custom` | | 气泡「自定义」那一项的默认文字，最多 60 字 |
| `cloth` | | 衣服 / 配件开关，见下 |
| `lines` | | 台词，见下 |
| `tail` | | 尾巴，见下 |
| `tune` | | 手感的默认值，见下 |
| `rig` | | 部件、关节、口型、点击分区，见下 |
| `psd` | | 工作用的 PSD。写了它，就会一保存就重新生成模型 |
| `psdSkipLayers` | | 不进模型的图层或组的名字（比如画了但不想用的闭嘴线） |
| `psdExtraLayers` | | PSD2Live 不认识、但本来就该这样的图层名，写在这里就不再提示「未知图层」 |

### theme

```json
"theme": { "style": "glass", "color": "ink" }
```

- `style`：`glass`（暗色玻璃）、`acrylic`（浅色磨砂）或 `flat`（实色）。
- `color`：`sakura`（樱粉）、`celadon`（青瓷）、`midnight`（午夜蓝）、`amber`（琥珀）或 `ink`（墨朱）。

用的人在控制中心改过以后，以他改的为准。

### cloth

```json
"cloth": {
  "keys": ["sleeves", "horns"],
  "labels": { "sleeves": "长袖", "horns": "龙角" }
}
```

`keys` 是开关的名字，`labels` 是控制中心里显示的中文。每个开关具体藏哪些部件，写在 `rig.cloth` 里。

### lines

```json
"lines": {
  "stats": ["点它时气泡里的话", "……"],
  "say": ["念出来的话", "……"]
}
```

- `stats`：点角色时，气泡里随机挑一句。
- `say`：要念出来时随机挑一句，用于点角色时念、空闲时说、右键菜单「说一句」。不写就用 `stats`。

### tail

有尾巴的角色才写。模型里要有对应的参数：用我们改过的 PSD2Live 生成的模型会带 `ParamTailWag`。官方版生成的没有这个参数，这段写了也不会出错，只是尾巴不会单独摆。

```json
"tail": { "param": "ParamTailWag", "idleAmp": 0.18, "idlePeriod": 4.2, "burstAmp": 0.9, "burstFreq": 2.2, "burstDecay": 1.5, "dragGain": 1.0, "sayAmp": 0.45 }
```

| 字段 | 说明 |
| --- | --- |
| `param` | 驱动尾巴的模型参数，取值 -1～1 |
| `idleAmp`、`idlePeriod` | 平时慢慢摆的幅度和周期（秒） |
| `burstAmp` | 点到尾巴时甩一阵的幅度 |
| `burstFreq`、`burstDecay` | 甩的频率（次 / 秒）和衰减快慢 |
| `dragGain` | 拖动时尾巴往反方向拖着的程度 |
| `sayAmp` | 开口说话时甩一下的幅度 |

### tune

手感的默认值，就是控制中心「外观」页里那些滑条。只写想改的那几项；用的人调过以后，以他调的为准。

| 字段 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `swayPeriod` | 2.0 | 0.6～6 | 左右轻晃的周期（秒） |
| `swayBody`、`swayZ` | 1.0、0.5 | 0～2、0～1.5 | 晃动时身体前后、左右的幅度 |
| `breathPeriod`、`breathAmp` | 3.4、1.0 | 1.5～8、0～2 | 呼吸的周期（秒）和幅度 |
| `headFollow`、`eyeFollow` | 1.0、1.0 | 0～2 | 头、眼睛跟鼠标的灵敏度 |
| `dragTilt` | 0.5 | 0～1 | 拖动时头跟着身体倒的比例 |
| `dragBody` | 1.0 | 0～2 | 拖动时身体的摆幅 |
| `limbArm` | 1.0 | 0～1.5 | 拖动时手臂的摆幅 |
| `headDy` | 24 | -80～80 | 头整体往下挪多少（画布像素） |
| `bodySx`、`bodySy` | 1.0、1.0 | 0.6～1.6 | 身体横向、纵向的比例，不影响头 |
| `blinkMin`、`blinkMax` | 1.6、5.4 | 0.4～8、0.6～12 | 两次眨眼的间隔（秒） |
| `blinkDouble` | 0.18 | 0～1 | 连眨两下的概率 |
| `clickVol` | 0.25 | 0～1 | 点击音效的音量 |

## rig

`rig` 告诉驱动模型里的部件（drawable）叫什么、关节在哪。坐标一律是**模型画布的像素**，PSD2Live 生成的模型就是 PSD 的尺寸，比如 1280×1280，左上角是 (0, 0)。不写的字段用驱动里的默认值（`live2d/driver.js` 的 `DEFAULT_RIG`），它按 PSD2Live 的部件名写，比如 `ArtMeshFace`、`ArtMeshFrontHair`。

| 字段 | 说明 |
| --- | --- |
| `cloth` | `{ 开关名: [部件名…] }`：开关关掉时藏起来的部件 |
| `autoCloth` | `[{ "when": 开关名, "hide": [部件名…] }]`：某个开关开着时自动藏掉的部件，比如穿着靴子时藏起脚 |
| `body`、`head` | 身体组、头组的部件。拖动时身体绕着脖子转，头组只跟着转 `dragTilt` 那么多 |
| `mouth` | `{ "smile", "open", "triangle" }`：平时、说话、被点 / 拖时各用哪个嘴的部件 |
| `mouthParam` | `ParamMouthOpenY` 怎么给，见下 |
| `mouthOrder` | `true`：把嘴挪到眉毛和前发之间画（有的模型嘴的绘制顺序太靠后时用） |
| `swingFollow` | `[{ draw, root, tip, u0 }]`：头组里越往下越跟着身体转的部件，比如垂到身后的长发 |
| `limbs` | 拖动时带弹簧甩动的肢体，见下 |
| `armKeys` | 「手臂摆幅」滑条管哪几条 `limbs`（写 `key`） |
| `ears` | `[{ draw, root, tip, dir, gain, freq, decay, u0, delay }]`：被点时抖一下的耳朵 |
| `extraParams` | 要由桌宠写值的额外参数，比如 `ParamTailWag` |
| `hit` | `{ "head": [部件…], "tail": [部件…], "front": [部件…] }`：点击分区。点中 head 点头抖耳，点中 tail 甩尾；front 是挡在尾巴前面的部件，点到它们不算点尾巴 |

### mouthParam

```json
"mouthParam": { "mix": "max", "smile": 0, "open": 0, "triangle": 1, "lo": 0.1, "hi": 1, "smooth": 18 }
```

- `mix: "replace"`（默认）：说话时 `ParamMouthOpenY` 直接等于音量。不说话时，被点 / 拖为 0，平时为 1。适合有好几张嘴的模型。
- `mix: "max"`：适合只有一张嘴的模型，比如苏墨。
  - 平时取 `smile` 的值，被点 / 拖时取 `triangle`，说话时取 `open`。
  - 音量映射到 `lo`～`hi` 之后，和上面的值取大的那个。
  - `smooth` 大于 0 时，对开合做平滑。

### limbs

```json
{ "key": "armL", "draws": ["ArtMeshHandwearL", "ArtMeshLayerL"], "root": [722, 560], "tip": [845, 900], "gain": 0.42, "K": 300, "C": 14, "u0": 0.2 }
```

| 字段 | 说明 |
| --- | --- |
| `key` | 名字（`armKeys` 引用它） |
| `draws` | 跟着这条肢体一起甩的部件 |
| `root`、`tip` | 骨轴的根和梢（画布坐标）：肩膀到手、胯到脚、腰到裙摆 |
| `gain` | 甩的幅度 |
| `K`、`C` | 弹簧的刚度和阻尼：K 大甩得快，C 大停得快 |
| `u0` | 骨轴上从哪里开始动，0～1：0.2 = 靠根的 20% 不动，再往梢越来越跟着转 |

### 怎么量坐标

`tools/preview/` 是一个离屏的预览工具：按角色档案载入模型，喂给它和桌宠一样的输入（摆动、鼠标、口型、衣服开关），截图或测命中，用来量关节和检查 rig。用法写在 `tools/preview/preview_main.cjs` 的开头，例如：

```powershell
npx electron --user-data-dir="$env:TEMP\pet-preview" tools/preview/preview_main.cjs characters/sumo.json scenario.json out
```

`scenario.json` 是一串步骤，每一步可以设动作、跑几帧、截图、测几个点命中哪个部件：

```json
[
  { "frames": 30, "shot": "idle" },
  { "motion": [0, 0, 1.2, 0.8], "frames": 20, "shot": "drag" },
  { "hit": [[640, 400], [640, 1100]] }
]
```

## 苏墨的档案

`characters/sumo.json` 是一份完整的例子：尾巴、只有一张嘴的口型、四条弹簧肢体、两只会抖的耳朵、点击分区都有。

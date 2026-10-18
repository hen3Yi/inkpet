# 本机接口

桌宠在本机开了一个小小的 HTTP 接口，给脚本、插件这类「别的程序」用：让桌宠说一句话、做个动作、换角色，或者看看它现在的状态。

- 地址：`http://127.0.0.1:18932`。只听本机，局域网里别的电脑连不上。
- 端口在 `config.json` 的 `api.port` 里改。
- 控制中心「系统」页能关掉接口、复制令牌、换一个新令牌。

## 令牌

每个请求都要带令牌，下面两种请求头写一种就行：

```
Authorization: Bearer <令牌>
X-Pet-Token: <令牌>
```

- 令牌在用户数据目录的 `api-token.txt` 里（`%APPDATA%\live2d-desktop-pet\api-token.txt`）。第一次启动时随机生成，以后不变。
- 在「系统」页换新令牌后，旧的马上失效。
- 带 `Origin` 请求头的请求一律拒绝（403）。浏览器里的网页发请求都会带这个头，这样随便打开的网页就没法指挥桌宠。
- 请求体是 JSON，最大 16 KB；回复都是 JSON。

## 接口

### GET /state

看桌宠现在的状态。

```json
{
  "character": { "id": "sumo", "name": "苏墨" },
  "characters": [{ "id": "sumo", "name": "苏墨" }],
  "speaking": false,
  "voice": "待机",
  "visible": true,
  "mouseThrough": false,
  "actions": ["nod", "shake", "tilt", "lookAround", "lookSide", "yawn", "stretch", "happy", "surprised", "sleepy", "sway"]
}
```

`voice` 的取值：

| 取值 | 意思 |
| --- | --- |
| `关` | 语音关着 |
| `在说话` | 正在念 |
| `没念出来` | 上一句没念出来 |
| `待机` | 空闲 |

### POST /say

让桌宠说一句：显示在气泡里，并且念出来。

```json
{ "text": "主上，该休息了。" }
```

- 回复：`{ "ok": true, "spoken": true, "error": "" }`。要**等这一句念完**（或者没念成）才回。
- `spoken: false` 时，`error` 写着原因，比如「语音关着」或合成失败的原因。没念成的话，气泡里照样会显示。
- 最多 400 字，多的截掉。正在念的时候又来新的，排在后面，最多排 3 句；再多的直接回 `spoken: false`。

### POST /stop

停下正在念的，并清空排队的。回复 `{ "ok": true }`。

### POST /action

做一个动作：

```json
{ "id": "nod" }
```

| id | 动作 |
| --- | --- |
| `nod` | 点头 |
| `shake` | 摇头 |
| `tilt` | 歪头 |
| `lookAround` | 张望 |
| `lookSide` | 左顾右盼 |
| `yawn` | 打哈欠 |
| `stretch` | 伸懒腰 |
| `happy` | 开心跳 |
| `surprised` | 惊讶 |
| `sleepy` | 打盹 |
| `sway` | 摇摆 |

`id` 写空字符串就随机做一个。不认识的 `id` 会回 `{ "ok": false, "error": "没有这个动作：…" }`。

### POST /character

换角色：

```json
{ "id": "sumo" }
```

- `id` 写空字符串，就换回排第一的角色。
- 回复：`{ "ok": true, "active": "sumo" }`。
- 和在控制中心里选一样，会记进设置。

## 出错

| 状态码 | 意思 |
| --- | --- |
| 400 | 请求体不是 JSON |
| 401 | 令牌不对，或者没带 |
| 403 | 带了 `Origin` 头（从网页发来的） |
| 404 | 没有这个接口 |
| 413 | 请求体超过 16 KB |
| 500 | 桌宠内部出错，`error` 里有原因 |

出错时回复 `{ "ok": false, "error": "原因" }`。

## 例子

PowerShell。`-ContentType` 里一定要写 `charset=utf-8`，不写的话，Windows PowerShell 5.1 会把中文变成问号：

```powershell
$token = (Get-Content "$env:APPDATA\live2d-desktop-pet\api-token.txt").Trim()
$h = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:18932/say -Headers $h -ContentType "application/json; charset=utf-8" -Body '{"text":"主上，该休息了。"}'
Invoke-RestMethod -Uri http://127.0.0.1:18932/state -Headers $h
```

Node.js（18 以上自带 fetch）：

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const token = fs.readFileSync(path.join(process.env.APPDATA || os.homedir(), 'live2d-desktop-pet', 'api-token.txt'), 'utf8').trim();
const pet = (p, body) => fetch('http://127.0.0.1:18932' + p, {
  method: body ? 'POST' : 'GET',
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}).then((r) => r.json());

await pet('/action', { id: 'happy' });
console.log(await pet('/say', { text: '今天的事，苏墨都替您记着。' }));
```

Python：

```python
import json, os, urllib.request

token = open(os.path.join(os.environ['APPDATA'], 'live2d-desktop-pet', 'api-token.txt'), encoding='utf-8').read().strip()
req = urllib.request.Request('http://127.0.0.1:18932/say', method='POST',
                             data=json.dumps({'text': '主上，该休息了。'}).encode('utf-8'),
                             headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
print(json.load(urllib.request.urlopen(req)))
```

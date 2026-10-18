# Prepare a hand-edited character PSD for PSD2Live (the pet rebuilds its Live2D model on every save).
#
# - Every pixel / shape / type / smart-object layer becomes one visible layer: PSD2Live only builds
#   drawables from visible layers, and expression layers (eye close, mouth close) are usually hidden
#   while painting.
# - Groups are flattened (their layers keep their own names). A layer or group whose name starts with
#   '#' is left out (sketches, references).
# - Masks, opacity and clipping layers are baked by compositing each base layer on its own; clipping
#   layers are not emitted separately.
# - A two-eye "eye close" / "闭眼" layer is split into "eye close r" (viewer-left) / "eye close l",
#   and closed-eye layers are moved right above the eyelashes.
# - Every layer is cropped to its content; empty layers are dropped.
# - --skip '<json list>': layers (or groups) the character profile keeps out of the model
#   (psdSkipLayers). Matched like PSD2Live matches names: case-insensitive, the whole name or the
#   name followed by a space / '-' / '_' ("mouth close 拷贝").
#
# The source PSD is only read. Prints one JSON line: {"size": [w, h], "layers": [...], "notes": [...]}.
# usage: python -I -X utf8 psd_prepare.py <in.psd> <out.psd> [--skip '["mouth close"]']
import json
import sys
import unicodedata

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

KINDS = {'pixel', 'shape', 'type', 'smartobject'}
EYE_CLOSE_BOTH = {'eye close', 'eye_close', 'eyeclose', '闭眼', '閉眼'}
SKIP = []   # normalised names from --skip


def norm(name):
    return unicodedata.normalize('NFKC', name).strip().lower()


def listed(layer):
    n = norm(layer.name)
    return any(n == s or n.startswith((s + ' ', s + '-', s + '_')) for s in SKIP)


def skipped(layer):
    return layer.name.strip().startswith('#') or listed(layer)


def leaves(group, notes):
    for layer in group:
        if listed(layer):
            notes.append('「%s」按角色档案的设置不进模型' % layer.name.strip())
            continue
        if skipped(layer):
            notes.append('跳过（# 开头）：' + layer.name)
            continue
        if layer.is_group():
            yield from leaves(layer, notes)
            continue
        if getattr(layer, 'clipping', False):
            continue   # baked into the layer it clips
        if layer.kind not in KINDS:
            notes.append('跳过（%s 图层）：%s' % (layer.kind, layer.name))
            continue
        yield layer


def fail(message):
    # One readable line for the pet's status card instead of a traceback; exit code 2 = "message is final".
    print(message, file=sys.stderr)
    sys.exit(2)


def short(e):
    text = str(e).strip()
    return (text.splitlines()[-1] if text else type(e).__name__)[:200]


def main(src, out):
    try:
        psd_in = PSDImage.open(src)
    except Exception as e:
        fail('读不了这个 PSD（可能还没存完，或者文件坏了）：' + short(e))
    w, h = psd_in.width, psd_in.height
    notes = []
    layers = []
    for layer in leaves(psd_in, notes):
        # Composited over the layer's own box (mask and clipping layers included, hidden or not), then
        # placed on a full canvas; a full-canvas viewport per layer takes ~10 s for 29 layers.
        x0, y0, x1, y1 = layer.bbox
        im = layer.composite(layer_filter=lambda l: not skipped(l)) if x1 > x0 and y1 > y0 else None
        if im is None or not im.getbbox():
            notes.append('空图层：' + layer.name)
            continue
        canvas = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        canvas.paste(im.convert('RGBA'), (x0, y0))
        layers.append([layer.name.strip(), canvas])

    # one layer with both closed eyes: split between the eyes
    def centre(prefix):
        for name, im in layers:
            if name.lower().startswith(prefix):
                box = im.getbbox()
                return (box[0] + box[2]) / 2 if box else None
        return None
    split = []
    for name, im in layers:
        if name.lower() in EYE_CLOSE_BOTH:
            r, l = centre('eyewhite-r'), centre('eyewhite-l')
            mid = int(round((r + l) / 2)) if r is not None and l is not None else w // 2
            a = np.asarray(im).copy()
            right = a.copy(); right[:, mid:, 3] = 0   # viewer-left half = the character's right eye
            left = a.copy(); left[:, :mid, 3] = 0
            split += [['eye close r', Image.fromarray(right, 'RGBA')], ['eye close l', Image.fromarray(left, 'RGBA')]]
            notes.append('「%s」拆成左右两只（x = %d）' % (name, mid))
        else:
            split.append([name, im])
    layers = [l for l in split if l[1].getbbox()]

    closed = [l for l in layers if l[0].lower().startswith('eye close')]
    rest = [l for l in layers if not l[0].lower().startswith('eye close')]
    lashes = [i for i, (n, _) in enumerate(rest) if n.lower().startswith('eyelash')]
    if closed and lashes:
        at = lashes[-1] + 1
        rest[at:at] = closed
    else:
        rest += closed

    psd = PSDImage.new('RGBA', (w, h))
    for name, im in rest:
        x0, y0, x1, y1 = im.getbbox()
        layer = PixelLayer.frompil(im.crop((x0, y0, x1, y1)), psd, 'Layer', top=y0, left=x0)
        name = name[:80]
        layer.name = name           # the setter writes the Unicode name block (what Photoshop reads)
        layer._record.name = name   # PSD2Live (umamo) reads only the legacy Pascal name, as UTF-8; the setter put '?' there for Chinese
        psd.append(layer)
    # PSD2Live reads the layers only; recompositing the merged preview would cost ~2.5 s per save.
    psd._update_preview = lambda: None
    psd.save(out, encoding='utf-8')
    print(json.dumps({'size': [w, h], 'layers': [n for n, _ in rest], 'notes': notes}, ensure_ascii=False))


if __name__ == '__main__':
    args = sys.argv[1:]
    if '--skip' in args:
        i = args.index('--skip')
        try:
            SKIP[:] = [norm(str(s)) for s in json.loads(args[i + 1]) if str(s).strip()]
        except Exception:
            fail('--skip 要给 JSON 数组，比如 \'["mouth close"]\'')
        del args[i:i + 2]
    try:
        main(args[0], args[1])
    except SystemExit:
        raise
    except Exception as e:
        fail('整理 PSD 时出错：%s: %s' % (type(e).__name__, short(e)))

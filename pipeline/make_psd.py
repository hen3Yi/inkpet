# Pack the rebuilt layer PNGs into a PSD for PSD2Live (stacking order from _order.json, back first).
# Also drops detached specks (See-through edge junk, tail-cut leftovers) from every layer.
# usage: python -I make_psd.py <layers_dir> <out.psd>
import json, sys
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
from scipy import ndimage

src, out = sys.argv[1:3]
order = json.load(open(f'{src}/_order.json', encoding='utf-8'))


def despeckle(im):
    """Drop See-through's stray specks (alpha up to ~35 in canvas corners and along edges, plus
    tail-cut leftovers in back hair). Keeps the largest blob and any blob at least 2% of it."""
    a = np.asarray(im).copy()
    lab, n = ndimage.label(a[..., 3] > 24)
    if n == 0:
        return im
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    keep_ids = [i + 1 for i, s in enumerate(sizes) if s >= max(60, 0.02 * sizes.max()) or s == sizes.max()]
    keep = np.isin(lab, keep_ids)
    keep = ndimage.binary_dilation(keep, iterations=2)
    a[~keep, 3] = 0
    return Image.fromarray(a, 'RGBA')


psd = PSDImage.new('RGBA', (1280, 1280))
for name in order:
    im = Image.open(f'{src}/{name}.png').convert('RGBA')
    im = despeckle(im)
    if not im.getbbox():
        continue
    # Full-canvas layers: PSD2Live builds hair meshes against the layer rect, and
    # cropped hair layers came out with stray triangles reaching the canvas corners.
    layer = PixelLayer.frompil(im, psd, name, top=0, left=0)
    psd.append(layer)
psd.save(out)
check = PSDImage.open(out)
print(out, check.size, [l.name for l in check])

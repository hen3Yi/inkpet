# Rebuild See-through output into the PSD that PSD2Live consumes.
#  - every pixel that is visible in the original keeps the original colour; See-through's
#    regenerated colour is only used for parts hidden behind something else
#  - the tail is cut out of "back hair" (See-through merged it there) with a hand-traced outline
#  - the qipao is split by the per-pixel depth maps into the lining behind the legs
#    ("bottomwear") and the front panels ("topwear")
# usage: python -I build_layers.py <run_dir> <original_png> <out_dir>
import glob, json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

run, orig_path, out = sys.argv[1:4]
W = H = 1280
info = json.load(open(glob.glob(run + '/*_layers.json')[0], encoding='utf-8'))
meta = {l['name']: l for l in info['layers']}


def load(name, depth=False):
    l = meta[name]
    suffix = '_depth' if depth else ''
    im = Image.open(glob.glob(f'{run}/*_{name}{suffix}.png')[0])
    im = im.convert('L' if depth else 'RGBA')
    c = Image.new(im.mode, (W, H), 255 if depth else (0, 0, 0, 0))
    c.paste(im, (l['left'], l['top']))
    a = np.asarray(c).astype(np.float32)
    return a if depth else a / 255.0


orig = np.asarray(Image.open(orig_path).convert('RGB')).astype(np.float32) / 255.0
src = {n: load(n) for n in meta if n not in ('neckwear', 'bottomwear', 'wings', 'objects', 'eyewear', 'earwear', 'tail')}

# --- tail: hand-traced outline (canvas px), root starts behind the skirt -------------------------
TAIL = [(795, 905), (830, 893), (870, 912), (905, 927), (940, 945), (975, 970), (1000, 1000),
        (1014, 1040), (1022, 1080), (1020, 1130), (1018, 1255), (740, 1255), (800, 1165),
        (850, 1140), (880, 1100), (905, 1080), (935, 1065), (945, 1035), (930, 1012),
        (895, 992), (855, 978), (800, 968)]
# Hard cut in back hair; the tail (drawn above it) reaches 3 px further so the two overlap. A soft
# shared edge would leave both half-transparent there and show a pale seam.
m = Image.new('L', (W, H), 0)
ImageDraw.Draw(m).polygon(TAIL, fill=255)
cut = np.asarray(m).astype(np.float32) / 255.0
tail_mask = np.asarray(m.filter(ImageFilter.MaxFilter(7))).astype(np.float32) / 255.0
back = src.pop('back hair')
tail = back.copy()
tail[..., 3] *= tail_mask
# back hair is cut further down, once the draw order is known (see below)

# --- qipao: lining behind the legs vs front panels ---------------------------------------------
top = src.pop('topwear')
td, ld = load('topwear', True), load('legwear', True)
behind = (top[..., 3] > 0.5) & (src['legwear'][..., 3] > 0.5) & (td > ld)
behind = np.asarray(Image.fromarray((behind * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
lining = top.copy(); lining[..., 3] *= behind
front = top.copy(); front[..., 3] *= ~behind

# back -> front draw order (PSD2Live reads names; order = PSD stacking)
ORDER = [
    ('back hair', back), ('tail', tail), ('bottomwear', lining),
    ('legwear', src['legwear']), ('footwear', src['footwear']), ('neck', src['neck']),
    ('topwear', front), ('handwear-r', src['handwear-r']), ('handwear-l', src['handwear-l']),
    ('headwear', src['headwear']), ('ears-r', src['ears-r']), ('ears-l', src['ears-l']),
    ('face', src['face']), ('nose', src['nose']), ('mouth', src['mouth']),
    ('eyewhite-r', src['eyewhite-r']), ('eyewhite-l', src['eyewhite-l']),
    ('irides-r', src['irides-r']), ('irides-l', src['irides-l']),
    ('eyelash-r', src['eyelash-r']), ('eyelash-l', src['eyelash-l']),
    ('eyebrow-r', src['eyebrow-r']), ('eyebrow-l', src['eyebrow-l']),
    ('front hair', src['front hair']),
]

# Only cut the tail out of back hair where the tail is visible in the original. Where something in
# front hides it (hand, skirt) the back hair stays as filler: back hair follows the head and the tail
# follows the body, so a cut edge there opens into a see-through gap as soon as the two move apart.
names = [n for n, _ in ORDER]
in_front = np.zeros((H, W), np.float32)
for name, lay in ORDER[names.index('tail') + 1:]:
    in_front = 1.0 - (1.0 - in_front) * (1.0 - lay[..., 3])
# Near the root (pinned, barely moves) back hair also runs ~12 px under the tail: hair follows the
# head and the tail follows the body, so with breathing their shared edge would open into a gap.
root_cut = np.asarray(m.filter(ImageFilter.MinFilter(25))).astype(np.float32) / 255.0
root_band = np.zeros((H, W), bool); root_band[:960] = True
cut = np.where(root_band, root_cut, cut)
back[..., 3] *= 1.0 - cut * (in_front < 0.5)

# Pad the hidden tail root upward (behind hand/skirt) by smearing each column's top tail pixel, so a
# lifted hand during breathing does not uncover an empty strip above the tail edge.
PAD = 18
ta = tail[..., 3]
for x in range(780, 880):
    col = np.nonzero(ta[860:980, x] > 0.8)[0]
    if not len(col):
        continue
    top = 860 + col[0]
    for y in range(max(0, top - PAD), top):
        if in_front[y, x] > 0.5 and ta[y, x] < 0.8:
            tail[y, x] = tail[top, x]

# visibility front -> back: share of each layer's pixel that is actually seen in the original
remaining = np.ones((H, W), np.float32)
final = {}
for name, lay in reversed(ORDER):
    a = lay[..., 3]
    seen = remaining  # fraction of this pixel not yet covered by layers in front
    rgb = orig * seen[..., None] + lay[..., :3] * (1.0 - seen[..., None])
    final[name] = np.dstack([rgb, a])
    remaining = remaining * (1.0 - a)

os.makedirs(out, exist_ok=True)
comp = np.ones((H, W, 3), np.float32)
for name, _ in ORDER:
    lay = final[name]
    comp = lay[..., :3] * lay[..., 3:] + comp * (1 - lay[..., 3:])
    Image.fromarray((np.clip(lay, 0, 1) * 255).astype(np.uint8), 'RGBA').save(f'{out}/{name}.png')
Image.fromarray((comp * 255).astype(np.uint8)).save(f'{out}/_composite.png')
diff = np.abs(comp - orig).mean(axis=2)
print('mean abs diff %.4f, pixels off >0.1: %d' % (diff.mean(), int((diff > 0.1).sum())))
json.dump([n for n, _ in ORDER], open(f'{out}/_order.json', 'w', encoding='utf-8'), ensure_ascii=False)

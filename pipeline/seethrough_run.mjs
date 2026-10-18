// Run See-through on one image through the ComfyUI API and copy the layer PNGs + info JSON out.
// usage: node seethrough_run.mjs <image.png> <outDir> [resolution=1280] [seed=42]
// env: COMFY_URL (default http://127.0.0.1:8188), COMFY_OUTPUT_DIR (ComfyUI's output folder;
//      if unset, taken from ComfyUI's --output-directory, else <ComfyUI>/output)
import fs from 'node:fs';
import path from 'node:path';

const [img, outDir, resArg, seedArg] = process.argv.slice(2);
if (!img || !outDir) { console.error('usage: node seethrough_run.mjs <image> <outDir> [res] [seed]'); process.exit(2); }
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
// models are fetched from Hugging Face the first time unless SEETHROUGH_NO_DOWNLOAD=1 (then they must already be in ComfyUI/models)
const AUTO_DOWNLOAD = process.env.SEETHROUGH_NO_DOWNLOAD !== '1';
const res = Number(resArg || 1280);
const seed = Number(seedArg || 42);

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${COMFY}/system_stats`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('ComfyUI not up');
}

// SeeThrough_SavePSD writes into ComfyUI's output folder; the API does not report the file names,
// so the files are picked up from that folder by prefix.
async function comfyOutputDir() {
  if (process.env.COMFY_OUTPUT_DIR) return process.env.COMFY_OUTPUT_DIR;
  const argv = (await (await fetch(`${COMFY}/system_stats`)).json())?.system?.argv || [];
  const i = argv.indexOf('--output-directory');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  if (argv[0] && path.isAbsolute(argv[0])) {
    const dir = path.join(path.dirname(argv[0]), 'output');
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error('cannot tell where ComfyUI saves its output; set COMFY_OUTPUT_DIR');
}

await waitUp();
const COMFY_OUT = await comfyOutputDir();
const form = new FormData();
form.append('image', new Blob([fs.readFileSync(img)]), path.basename(img));
form.append('overwrite', 'true');
const up = await (await fetch(`${COMFY}/upload/image`, { method: 'POST', body: form })).json();

const prefix = `seethrough_${Date.now()}`;
const prompt = {
  '1': { class_type: 'LoadImage', inputs: { image: up.name } },
  '2': { class_type: 'SeeThrough_LoadLayerDiffModel', inputs: { model: 'layerdifforg/seethroughv0.0.2_layerdiff3d', vae_ckpt: '', unet_ckpt: '', quant_mode: 'none', cache_tag_embeds: true, group_offload: true, auto_download: AUTO_DOWNLOAD } },
  '3': { class_type: 'SeeThrough_LoadDepthModel', inputs: { model: '24yearsold/seethroughv0.0.1_marigold', quant_mode: 'none', cache_tag_embeds: true, group_offload: true, auto_download: AUTO_DOWNLOAD } },
  '4': { class_type: 'SeeThrough_GenerateLayers', inputs: { image: ['1', 0], layerdiff_model: ['2', 0], seed, resolution: res, num_inference_steps: 30 } },
  '5': { class_type: 'SeeThrough_GenerateDepth', inputs: { layers: ['4', 0], depth_model: ['3', 0], seed, resolution_depth: -1 } },
  '6': { class_type: 'SeeThrough_PostProcess', inputs: { layers_depth: ['5', 0], tblr_split: true, use_lama: true } },
  '7': { class_type: 'SeeThrough_SavePSD', inputs: { parts: ['6', 0], filename_prefix: prefix } },
};
const q = await (await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })).json();
if (!q.prompt_id) { console.error(JSON.stringify(q).slice(0, 2000)); process.exit(1); }
console.log('queued', q.prompt_id);

const t0 = Date.now();
for (;;) {
  await new Promise(r => setTimeout(r, 5000));
  const h = await (await fetch(`${COMFY}/history/${q.prompt_id}`)).json();
  const e = h[q.prompt_id];
  if (!e) { if (Date.now() - t0 > 30 * 60e3) throw new Error('timeout'); continue; }
  const st = e.status || {};
  if (st.status_str === 'error') {
    const msg = (st.messages || []).find(m => m[0] === 'execution_error');
    console.error('error', JSON.stringify(msg?.[1] || st).slice(0, 3000));
    process.exit(1);
  }
  if (st.completed) break;
}
console.log('done in', Math.round((Date.now() - t0) / 1000), 's');

fs.mkdirSync(outDir, { recursive: true });
const files = fs.readdirSync(COMFY_OUT).filter(f => f.startsWith(prefix));
for (const f of files) fs.renameSync(path.join(COMFY_OUT, f), path.join(outDir, f.slice(prefix.length + 1)));
console.log("moved", files.length, 'files to', outDir);

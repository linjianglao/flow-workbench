(() => {
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(k => k != null && e.append(k.nodeType ? k : document.createTextNode(k)));
  return e;
};

// ------------------------------------------------------------ state ---
const S = {
  samples: [], active: -1, channels: [], stains: {}, ranges: {},
  transforms: {}, tfns: {}, spill: null, fileSpill: null, compOn: false,
  gates: [], nextId: 1, ctrl: {}, overlays: new Set(),
  view: { x: null, y: null, pop: 'root', tool: 'pointer', sel: null, pt: 2 },
  tab: 'gate', version: 0, statChans: null
};
let nextSampleId = 1;
const FONT = getComputedStyle(document.body).fontFamily;
const densityCache = new Map();

const isScatter = ch => /^(FSC|SSC|FS |SS |FS$|SS$)/i.test(ch);
const isTime = ch => /time/i.test(ch);
const isFluor = ch => !isScatter(ch) && !isTime(ch) && !/width|^event/i.test(ch);
const short = ch => (S.stains[ch] && S.stains[ch] !== ch) ? S.stains[ch] : ch;
const label = ch => (S.stains[ch] && S.stains[ch] !== ch) ? `${S.stains[ch]} (${ch})` : ch;
function laser(ch) {
  const s = (ch + ' ' + (S.stains[ch] || '')).toUpperCase();
  if (isScatter(ch) || isTime(ch)) return 'var(--lnone)';
  if (/BUV|UV\d|355|INDO/.test(s)) return 'var(--l355)';
  if (/BV\d|PACIFIC|V\d{3}|^V\d|405|DAPI|HOECHST|SUPER ?BRIGHT 4|EFLUOR ?450|BV/.test(s)) return 'var(--l405)';
  if (/APC|ALEXA ?(FLUOR ?)?6[4-9]|AF6|R\d{3}|^R\d|640|633|RL\d|CY5\b|IRFP|DRAQ/.test(s)) return 'var(--l640)';
  if (/PE|MCHERRY|RFP|TDTOMATO|YL\d|YG|561|532|Y\d{3}|^Y\d|G\d{3}|^G\d|PI\b|7-?AAD/.test(s) && !/PERCP/.test(s)) return 'var(--l561)';
  if (/FITC|GFP|B\d{3}|^B\d|BL\d|488|PERCP|ALEXA ?(FLUOR ?)?488|AF488|FL\d/.test(s)) return 'var(--l488)';
  return 'var(--lnone)';
}
const laserHex = ch => getComputedStyle(document.documentElement).getPropertyValue(laser(ch).slice(4, -1)).trim() || '#A3ADB3';

let toast = function (msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), err ? 7000 : 3200);
};
let toastTimer = 0;

// ------------------------------------------------------- data access ---
const activeSample = () => S.samples[S.active];
function getComp(s) {
  if (!s._comp) {
    try { s._comp = (S.compOn && S.spill) ? Core.compensate(s.fcs, S.spill) : s.fcs.cols; }
    catch (e) { toast(e.message, true); s._comp = s.fcs.cols; }
  }
  return s._comp;
}
const getRaw = (s, ch) => getComp(s)[s.idx[ch]];
const getUncomp = (s, ch) => s.fcs.cols[s.idx[ch]];
function tfn(ch) { return S.tfns[ch] || (S.tfns[ch] = Core.transformFns(S.transforms[ch])); }
function getT(s, ch) { return s._t[ch] || (s._t[ch] = Core.applyTransform(S.transforms[ch], getRaw(s, ch))); }
function getTUncomp(s, ch) { const k = 'u:' + ch; return s._t[k] || (s._t[k] = Core.applyTransform(S.transforms[ch], getUncomp(s, ch))); }
const gateById = id => S.gates.find(g => g.id === id);
function getPop(s, id) {
  if (id === 'root') return s.all;
  if (s._pops.has(id)) return s._pops.get(id);
  const base = gateById(id); if (!base) return new Int32Array(0);
  const g = effGate(s, base);
  const parent = getPop(s, g.parent);
  const idx = Core.applyGate(g, getT(s, g.x), g.y ? getT(s, g.y) : null, tfn(g.x), g.y ? tfn(g.y) : null, parent);
  s._pops.set(id, idx); return idx;
}
function popName(id) { return id === 'root' ? 'All events' : (gateById(id) || {}).name || '?'; }
function invalidate({ comp = false, channel = null } = {}) {
  S.version++; densityCache.clear();
  S.samples.forEach(s => {
    if (comp) { s._comp = null; s._t = {}; }
    if (channel) { delete s._t[channel]; delete s._t['u:' + channel]; S.tfns[channel] = null; }
    s._pops.clear();
  });
}
/* Gates belong to exactly one group, so the tree you see is the active group's tree. */
function childrenIn(id, gid) { return S.gates.filter(g => g.parent === id && g.group === gid); }
function children(id) { return childrenIn(id, S.activeGroup); }
function treeIn(gid, id = 'root', depth = 0, out = []) {
  out.push({ id, depth });
  childrenIn(id, gid).forEach(g => treeIn(gid, g.id, depth + 1, out));
  return out;
}
function dfs() { return treeIn(S.activeGroup); }
function descendants(id) { const g = gateById(id); return treeIn(g ? g.group : S.activeGroup, id).slice(1).map(d => d.id); }

// ------------------------------------------------------------ loading ---
function addSample(fcs, bytes) {
  const names = fcs.params.map(p => p.name);
  if (!S.samples.length) {
    S.channels = names;
    fcs.params.forEach(p => { S.stains[p.name] = p.stain; S.ranges[p.name] = p.range; });
  } else {
    const missing = S.channels.filter(c => !names.includes(c));
    if (missing.length) { toast(`${fcs.name} was skipped because it lacks ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}. All files need the same channels.`, true); return false; }
  }
  let name = fcs.name, k = 2;
  while (S.samples.some(s => s.name === name)) name = `${fcs.name} (${k++})`;
  const s = { id: nextSampleId++, name, fcs, bytes: bytes || null, idx: Object.fromEntries(names.map((n, i) => [n, i])), _comp: null, _t: {}, _pops: new Map(), all: Int32Array.from({ length: fcs.N }, (_, i) => i) };
  S.samples.push(s);
  if (S.groups.length) { const ag = activeGroup(); if (ag) ag.members.push(s.id); }
  if (!S.spill && fcs.spill && fcs.spill.channels.every(c => names.includes(c))) {
    S.fileSpill = JSON.parse(JSON.stringify(fcs.spill)); S.spill = JSON.parse(JSON.stringify(fcs.spill)); S.compOn = true;
    S.samples.forEach(x => { x._comp = null; x._t = {}; x._pops.clear(); });
  }
  if (S.samples.length === 1) {
    S.active = 0;
    S.channels.forEach(ch => { S.transforms[ch] = Core.defaultTransform(ch, getRaw(s, ch), S.ranges[ch]); });
    const find = re => S.channels.find(c => re.test(c));
    S.view.x = find(/^FSC-A$/i) || find(/^FSC/i) || find(/^FS/i) || S.channels[0];
    S.view.y = find(/^SSC-A$/i) || find(/^SSC/i) || find(/^SS/i) || S.channels[1] || '';
  }
  guessControl(s);
  ensureGroups();
  if (!activeGroup().members.includes(s.id)) activeGroup().members.push(s.id);
  return true;
}
function guessControl(s) {
  const n = s.name.toLowerCase();
  if (/unstain|blank|negative|^neg\b/.test(n)) { S.ctrl[s.id] = 'unstained'; return; }
  if (!/single|comp|control|ctrl|only|bead/.test(n)) return;
  const fl = spillChannels();
  const hit = fl.find(ch => { const base = ch.replace(/-[AHW]$/, '').toLowerCase(); return n.includes(base) || (S.stains[ch] && n.includes(S.stains[ch].toLowerCase())); });
  if (hit) S.ctrl[s.id] = hit;
}
async function addFiles(files) {
  let added = 0; const problems = [];
  const realToast = toast; toast = (m, err) => err ? problems.push(m) : null;
  for (const f of files) {
    try { const buf = await f.arrayBuffer(); if (addSample(Core.parseFCS(buf, f.name), new Uint8Array(buf))) added++; }
    catch (e) { problems.push(e.message || `Could not read ${f.name}.`); }
  }
  toast = realToast;
  if (added) { markDirty(); refreshAll(); }
  if (problems.length) toast((added ? `Added ${added} file${added > 1 ? 's' : ''}. ` : '') + problems.join(' '), true);
  else if (added) toast(`Added ${added} file${added > 1 ? 's' : ''}.`);
}
/* The demo is two donors run on different days plus the compensation controls. Donor B's cells sit
   well off donor A's on scatter, so the two donors need separate gating - which is what the groups
   are there to carry. */
function applyDemoGroups() {
  S.groups = Core.demoGroups().map(g => ({ ...g, members: g.members.map(i => S.samples[i]).filter(Boolean).map(s => s.id) }));
  S.activeGroup = S.groups[0].id;
}
function loadDemo() {
  resetState();
  Core.demoSet().forEach(fcs => addSample(fcs));
  applyDemoGroups();
  S.view.pop = 'root'; S.view.sel = null;
  invalidate({ comp: true }); refreshAll();
  toast('Demo loaded: two donors of 3 samples each, grouped, plus 5 compensation controls. Draw a gate and it applies to every sample in the active group.');
}
function loadWorkedExample() {
  resetState();
  Core.demoSet().forEach(fcs => addSample(fcs));
  applyDemoGroups();
  const a = Core.demoAnalysis();
  S.gates = a.gates.map(g => ({ ...g }));
  S.nextId = S.gates.length + 1;
  S.overrides = {};
  a.overrides.forEach(o => { const s = S.samples[o.sample]; if (s) S.overrides[s.id + ':' + o.gate] = { pts: o.pts }; });
  S.statSummary = true;
  S.view.pop = 'root'; S.view.sel = null; S.view.x = 'FSC-A'; S.view.y = 'SSC-A';
  invalidate({ comp: true }); refreshAll();
  toast('Worked example loaded. Donor A and Donor B each carry their own gating tree, and Donor B stimulated has one gate nudged because that file drifted.');
}

// ------------------------------------------------------------ plotting ---
const PAL = ['#1F3BB3', '#14A6C8', '#3DB54A', '#F1D30F', '#F08A0C', '#D7261E'];
const LUT = (() => {
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), c = PAL.map(hex), out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (c.length - 1), k = Math.min(Math.floor(t), c.length - 2), f = t - k;
    for (let j = 0; j < 3; j++) out[i * 3 + j] = Math.round(c[k][j] + (c[k + 1][j] - c[k][j]) * f);
  }
  return out;
})();
const OVERLAY_COLORS = ['#D8342C', '#0A9BD6', '#7A3FD1', '#E08A00', '#2E8B57', '#C2185B'];

/* Several samples in one dot plot: each series gets a flat colour, alpha-blended by local density
   so overlapping populations stay readable instead of the last one painting over the rest. */
function seriesImage(key, series, xr, yr, w, h, pt) {
  if (key && densityCache.has(key)) return densityCache.get(key);
  const bw = Math.max(1, Math.round(w / pt)), bh = Math.max(1, Math.round(h / pt));
  const rgba = new Uint8ClampedArray(bw * bh * 4);
  const sx = bw / (xr[1] - xr[0]), sy = bh / (yr[1] - yr[0]);
  series.forEach(S2 => {
    const counts = new Uint32Array(bw * bh); let max = 0;
    const xs = S2.xT, ys = S2.yT, ix = S2.idx;
    for (let q = 0; q < ix.length; q++) {
      const e = ix[q];
      let i = Math.floor((xs[e] - xr[0]) * sx), j = Math.floor((ys[e] - yr[0]) * sy);
      if (i < 0) i = 0; else if (i >= bw) i = bw - 1;
      if (j < 0) j = 0; else if (j >= bh) j = bh - 1;
      const c = ++counts[(bh - 1 - j) * bw + i]; if (c > max) max = c;
    }
    const lm = Math.log1p(max) || 1, [r, g, b] = [1, 3, 5].map(k => parseInt(S2.color.slice(k, k + 2), 16));
    for (let k = 0; k < counts.length; k++) {
      const c = counts[k]; if (!c) continue;
      const a = 0.3 + 0.65 * Math.log1p(c) / lm, o = k * 4, ia = rgba[o + 3] / 255;
      const na = a + ia * (1 - a);
      rgba[o] = (r * a + rgba[o] * ia * (1 - a)) / na;
      rgba[o + 1] = (g * a + rgba[o + 1] * ia * (1 - a)) / na;
      rgba[o + 2] = (b * a + rgba[o + 2] * ia * (1 - a)) / na;
      rgba[o + 3] = na * 255;
    }
  });
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
  cv.getContext('2d').putImageData(new ImageData(rgba, bw, bh), 0, 0);
  if (key) densityCache.set(key, cv);
  return cv;
}

function densityImage(key, xT, yT, idx, xr, yr, w, h, pt) {
  if (key && densityCache.has(key)) return densityCache.get(key);
  const bw = Math.max(1, Math.round(w / pt)), bh = Math.max(1, Math.round(h / pt));
  const counts = new Uint32Array(bw * bh); let max = 0;
  const sx = bw / (xr[1] - xr[0]), sy = bh / (yr[1] - yr[0]), n = idx.length;
  for (let q = 0; q < n; q++) {
    const e = idx[q];
    let i = Math.floor((xT[e] - xr[0]) * sx), j = Math.floor((yT[e] - yr[0]) * sy);
    if (i < 0) i = 0; else if (i >= bw) i = bw - 1;
    if (j < 0) j = 0; else if (j >= bh) j = bh - 1;
    const c = ++counts[(bh - 1 - j) * bw + i]; if (c > max) max = c;
  }
  const cv = document.createElement('canvas'); cv.width = bw; cv.height = bh;
  const ctx = cv.getContext('2d'), img = ctx.createImageData(bw, bh), d = img.data, lm = Math.log1p(max);
  for (let k = 0; k < counts.length; k++) {
    const c = counts[k]; if (!c) continue;
    const li = Math.min(255, Math.round(Math.log1p(c) / lm * 255)) * 3;
    d[k * 4] = LUT[li]; d[k * 4 + 1] = LUT[li + 1]; d[k * 4 + 2] = LUT[li + 2]; d[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  if (key) densityCache.set(key, cv);
  return cv;
}
function histogram(xT, idx, xr, bins = 220) {
  const c = new Float64Array(bins), s = bins / (xr[1] - xr[0]);
  for (let q = 0; q < idx.length; q++) { let i = Math.floor((xT[idx[q]] - xr[0]) * s); if (i < 0) i = 0; else if (i >= bins) i = bins - 1; c[i]++; }
  const k = [0.06, 0.24, 0.4, 0.24, 0.06], out = new Float64Array(bins);
  for (let i = 0; i < bins; i++) { let v = 0; for (let j = -2; j <= 2; j++) { const ii = Math.min(bins - 1, Math.max(0, i + j)); v += c[ii] * k[j + 2]; } out[i] = v; }
  return out;
}

/* spec: {xch, ych|null, xT, yT, idx, gates:[{gate,pct,selected}], draft, overlays:[{xT,idx,color}], title, small, pt, cacheKey} */
function drawPlot(cv, spec, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return paintPlot(ctx, spec, cssW, cssH);
}
/* Draws one plot into any 2D context (canvas or the SVG recorder) with its top-left at the current origin. */
function paintPlot(ctx, spec, cssW, cssH) {
  const sm = !!spec.small, fs = (sm ? 10.5 : 11.5) * (spec.fontScale || 1);
  const g = { ml: sm ? 50 : 66, mt: sm ? 28 : 30, mr: sm ? 10 : 16, mb: sm ? 40 : 50 };
  g.w = cssW - g.ml - g.mr; g.h = cssH - g.mt - g.mb;
  const xcfg = S.transforms[spec.xch], hist = !spec.ych, ycfg = hist ? null : S.transforms[spec.ych];
  const xr = xcfg.range, yr = hist ? [0, 1] : ycfg.range;
  g.xr = xr; g.yr = yr; g.hist = hist;
  g.tx = t => g.ml + (t - xr[0]) / (xr[1] - xr[0]) * g.w;
  g.ty = t => g.mt + g.h - (t - yr[0]) / (yr[1] - yr[0]) * g.h;
  g.fromPx = (px, py) => [xr[0] + (px - g.ml) / g.w * (xr[1] - xr[0]), yr[0] + (g.mt + g.h - py) / g.h * (yr[1] - yr[0])];
  if (!spec.transparent) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cssW, cssH); }
  ctx.font = `${fs}px ${FONT}`;

  // data
  ctx.save(); ctx.beginPath(); ctx.rect(g.ml, g.mt, g.w, g.h); ctx.clip();
  if (!hist) {
    const img = spec.series ? seriesImage(spec.cacheKey, spec.series, xr, yr, g.w, g.h, spec.pt || 2)
      : densityImage(spec.cacheKey, spec.xT, spec.yT, spec.idx, xr, yr, g.w, g.h, spec.pt || 2);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(img, g.ml, g.mt, g.w, g.h);
  } else {
    const curves = spec.curves || [{ xT: spec.xT, idx: spec.idx, color: '#16212A', fill: true }].concat(spec.overlays || []);
    const hs = curves.map(c => histogram(c.xT, c.idx, xr));
    const norm = curves.length > 1 ? hs.map(h => Math.max(...h) || 1) : hs.map(() => Math.max(...hs[0]) || 1);
    curves.forEach((c, k) => {
      const h = hs[k], n = h.length;
      ctx.beginPath(); ctx.moveTo(g.tx(xr[0]), g.ty(0));
      for (let i = 0; i < n; i++) ctx.lineTo(g.tx(xr[0] + (i + 0.5) / n * (xr[1] - xr[0])), g.ty(h[i] / norm[k] * 0.92));
      ctx.lineTo(g.tx(xr[1]), g.ty(0));
      if (c.fill) { ctx.fillStyle = 'rgba(10,115,184,.16)'; ctx.fill(); }
      ctx.strokeStyle = c.color; ctx.lineWidth = c.fill ? 1.4 : 1.8; ctx.stroke();
    });
  }
  ctx.restore();

  // frame + axes
  ctx.strokeStyle = '#C9D1CF'; ctx.lineWidth = 1; ctx.strokeRect(g.ml + .5, g.mt + .5, g.w - 1, g.h - 1);
  drawAxis(ctx, g, xcfg, 'x', fs);
  if (!hist) drawAxis(ctx, g, ycfg, 'y', fs);
  else { ctx.fillStyle = '#5A6670'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; [0, 0.5, 1].forEach(v => { const y = g.ty(v * 0.92); ctx.fillText(Math.round(v * 100) + '', g.ml - 8, y); ctx.fillRect(g.ml - 5, Math.round(y), 5, 1); }); }
  // titles
  ctx.fillStyle = '#16212A'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const xl = label(spec.xch); ctx.font = `600 ${fs + 1}px ${FONT}`;
  const xw = ctx.measureText(xl).width, xcy = cssH - (sm ? 8 : 11);
  ctx.fillText(xl, g.ml + g.w / 2 + 7, xcy);
  ctx.fillStyle = laserHex(spec.xch); ctx.beginPath(); ctx.arc(g.ml + g.w / 2 - xw / 2 - 3, xcy - 4, 4, 0, 7); ctx.fill();
  ctx.save(); ctx.translate(sm ? 11 : 14, g.mt + g.h / 2); ctx.rotate(-Math.PI / 2);
  const yl = hist ? '% of mode' : label(spec.ych), yw = ctx.measureText(yl).width;
  ctx.fillStyle = '#16212A'; ctx.textBaseline = 'middle'; ctx.fillText(yl, 7, 0);
  if (!hist) { ctx.fillStyle = laserHex(spec.ych); ctx.beginPath(); ctx.arc(-yw / 2 - 3, 0, 4, 0, 7); ctx.fill(); }
  ctx.restore();
  if (spec.title) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#16212A';
    ctx.font = `600 ${fs + 1.5}px ${FONT}`; ctx.fillText(spec.title, g.ml, g.mt - 10);
    if (spec.subtitle) { const tw = ctx.measureText(spec.title).width; ctx.font = `${fs}px ${FONT}`; ctx.fillStyle = '#5A6670'; ctx.fillText(spec.subtitle, g.ml + tw + 8, g.mt - 10); }
  }
  // gates
  ctx.save(); ctx.beginPath(); ctx.rect(g.ml - 1, g.mt - 1, g.w + 2, g.h + 2); ctx.clip();
  (spec.gates || []).forEach(o => drawGate(ctx, g, o.gate, spec.pct === false ? null : o.pct, o.selected, fs, spec.labels !== false, o.adjusted));
  if (spec.draft) drawDraft(ctx, g, spec.draft);
  ctx.restore();
  // legend goes last so gate labels can never sit on top of it
  if (spec.legendItems && spec.legendItems.length) drawPanelLegend(ctx, g, spec.legendItems, fs, spec.legendPos);
  return g;
}

function drawPanelLegend(ctx, g, items, fs, pos = 'tr') {
  const sz = fs * 0.92, lh = sz * 1.6, pad = 7;
  ctx.font = `400 ${sz}px ${FONT}`;
  const w = Math.max(...items.map(i => ctx.measureText(i.name).width)) + 30 + pad * 2;
  const h = items.length * lh + pad * 2 - (lh - sz) * 0.4;
  const x = pos[1] === 'l' ? g.ml + 6 : g.ml + g.w - w - 6;
  const y = pos[0] === 'b' ? g.mt + g.h - h - 6 : g.mt + 6;
  ctx.fillStyle = 'rgba(255,255,255,.86)'; roundRect(ctx, x, y, w, h, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(22,33,42,.18)'; ctx.lineWidth = 1; ctx.stroke();
  items.forEach((it, k) => {
    const cy = y + pad + k * lh + sz * 0.55;
    ctx.fillStyle = it.color; ctx.fillRect(x + pad, cy - 1.5, 16, 3);
    ctx.fillStyle = '#16212A'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(it.name, x + pad + 22, cy);
  });
}

function drawAxis(ctx, g, cfg, ax, fs) {
  const { major, minor } = Core.ticksFor(cfg);
  const pos = ax === 'x' ? g.tx : g.ty;
  ctx.fillStyle = '#8C979F';
  const drawn = [];
  const tick = (p, len) => { if (drawn.some(d => Math.abs(d - p) < 3)) return; drawn.push(p); if (ax === 'x') ctx.fillRect(p, g.mt + g.h, 1, len); else ctx.fillRect(g.ml - len, p, len, 1); };
  ctx.fillStyle = '#5A6670';
  const lin = cfg.type === 'linear';
  const pri = major.slice().sort((a, b) => lin ? 0 : (a.v === 0 ? -1 : b.v === 0 ? 1 : Math.abs(b.v) - Math.abs(a.v)));
  const kept = [], gap = ax === 'x' ? 30 : 16;
  pri.forEach(t => {
    const p = pos(t.y);
    if (!lin && Math.abs(t.v) > 0 && Math.abs(t.v) <= 10 && cfg.type !== 'log') return;
    if (kept.every(k => Math.abs(k - p) >= gap)) { kept.push(p); t.show = true; }
  });
  major.filter(t => t.show).forEach(t => tick(Math.round(pos(t.y)), 6));
  ctx.fillStyle = '#9AA4AA';
  major.filter(t => !t.show).forEach(t => tick(Math.round(pos(t.y)), 4));
  minor.forEach(t => tick(Math.round(pos(t.y)), 3));
  ctx.fillStyle = '#5A6670';
  major.forEach(t => {
    const p = Math.round(pos(t.y));
    if (!t.show) return;
    if (ax === 'x') { ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(t.label, p, g.mt + g.h + 8); }
    else { ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(t.label, g.ml - 9, p); }
  });
}

function shapeT(gate) {
  const fx = tfn(gate.x), fy = gate.y ? tfn(gate.y) : null;
  if (gate.type === 'interval') return gate.pts.map(p => [fx.f(p[0]), 0]);
  if (gate.type === 'quad') return [[fx.f(gate.pts[0][0]), fy.f(gate.pts[0][1])]];
  if (gate.type === 'ellipse') return Core.ellipsePoints(gate, fx, fy);
  if (gate.type === 'rect') { const [a, b] = gate.pts.map(p => [fx.f(p[0]), fy.f(p[1])]); return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; }
  return gate.pts.map(p => [fx.f(p[0]), fy.f(p[1])]);
}
function handlesT(gate) {
  const fx = tfn(gate.x), fy = gate.y ? tfn(gate.y) : null;
  if (gate.type === 'rect' || gate.type === 'quad') return shapeT(gate);
  if (gate.type === 'interval') return gate.pts.map(p => [fx.f(p[0]), null]);
  return gate.pts.map(p => [fx.f(p[0]), fy.f(p[1])]);
}
/* The four arms of a quadrant share one centre. When a single sample is being adjusted the
   override objects move together; otherwise the group's own gates do. */
function quadTargets(gate) {
  const arms = S.gates.filter(q => q.quadGroup === gate.quadGroup);
  if (!gate._ov) return arms;
  const s = S.samples.find(x => x.id === gate._ov);
  return arms.map(q => editTarget(s, q));
}
function setHandle(gate, h, t) {
  const fx = tfn(gate.x), fy = gate.y ? tfn(gate.y) : null;
  const rx = fx.inv(t[0]), ry = fy ? fy.inv(t[1]) : 0;
  if (gate.type === 'rect') {
    const P = gate.pts;
    if (h === 0) P[0] = [rx, ry]; else if (h === 2) P[1] = [rx, ry];
    else if (h === 1) { P[1][0] = rx; P[0][1] = ry; } else { P[0][0] = rx; P[1][1] = ry; }
  } else if (gate.type === 'interval') gate.pts[h] = [rx, 0];
  else if (gate.type === 'quad') quadTargets(gate).forEach(q => { q.pts = [[rx, ry]]; });
  else if (gate.type === 'ellipse' && h === 0) { // moving centre drags the whole ellipse
    const c = [fx.f(gate.pts[0][0]), fy.f(gate.pts[0][1])], d = [t[0] - c[0], t[1] - c[1]];
    gate.pts = gate.pts.map(p => [fx.inv(fx.f(p[0]) + d[0]), fy.inv(fy.f(p[1]) + d[1])]);
  } else gate.pts[h] = [rx, ry];
}
function moveGate(gate, orig, d) {
  const fx = tfn(gate.x), fy = gate.y ? tfn(gate.y) : null;
  const mv = pts => pts.map(p => [fx.inv(fx.f(p[0]) + d[0]), fy ? fy.inv(fy.f(p[1]) + d[1]) : 0]);
  if (gate.type === 'quad') { const np = mv(orig); quadTargets(gate).forEach(q => { q.pts = np.map(p => p.slice()); }); }
  else gate.pts = mv(orig);
}
function labelPos(gate, g) {
  if (gate.type === 'quad') {
    const q = gate.quadrant, pad = 8;
    return { x: q[0] === '+' ? g.ml + g.w - pad : g.ml + pad, y: q[1] === '+' ? g.mt + pad + 8 : g.mt + g.h - pad - 8, align: q[0] === '+' ? 'right' : 'left' };
  }
  const s = shapeT(gate);
  if (gate.type === 'interval') return { x: g.tx((s[0][0] + s[1][0]) / 2), y: g.mt + 16, align: 'center' };
  let top = Infinity, cx = 0; s.forEach(p => { cx += p[0]; top = Math.min(top, g.ty(p[1])); });
  let yy = 0; s.forEach(p => { yy = Math.max(yy, p[1]); });
  const y = g.ty(yy) - 11;
  return { x: g.tx(cx / s.length), y: y < g.mt + 12 ? g.ty(s.reduce((a, p) => a + p[1], 0) / s.length) : y, align: 'center' };
}
function drawGate(ctx, g, gate, pct, selected, fs, showLabel = true, adjusted = false) {
  const s = shapeT(gate);
  ctx.lineWidth = selected ? 2.2 : 1.6; ctx.strokeStyle = selected ? '#0A73B8' : '#16212A';
  ctx.beginPath();
  if (gate.type === 'interval') {
    const a = g.tx(s[0][0]), b = g.tx(s[1][0]), y = g.mt + 26;
    ctx.moveTo(a, g.mt + g.h); ctx.lineTo(a, y); ctx.lineTo(b, y); ctx.lineTo(b, g.mt + g.h);
    ctx.stroke();
  } else if (gate.type === 'quad') {
    const x = g.tx(s[0][0]), y = g.ty(s[0][1]);
    ctx.moveTo(x, g.mt); ctx.lineTo(x, g.mt + g.h); ctx.moveTo(g.ml, y); ctx.lineTo(g.ml + g.w, y); ctx.stroke();
  } else {
    s.forEach((p, i) => i ? ctx.lineTo(g.tx(p[0]), g.ty(p[1])) : ctx.moveTo(g.tx(p[0]), g.ty(p[1])));
    ctx.closePath(); ctx.stroke();
    if (selected) { ctx.fillStyle = 'rgba(10,115,184,.07)'; ctx.fill(); }
  }
  if (showLabel) drawGateLabel(ctx, g, gate, pct, selected, fs, adjusted);
  if (selected) {
    handlesT(gate).forEach(p => {
      const x = g.tx(p[0]), y = p[1] == null ? g.mt + 26 : g.ty(p[1]);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0A73B8'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fill(); ctx.stroke();
    });
  }
}
function drawGateLabel(ctx, g, gate, pct, selected, fs, adjusted = false) {
  const lp = labelPos(gate, g);
  const txt = `${gate.name}${adjusted ? ' \u2022' : ''}${pct != null && isFinite(pct) ? '  ' + fmtPct(pct) : ''}`;
  ctx.font = `600 ${fs}px ${FONT}`;
  const w = ctx.measureText(txt).width + 12, h = fs + 8;
  let x0 = lp.align === 'center' ? lp.x - w / 2 : lp.align === 'right' ? lp.x - w : lp.x;
  x0 = Math.max(g.ml + 2, Math.min(g.ml + g.w - w - 2, x0));
  const y0 = Math.max(g.mt + 2, Math.min(g.mt + g.h - h - 2, lp.y - h / 2));
  ctx.fillStyle = selected ? 'rgba(10,115,184,.94)' : 'rgba(255,255,255,.9)';
  roundRect(ctx, x0, y0, w, h, 5); ctx.fill();
  if (!selected) { ctx.strokeStyle = 'rgba(22,33,42,.25)'; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.fillStyle = selected ? '#fff' : '#16212A'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, x0 + 6, y0 + h / 2 + 0.5);
}
function drawDraft(ctx, g, d) {
  ctx.strokeStyle = '#0A73B8'; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  if (d.type === 'rect') { const [a, b] = d.pts; ctx.rect(g.tx(a[0]), g.ty(a[1]), g.tx(b[0]) - g.tx(a[0]), g.ty(b[1]) - g.ty(a[1])); }
  else if (d.type === 'interval') { const a = g.tx(d.pts[0][0]), b = g.tx(d.pts[1][0]); ctx.moveTo(a, g.mt + g.h); ctx.lineTo(a, g.mt + 26); ctx.lineTo(b, g.mt + 26); ctx.lineTo(b, g.mt + g.h); }
  else if (d.type === 'ellipse') {
    const c = d.pts[0], a = d.pts[1], b = d.pts[2];
    for (let k = 0; k <= 72; k++) { const t = 2 * Math.PI * k / 72, x = c[0] + (a[0] - c[0]) * Math.cos(t) + (b[0] - c[0]) * Math.sin(t), y = c[1] + (a[1] - c[1]) * Math.cos(t) + (b[1] - c[1]) * Math.sin(t); k ? ctx.lineTo(g.tx(x), g.ty(y)) : ctx.moveTo(g.tx(x), g.ty(y)); }
  } else if (d.type === 'poly') {
    d.pts.forEach((p, i) => i ? ctx.lineTo(g.tx(p[0]), g.ty(p[1])) : ctx.moveTo(g.tx(p[0]), g.ty(p[1])));
    if (d.hover) ctx.lineTo(g.tx(d.hover[0]), g.ty(d.hover[1]));
  }
  ctx.stroke(); ctx.setLineDash([]);
  if (d.type === 'poly') d.pts.forEach((p, i) => { ctx.fillStyle = i ? '#0A73B8' : '#fff'; ctx.strokeStyle = '#0A73B8'; ctx.beginPath(); ctx.arc(g.tx(p[0]), g.ty(p[1]), i ? 3 : 5, 0, 7); ctx.fill(); ctx.stroke(); });
}
function roundRect(ctx, x, y, w, h, r) {
  const P = Math.PI; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -P / 2, 0);
  ctx.lineTo(x + w, y + h - r); ctx.arc(x + w - r, y + h - r, r, 0, P / 2); ctx.lineTo(x + r, y + h); ctx.arc(x + r, y + h - r, r, P / 2, P);
  ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, P, 1.5 * P); ctx.closePath();
}
const fmtPct = p => (p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toPrecision(2)) + '%';
const fmtNum = v => { const a = Math.abs(v); if (!isFinite(v)) return '–'; if (a >= 1e4) return v.toExponential(2).replace('e+', '×10^'); if (a >= 100) return v.toFixed(0); if (a >= 1) return v.toFixed(2); return v.toPrecision(3); };
const fmtInt = n => n.toLocaleString('en-US');
const fmtStat = v => !isFinite(v) ? '–' : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2);

// ------------------------------------------------------------ gate tab ---
const cv = $('#plot');
let G = null, drag = null, draft = null, hoverT = null, pendingName = false;

function plotGates() {
  const v = S.view, hist = !v.y;
  return S.gates.filter(g => g.group === S.activeGroup && g.parent === v.pop && g.x === v.x && (hist ? g.type === 'interval' : (g.type !== 'interval' && g.y === v.y)));
}
function plotSize() {
  const box = $('#plotBox'), w = box.clientWidth, h = Math.max(360, window.innerHeight - box.getBoundingClientRect().top - 40);
  const sz = Math.max(320, Math.min(w, h, 720));
  return [sz, sz];
}
function renderPlot() {
  const s = activeSample(); if (!s) return;
  const v = S.view, [w, h] = plotSize();
  const pop = getPop(s, v.pop), parentN = pop.length;
  const gates = plotGates().map(g => ({ gate: effGate(s, g), pct: parentN ? getPop(s, g.id).length / parentN * 100 : 0, selected: v.sel === g.id, adjusted: hasOverride(s, g) }));
  const overlays = !v.y ? [...S.overlays].map((id, k) => { const o = S.samples.find(x => x.id === id); return o && o !== s ? { xT: getT(o, v.x), idx: getPop(o, v.pop), color: OVERLAY_COLORS[k % OVERLAY_COLORS.length] } : null; }).filter(Boolean) : [];
  G = drawPlot(cv, {
    xch: v.x, ych: v.y || null, xT: getT(s, v.x), yT: v.y ? getT(s, v.y) : null, idx: pop, gates, draft, overlays, pt: v.pt,
    title: popName(v.pop), subtitle: `${fmtInt(parentN)} events`,
    cacheKey: `${s.id}|${S.activeGroup}|${v.pop}|${v.x}|${v.y}|${w}|${h}|${v.pt}|${S.version}`
  }, w, h);
  renderStatus();
}
function renderStatus() {
  const s = activeSample(); if (!s) return;
  const parts = [el('span', {}, 'Sample ', el('b', {}, s.name))];
  if (!inActiveGroup(s)) parts.push(el('span', { class: 'warn' }, `not in ${activeGroup().name} — showing that group's gates anyway`));
  if (hoverT && G) {
    const fx = tfn(S.view.x); parts.push(el('span', {}, `${short(S.view.x)} `, el('b', {}, fmtNum(fx.inv(hoverT[0])))));
    if (S.view.y) parts.push(el('span', {}, `${short(S.view.y)} `, el('b', {}, fmtNum(tfn(S.view.y).inv(hoverT[1])))));
  } else parts.push(el('span', {}, S.view.tool === 'poly' && draft ? 'Click to add points. Double-click or press Enter to close the polygon.' : ''));
  $('#status').replaceChildren(...parts, el('button', { class: 'linkbtn', onclick: savePlotPng }, 'Save plot as PNG'));
}
function renderToolbar() {
  const mk = (sel, val, withHist) => {
    const opts = (withHist ? [el('option', { value: '' }, 'Histogram')] : []).concat(S.channels.map(c => el('option', { value: c }, label(c))));
    sel.replaceChildren(...opts); sel.value = val || '';
  };
  mk($('#selX'), S.view.x, false); mk($('#selY'), S.view.y, true);
  const hist = !S.view.y;
  document.querySelectorAll('#tools button').forEach(b => {
    const t = b.dataset.tool;
    b.disabled = hist ? ['rect', 'poly', 'ellipse', 'quad'].includes(t) : t === 'interval';
    if (b.disabled && S.view.tool === t) S.view.tool = 'pointer';
    b.setAttribute('aria-pressed', S.view.tool === t);
  });
  cv.style.cursor = S.view.tool === 'pointer' ? 'default' : 'crosshair';
}
function renderInspector() {
  const box = $('#axisInsp'); box.replaceChildren(el('h2', {}, 'Axes'));
  [S.view.x, S.view.y].filter(Boolean).forEach(ch => box.append(...axisControls(ch)));
  // gate list
  const s = activeSample(), list = $('#gateList'); list.replaceChildren();
  const gs = plotGates(), parentN = s ? getPop(s, S.view.pop).length : 0;
  gs.forEach(g => list.append(el('li', { class: S.view.sel === g.id ? 'on' : '', onclick: () => { S.view.sel = g.id; setTool('pointer'); renderGateTab(); } },
    el('span', { class: 'gname' }, g.name), el('span', { class: 'scount' }, parentN ? fmtPct(getPop(s, g.id).length / parentN * 100) : ''))));
  $('#gateHint').classList.toggle('hidden', gs.length > 0);
  const sel = gateById(S.view.sel), btns = $('#gateBtns'); btns.replaceChildren();
  const scope = $('#scopeBox'); if (scope) scope.replaceChildren(...[sel && gs.includes(sel) ? editScopeControl() : null].filter(Boolean));
  if (sel && gs.includes(sel)) {
    btns.append(el('button', { class: 'btn', onclick: () => { S.view.pop = sel.id; S.view.sel = null; renderGateTab(); renderTree(); } }, 'Plot this population'),
      el('button', { class: 'btn', onclick: e => renameGate(sel, e.target) }, 'Rename'),
      el('button', { class: 'btn danger', onclick: () => deleteGate(sel.id) }, 'Delete'));
  }
  // overlays
  const ov = $('#overlaySec'); ov.classList.toggle('hidden', !!S.view.y || S.samples.length < 2);
  if (!S.view.y) {
    const others = S.samples.filter(x => x !== s);
    let k = 0;
    $('#overlayList').replaceChildren(el('div', { class: 'chk' }, el('input', { type: 'checkbox', checked: true, disabled: true, 'aria-label': 'Active sample' }), el('span', { class: 'swatch', style: 'background:#16212A' }), s.name + ' (active)'), ...others.map(o => {
      const on = S.overlays.has(o.id), color = on ? OVERLAY_COLORS[[...S.overlays].indexOf(o.id) % OVERLAY_COLORS.length] : 'transparent'; k++;
      return el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: on, onchange: e => { e.target.checked ? S.overlays.add(o.id) : S.overlays.delete(o.id); renderGateTab(); } }), el('span', { class: 'swatch', style: `background:${color}` }), o.name);
    }));
  }
}
function axisControls(ch) {
  const cfg = S.transforms[ch], out = [];
  out.push(el('div', { class: 'axhead' }, el('span', { class: 'laser', style: `background:${laser(ch)}` }), label(ch)));
  const typeSel = el('select', { id: 'tt-' + ch, onchange: e => setTransformType(ch, e.target.value) },
    ...[['linear', 'Linear'], ['log', 'Log'], ['arcsinh', 'Arcsinh'], ['logicle', 'Logicle']].map(([v, t]) => el('option', { value: v, selected: cfg.type === v }, t)));
  out.push(el('div', { class: 'field' }, el('label', { for: 'tt-' + ch }, 'Transform'), typeSel));
  const num = (lab, key, step, min, max, fn) => {
    const id = `tp-${key}-${ch}`;
    return el('div', { class: 'field' }, el('label', { for: id }, lab), el('input', { id, type: 'number', step, min, max, value: +(+fn.get()).toPrecision(6), onchange: e => { const v = parseFloat(e.target.value); if (isFinite(v)) { fn.set(v); commitTransform(ch); } } }));
  };
  if (cfg.type === 'logicle') {
    out.push(num('Width (W)', 'W', 0.05, 0, 2.2, { get: () => cfg.W, set: v => { cfg.W = Math.max(0, Math.min(v, cfg.M / 2 - 0.01)); } }));
    out.push(num('Decades (M)', 'M', 0.1, 2, 7, { get: () => cfg.M, set: v => { cfg.M = v; } }));
    out.push(num('Top (T)', 'T', 1000, 100, 1e9, { get: () => cfg.T, set: v => { cfg.T = v; } }));
  } else if (cfg.type === 'arcsinh') {
    out.push(num('Cofactor', 'c', 5, 0.1, 1e5, { get: () => cfg.cofactor, set: v => { const top = Math.sinh(cfg.range[1]) * cfg.cofactor, bot = Math.sinh(cfg.range[0]) * cfg.cofactor; cfg.cofactor = v; cfg.range = [Math.asinh(bot / v), Math.asinh(top / v)]; } }));
  } else if (cfg.type === 'linear') {
    out.push(num('Minimum', 'lo', 1000, -1e9, 1e9, { get: () => cfg.range[0], set: v => { if (v < cfg.range[1]) cfg.range[0] = v; } }));
    out.push(num('Maximum', 'hi', 1000, -1e9, 1e9, { get: () => cfg.range[1], set: v => { if (v > cfg.range[0]) cfg.range[1] = v; } }));
  } else if (cfg.type === 'log') {
    out.push(num('From decade', 'lo', 1, -2, 9, { get: () => cfg.range[0], set: v => { if (v < cfg.range[1]) cfg.range[0] = v; } }));
    out.push(num('To decade', 'hi', 0.1, -2, 10, { get: () => cfg.range[1], set: v => { if (v > cfg.range[0]) cfg.range[1] = v; } }));
  }
  out.push(el('div', { class: 'minibtns' },
    el('button', { class: 'btn', onclick: () => setTransformType(ch, cfg.type) }, 'Re-estimate'),
    isFluor(ch) ? el('button', { class: 'btn', title: 'Use this transform for every fluorescence channel', onclick: () => applyToAllFluor(ch) }, 'Use for all markers') : null));
  return out;
}
function setTransformType(ch, type) {
  const s = activeSample();
  S.transforms[ch] = Core.buildTransform(type, ch, getRaw(s, ch), S.ranges[ch], type === S.transforms[ch].type && type === 'arcsinh' ? { cofactor: S.transforms[ch].cofactor } : {});
  commitTransform(ch);
}
function applyToAllFluor(ch) {
  const src = S.transforms[ch], s = activeSample();
  S.channels.filter(isFluor).forEach(c => {
    if (c === ch) return;
    S.transforms[c] = src.type === 'logicle' ? Core.buildTransform('logicle', c, getRaw(s, c), S.ranges[c], { M: src.M }) : Core.buildTransform(src.type, c, getRaw(s, c), S.ranges[c], { cofactor: src.cofactor });
    invalidate({ channel: c });
  });
  commitTransform(ch); toast(`Applied ${src.type} to all marker channels.`);
}
function commitTransform(ch) {
  markDirty();
  const c = S.transforms[ch];
  if (c.type === 'logicle') { const s = activeSample(); S.transforms[ch] = Core.logicleCfg(getRaw(s, ch), c.T, c.M, c.W, c.A || 0); }
  invalidate({ channel: ch }); renderGateTab(); renderTree();
}

function renderGateTab() { renderToolbar(); renderPlot(); renderInspector(); }
function setTool(t) { S.view.tool = t; draft = null; renderToolbar(); renderPlot(); }

// ---------- canvas interaction
const evPos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function snap(t, r) { const span = r[1] - r[0]; if (t > r[1] - 0.012 * span) return r[1] + 0.004 * span; if (t < r[0] + 0.012 * span) return r[0] - 0.004 * span; return t; }
const snapT = t => [snap(t[0], G.xr), G.hist ? 0 : snap(t[1], G.yr)];
function hitHandle(px, py) {
  const sel = gateById(S.view.sel); if (!sel || !plotGates().includes(sel)) return -1;
  const hs = handlesT(effGate(activeSample(), sel));
  for (let i = 0; i < hs.length; i++) { const x = G.tx(hs[i][0]), y = hs[i][1] == null ? G.mt + 26 : G.ty(hs[i][1]); if (Math.abs(x - px) < 8 && Math.abs(y - py) < 8) return i; }
  return -1;
}
function hitGate(t) {
  const sm = activeSample(), gs = plotGates().slice().reverse();
  for (const base of gs) {
    const g = effGate(sm, base), s = shapeT(g);
    if (g.type === 'interval') { const a = Math.min(s[0][0], s[1][0]), b = Math.max(s[0][0], s[1][0]); if (t[0] >= a && t[0] <= b) return base; }
    else if (g.type === 'quad') { const q = (t[0] > s[0][0] ? '+' : '-') + (t[1] > s[0][1] ? '+' : '-'); if (g.quadrant === q) return base; }
    else if (Core.pointInPoly(t[0], t[1], s.map(p => p[0]), s.map(p => p[1]))) return base;
  }
  return null;
}
cv.addEventListener('pointerdown', e => {
  if (!G || pendingName) return;
  const [px, py] = evPos(e), t = G.fromPx(px, py), tool = S.view.tool;
  cv.setPointerCapture(e.pointerId);
  if (tool === 'pointer') {
    const sm = activeSample();
    const h = hitHandle(px, py);
    if (h >= 0) { drag = { mode: 'handle', h, gate: editTarget(sm, gateById(S.view.sel)) }; return; }
    const g = hitGate(t);
    S.view.sel = g ? g.id : null;
    if (g) { const tgt = editTarget(sm, g); drag = { mode: 'move', gate: tgt, start: t, orig: tgt.pts.map(p => p.slice()), moved: false }; }
    renderPlot(); renderInspector(); return;
  }
  const st = snapT(t);
  if (tool === 'rect') draft = { type: 'rect', pts: [st, st.slice()] }, drag = { mode: 'draw' };
  else if (tool === 'interval') draft = { type: 'interval', pts: [st, st.slice()] }, drag = { mode: 'draw' };
  else if (tool === 'ellipse') draft = { type: 'ellipse', pts: [t, t.slice(), t.slice()] }, drag = { mode: 'draw' };
  else if (tool === 'quad') { createQuad(t); return; }
  else if (tool === 'poly') {
    if (!draft) draft = { type: 'poly', pts: [] };
    const f = draft.pts[0];
    if (f && draft.pts.length >= 3 && Math.hypot(G.tx(f[0]) - px, G.ty(f[1]) - py) < 9) { finishPoly(); return; }
    draft.pts.push(st);
  }
  renderPlot();
});
cv.addEventListener('pointermove', e => {
  if (!G) return;
  const [px, py] = evPos(e), t = G.fromPx(px, py);
  const inside = px >= G.ml && px <= G.ml + G.w && py >= G.mt && py <= G.mt + G.h;
  hoverT = inside ? t : null;
  if (drag && drag.mode === 'draw' && draft) {
    if (draft.type === 'ellipse') { const c = draft.pts[0]; draft.pts[1] = [t[0], c[1]]; draft.pts[2] = [c[0], t[1]]; }
    else draft.pts[1] = snapT(t);
    renderPlot(); return;
  }
  if (drag && drag.mode === 'handle') { setHandle(drag.gate, drag.h, G.hist ? [snap(t[0], G.xr), 0] : (drag.gate.type === 'ellipse' ? t : snapT(t))); invalidateGates(); renderPlot(); return; }
  if (drag && drag.mode === 'move') {
    const d = [t[0] - drag.start[0], G.hist ? 0 : t[1] - drag.start[1]];
    if (Math.abs(d[0]) + Math.abs(d[1]) > 0) { drag.moved = true; moveGate(drag.gate, drag.orig, d); invalidateGates(); renderPlot(); }
    return;
  }
  if (draft && draft.type === 'poly') { draft.hover = snapT(t); renderPlot(); return; }
  if (S.view.tool === 'pointer') cv.style.cursor = hitHandle(px, py) >= 0 ? 'grab' : (hitGate(t) && S.view.sel ? 'move' : 'default');
  renderStatus();
});
cv.addEventListener('pointerleave', () => { hoverT = null; renderStatus(); });
cv.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'draw' && draft) {
    const a = draft.pts[0], b = draft.pts[1] || a;
    const small = draft.type === 'ellipse' ? (Math.abs(G.tx(draft.pts[1][0]) - G.tx(a[0])) < 4 || Math.abs(G.ty(draft.pts[2][1]) - G.ty(a[1])) < 4)
      : (Math.abs(G.tx(b[0]) - G.tx(a[0])) < 4 || (!G.hist && Math.abs(G.ty(b[1]) - G.ty(a[1])) < 4));
    if (small) { draft = null; renderPlot(); return; }
    proposeGate(draft);
  } else if (d.mode === 'handle' || (d.mode === 'move' && d.moved)) { afterGateEdit(); }
});
cv.addEventListener('dblclick', () => { if (draft && draft.type === 'poly') { draft.pts.pop(); finishPoly(); } });
function finishPoly() {
  if (!draft || draft.pts.length < 3) { toast('A polygon needs at least three points.', true); return; }
  delete draft.hover; proposeGate(draft);
}
function invalidateGates() { markDirty(); S.version++; densityCache.clear(); S.samples.forEach(s => s._pops.clear()); }
function afterGateEdit() { invalidateGates(); renderGateTab(); renderTree(); }

function suggestName(d) {
  const x = S.view.x, y = S.view.y;
  if (d.type === 'interval') return `${short(x)}+`;
  if (isScatter(x) && isScatter(y)) {
    const bx = x.replace(/-[AHW]$/i, ''), by = y.replace(/-[AHW]$/i, '');
    if (bx === by) return 'Single cells';
    return S.view.pop === 'root' ? 'Cells' : 'Population ' + (S.gates.length + 1);
  }
  if (isFluor(x) && !isFluor(y)) return `${short(x)}+`;
  if (isFluor(y) && !isFluor(x)) return `${short(y)}+`;
  if (/live|dead|viab|zombie|7-?aad|dapi/i.test(short(x) + short(y))) return 'Live cells';
  return 'Population ' + (S.gates.length + 1);
}
function proposeGate(d) {
  const fx = tfn(S.view.x), fy = S.view.y ? tfn(S.view.y) : null;
  let pts;
  if (d.type === 'interval') pts = d.pts.map(p => [fx.inv(p[0]), 0]);
  else pts = d.pts.map(p => [fx.inv(p[0]), fy.inv(p[1])]);
  const gate = { id: 'g' + (S.nextId++), group: S.activeGroup, name: '', parent: S.view.pop, type: d.type, x: S.view.x, y: d.type === 'interval' ? null : S.view.y, pts };
  const r = cv.getBoundingClientRect();
  askName({ left: r.left + r.width / 2 - 125, top: r.top + 60 }, 'Name this population', suggestName(d), name => {
    draft = null;
    if (name == null) { renderPlot(); return; }
    gate.name = name || suggestName(d); S.gates.push(gate); S.view.sel = gate.id;
    afterGateEdit();
  });
}
function createQuad(t) {
  const fx = tfn(S.view.x), fy = tfn(S.view.y), raw = [fx.inv(t[0]), fy.inv(t[1])], grp = 'q' + S.nextId;
  const nx = short(S.view.x), ny = short(S.view.y);
  [['-+', `${nx}− ${ny}+`], ['++', `${nx}+ ${ny}+`], ['+-', `${nx}+ ${ny}−`], ['--', `${nx}− ${ny}−`]].forEach(([q, name]) => {
    S.gates.push({ id: 'g' + (S.nextId++), group: S.activeGroup, name, parent: S.view.pop, type: 'quad', quadrant: q, quadGroup: grp, x: S.view.x, y: S.view.y, pts: [raw.slice()] });
  });
  S.view.sel = null; setTool('pointer'); afterGateEdit();
}
function askName(pos, title, def, cb) {
  pendingName = true;
  const input = el('input', { type: 'text', value: def, 'aria-label': title });
  const close = v => { pop.remove(); pendingName = false; cb(v); };
  const pop = el('div', { class: 'pop', style: `position:fixed;left:${Math.max(8, pos.left)}px;top:${Math.max(8, pos.top)}px` },
    el('label', {}, title), input,
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(input.value.trim()) }, 'Save')));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') close(input.value.trim()); if (e.key === 'Escape') close(null); e.stopPropagation(); });
  document.body.append(pop); input.focus(); input.select();
}
function renameGate(g, anchor) {
  const r = anchor.getBoundingClientRect();
  askName({ left: r.left, top: r.bottom + 6 }, 'Rename population', g.name, v => { if (v) { g.name = v; renderAll(); } });
}
function deleteGate(id) {
  const g = gateById(id); if (!g) return;
  const kill = [id, ...descendants(id)];
  if (kill.length > 1 && !confirm(`Delete "${g.name}" and ${kill.length - 1} population${kill.length > 2 ? 's' : ''} inside it?`)) return;
  S.gates = S.gates.filter(x => !kill.includes(x.id));
  Object.keys(S.overrides).forEach(k => { if (kill.includes(k.split(':')[1])) delete S.overrides[k]; });
  if (kill.includes(S.view.pop)) S.view.pop = g.parent;
  if (kill.includes(S.view.sel)) S.view.sel = null;
  invalidateGates(); renderAll();
}

// ------------------------------------------------------------ sidebar ---
function renderSamples() {
  const ul = $('#sampleList'); ul.replaceChildren();
  $('#sampleHint').classList.toggle('hidden', S.samples.length > 0);
  S.samples.forEach((s, i) => {
    const ctrl = S.ctrl[s.id];
    const ag = activeGroup(), mine = groupsOf(s), nOv = sampleOverrides(s);
    ul.append(el('li', { class: (i === S.active ? 'on' : '') + (ag && !ag.members.includes(s.id) ? ' outside' : ''), title: s.fcs.fileName, onclick: () => { S.active = i; S.overlays.delete(s.id); renderAll(); }, ondblclick: e => askName({ left: e.clientX, top: e.clientY }, 'Rename sample', s.name, v => { if (v) { s.name = v; renderAll(); } }) },
      ag ? el('input', { type: 'checkbox', class: 'memchk', checked: ag.members.includes(s.id), title: `In ${ag.name}`, 'aria-label': `${s.name} in ${ag.name}`, onclick: e => e.stopPropagation(), onchange: e => toggleMember(ag, s.id, e.target.checked) }) : null,
      el('span', { class: 'sname' }, s.name),
      mine.length ? el('span', { class: 'chips', title: mine.map(g => g.name).join(', ') }, ...mine.slice(0, 4).map(g => el('span', { class: 'gdot', style: `background:${g.color}` }))) : null,
      nOv ? el('span', { class: 'ovdot', title: `${nOv} gate${nOv === 1 ? '' : 's'} adjusted for this sample` }, '\u2022') : null,
      el('span', { class: 'scount' }, ctrl ? (ctrl === 'unstained' ? 'unstained' : 'control') : fmtInt(s.fcs.N)),
      el('button', { class: 'iconbtn', 'aria-label': `Remove ${s.name}`, title: 'Remove sample', onclick: e => { e.stopPropagation(); removeSample(i); } }, '×')));
  });
}
function removeSample(i) {
  const s = S.samples[i]; S.samples.splice(i, 1); S.overlays.delete(s.id); delete S.ctrl[s.id];
  S.groups.forEach(g => { const k = g.members.indexOf(s.id); if (k >= 0) g.members.splice(k, 1); });
  Object.keys(S.overrides).forEach(k => { if (k.startsWith(s.id + ':')) delete S.overrides[k]; });
  if (S.active >= S.samples.length) S.active = S.samples.length - 1;
  if (!S.samples.length) { Object.assign(S, { channels: [], transforms: {}, tfns: {}, spill: null, fileSpill: null, compOn: false, gates: [], active: -1, groups: [], activeGroup: null, overrides: {} }); S.view.pop = 'root'; }
  densityCache.clear(); refreshAll();
}
function renderTree() {
  const ul = $('#popTree'); ul.replaceChildren(); const s = activeSample(); if (!s) return;
  dfs().forEach(({ id, depth }) => {
    const g = gateById(id), n = getPop(s, id).length, pn = g ? getPop(s, g.parent).length : n;
    const li = el('li', { class: S.view.pop === id ? 'on' : '', style: `padding-left:${8 + depth * 14}px`, title: id === 'root' ? '' : `${label(g.x)}${g.y ? ' vs ' + label(g.y) : ''}`, onclick: () => { S.view.pop = id; S.view.sel = null; if (S.tab !== 'gate') switchTab('gate'); else renderGateTab(); renderTree(); } },
      depth ? el('span', { class: 'guide', 'aria-hidden': 'true' }, '└') : null,
      el('span', { class: 'pname' }, popName(id)),
      el('span', { class: 'pct' }, id === 'root' ? fmtInt(n) : (pn ? fmtPct(n / pn * 100) : '–')));
    if (g) {
      const nAdj = groupMembers(activeGroup()).filter(m => hasOverride(m, g)).length;
      if (nAdj) li.append(el('span', { class: 'ovdot', title: `${nAdj} sample${nAdj === 1 ? '' : 's'} adjusted` }, '\u2022'));
    }
    if (g) li.append(el('span', { class: 'acts' },
      el('button', { class: 'iconbtn', title: 'Show where this gate was drawn', 'aria-label': `Show gate ${g.name}`, onclick: e => { e.stopPropagation(); S.view.pop = g.parent; S.view.x = g.x; S.view.y = g.y || ''; S.view.sel = g.id; setTool('pointer'); switchTab('gate'); renderTree(); } }, '◎'),
      el('button', { class: 'iconbtn', title: 'Rename', 'aria-label': `Rename ${g.name}`, onclick: e => { e.stopPropagation(); renameGate(g, e.currentTarget); } }, '✎'),
      el('button', { class: 'iconbtn', title: 'Delete', 'aria-label': `Delete ${g.name}`, onclick: e => { e.stopPropagation(); deleteGate(g.id); } }, '×')));
    ul.append(li);
  });
}

// ------------------------------------------------------------ scheme tab ---
function renderScheme() {
  const s = activeSample(), grid = $('#schemeGrid'); grid.replaceChildren(); if (!s) return;
  const groups = [];
  dfs().forEach(({ id }) => {
    const m = new Map();
    children(id).forEach(g => { const k = g.x + '|' + (g.y || ''); if (!m.has(k)) m.set(k, []); m.get(k).push(g); });
    m.forEach(gs => groups.push({ parent: id, gates: gs }));
  });
  $('#schemeLead').textContent = groups.length
    ? `Every gate in ${activeGroup().name} for ${s.name}, drawn on its parent population. Percentages are of the parent.`
    : `No gates in ${activeGroup() ? activeGroup().name : 'this group'} yet. Draw gates on the Gate tab and the full strategy will appear here.`;
  groups.forEach(gr => {
    const c = el('canvas'); grid.append(c);
    const g0 = gr.gates[0], pop = getPop(s, gr.parent), pn = pop.length;
    const w = Math.max(280, Math.min(380, c.clientWidth || 300));
    drawPlot(c, {
      xch: g0.x, ych: g0.y, xT: getT(s, g0.x), yT: g0.y ? getT(s, g0.y) : null, idx: pop, small: true, pt: 2,
      gates: gr.gates.map(g => ({ gate: g, pct: pn ? getPop(s, g.id).length / pn * 100 : 0 })),
      title: popName(gr.parent), subtitle: fmtInt(pn), cacheKey: `sch|${s.id}|${gr.parent}|${g0.x}|${g0.y}|${w}|${S.version}`
    }, w, w);
  });
}
function schemePng() {
  const cs = [...document.querySelectorAll('#schemeGrid canvas')]; if (!cs.length) return toast('Nothing to save yet.', true);
  const cols = Math.min(3, cs.length), rows = Math.ceil(cs.length / cols), W = cs[0].width, H = cs[0].height, pad = 16;
  const out = document.createElement('canvas'); out.width = cols * W + (cols + 1) * pad; out.height = rows * H + (rows + 1) * pad;
  const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
  cs.forEach((c, i) => ctx.drawImage(c, pad + (i % cols) * (W + pad), pad + Math.floor(i / cols) * (H + pad)));
  download(out.toDataURL('image/png'), `${activeSample().name}_gating_scheme.png`);
}

// ------------------------------------------------------------ comp tab ---
function spillChannels() { return S.spill ? S.spill.channels : S.channels.filter(isFluor); }
function ensureSpill() {
  if (!S.spill) { const ch = S.channels.filter(isFluor); S.spill = { channels: ch, matrix: ch.map((_, i) => ch.map((__, j) => i === j ? 1 : 0)) }; }
}
function renderComp() {
  if (!S.samples.length) return;
  ensureSpill();
  $('#compOn').checked = S.compOn;
  $('#btnCompFile').disabled = !S.fileSpill;
  const chs = S.spill.channels, M = S.spill.matrix, tbl = $('#matrix');
  const head = el('tr', {}, el('th', { class: 'l' }, 'Fluorochrome ↓  Detector →'), ...chs.map(c => el('th', {}, el('span', { class: 'laser', style: `display:inline-block;margin-right:5px;background:${laser(c)}` }), short(c))));
  const rows = chs.map((r, i) => el('tr', {}, el('td', { class: 'l' }, label(r)), ...chs.map((c, j) => {
    if (i === j) return el('td', { class: 'diag' }, '100');
    const v = M[i][j] * 100;
    return el('td', { class: Math.abs(v) >= 25 ? 'hot' : '' }, el('input', { type: 'number', step: '0.1', value: +v.toFixed(3), 'aria-label': `Spillover of ${short(r)} into ${short(c)} (%)`,
      oninput: e => { const x = parseFloat(e.target.value); if (!isFinite(x)) return; M[i][j] = x / 100; e.target.parentNode.className = Math.abs(x) >= 25 ? 'hot' : ''; compChanged(true); } }));
  })));
  tbl.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  // controls
  const box = $('#ctrlAssign'); box.replaceChildren();
  S.samples.forEach(s => {
    const id = 'ctl-' + s.id, sel = el('select', { id, class: 'ch', onchange: e => { if (e.target.value) S.ctrl[s.id] = e.target.value; else delete S.ctrl[s.id]; renderSamples(); } },
      el('option', { value: '' }, 'Not a control'), el('option', { value: 'unstained' }, 'Unstained'), ...chs.map(c => el('option', { value: c }, `Single stain: ${label(c)}`)));
    sel.value = S.ctrl[s.id] || '';
    box.append(el('div', { class: 'field', style: 'padding-left:0;grid-template-columns:150px 1fr;max-width:460px' }, el('label', { for: id, title: s.name, style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, s.name), sel));
  });
  const ps = $('#ctrlPop'); const prev = ps.value;
  ps.replaceChildren(...dfs().map(({ id, depth }) => el('option', { value: id }, '  '.repeat(depth) + popName(id))));
  ps.value = dfs().some(d => d.id === prev) ? prev : 'root';
  // preview selects
  const fill = (sel, def) => { const v = sel.value; sel.replaceChildren(...chs.map(c => el('option', { value: c }, short(c)))); sel.value = chs.includes(v) ? v : def; };
  fill($('#pvX'), chs[0]); fill($('#pvY'), chs[1] || chs[0]);
  renderPreview();
}
let pvRaf = 0;
function compChanged(previewOnly) {
  markDirty();
  invalidate({ comp: true });
  cancelAnimationFrame(pvRaf); pvRaf = requestAnimationFrame(() => { renderPreview(); if (!previewOnly) renderComp(); renderTree(); });
}
function renderPreview() {
  const s = activeSample(); if (!s || !S.spill) return;
  const x = $('#pvX').value, y = $('#pvY').value; if (!x || !y) return;
  const w = Math.max(200, Math.min(360, Math.floor(($('#pvRaw').parentNode.clientWidth - 12) / 2)));
  const spec = { xch: x, ych: y, idx: s.all, small: true, pt: 2 };
  drawPlot($('#pvRaw'), { ...spec, xT: getTUncomp(s, x), yT: getTUncomp(s, y), title: 'Uncompensated', cacheKey: `pvr|${s.id}|${x}|${y}|${w}|${S.version}` }, w, w);
  const tmp = S.compOn; S.compOn = true; if (!tmp) { s._comp = null; s._t = {}; }
  drawPlot($('#pvComp'), { ...spec, xT: getT(s, x), yT: getT(s, y), title: 'Compensated', cacheKey: null }, w, w);
  if (!tmp) { S.compOn = false; s._comp = null; s._t = {}; }
}
function computeFromControls() {
  const chs = spillChannels(), popId = $('#ctrlPop').value;
  const subset = (s, ch, idx) => { const src = getUncomp(s, ch), o = new Float32Array(idx.length); for (let i = 0; i < idx.length; i++) o[i] = src[idx[i]]; return o; };
  const colsFor = s => { const idx = getPop(s, popId); return { n: idx.length, cols: Object.fromEntries(chs.map(c => [c, subset(s, c, idx)])) }; };
  const ctrls = S.samples.filter(s => S.ctrl[s.id] && S.ctrl[s.id] !== 'unstained').map(s => ({ primary: S.ctrl[s.id], ...colsFor(s), name: s.name }));
  const un = S.samples.find(s => S.ctrl[s.id] === 'unstained');
  if (!ctrls.length) { $('#computeMsg').textContent = 'Assign at least one sample as a single-stain control first.'; return; }
  const small = ctrls.filter(c => c.n < 500);
  const res = Core.spilloverFromControls(chs, ctrls, un ? colsFor(un) : null);
  S.spill = { channels: chs, matrix: res.matrix }; S.compOn = true;
  const missing = chs.filter(c => !ctrls.some(k => k.primary === c));
  $('#computeMsg').textContent = `Computed from ${ctrls.length} control${ctrls.length > 1 ? 's' : ''}${un ? ' and the unstained sample' : ' without an unstained sample'}, using ${popName(popId)}.` +
    (missing.length ? ` Rows without a control were left at zero spillover: ${missing.map(short).join(', ')}.` : '') +
    (small.length ? ` Few events in ${small.map(c => c.name).join(', ')}, so treat those rows with caution.` : '');
  compChanged(false);
}

// ------------------------------------------------------------ stats tab ---
function statValue(kind, col, idx) {
  if (!idx.length) return NaN;
  if (kind === 'median') return Core.quantile(col, 0.5, idx);
  if (kind === 'mean') return Core.mean(col, idx);
  if (kind === 'gmean') { let s = 0, n = 0; for (let i = 0; i < idx.length; i++) { const v = col[idx[i]]; if (v > 0) { s += Math.log(v); n++; } } return n ? Math.exp(s / n) : NaN; }
  if (kind === 'cv') { const [a, m, b] = Core.quantiles(col, [0.1587, 0.5, 0.8413], idx); return 100 * 0.5 * (b - a) / m; }
}
/* One block per group: every member sample against that group's own tree, optionally followed
   by a summary row carrying the mean and SD across the group. A sample in two groups appears
   under both, measured against each group's gates. */
function statRows() {
  const kind = $('#statKind').value, chs = S.statChans || [], rows = [];
  const groups = S.statGroup === 'all' ? S.groups : S.groups.filter(g => g.id === S.statGroup);
  groups.forEach(grp => {
    const tree = treeIn(grp.id), members = groupMembers(grp);
    members.forEach(s => {
      const tot = s.fcs.N;
      tree.forEach(({ id, depth }) => {
        const g = gateById(id), idx = getPop(s, id), pn = g ? getPop(s, g.parent).length : tot;
        rows.push({ group: grp.name, groupId: grp.id, color: grp.color, sample: s.name, pop: popName(id), depth,
          parent: g ? popName(g.parent) : '', count: idx.length,
          pctParent: pn ? idx.length / pn * 100 : NaN, pctTotal: tot ? idx.length / tot * 100 : NaN,
          adjusted: !!(g && hasOverride(s, g)),
          vals: chs.map(c => statValue(kind, getRaw(s, c), idx)) });
      });
    });
    if (S.statSummary && members.length > 1) {
      tree.forEach(({ id, depth }) => {
        const g = gateById(id);
        const per = members.map(s => {
          const idx = getPop(s, id), pn = g ? getPop(s, g.parent).length : s.fcs.N;
          return { pctParent: pn ? idx.length / pn * 100 : NaN, pctTotal: s.fcs.N ? idx.length / s.fcs.N * 100 : NaN,
            count: idx.length, vals: chs.map(c => statValue(kind, getRaw(s, c), idx)) };
        });
        rows.push({ group: grp.name, groupId: grp.id, color: grp.color, summary: true, n: members.length,
          sample: `mean \u00b1 SD (n=${members.length})`, pop: popName(id), depth, parent: g ? popName(g.parent) : '',
          count: avg(per.map(p => p.count)), countSd: sd(per.map(p => p.count)),
          pctParent: avg(per.map(p => p.pctParent)), pctParentSd: sd(per.map(p => p.pctParent)),
          pctTotal: avg(per.map(p => p.pctTotal)), pctTotalSd: sd(per.map(p => p.pctTotal)),
          vals: chs.map((_, k) => avg(per.map(p => p.vals[k]))), valsSd: chs.map((_, k) => sd(per.map(p => p.vals[k]))) });
      });
    }
  });
  return rows;
}
const avg = a => { const v = a.filter(isFinite); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN; };
const sd = a => { const v = a.filter(isFinite); if (v.length < 2) return NaN; const m = avg(v); return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / (v.length - 1)); };
const pm = (m, s, f) => !isFinite(m) ? '\u2013' : f(m) + (isFinite(s) ? ' \u00b1 ' + f(s) : '');
function renderStats() {
  if (!S.samples.length) return;
  if (!S.statChans) S.statChans = spillChannels().slice(0, 6);
  $('#statChans').replaceChildren(...S.channels.map(c => el('label', {}, el('input', { type: 'checkbox', checked: S.statChans.includes(c), onchange: e => { S.statChans = S.channels.filter(x => x === c ? e.target.checked : S.statChans.includes(x)); renderStats(); } }), el('span', { class: 'laser', style: `background:${laser(c)}` }), short(c))));
  const gsel = $('#statGroup');
  gsel.replaceChildren(el('option', { value: 'all' }, 'All groups'), ...S.groups.map(g => el('option', { value: g.id }, g.name)));
  gsel.value = S.groups.some(g => g.id === S.statGroup) ? S.statGroup : 'all';
  $('#statSummary').checked = !!S.statSummary;
  const kind = $('#statKind').selectedOptions[0].textContent;
  const rows = statRows(), tbl = $('#statTable');
  const head = el('tr', {}, el('th', { class: 'l' }, 'Group'), el('th', { class: 'l' }, 'Sample'), el('th', { class: 'l' }, 'Population'), el('th', {}, 'Events'), el('th', {}, '% of parent'), el('th', {}, '% of all'), ...S.statChans.map(c => el('th', {}, `${short(c)} ${kind.toLowerCase()}`)));
  let lastS = null, lastG = null;
  const body = rows.map(r => {
    const newBlock = r.sample !== lastS && lastS !== null;
    const tr = el('tr', { class: (newBlock ? 'grp ' : '') + (r.summary ? 'summary' : '') },
      el('td', { class: 'l' }, r.group !== lastG ? el('span', {}, el('span', { class: 'gdot', style: `background:${r.color};margin-right:6px` }), r.group) : ''),
      el('td', { class: 'l' }, r.sample !== lastS ? el('span', {}, r.sample, r.adjusted ? el('span', { class: 'ovdot', title: 'gate adjusted for this sample' }, ' \u2022') : null) : ''),
      el('td', { class: 'l', style: `padding-left:${10 + r.depth * 14}px` }, r.pop),
      el('td', {}, r.summary ? pm(r.count, r.countSd, v => fmtInt(Math.round(v))) : fmtInt(r.count)),
      el('td', {}, !r.parent ? '' : r.summary ? pm(r.pctParent, r.pctParentSd, v => v.toFixed(1) + '%') : fmtPct(r.pctParent)),
      el('td', {}, r.summary ? pm(r.pctTotal, r.pctTotalSd, v => v.toFixed(1) + '%') : fmtPct(r.pctTotal)),
      ...r.vals.map((v, k) => el('td', {}, r.summary ? pm(v, r.valsSd[k], fmtStat) : fmtStat(v))));
    lastS = r.sample; lastG = r.group; return tr;
  });
  tbl.replaceChildren(el('thead', {}, head), el('tbody', {}, ...body));
  $('#statLead').textContent = S.groups.length > 1
    ? 'Each group is measured against its own gating tree. A sample in two groups appears under both.'
    : 'Counts and frequencies for every population in every sample. Marker statistics use compensated, untransformed values.';
}
function statsCsv() {
  const kind = $('#statKind').value, rows = statRows();
  const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const num = v => isFinite(v) ? +v.toPrecision(6) : '';
  const lines = [['group', 'sample', 'is_group_summary', 'n', 'gate_adjusted', 'population', 'parent', 'events', 'events_sd', 'pct_of_parent', 'pct_of_parent_sd', 'pct_of_all', 'pct_of_all_sd',
    ...S.statChans.flatMap(c => [`${short(c)}_${kind}`, `${short(c)}_${kind}_sd`])].map(q).join(',')];
  rows.forEach(r => lines.push([r.group, r.sample, r.summary ? 1 : 0, r.summary ? r.n : 1, r.adjusted ? 1 : 0, r.pop, r.parent,
    num(r.count), num(r.countSd), r.parent ? num(r.pctParent) : '', r.parent ? num(r.pctParentSd) : '', num(r.pctTotal), num(r.pctTotalSd),
    ...r.vals.flatMap((v, k) => [num(v), num(r.valsSd ? r.valsSd[k] : NaN)])].map(q).join(',')));
  download(URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), 'population_statistics.csv');
}

// ------------------------------------------------------------ templates ---
function download(url, name) { const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); }
function saveTemplate() {
  if (!S.samples.length) return toast('Add samples and draw gates before saving a template.', true);
  const tpl = { format: 'flow-workbench-template', version: 1, saved: new Date().toISOString(), channels: S.channels, transforms: S.transforms, compensation: { apply: S.compOn, spillover: S.spill }, gates: S.gates };
  download(URL.createObjectURL(new Blob([JSON.stringify(tpl, null, 1)], { type: 'application/json' })), 'gating_template.json');
  toast('Template saved.');
}
async function openTemplate(file) {
  if (!S.samples.length) return toast('Add FCS files first, then open a template to apply it to them.', true);
  let tpl; try { tpl = JSON.parse(await file.text()); } catch (e) { return toast('That file is not valid JSON.', true); }
  if (tpl.format !== 'flow-workbench-template') return toast('That JSON file is not a Flow Workbench template.', true);
  const used = new Set(); (tpl.gates || []).forEach(g => { used.add(g.x); if (g.y) used.add(g.y); });
  const missing = [...used].filter(c => !S.channels.includes(c));
  if (missing.length) return toast(`The template uses channels these files lack: ${missing.join(', ')}.`, true);
  Object.entries(tpl.transforms || {}).forEach(([c, cfg]) => { if (S.channels.includes(c)) S.transforms[c] = cfg; });
  S.tfns = {};
  if (tpl.compensation && tpl.compensation.spillover && tpl.compensation.spillover.channels.every(c => S.channels.includes(c))) { S.spill = tpl.compensation.spillover; S.compOn = !!tpl.compensation.apply; }
  markDirty();
  S.gates = tpl.gates || []; S.nextId = 1 + Math.max(0, ...S.gates.map(g => parseInt(String(g.id).replace(/\D/g, ''), 10) || 0));
  S.view.pop = 'root'; S.view.sel = null;
  invalidate({ comp: true }); renderAll(); toast(`Applied template with ${S.gates.length} gate${S.gates.length === 1 ? '' : 's'}.`);
}

// ------------------------------------------------------------ shell ---
function switchTab(t) {
  S.tab = t;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  renderAll();
}
function renderAll() {
  const has = S.samples.length > 0;
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(b => { b.disabled = !has; });
  if (has) ensureGroups();
  renderGroups(); renderSamples();
  if (!has) { $('#pane-empty').classList.add('on'); $('#popTree').replaceChildren(); $('#groupList').replaceChildren(); return; }
  $('#pane-' + S.tab).classList.add('on');
  renderTree();
  if (S.tab === 'gate') renderGateTab();
  else if (S.tab === 'scheme') renderScheme();
  else if (S.tab === 'comp') renderComp();
  else if (S.tab === 'stats') renderStats();
  else if (S.tab === 'export') renderExport();
  renderProjName();
}
function refreshAll() { renderAll(); }

/*__EXT__*/
// wire up
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#btnOpen').onclick = $('#btnOpen2').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#btnDemo').onclick = loadDemo;
$('#btnExample').onclick = loadWorkedExample;
$('#tplIn').onchange = e => { if (e.target.files[0]) openTemplate(e.target.files[0]); e.target.value = ''; };
$('#selX').onchange = e => { e.target.blur(); S.view.x = e.target.value; S.view.sel = null; draft = null; renderGateTab(); };
$('#selY').onchange = e => { e.target.blur(); S.view.y = e.target.value; S.view.sel = null; draft = null; renderGateTab(); };
$('#btnSwap').onclick = () => { if (!S.view.y) return; [S.view.x, S.view.y] = [S.view.y, S.view.x]; S.view.sel = null; renderGateTab(); };
document.querySelectorAll('#tools button').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#ptSize').oninput = e => { S.view.pt = +e.target.value; renderPlot(); };
function savePlotPng() { const v = S.view, sel = v.sel; v.sel = null; renderPlot(); download(cv.toDataURL('image/png'), `${activeSample().name}_${popName(v.pop)}_${short(v.x)}${v.y ? '_' + short(v.y) : ''}.png`.replace(/[^\w.+-]+/g, '_')); v.sel = sel; renderPlot(); }
$('#btnSchemePng').onclick = schemePng;
$('#compOn').onchange = e => { S.compOn = e.target.checked; compChanged(true); };
$('#btnCompFile').onclick = () => { if (S.fileSpill) { S.spill = JSON.parse(JSON.stringify(S.fileSpill)); compChanged(false); toast('Restored the matrix stored in the FCS file.'); } };
$('#btnCompIdent').onclick = () => { const ch = spillChannels(); S.spill = { channels: ch, matrix: ch.map((_, i) => ch.map((__, j) => i === j ? 1 : 0)) }; compChanged(false); };
$('#btnCompCsv').onclick = () => { const ch = S.spill.channels; const lines = [',' + ch.join(','), ...S.spill.matrix.map((r, i) => ch[i] + ',' + r.join(','))]; download(URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), 'spillover_matrix.csv'); };
$('#btnCompute').onclick = computeFromControls;
$('#pvX').onchange = $('#pvY').onchange = renderPreview;
$('#statKind').onchange = renderStats;
$('#statGroup').onchange = e => { S.statGroup = e.target.value; markDirty(); renderStats(); };
$('#statSummary').onchange = e => { S.statSummary = e.target.checked; markDirty(); renderStats(); };
$('#btnCsv').onclick = statsCsv;
$('#btnFcsExport').onclick = () => {
  const s = activeSample(), idx = getPop(s, S.view.pop);
  const bytes = Core.writeFCS(s.fcs, idx, getComp(s));
  download(URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' })), `${s.name}_${popName(S.view.pop)}.fcs`.replace(/[^\w.+-]+/g, '_'));
  toast(`Exported ${fmtInt(idx.length)} events from ${popName(S.view.pop)}${S.compOn ? ' (compensated values)' : ''}.`);
};
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) dz.classList.remove('over'); }));
document.addEventListener('drop', e => { const fs = [...e.dataTransfer.files]; const tpl = fs.find(f => /\.json$/i.test(f.name)); const fcs = fs.filter(f => !/\.json$/i.test(f.name)); if (fcs.length) addFiles(fcs).then(() => tpl && openTemplate(tpl)); else if (tpl) openTemplate(tpl); });
document.addEventListener('keydown', e => {
  if (pendingName || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || S.tab !== 'gate' || !S.samples.length) return;
  const k = e.key.toLowerCase(), map = { v: 'pointer', r: 'rect', p: 'poly', e: 'ellipse', i: 'interval', q: 'quad' };
  if (map[k] && !e.metaKey && !e.ctrlKey) { const b = document.querySelector(`#tools button[data-tool="${map[k]}"]`); if (!b.disabled) setTool(map[k]); return; }
  if (e.key === 'Escape') { if (draft) { draft = null; renderPlot(); } else { S.view.sel = null; renderGateTab(); } }
  if (e.key === 'Enter' && draft && draft.type === 'poly') finishPoly();
  if ((e.key === 'Backspace' || e.key === 'Delete')) {
    if (draft && draft.type === 'poly') { draft.pts.pop(); if (!draft.pts.length) draft = null; renderPlot(); e.preventDefault(); }
    else if (S.view.sel) { deleteGate(S.view.sel); e.preventDefault(); }
  }
});
let rz = 0; window.addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { densityCache.clear(); renderAll(); }); });
window.FW = { S, loadDemo, addSample, renderAll, getPop, switchTab, setTool, computeFromControls,
  toPx: (rx, ry) => { const r = cv.getBoundingClientRect(); return [r.left + G.tx(tfn(S.view.x).f(rx)), r.top + (S.view.y ? G.ty(tfn(S.view.y).f(ry)) : G.mt + G.h / 2)]; } };

// ---- file menu, projects and export wiring
$('#btnFile').onclick = e => { e.stopPropagation(); toggleMenu(); };
document.addEventListener('click', e => { if (!e.target.closest('.menuwrap')) toggleMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleMenu(false); });
const menu = (id, fn) => { $(id).onclick = () => { toggleMenu(false); fn(); }; };
menu('#miNew', () => {
  if (S.dirty && !confirm('Start a new project? Changes that are not in a saved project file will be lost.')) return;
  resetState(); S.tab = 'gate'; document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === 'gate'));
  document.title = 'Flow Workbench'; renderAll();
});
menu('#miOpenProj', pickProject);
menu('#miSaveProj', () => saveProject(false));
menu('#miSaveProjAs', () => saveProject(true));
menu('#miAddFcs', () => $('#fileIn').click());
menu('#miOpenTpl', () => $('#tplIn').click());
menu('#miSaveTpl', saveTemplate);
$('#btnSaveProj').onclick = () => saveProject(false);
$('#btnOpenProj2').onclick = pickProject;
$('#expPreview').addEventListener('pointerdown', e => { if (E.layout === 'free') freePointerDown(e); });
$('#expPreview').addEventListener('pointermove', e => { if (E.layout === 'free') freePointerMove(e); });
$('#expPreview').addEventListener('pointerup', () => { if (E.layout === 'free') freePointerUp(); });
$('#expPreview').addEventListener('dblclick', e => { if (E.layout === 'free') freeDblClick(e); });
document.addEventListener('keydown', e => {
  if (S.tab !== 'export' || E.layout !== 'free' || !freeSel) return;
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { freeDelete(); e.preventDefault(); }
  else if (e.key === 'Escape') { freeSel = null; renderExport(); }
  else if (e.key.startsWith('Arrow')) {
    const it = freeById(freeSel), d = e.shiftKey ? 10 : 1;
    const dx = (e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0), dy = (e.key === 'ArrowDown' ? d : e.key === 'ArrowUp' ? -d : 0);
    if (it.type === 'arrow') { it.x1 += dx; it.y1 += dy; it.x2 += dx; it.y2 += dy; } else { it.x += dx; it.y += dy; }
    markDirty(); renderExportPreview(); e.preventDefault();
  }
});
$('#projIn').onchange = e => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.FW.saveProject = saveProject; window.FW.openProject = openProject; window.FW.buildFigure = buildFigure;
window.FW.dfs = dfs; window.FW.treeIn = treeIn; window.FW.loadWorkedExample = loadWorkedExample; window.FW.invalidateGates = invalidateGates; window.FW.addGroup = addGroup; window.FW.setActiveGroup = setActiveGroup;
window.FW.copyGatesTo = copyGatesTo; window.FW.toggleMember = toggleMember; window.FW.deleteGroup = deleteGroup;
window.FW.effGate = effGate; window.FW.hasOverride = hasOverride; window.FW.clearOverride = clearOverride; window.FW.groupMembers = groupMembers;
window.FW.figureSvg = figureSvg; window.FW.E = E; window.FW.renderExport = renderExport; window.FW.SvgCtx = SvgCtx;

renderAll();
})();

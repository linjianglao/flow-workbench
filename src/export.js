// ------------------------------------------------------------ export tab ---
const LAYOUTS = [
  { id: 'current', name: 'Current plot', desc: 'The plot on the Gate tab, with its histogram overlays.' },
  { id: 'strategy', name: 'Gating strategy', desc: 'Every gating step for one sample, wrapped into a grid.' },
  { id: 'cols', name: 'Samples in columns', desc: 'One column per sample and one row per plot, for comparing conditions.' },
  { id: 'rows', name: 'Samples in rows', desc: 'One row per sample showing each gating step across the page.' },
  { id: 'overlay', name: 'Histogram overlay', desc: 'One marker in one population, all chosen samples on the same axes.' },
  { id: 'ridge', name: 'Stacked histograms', desc: 'One marker in one population, samples offset vertically with gate frequencies.' },
  { id: 'free', name: 'Free layout', desc: 'Place plots anywhere on a blank canvas and annotate them with text and arrows.' }
];
const RIDGE_COLORS = ['#0A73B8', '#D8342C', '#2E8B57', '#7A3FD1', '#E08A00', '#C2185B', '#14A6C8', '#6D7A2A'];
const E = { layout: 'strategy', sampleId: null, plots: null, samples: null, pop: 'root', pops: null, compare: 'samples', ch: null, gate: '', cols: 3, size: 300, pt: 2,
  labels: true, pct: true, titles: true, heading: '', fmt: 'png', scale: 2, transparent: false, fontScale: 1 };

function exportSettingsForSave() {
  const { plots, samples, sampleId, free, pops, ...rest } = E;
  const freeOut = free ? { ...free, items: free.items.map(i => i.type === 'panel' ? { ...i, sampleId: undefined, sampleIdx: S.samples.findIndex(s => s.id === i.sampleId) } : { ...i }) } : null;
  return { ...rest, free: freeOut, pops: pops ? [...pops] : null, plots: plots ? [...plots] : null, sampleIdx: S.samples.findIndex(s => s.id === sampleId), samplesIdx: samples ? [...samples].map(id => S.samples.findIndex(s => s.id === id)).filter(i => i >= 0) : null };
}
function restoreExportSettings(o) {
  if (!o) return;
  const { plots, sampleIdx, samplesIdx, free, pops, ...rest } = o; Object.assign(E, rest);
  E.pops = pops ? new Set(pops) : null;
  E.free = free ? { ...free, items: (free.items || []).map(i => { if (i.type !== 'panel') return { ...i }; const { sampleIdx: si, ...r } = i; const s = S.samples[si] || S.samples[0]; return { ...r, sampleId: s && s.id }; }) } : null;
  E.plots = plots ? new Set(plots) : null;
  E.sampleId = S.samples[sampleIdx] ? S.samples[sampleIdx].id : null;
  E.samples = samplesIdx ? new Set(samplesIdx.map(i => S.samples[i] && S.samples[i].id).filter(Boolean)) : null;
}

function plotGroups() {
  const groups = [];
  dfs().forEach(({ id }) => {
    const m = new Map();
    children(id).forEach(g => { const k = `${id}|${g.x}|${g.y || ''}`; if (!m.has(k)) m.set(k, { key: k, parent: id, x: g.x, y: g.y || null, gates: [] }); m.get(k).gates.push(g); });
    m.forEach(v => groups.push(v));
  });
  return groups;
}
const groupLabel = gr => `${popName(gr.parent)}: ${short(gr.x)}${gr.y ? ' vs ' + short(gr.y) : ' histogram'}`;
const expSamples = () => S.samples.filter(s => E.samples ? E.samples.has(s.id) : (inActiveGroup(s) && !S.ctrl[s.id]));
const expGroups = () => plotGroups().filter(g => !E.plots || E.plots.has(g.key));
const expSample = () => S.samples.find(s => s.id === E.sampleId) || activeSample();

function groupSpec(s, gr, P) {
  const pop = getPop(s, gr.parent), pn = pop.length;
  return {
    xch: gr.x, ych: gr.y, xT: getT(s, gr.x), yT: gr.y ? getT(s, gr.y) : null, idx: pop, small: P < 340, pt: E.pt, fontScale: E.fontScale,
    gates: gr.gates.map(g => ({ gate: g, pct: pn ? getPop(s, g.id).length / pn * 100 : 0 })),
    labels: E.labels, pct: E.pct, transparent: E.transparent,
    title: E.titles ? popName(gr.parent) : '', subtitle: E.titles ? fmtInt(pn) : '',
    cacheKey: `x|${s.id}|${gr.parent}|${gr.x}|${gr.y}|${P}|${E.pt}|${S.version}`
  };
}

/* Returns {W, H, draw(ctx)} describing the whole figure in CSS pixels. */
function buildFigure() {
  const P = E.size, gap = 14, pad = 22, fs = 13 * E.fontScale;
  const headH = E.heading ? Math.round(30 * E.fontScale) : 0;
  const text = (ctx, t, x, y, o = {}) => { ctx.font = `${o.weight || 600} ${o.size || fs}px ${FONT}`; ctx.fillStyle = o.color || '#16212A'; ctx.textAlign = o.align || 'left'; ctx.textBaseline = o.base || 'alphabetic'; ctx.fillText(t, x, y); };
  const bg = (ctx, W, H) => { if (!E.transparent) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); } if (E.heading) text(ctx, E.heading, pad, pad + 16 * E.fontScale, { size: 17 * E.fontScale }); };
  const panel = (ctx, x, y, spec, w, h) => { ctx.save(); ctx.translate(x, y); paintPlot(ctx, spec, w, h); ctx.restore(); };
  const empty = msg => ({ W: 520, H: 140, empty: msg, draw: ctx => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 520, 140); text(ctx, msg, 260, 74, { align: 'center', weight: 400, color: '#5A6670' }); } });

  if (E.layout === 'free') return freeFigure();

  if (E.layout === 'current') {
    const s = activeSample(), v = S.view, pop = getPop(s, v.pop), pn = pop.length;
    const overlays = !v.y ? [...S.overlays].map((id, k) => { const o = S.samples.find(x => x.id === id); return o && o !== s ? { xT: getT(o, v.x), idx: getPop(o, v.pop), color: OVERLAY_COLORS[k % OVERLAY_COLORS.length], name: o.name } : null; }).filter(Boolean) : [];
    const spec = { xch: v.x, ych: v.y || null, xT: getT(s, v.x), yT: v.y ? getT(s, v.y) : null, idx: pop, overlays, pt: E.pt, small: P < 340, fontScale: E.fontScale,
      gates: plotGates().map(g => ({ gate: g, pct: pn ? getPop(s, g.id).length / pn * 100 : 0 })), labels: E.labels, pct: E.pct, transparent: E.transparent,
      title: E.titles ? popName(v.pop) : '', subtitle: E.titles ? `${s.name}, ${fmtInt(pn)} events` : '', cacheKey: `xc|${s.id}|${v.pop}|${v.x}|${v.y}|${P}|${E.pt}|${S.version}` };
    const legW = overlays.length ? 190 : 0, W = pad * 2 + P + legW, H = pad * 2 + headH + P;
    return { W, H, draw: ctx => {
      bg(ctx, W, H); panel(ctx, pad, pad + headH, spec, P, P);
      if (legW) [{ name: s.name, color: '#16212A' }, ...overlays].forEach((o, i) => legendRow(ctx, pad + P + 14, pad + headH + 40 + i * 20, o.color, o.name, fs));
    } };
  }

  if (E.layout === 'strategy') {
    const s = expSample(), gs = expGroups();
    if (!gs.length) return empty('Draw some gates first. Each gating step becomes one panel here.');
    const cols = Math.max(1, Math.min(E.cols, gs.length)), rows = Math.ceil(gs.length / cols), subH = E.titles ? Math.round(24 * E.fontScale) : 0;
    const W = pad * 2 + cols * P + (cols - 1) * gap, H = pad * 2 + headH + subH + rows * P + (rows - 1) * gap;
    return { W, H, draw: ctx => {
      bg(ctx, W, H);
      if (E.titles) text(ctx, s.name, pad, pad + headH + 14 * E.fontScale, { size: 14 * E.fontScale });
      gs.forEach((gr, i) => panel(ctx, pad + (i % cols) * (P + gap), pad + headH + subH + Math.floor(i / cols) * (P + gap), groupSpec(s, gr, P), P, P));
    } };
  }

  if (E.layout === 'cols' || E.layout === 'rows') {
    const ss = expSamples(), gs = expGroups();
    if (!gs.length) return empty('Draw some gates first, then choose which plots to include.');
    if (!ss.length) return empty('Choose at least one sample.');
    const byCol = E.layout === 'cols', nR = byCol ? gs.length : ss.length, nC = byCol ? ss.length : gs.length;
    const colH = byCol ? Math.round(26 * E.fontScale) : 0, rowW = byCol ? 0 : Math.round(28 * E.fontScale);
    const W = pad * 2 + rowW + nC * P + (nC - 1) * gap, H = pad * 2 + headH + colH + nR * P + (nR - 1) * gap;
    return { W, H, draw: ctx => {
      bg(ctx, W, H);
      const x0 = pad + rowW, y0 = pad + headH + colH;
      if (byCol) ss.forEach((s, c) => text(ctx, s.name, x0 + c * (P + gap) + P / 2, pad + headH + 16 * E.fontScale, { align: 'center', size: 13.5 * E.fontScale }));
      else ss.forEach((s, r) => { ctx.save(); ctx.translate(pad + 10 * E.fontScale, y0 + r * (P + gap) + P / 2); ctx.rotate(-Math.PI / 2); text(ctx, s.name, 0, 0, { align: 'center', base: 'middle', size: 13.5 * E.fontScale }); ctx.restore(); });
      for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) {
        const s = byCol ? ss[c] : ss[r], gr = byCol ? gs[r] : gs[c];
        panel(ctx, x0 + c * (P + gap), y0 + r * (P + gap), groupSpec(s, gr, P), P, P);
      }
    } };
  }

  // one marker; rows are either samples or populations
  const ch = E.ch && S.channels.includes(E.ch) ? E.ch : S.channels.find(isFluor) || S.channels[0];
  const rows = compareRows();
  if (!rows.length) return empty(E.compare === 'populations' ? 'Choose at least one population.' : 'Choose at least one sample.');
  const pop = E.pop === 'root' || gateById(E.pop) ? E.pop : 'root';
  const heading = E.compare === 'populations' ? expSample().name : popName(pop);
  if (E.layout === 'overlay') {
    const curves = rows.map((r, i) => ({ xT: getT(r.s, ch), idx: r.idx, color: RIDGE_COLORS[i % RIDGE_COLORS.length], name: r.name }));
    ctx0.font = `400 ${fs * 0.92}px ${FONT}`;
    const legW = Math.min(340, Math.max(...curves.map(c => ctx0.measureText(`${c.name} (${fmtInt(c.idx.length)})`).width)) + 54);
    const pw = Math.round(P * 1.3), W = pad * 2 + pw + legW, H = pad * 2 + headH + P;
    const spec = { xch: ch, ych: null, curves, idx: curves[0].idx, xT: curves[0].xT, small: P < 340, fontScale: E.fontScale, transparent: E.transparent,
      gates: E.compare === 'populations' ? [] : children(pop).filter(g => g.type === 'interval' && g.x === ch).map(g => ({ gate: g, pct: null })),
      labels: E.labels, pct: false, title: E.titles ? heading : '' };
    return { W, H, draw: ctx => {
      bg(ctx, W, H); panel(ctx, pad, pad + headH, spec, pw, P);
      curves.forEach((c, i) => legendRow(ctx, pad + pw + 14, pad + headH + 40 + i * 20, c.color, `${c.name} (${fmtInt(c.idx.length)})`, fs));
    } };
  }
  // ridge
  const gate = E.compare === 'samples' && gateById(E.gate) && gateById(E.gate).parent === pop && gateById(E.gate).x === ch ? gateById(E.gate) : null;
  return ridgeFigure(rows, heading, ch, gate, { P, pad, headH, fs, bg, text });
}

/* The two one-marker layouts compare either several samples in one population, or several
   populations within one sample. Both resolve to the same list of labelled row definitions. */
function compareRows() {
  if (E.compare === 'populations') {
    const s = expSample(), ids = dfs().map(d => d.id).filter(id => E.pops ? E.pops.has(id) : gateById(id));
    return ids.map(id => ({ s, pop: id, name: popName(id), idx: getPop(s, id) }));
  }
  const pop = E.pop === 'root' || gateById(E.pop) ? E.pop : 'root';
  return expSamples().map(s => ({ s, pop, name: s.name, idx: getPop(s, pop) }));
}

function legendRow(ctx, x, y, color, name, fs) {
  ctx.fillStyle = color; ctx.fillRect(x, y - 2, 18, 3);
  ctx.font = `400 ${fs * 0.92}px ${FONT}`; ctx.fillStyle = '#16212A'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(name, x + 26, y);
}

function ridgeFigure(rows, heading, ch, gate, { P, pad, headH, fs, bg, text }) {
  const cfg = S.transforms[ch], xr = cfg.range, rowH = Math.max(28, Math.round(P / 5.5)), amp = rowH * 1.7;
  ctx0.font = `600 ${fs * 0.95}px ${FONT}`;
  const nameW = Math.min(230, Math.max(...rows.map(r => ctx0.measureText(r.name).width)) + 16);
  const pctW = gate ? 76 : 82, pw = Math.round(P * 1.35), titleH = E.titles ? 28 : 0;
  const W = pad * 2 + nameW + pw + pctW, plotTop = pad + headH + titleH + amp - rowH, H = plotTop + rows.length * rowH + 52 + pad;
  const g = { ml: pad + nameW, mt: plotTop - amp + rowH, w: pw, h: 0 };
  g.h = plotTop + rows.length * rowH - g.mt; g.tx = t => g.ml + (t - xr[0]) / (xr[1] - xr[0]) * pw;
  return { W, H, draw: ctx => {
    bg(ctx, W, H);
    if (E.titles) text(ctx, `${heading}: ${label(ch)}`, g.ml, pad + headH + 16 * E.fontScale, { size: 14 * E.fontScale });
    if (gate) {
      const fx = tfn(ch), a = g.tx(fx.f(gate.pts[0][0])), b = g.tx(fx.f(gate.pts[1][0])), lo = Math.max(g.ml, Math.min(a, b)), hi = Math.min(g.ml + pw, Math.max(a, b));
      ctx.fillStyle = 'rgba(10,115,184,.07)'; ctx.fillRect(lo, g.mt, hi - lo, g.h);
      ctx.strokeStyle = '#0A73B8'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      [lo, hi].forEach(x => { ctx.beginPath(); ctx.moveTo(x, g.mt); ctx.lineTo(x, g.mt + g.h); ctx.stroke(); });
      ctx.setLineDash([]);
      text(ctx, gate.name, W - pad, g.mt - 4, { align: 'right', size: fs * 0.9, color: '#0A73B8' });
    }
    rows.forEach((r, i) => {
      const base = plotTop + (i + 1) * rowH, idx = r.idx, h = histogram(getT(r.s, ch), idx, xr), mx = Math.max(...h) || 1, n = h.length, col = RIDGE_COLORS[i % RIDGE_COLORS.length];
      ctx.beginPath(); ctx.moveTo(g.tx(xr[0]), base);
      for (let k = 0; k < n; k++) ctx.lineTo(g.tx(xr[0] + (k + 0.5) / n * (xr[1] - xr[0])), base - h[k] / mx * amp);
      ctx.lineTo(g.tx(xr[1]), base); ctx.closePath();
      ctx.fillStyle = hexA(col, 0.55); ctx.fill(); ctx.strokeStyle = '#16212A'; ctx.lineWidth = 1; ctx.stroke();
      text(ctx, r.name, g.ml - 10, base - 4, { align: 'right', size: fs * 0.95 });
      const stat = gate ? (idx.length ? fmtPct(getPop(r.s, gate.id).length / idx.length * 100) : '\u2013') : fmtInt(idx.length);
      text(ctx, stat, W - pad, base - 4, { align: 'right', weight: 400, size: fs * 0.95 });
    });
    ctx.fillStyle = '#C9D1CF'; ctx.fillRect(g.ml, g.mt + g.h, pw, 1);
    drawAxis(ctx, g, cfg, 'x', 11.5 * E.fontScale);
    ctx.font = `600 ${12.5 * E.fontScale}px ${FONT}`; ctx.fillStyle = '#16212A'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(label(ch), g.ml + pw / 2, g.mt + g.h + 42);
  } };
}
const ctx0 = document.createElement('canvas').getContext('2d');
const hexA = (hex, a) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')},${a})`;

// ---------- export tab UI
function renderExport() {
  if (!S.samples.length) return;
  if (!E.sampleId || !S.samples.some(s => s.id === E.sampleId)) E.sampleId = activeSample().id;
  if (!E.ch || !S.channels.includes(E.ch)) E.ch = S.channels.find(isFluor) || S.channels[0];
  if (E.pop === 'root' && !E.popTouched && gateById(S.view.pop)) E.pop = S.view.pop;
  const box = $('#expControls'); box.replaceChildren();
  const L = E.layout, onePlot = L === 'overlay' || L === 'ridge';
  const set = (k, v, full) => { E[k] = v; markDirty(); full ? renderExport() : renderExportPreview(); };

  // layout picker
  if (S.groups.length > 1) box.append(el('p', { class: 'hint', style: 'padding:0 0 10px' },
    'Drawn from group ', el('b', {}, el('span', { class: 'gdot', style: `background:${activeGroup().color};margin-right:5px` }), activeGroup().name),
    '. Switch groups in the sidebar to build the same figure from another one.'));
  box.append(el('h3', {}, 'Layout'), el('div', { class: 'layouts', role: 'radiogroup', 'aria-label': 'Figure layout' },
    ...LAYOUTS.map(l => el('button', { class: 'layout' + (L === l.id ? ' on' : ''), role: 'radio', 'aria-checked': L === l.id, onclick: () => set('layout', l.id, true) },
      layoutIcon(l.id), el('span', { class: 'lname' }, l.name)))),
    el('p', { class: 'hint', style: 'padding:6px 0 0' }, LAYOUTS.find(l => l.id === L).desc));

  if (L === 'free') {
    box.append(...freeControls());
    box.append(el('div', { class: 'expsec' }, el('h3', {}, 'Appearance'),
      fieldText('Figure title', E.heading, v => set('heading', v)),
      fieldRange('Text size', 0.8, 1.6, 0.05, E.fontScale, v => set('fontScale', v), v => Math.round(v * 100) + '%'),
      checkRow('Panel titles', E.titles, v => set('titles', v)),
      checkRow('Gate names', E.labels, v => set('labels', v)),
      checkRow('Gate percentages', E.pct, v => set('pct', v)),
      checkRow('Transparent background', E.transparent, v => set('transparent', v))));
    box.append(outputSection());
    renderExportPreview();
    return;
  }

  // content
  const content = el('div', { class: 'expsec' }, el('h3', {}, 'Content'));
  if (L === 'current') content.append(el('p', { class: 'hint', style: 'padding:0' }, `${popName(S.view.pop)}, ${short(S.view.x)}${S.view.y ? ' vs ' + short(S.view.y) : ' histogram'} for ${activeSample().name}. Change it on the Gate tab.`));
  if (L === 'strategy') content.append(fieldSel('Sample', S.samples.map(s => [s.id, s.name]), E.sampleId, v => set('sampleId', +v)));
  if (onePlot) {
    content.append(fieldSel('Compare', [['samples', 'Samples, in one population'], ['populations', 'Populations, in one sample']], E.compare, v => set('compare', v, true)));
    content.append(fieldSel('Marker', S.channels.map(c => [c, label(c)]), E.ch, v => { E.gate = ''; set('ch', v, true); }));
    if (E.compare === 'populations') {
      content.append(fieldSel('Sample', S.samples.map(s => [s.id, s.name]), E.sampleId, v => set('sampleId', +v, true)));
      const all = dfs().filter(d => gateById(d.id));
      content.append(el('div', { class: 'sublabel' }, 'Populations'), checkList(all.map(({ id, depth }) => [id, '\u2002'.repeat(depth) + popName(id)]),
        id => E.pops ? E.pops.has(id) : true, (id, on) => {
          const cur = E.pops || new Set(all.map(d => d.id)); on ? cur.add(id) : cur.delete(id); E.pops = cur; markDirty(); renderExportPreview();
        }, 'Draw some gates first.'));
    } else {
      content.append(fieldSel('Population', dfs().map(({ id, depth }) => [id, '\u2002'.repeat(depth) + popName(id)]), E.pop, v => { E.gate = ''; E.popTouched = true; set('pop', v, true); }));
      if (L === 'ridge') {
        const ints = children(E.pop).filter(g => g.type === 'interval' && g.x === E.ch);
        if (ints.length && !E.gate) E.gate = ints[0].id;
        content.append(fieldSel('Show gate', [['', 'None'], ...ints.map(g => [g.id, g.name])], E.gate, v => set('gate', v)));
      }
    }
  }
  if (['strategy', 'cols', 'rows'].includes(L)) {
    const gs = plotGroups();
    content.append(el('div', { class: 'sublabel' }, 'Plots'), checkList(gs.map(g => [g.key, groupLabel(g)]), k => !E.plots || E.plots.has(k), (k, on) => {
      const cur = E.plots || new Set(gs.map(g => g.key)); on ? cur.add(k) : cur.delete(k); E.plots = cur.size === gs.length ? null : cur; markDirty(); renderExportPreview();
    }, gs.length ? null : 'No gates yet.'));
  }
  if (L !== 'current' && L !== 'strategy' && !(onePlot && E.compare === 'populations')) {
    content.append(el('div', { class: 'sublabel' }, 'Samples'), checkList(S.samples.map(s => [s.id, s.name]), id => E.samples ? E.samples.has(id) : (!S.ctrl[id] && activeGroup() && activeGroup().members.includes(id)), (id, on) => {
      const cur = E.samples || new Set(expSamples().map(s => s.id)); on ? cur.add(id) : cur.delete(id); E.samples = cur; markDirty(); renderExportPreview();
    }));
  }
  box.append(content);

  // appearance
  const look = el('div', { class: 'expsec' }, el('h3', {}, 'Appearance'));
  look.append(fieldText('Figure title', E.heading, v => set('heading', v)));
  if (L === 'strategy') look.append(fieldRange('Columns', 1, 6, 1, E.cols, v => set('cols', v)));
  look.append(fieldRange('Panel size', 200, 520, 10, E.size, v => set('size', v), v => v + ' px'));
  look.append(fieldRange('Text size', 0.8, 1.6, 0.05, E.fontScale, v => set('fontScale', v), v => Math.round(v * 100) + '%'));
  if (!onePlot) look.append(fieldRange('Dot size', 1, 4, 1, E.pt, v => set('pt', v)));
  look.append(checkRow('Panel titles', E.titles, v => set('titles', v)), checkRow('Gate names', E.labels, v => set('labels', v)));
  if (!onePlot) look.append(checkRow('Gate percentages', E.pct, v => set('pct', v)));
  look.append(checkRow('Transparent background', E.transparent, v => set('transparent', v)));
  box.append(look);

  box.append(outputSection());
  renderExportPreview();
}
function outputSection() {
  const set = (k, v, full) => { E[k] = v; markDirty(); full ? renderExport() : renderExportPreview(); };
  const outSec = el('div', { class: 'expsec' }, el('h3', {}, 'File'));
  outSec.append(el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'File format' }, ...[['png', 'PNG'], ['svg', 'SVG'], ['pdf', 'PDF']].map(([v, t]) =>
    el('button', { role: 'radio', 'aria-checked': E.fmt === v, class: E.fmt === v ? 'on' : '', onclick: () => set('fmt', v, true) }, t))));
  if (E.fmt === 'png') outSec.append(fieldSel('Resolution', [[1, 'Screen (1×)'], [2, 'High (2×, ~150 dpi)'], [4, 'Print (4×, ~300 dpi)']], E.scale, v => set('scale', +v, true)));
  outSec.append(el('p', { class: 'hint', style: 'padding:4px 0 10px' }, { png: 'A bitmap image for slides and documents.', svg: 'Vector file for Illustrator, Inkscape or Affinity. Text and gates stay editable; dot plots are embedded images.', pdf: 'Opens your browser’s print dialog. Choose “Save as PDF”. Axes, text and gates stay vector.' }[E.fmt]));
  outSec.append(el('button', { class: 'btn primary', id: 'btnExportFig', onclick: doExport }, E.fmt === 'pdf' ? 'Open print dialog' : `Export ${E.fmt.toUpperCase()}`));
  return outSec;
}
function fieldSel(lab, opts, val, onchange) {
  const id = 'ex-' + lab.replace(/\W/g, '');
  const sel = el('select', { id, onchange: e => onchange(e.target.value) }, ...opts.map(([v, t]) => el('option', { value: v }, t)));
  sel.value = String(val);
  return el('div', { class: 'field' }, el('label', { for: id }, lab), sel);
}
function fieldText(lab, val, onchange) {
  const id = 'ex-' + lab.replace(/\W/g, '');
  return el('div', { class: 'field' }, el('label', { for: id }, lab), el('input', { id, type: 'text', value: val, placeholder: 'Optional', oninput: e => onchange(e.target.value) }));
}
function fieldRange(lab, min, max, step, val, onchange, fmt = v => v) {
  const id = 'ex-' + lab.replace(/\W/g, ''), out = el('span', { class: 'rangeval' }, fmt(val));
  return el('div', { class: 'field' }, el('label', { for: id }, lab), el('div', { class: 'rangewrap' }, el('input', { id, type: 'range', min, max, step, value: val, oninput: e => { out.textContent = fmt(+e.target.value); onchange(+e.target.value); } }), out));
}
function checkRow(lab, val, onchange) { return el('label', { class: 'chk', style: 'padding:3px 0' }, el('input', { type: 'checkbox', checked: val, onchange: e => onchange(e.target.checked) }), lab); }
function checkList(items, isOn, onToggle, emptyMsg) {
  if (!items.length) return el('p', { class: 'hint', style: 'padding:0' }, emptyMsg || 'Nothing to choose.');
  return el('div', { class: 'checklist' }, ...items.map(([k, t]) => el('label', { class: 'chk', style: 'padding:2px 0' }, el('input', { type: 'checkbox', checked: isOn(k), onchange: e => onToggle(k, e.target.checked) }), el('span', {}, t))));
}
function layoutIcon(id) {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 44 32'); svg.setAttribute('width', '44'); svg.setAttribute('height', '32'); svg.setAttribute('aria-hidden', 'true');
  const r = (x, y, w, h, fill) => { const e = document.createElementNS(ns, 'rect'); Object.entries({ x, y, width: w, height: h, rx: 1.5, fill: fill || 'none', stroke: 'currentColor', 'stroke-width': 1.3 }).forEach(([k, v]) => e.setAttribute(k, v)); svg.append(e); };
  const p = (d, extra = {}) => { const e = document.createElementNS(ns, 'path'); e.setAttribute('d', d); Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, ...extra }).forEach(([k, v]) => e.setAttribute(k, v)); svg.append(e); };
  if (id === 'current') r(13, 5, 18, 22);
  if (id === 'strategy') { [[4, 4], [17, 4], [30, 4], [4, 18], [17, 18]].forEach(([x, y]) => r(x, y, 10, 10)); }
  if (id === 'cols') { [4, 17, 30].forEach(x => { p(`M${x} 3h10`, { 'stroke-width': 2 }); r(x, 7, 10, 10); r(x, 19, 10, 10); }); }
  if (id === 'rows') { [5, 19].forEach(y => { p(`M3 ${y}v10`, { 'stroke-width': 2 }); r(7, y, 10, 10); r(19, y, 10, 10); r(31, y, 10, 10); }); }
  if (id === 'overlay') { r(4, 4, 36, 24); p('M6 26C12 26 12 10 16 10S20 26 24 26', {}); p('M12 26C18 26 20 14 24 14S30 26 36 26', { 'stroke-dasharray': '2 1.5' }); }
  if (id === 'ridge') { [8, 15, 22].forEach(y => p(`M6 ${y + 6}C11 ${y + 6} 12 ${y} 16 ${y}S21 ${y + 6} 26 ${y + 6}H38`)); }
  return svg;
}
function renderExportPreview() {
  const cvp = $('#expPreview'), wrap = $('#expPreviewWrap'); if (!cvp || !S.samples.length) return;
  const fig = buildFigure(), avail = Math.max(280, wrap.clientWidth - 2), sc = Math.min(1, avail / fig.W), dpr = window.devicePixelRatio || 1;
  cvp.width = Math.round(fig.W * sc * dpr); cvp.height = Math.round(fig.H * sc * dpr);
  cvp.style.width = Math.round(fig.W * sc) + 'px'; cvp.style.height = Math.round(fig.H * sc) + 'px';
  cvp.classList.toggle('checker', E.transparent);
  const ctx = cvp.getContext('2d'); ctx.setTransform(sc * dpr, 0, 0, sc * dpr, 0, 0); ctx.clearRect(0, 0, fig.W, fig.H);
  fig.draw(ctx);
  cvp.classList.toggle('editable', fig.free);
  if (fig.free) drawFreeChrome(ctx, sc); else { freeSel = null; freeHover = null; cvp.style.cursor = 'default'; }
  const px = E.fmt === 'png' ? `${Math.round(fig.W * E.scale)} × ${Math.round(fig.H * E.scale)} px` : `${Math.round(fig.W)} × ${Math.round(fig.H)} pt`;
  $('#expInfo').textContent = fig.empty ? '' : `Output size ${px}${sc < 1 ? `. Preview shown at ${Math.round(sc * 100)}%.` : '.'}`;
  const b = $('#btnExportFig'); if (b) b.disabled = !!fig.empty;
}
function figureName() {
  if (E.layout === 'free') return `Figure_${(E.heading || activeSample().name)}`.replace(/[^\w.+-]+/g, '_');
  const s = E.layout === 'strategy' ? expSample().name : E.layout === 'current' ? activeSample().name : (E.layout === 'overlay' || E.layout === 'ridge') ? `${popName(E.pop)}_${short(E.ch)}` : 'samples';
  return `${LAYOUTS.find(l => l.id === E.layout).name}_${s}`.replace(/[^\w.+-]+/g, '_');
}
function figureSvg(fig) { const c = new SvgCtx(Math.ceil(fig.W), Math.ceil(fig.H)); fig.draw(c); return c.toString(); }
function doExport() {
  const fig = buildFigure(); if (fig.empty) return;
  if (E.fmt === 'png') {
    const c = document.createElement('canvas'); c.width = Math.round(fig.W * E.scale); c.height = Math.round(fig.H * E.scale);
    const ctx = c.getContext('2d'); ctx.scale(E.scale, E.scale); fig.draw(ctx);
    c.toBlob(b => { download(URL.createObjectURL(b), figureName() + '.png'); toast('Figure exported as PNG.'); }, 'image/png');
  } else if (E.fmt === 'svg') {
    download(URL.createObjectURL(new Blob([figureSvg(fig)], { type: 'image/svg+xml' })), figureName() + '.svg'); toast('Figure exported as SVG.');
  } else {
    const svg = figureSvg(fig).replace(/^<\?xml[^>]*>\s*/, '');
    const w = window.open('', '_blank');
    if (!w) return toast('The print window was blocked. Allow pop-ups for this file, or export SVG and convert it.', true);
    w.document.write(`<!DOCTYPE html><html><head><title>${SvgCtx.esc(figureName())}</title><style>@page{size:${Math.ceil(fig.W)}px ${Math.ceil(fig.H)}px;margin:0}html,body{margin:0;padding:0}svg{display:block;width:100%;height:auto}</style></head><body>${svg}<script>window.onload=()=>setTimeout(()=>window.print(),150)<\/script></body></html>`);
    w.document.close();
  }
}

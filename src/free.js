// --------------------------------------------------- free-form canvas ---
/* A figure the user composes by hand: plot panels, text and arrows placed anywhere.
   Items are plain objects so they serialise straight into the project file, and they
   draw through the same paintPlot routine as every other layout, so PNG, SVG and PDF
   output all stay identical to the preview. */
const FREE_DEFAULT = () => ({ W: 900, H: 640, snap: 5, items: [] });
let freeSel = null, freeDrag = null, freeHover = null;
const ARROW_COLORS = ['#16212A', '#B3261E', '#0A73B8', '#2E8B57', '#7A3FD1', '#E08A00'];

function freeState() { if (!E.free) E.free = FREE_DEFAULT(); return E.free; }
const freeItems = () => freeState().items;
const freeById = id => freeItems().find(i => i.id === id);
function freeAdd(item) {
  const F = freeState();
  item.id = 'i' + (F.nextId = (F.nextId || 0) + 1);
  F.items.push(item); freeSel = item.id; markDirty(); renderExport();
  return item;
}
/* Finds somewhere the new item will actually be visible rather than buried under a plot. */
function freeFreeSpot(w, h, step = 16) {
  const F = freeState(), used = F.items.map(freeBounds);
  const clear = (x, y) => !used.some(b => x < b.x + b.w + 8 && x + w + 8 > b.x && y < b.y + b.h + 8 && y + h + 8 > b.y);
  for (let y = 24; y + h <= F.H; y += step) for (let x = 24; x + w <= F.W; x += step) if (clear(x, y)) return [x, y];
  let maxY = 24; used.forEach(b => { maxY = Math.max(maxY, b.y + b.h + 14); });
  if (maxY + h > F.H) F.H = Math.round(maxY + h + 24);
  return [24, maxY];
}
function addFreePanel(seed = {}) {
  const w = E.size, h = E.size, [x, y] = freeFreeSpot(w, h, Math.round(w / 4));
  const gr = plotGroups()[0];
  return freeAdd({ type: 'panel', x, y, w, h, pt: E.pt,
    sampleId: seed.sampleId ?? (E.sampleId || activeSample().id),
    pop: seed.pop ?? (gr ? gr.parent : S.view.pop),
    xch: seed.xch ?? (gr ? gr.x : S.view.x),
    ych: seed.ych !== undefined ? seed.ych : (gr ? gr.y : (S.view.y || null)) });
}
function addFreeText() {
  const [x, y] = freeFreeSpot(210, 26, 10);
  return freeAdd({ type: 'text', x, y, text: 'Double-click to edit', size: 15, weight: 600, color: '#16212A', align: 'left' });
}
function addFreeArrow(head) {
  const [x, y] = freeFreeSpot(170, 20, 10);
  return freeAdd({ type: 'arrow', x1: x + 6, y1: y + 10, x2: x + 160, y2: y + 10, head, width: 1.8, color: '#16212A' });
}
function fillFromStrategy() {
  const F = freeState(), s = expSample(), gs = expGroups();
  if (!gs.length) return toast('Draw some gates first, then this fills the canvas with them.', true);
  F.items = F.items.filter(i => i.type !== 'panel');
  const P = E.size, gap = 16, perRow = Math.max(1, Math.floor((F.W - 2 * 24 + gap) / (P + gap)));
  gs.forEach((gr, i) => {
    F.items.push({ id: 'i' + (F.nextId = (F.nextId || 0) + 1), type: 'panel', x: 24 + (i % perRow) * (P + gap), y: 24 + Math.floor(i / perRow) * (P + gap),
      w: P, h: P, pt: E.pt, sampleId: s.id, pop: gr.parent, xch: gr.x, ych: gr.y });
  });
  const rows = Math.ceil(gs.length / perRow);
  F.H = Math.max(F.H, 24 * 2 + rows * P + (rows - 1) * gap);
  freeSel = null; markDirty(); renderExport();
}
function fitFreeCanvas() {
  const F = freeState(); if (!F.items.length) return;
  let maxX = 0, maxY = 0;
  F.items.forEach(i => { const b = freeBounds(i); maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h); });
  F.W = Math.round(maxX + 24); F.H = Math.round(maxY + 24); markDirty(); renderExport();
}

/* One panel, one or more samples. With overlay on, each sample gets its own colour: curves for a
   histogram, alpha-blended dots otherwise. The legend carries each sample's gate frequency, which is
   the number you actually want when comparing conditions in a single plot. */
function panelSamples(it) {
  const base = S.samples.find(x => x.id === it.sampleId) || activeSample();
  const extra = (it.overlay || []).map(id => S.samples.find(x => x.id === id)).filter(Boolean).filter(x => x !== base);
  return [base, ...extra];
}
function panelPops(it) {
  const base = it.pop === 'root' || gateById(it.pop) ? it.pop : 'root';
  const extra = (it.popOverlay || []).filter(p => p !== base && (p === 'root' || gateById(p)));
  return [base, ...extra];
}
/* A panel can compare across samples, across populations, or both at once; the series are the
   cross product. Histograms become one curve per series, each normalised to its own mode so
   populations of very different size stay comparable; dot plots become alpha-blended colours. */
function freePanelSpec(it) {
  const ss = panelSamples(it), pops = panelPops(it), s = ss[0], pop = pops[0];
  const multiS = ss.length > 1, multiP = pops.length > 1, multi = multiS || multiP;
  const xch = S.channels.includes(it.xch) ? it.xch : S.channels[0];
  const ych = it.ych && S.channels.includes(it.ych) ? it.ych : null;
  const idx = getPop(s, pop), pn = idx.length;
  const gates = children(pop).filter(g => g.x === xch && (ych ? (g.type !== 'interval' && g.y === ych) : g.type === 'interval'));
  const shared = multiP ? pops.map(p => p === 'root' ? null : gateById(p).parent) : [];
  const sharedParent = multiP && shared.every(p => p && p === shared[0]) ? shared[0] : null;
  const defTitle = multiP ? (sharedParent ? popName(sharedParent) : label(xch)) : popName(pop);
  const spec = { xch, ych, xT: getT(s, xch), yT: ych ? getT(s, ych) : null, idx, small: it.w < 340, pt: it.pt || E.pt, fontScale: E.fontScale,
    gates: gates.map(g => ({ gate: g, pct: multi ? null : (pn ? getPop(s, g.id).length / pn * 100 : 0) })),
    labels: E.labels && !multiP, pct: multi ? false : E.pct, transparent: true,
    title: E.titles ? (it.title || defTitle) : '', subtitle: E.titles ? (it.subtitle || (multi ? '' : fmtInt(pn))) : '',
    cacheKey: `fp|${ss.map(x => x.id).join('.')}|${pops.join('.')}|${xch}|${ych}|${Math.round(it.w)}|${Math.round(it.h)}|${it.pt || E.pt}|${S.version}` };
  if (!multi) return spec;
  const parts = [];
  ss.forEach(x => pops.forEach(p => parts.push({ s: x, pop: p, idx: getPop(x, p) })));
  parts.forEach((p, k) => { p.color = RIDGE_COLORS[k % RIDGE_COLORS.length]; });
  if (ych) spec.series = parts.map(p => ({ xT: getT(p.s, xch), yT: getT(p.s, ych), idx: p.idx, color: p.color }));
  else spec.curves = parts.map(p => ({ xT: getT(p.s, xch), idx: p.idx, color: p.color }));
  spec.legendPos = it.legendPos || 'tr';
  if (it.legend !== false) {
    const gate = gates.length === 1 && !multiP ? gates[0] : null;
    spec.legendItems = parts.map(p => {
      const base = multiS && multiP ? `${p.s.name} \u00b7 ${popName(p.pop)}` : multiP ? popName(p.pop) : p.s.name;
      const stat = gate && p.idx.length ? `  ${fmtPct(getPop(p.s, gate.id).length / p.idx.length * 100)}`
        : multiP ? `  ${fmtInt(p.idx.length)}` : '';
      return { color: p.color, name: base + stat };
    });
  }
  return spec;
}
function drawFreeItem(ctx, it) {
  if (it.type === 'panel') { ctx.save(); ctx.translate(it.x, it.y); paintPlot(ctx, freePanelSpec(it), it.w, it.h); ctx.restore(); return; }
  if (it.type === 'text') {
    const lines = String(it.text || '').split('\n');
    ctx.font = `${it.weight || 400} ${it.size}px ${FONT}`; ctx.fillStyle = it.color || '#16212A';
    ctx.textAlign = it.align || 'left'; ctx.textBaseline = 'alphabetic';
    lines.forEach((ln, k) => ctx.fillText(ln, it.x, it.y + it.size + k * it.size * 1.35));
    return;
  }
  // arrow / line
  const dx = it.x2 - it.x1, dy = it.y2 - it.y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const hl = Math.max(7, (it.width || 1.8) * 4.2), hw = hl * 0.55;
  const endHead = it.head === 'end' || it.head === 'both', startHead = it.head === 'both';
  ctx.strokeStyle = it.color || '#16212A'; ctx.lineWidth = it.width || 1.8;
  if (it.dashed) ctx.setLineDash([it.width * 3, it.width * 2.2]);
  ctx.beginPath();
  ctx.moveTo(it.x1 + (startHead ? ux * hl * 0.9 : 0), it.y1 + (startHead ? uy * hl * 0.9 : 0));
  ctx.lineTo(it.x2 - (endHead ? ux * hl * 0.9 : 0), it.y2 - (endHead ? uy * hl * 0.9 : 0));
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = it.color || '#16212A';
  const head = (tipX, tipY, sx, sy) => {
    ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - sx * hl - (-sy) * hw, tipY - sy * hl - sx * hw);
    ctx.lineTo(tipX - sx * hl + (-sy) * hw, tipY - sy * hl - (-sx) * hw);
    ctx.closePath(); ctx.fill();
  };
  if (endHead) head(it.x2, it.y2, ux, uy);
  if (startHead) head(it.x1, it.y1, -ux, -uy);
}
function freeBounds(it) {
  if (it.type === 'panel') return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.type === 'text') {
    const lines = String(it.text || ' ').split('\n');
    ctx0.font = `${it.weight || 400} ${it.size}px ${FONT}`;
    const w = Math.max(...lines.map(l => ctx0.measureText(l).width), 10), h = it.size * (1 + (lines.length - 1) * 1.35) * 1.1;
    const x = it.align === 'center' ? it.x - w / 2 : it.align === 'right' ? it.x - w : it.x;
    return { x, y: it.y, w, h };
  }
  const pad = Math.max(6, (it.width || 2) * 3);
  return { x: Math.min(it.x1, it.x2) - pad, y: Math.min(it.y1, it.y2) - pad, w: Math.abs(it.x2 - it.x1) + 2 * pad, h: Math.abs(it.y2 - it.y1) + 2 * pad };
}
function freeFigure() {
  const F = freeState(), W = F.W, H = F.H;
  return { W, H, free: true, draw: ctx => {
    if (!E.transparent) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    if (E.heading) { ctx.font = `600 ${17 * E.fontScale}px ${FONT}`; ctx.fillStyle = '#16212A'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(E.heading, 22, 22 + 16 * E.fontScale); }
    F.items.forEach(it => drawFreeItem(ctx, it));
  } };
}

// ---------- selection chrome, drawn on the preview only
function drawFreeChrome(ctx, sc) {
  const it = freeById(freeSel);
  const ring = (b, color) => { ctx.save(); ctx.setLineDash([4 / sc, 3 / sc]); ctx.strokeStyle = color; ctx.lineWidth = 1 / sc; ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4); ctx.restore(); };
  if (freeHover && freeHover !== freeSel) { const h = freeById(freeHover); if (h) ring(freeBounds(h), 'rgba(22,33,42,.35)'); }
  if (!it) return;
  const b = freeBounds(it); ring(b, '#0A73B8');
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#0A73B8'; ctx.lineWidth = 1.5 / sc;
  const hs = 4.5 / sc;
  freeHandles(it).forEach(p => { ctx.beginPath(); ctx.rect(p[0] - hs, p[1] - hs, hs * 2, hs * 2); ctx.fill(); ctx.stroke(); });
}
function freeHandles(it) {
  if (it.type === 'panel') return [[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h]];
  if (it.type === 'text') return [];
  return [[it.x1, it.y1], [it.x2, it.y2]];
}
function freeHit(x, y, sc) {
  const tol = 7 / sc;
  const it = freeById(freeSel);
  if (it) { const hs = freeHandles(it); for (let i = 0; i < hs.length; i++) if (Math.abs(hs[i][0] - x) < tol + 2 && Math.abs(hs[i][1] - y) < tol + 2) return { item: it, handle: i }; }
  const items = freeItems();
  for (let i = items.length - 1; i >= 0; i--) {
    const o = items[i];
    if (o.type === 'arrow') { if (distToSeg(x, y, o.x1, o.y1, o.x2, o.y2) < Math.max(tol, (o.width || 2) * 1.5)) return { item: o, handle: -1 }; continue; }
    const b = freeBounds(o);
    if (x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2) return { item: o, handle: -1 };
  }
  return null;
}
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
const snapv = v => { const s = freeState().snap; return s > 1 ? Math.round(v / s) * s : Math.round(v); };

function freePointerDown(e) {
  const cvp = $('#expPreview'), r = cvp.getBoundingClientRect(), sc = r.width / freeState().W;
  const x = (e.clientX - r.left) / sc, y = (e.clientY - r.top) / sc;
  const hit = freeHit(x, y, sc);
  cvp.setPointerCapture(e.pointerId);
  if (!hit) { if (freeSel) { freeSel = null; renderExport(); } return; }
  const changed = freeSel !== hit.item.id;
  freeSel = hit.item.id;
  freeDrag = { item: hit.item, handle: hit.handle, ox: x, oy: y, orig: JSON.parse(JSON.stringify(hit.item)), moved: false };
  if (changed) renderExport(); else renderExportPreview();
}
function freePointerMove(e) {
  const cvp = $('#expPreview'), r = cvp.getBoundingClientRect(), F = freeState(), sc = r.width / F.W;
  const x = (e.clientX - r.left) / sc, y = (e.clientY - r.top) / sc;
  if (!freeDrag) {
    const hit = freeHit(x, y, sc), id = hit ? hit.item.id : null;
    cvp.style.cursor = hit ? (hit.handle >= 0 ? 'nwse-resize' : 'move') : 'default';
    if (id !== freeHover) { freeHover = id; renderExportPreview(); }
    return;
  }
  const d = freeDrag, o = d.orig, dx = x - d.ox, dy = y - d.oy;
  d.moved = true;
  if (d.handle < 0) {
    if (o.type === 'arrow') { d.item.x1 = snapv(o.x1 + dx); d.item.y1 = snapv(o.y1 + dy); d.item.x2 = snapv(o.x2 + dx); d.item.y2 = snapv(o.y2 + dy); }
    else { d.item.x = snapv(o.x + dx); d.item.y = snapv(o.y + dy); }
  } else if (o.type === 'arrow') {
    const k = d.handle === 0 ? '1' : '2';
    d.item['x' + k] = snapv(o['x' + k] + dx); d.item['y' + k] = snapv(o['y' + k] + dy);
  } else {
    let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
    if (d.handle === 0) { x0 = o.x + dx; y0 = o.y + dy; } else if (d.handle === 1) { x1 = o.x + o.w + dx; y0 = o.y + dy; }
    else if (d.handle === 2) { x1 = o.x + o.w + dx; y1 = o.y + o.h + dy; } else { x0 = o.x + dx; y1 = o.y + o.h + dy; }
    if (e.shiftKey) { const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); if (d.handle === 0 || d.handle === 3) x0 = x1 - side; else x1 = x0 + side; if (d.handle === 0 || d.handle === 1) y0 = y1 - side; else y1 = y0 + side; }
    d.item.x = snapv(Math.min(x0, x1)); d.item.y = snapv(Math.min(y0, y1));
    d.item.w = Math.max(140, snapv(Math.abs(x1 - x0))); d.item.h = Math.max(120, snapv(Math.abs(y1 - y0)));
  }
  renderExportPreview();
}
function freePointerUp() { if (freeDrag) { if (freeDrag.moved) { markDirty(); renderExport(); } freeDrag = null; } }
function freeDblClick(e) {
  const r = $('#expPreview').getBoundingClientRect(), sc = r.width / freeState().W;
  const hit = freeHit((e.clientX - r.left) / sc, (e.clientY - r.top) / sc, sc);
  if (hit && hit.item.type === 'text') { freeSel = hit.item.id; renderExport(); const f = $('#freeTextInput'); if (f) { f.focus(); f.select(); } }
}
function freeDelete() { const it = freeById(freeSel); if (!it) return; freeState().items = freeItems().filter(i => i !== it); freeSel = null; markDirty(); renderExport(); }
function freeDuplicate() {
  const it = freeById(freeSel); if (!it) return;
  const c = JSON.parse(JSON.stringify(it));
  if (c.type === 'arrow') { c.x1 += 16; c.y1 += 16; c.x2 += 16; c.y2 += 16; } else { c.x += 16; c.y += 16; }
  freeAdd(c);
}
function freeZ(dir) {
  const F = freeState(), i = F.items.findIndex(o => o.id === freeSel); if (i < 0) return;
  const j = dir === 'front' ? F.items.length - 1 : dir === 'back' ? 0 : Math.min(F.items.length - 1, Math.max(0, i + dir));
  const [o] = F.items.splice(i, 1); F.items.splice(j, 0, o); markDirty(); renderExport();
}

// ---------- inspector for the free canvas
function freeControls() {
  const F = freeState(), out = [];
  out.push(el('div', { class: 'expsec' }, el('h3', {}, 'Canvas'),
    el('div', { class: 'freeadd' },
      el('button', { class: 'btn', onclick: () => addFreePanel() }, '+ Plot'),
      el('button', { class: 'btn', onclick: addFreeText }, '+ Text'),
      el('button', { class: 'btn', onclick: () => addFreeArrow('end') }, '+ Arrow'),
      el('button', { class: 'btn', onclick: () => addFreeArrow('none') }, '+ Line')),
    fieldRange('Width', 300, 2000, 10, F.W, v => { F.W = v; markDirty(); renderExportPreview(); }, v => v + ' px'),
    fieldRange('Height', 240, 2000, 10, F.H, v => { F.H = v; markDirty(); renderExportPreview(); }, v => v + ' px'),
    fieldSel('Snap', [[1, 'Off'], [5, '5 px'], [10, '10 px'], [25, '25 px']], F.snap, v => { F.snap = +v; markDirty(); }),
    el('div', { class: 'minibtns', style: 'padding-left:0' },
      el('button', { class: 'btn', title: 'Lay out every gating step of the chosen sample', onclick: fillFromStrategy }, 'Fill from strategy'),
      el('button', { class: 'btn', onclick: fitFreeCanvas }, 'Shrink to fit')),
    el('p', { class: 'hint', style: 'padding:8px 0 0' }, freeItems().length ? 'Drag items in the preview to move them, corners to resize. Double-click text to edit.' : 'Add a plot, then arrange it freely. Nothing here is locked to a grid.')));

  const it = freeById(freeSel);
  const sec = el('div', { class: 'expsec' }, el('h3', {}, it ? ({ panel: 'Selected plot', text: 'Selected text', arrow: 'Selected line' })[it.type] : 'Selection'));
  if (!it) { sec.append(el('p', { class: 'hint', style: 'padding:0' }, 'Click an item in the preview to edit it.')); out.push(sec); return out; }
  const upd = (k, v, full) => { it[k] = v; markDirty(); full ? renderExport() : renderExportPreview(); };
  if (it.type === 'panel') {
    sec.append(fieldSel('Sample', S.samples.map(s => [s.id, s.name]), it.sampleId, v => upd('sampleId', +v)));
    sec.append(fieldSel('Population', dfs().map(({ id, depth }) => [id, '\u2002'.repeat(depth) + popName(id)]), it.pop, v => upd('pop', v, true)));
    sec.append(fieldSel('X axis', S.channels.map(c => [c, label(c)]), it.xch, v => upd('xch', v, true)));
    sec.append(fieldSel('Y axis', [['', 'Histogram'], ...S.channels.map(c => [c, label(c)])], it.ych || '', v => upd('ych', v || null, true)));
    sec.append(fieldText('Title', it.title || '', v => upd('title', v)));
    const others = S.samples.filter(s => s.id !== it.sampleId);
    const otherPops = dfs().filter(d => d.id !== it.pop);
    sec.append(el('div', { class: 'sublabel' }, 'Also show: other samples'),
      checkList(others.map(s => [s.id, s.name]), id => (it.overlay || []).includes(id), (id, on) => {
        const cur = new Set(it.overlay || []); on ? cur.add(id) : cur.delete(id);
        it.overlay = [...cur]; markDirty(); renderExport();
      }, 'Load more samples to overlay them.'));
    sec.append(el('div', { class: 'sublabel' }, 'Also show: other populations'),
      checkList(otherPops.map(({ id, depth }) => [id, '\u2002'.repeat(depth) + popName(id)]), id => (it.popOverlay || []).includes(id), (id, on) => {
        const cur = new Set(it.popOverlay || []); on ? cur.add(id) : cur.delete(id);
        it.popOverlay = [...cur]; markDirty(); renderExport();
      }, 'Draw more gates to overlay their populations.'));
    if ((it.overlay || []).length || (it.popOverlay || []).length) sec.append(...[
      checkRow('Legend', it.legend !== false, v => upd('legend', v)),
      it.legend === false ? null : fieldSel('Legend corner', [['tr', 'Top right'], ['tl', 'Top left'], ['br', 'Bottom right'], ['bl', 'Bottom left']], it.legendPos || 'tr', v => upd('legendPos', v)),
      el('p', { class: 'hint', style: 'padding:2px 0 0' }, (it.popOverlay || []).length
        ? 'Each population is drawn in its own colour and, on a histogram, normalised to its own mode so sizes stay comparable. The legend shows event counts.'
        : 'Samples are coloured individually. With exactly one gate on the panel, the legend shows each sample\u2019s frequency for it.')].filter(Boolean));
  } else if (it.type === 'text') {
    const ta = el('textarea', { id: 'freeTextInput', rows: 3, class: 'freetext', oninput: e => upd('text', e.target.value) }); ta.value = it.text || '';
    sec.append(el('div', { class: 'field', style: 'align-items:start' }, el('label', { for: 'freeTextInput' }, 'Text'), ta));
    sec.append(fieldRange('Size', 8, 40, 1, it.size, v => upd('size', v), v => v + ' px'));
    sec.append(fieldSel('Weight', [[400, 'Regular'], [600, 'Bold']], it.weight || 400, v => upd('weight', +v)));
    sec.append(fieldSel('Align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], it.align || 'left', v => upd('align', v)));
    sec.append(swatchRow(it.color || '#16212A', v => upd('color', v)));
  } else {
    sec.append(fieldSel('Ends', [['end', 'Arrow one end'], ['both', 'Arrows both ends'], ['none', 'Plain line']], it.head, v => upd('head', v)));
    sec.append(fieldRange('Thickness', 1, 6, 0.5, it.width || 1.8, v => upd('width', v)));
    sec.append(checkRow('Dashed', !!it.dashed, v => upd('dashed', v)));
    sec.append(swatchRow(it.color || '#16212A', v => upd('color', v)));
  }
  sec.append(el('div', { class: 'minibtns', style: 'padding-left:0;margin-top:6px' },
    el('button', { class: 'btn', onclick: () => freeZ('front') }, 'Bring to front'),
    el('button', { class: 'btn', onclick: () => freeZ('back') }, 'Send to back'),
    el('button', { class: 'btn', onclick: freeDuplicate }, 'Duplicate'),
    el('button', { class: 'btn danger', onclick: freeDelete }, 'Delete')));
  out.push(sec);
  return out;
}
function numBox(val, onchange) { return el('input', { type: 'number', class: 'numbox', value: Math.round(val), min: 100, step: 10, onchange: e => onchange(Math.round(+e.target.value || 0)) }); }
function swatchRow(cur, onpick) {
  return el('div', { class: 'field' }, el('label', {}, 'Colour'), el('div', { class: 'swatches' },
    ...ARROW_COLORS.map(c => el('button', { class: 'sw' + (c.toLowerCase() === String(cur).toLowerCase() ? ' on' : ''), style: `background:${c}`, 'aria-label': `Colour ${c}`, onclick: () => onpick(c) }))));
}

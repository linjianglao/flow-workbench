// ------------------------------------------------------------ projects ---
/* A project file bundles the original FCS bytes with the whole analysis (gates, transforms,
   compensation, sample names, control assignments, view and export settings).
   Layout: gzip( "FWPROJ01" | uint32 header length | header JSON | FCS file bytes ... ) */
const PROJ_MAGIC = 'FWPROJ01';
let projHandle = null, pickerUsable = true;
S.projectName = null; S.dirty = false;

function markDirty() { if (S.samples.length && !S.dirty) { S.dirty = true; renderProjName(); } }
function markSaved(name) { S.dirty = false; if (name) S.projectName = name; renderProjName(); }
function renderProjName() {
  const e = $('#projName'); if (!e) return;
  if (!S.samples.length) { e.textContent = ''; return; }
  e.replaceChildren(...[el('span', {}, S.projectName ? S.projectName.replace(/\.fwproj$/i, '') : 'Untitled project'),
    S.dirty ? el('span', { class: 'unsaved', title: 'There are changes that are not in a saved project file' }, 'Unsaved') : null].filter(Boolean));
  document.title = (S.projectName ? S.projectName.replace(/\.fwproj$/i, '') + ' - ' : '') + 'Flow Workbench';
}

function resetState() {
  Object.assign(S, { samples: [], active: -1, channels: [], stains: {}, ranges: {}, transforms: {}, tfns: {}, spill: null, fileSpill: null, compOn: false,
    gates: [], nextId: 1, ctrl: {}, overlays: new Set(), statChans: null, projectName: null, dirty: false,
    groups: [], activeGroup: null, overrides: {}, statGroup: 'all', statSummary: false, gateEditScope: 'group' });
  S.view = { x: null, y: null, pop: 'root', tool: 'pointer', sel: null, pt: 2 };
  densityCache.clear(); S.version++; projHandle = null;
}

async function gzip(blob) {
  if (!('CompressionStream' in window)) return blob;
  return new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}
async function gunzip(bytes) {
  if (!('DecompressionStream' in window)) throw new Error('This browser cannot open compressed project files. Update Safari or Chrome and try again.');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

async function buildProject() {
  // Prefer the bytes the file arrived with, so keywords (cytometer, dates, $SPILLOVER) survive untouched.
  const blobs = S.samples.map(s => s.bytes || (s.bytes = Core.writeFCS(s.fcs)));
  const header = {
    format: 'flow-workbench-project', version: 1, saved: new Date().toISOString(),
    samples: S.samples.map((s, i) => ({ name: s.name, fileName: s.fcs.fileName, control: S.ctrl[s.id] || null, bytes: blobs[i].length })),
    channels: S.channels, transforms: S.transforms,
    compensation: { apply: S.compOn, spillover: S.spill, fromFile: S.fileSpill },
    gates: S.gates, nextId: S.nextId,
    groups: S.groups.map(g => ({ ...g, members: g.members.map(id => S.samples.findIndex(s => s.id === id)).filter(i => i >= 0) })),
    activeGroup: S.activeGroup,
    overrides: Object.entries(S.overrides).map(([k, v]) => {
      const [sid, gid] = k.split(':');
      return { sample: S.samples.findIndex(s => String(s.id) === sid), gate: gid, pts: v.pts };
    }).filter(o => o.sample >= 0),
    statGroup: S.statGroup, statSummary: S.statSummary,
    view: { x: S.view.x, y: S.view.y, pop: S.view.pop, pt: S.view.pt }, active: S.active, tab: S.tab,
    overlays: [...S.overlays].map(id => S.samples.findIndex(s => s.id === id)).filter(i => i >= 0),
    statChans: S.statChans, statKind: $('#statKind').value, exportSettings: exportSettingsForSave()
  };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  const pre = new Uint8Array(12); pre.set(new TextEncoder().encode(PROJ_MAGIC)); new DataView(pre.buffer).setUint32(8, hb.length, true);
  return gzip(new Blob([pre, hb, ...blobs], { type: 'application/octet-stream' }));
}

async function saveProject(saveAs) {
  if (!S.samples.length) return toast('Add samples before saving a project.', true);
  let blob;
  try { blob = await buildProject(); } catch (e) { return toast('The project could not be saved: ' + e.message, true); }
  const mb = (blob.size / 1048576).toFixed(blob.size > 1048576 * 10 ? 0 : 1);
  const suggested = (S.projectName || (S.samples[0].name + ' analysis')).replace(/\.fwproj$/i, '').replace(/[\\/:*?"<>|]+/g, '_') + '.fwproj';
  if (window.showSaveFilePicker && pickerUsable) {
    const t0 = performance.now();
    try {
      if (!projHandle || saveAs) projHandle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'Flow Workbench project', accept: { 'application/octet-stream': ['.fwproj'] } }] });
      const w = await projHandle.createWritable(); await w.write(blob); await w.close();
      markSaved(projHandle.name); toast(`Saved ${projHandle.name} (${mb} MB).`); return;
    } catch (e) {
      projHandle = null;
      // A dialog a person saw and dismissed takes time; an instant abort means this context
      // cannot show one (sandboxed frame, some file:// setups), so fall through to a download.
      if (e.name === 'AbortError') { if (performance.now() - t0 > 250) return; pickerUsable = false; }
    }
  }
  download(URL.createObjectURL(blob), suggested);
  markSaved(suggested); toast(`Project downloaded as ${suggested} (${mb} MB). Open it with File > Open project next time.`);
}

async function pickProject() {
  if (S.dirty && !confirm('Open another project? Changes that are not in a saved project file will be lost.')) return;
  if (window.showOpenFilePicker && pickerUsable) {
    const t0 = performance.now();
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'Flow Workbench project', accept: { 'application/octet-stream': ['.fwproj'] } }] });
      await openProject(await h.getFile(), h); return;
    } catch (e) { if (e.name === 'AbortError' && performance.now() - t0 > 250) return; pickerUsable = false; }
  }
  $('#projIn').click();
}

async function openProject(file, handle = null) {
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    if (new TextDecoder().decode(bytes.subarray(0, 8)) !== PROJ_MAGIC) throw new Error(`${file.name} is not a Flow Workbench project file.`);
  } catch (e) { return toast(e.message, true); }
  const hl = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const P = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl)));
  if (P.format !== 'flow-workbench-project') return toast(`${file.name} is not a Flow Workbench project file.`, true);
  resetState();
  const realToast = toast, problems = []; toast = (m, err) => err ? problems.push(m) : null;
  let off = 12 + hl;
  for (const h of P.samples) {
    const chunk = bytes.slice(off, off + h.bytes); off += h.bytes;
    try {
      if (addSample(Core.parseFCS(chunk.buffer, h.fileName), chunk)) {
        const s = S.samples[S.samples.length - 1]; s.name = h.name;
        if (h.control) S.ctrl[s.id] = h.control; else delete S.ctrl[s.id];
      }
    } catch (e) { problems.push(`${h.name}: ${e.message}`); }
  }
  toast = realToast;
  if (!S.samples.length) return toast('No samples could be read from this project. ' + problems.join(' '), true);
  Object.entries(P.transforms || {}).forEach(([c, cfg]) => { if (S.channels.includes(c)) S.transforms[c] = cfg; });
  S.tfns = {};
  const comp = P.compensation || {};
  S.spill = comp.spillover || null; S.fileSpill = comp.fromFile || S.fileSpill; S.compOn = !!comp.apply && !!S.spill;
  S.gates = P.gates || []; S.nextId = P.nextId || (S.gates.length + 1);
  if (P.groups && P.groups.length) {
    S.groups = P.groups.map(g => ({ ...g, members: g.members.map(i => S.samples[i]).filter(Boolean).map(s => s.id) }));
    S.activeGroup = S.groups.some(g => g.id === P.activeGroup) ? P.activeGroup : S.groups[0].id;
  } else {
    // A 1.0 project has no groups: fold its single tree into one group holding every sample.
    S.groups = [{ id: 'G1', name: 'All samples', color: GROUP_COLORS[0], members: S.samples.map(s => s.id) }];
    S.activeGroup = 'G1';
    S.gates.forEach(g => { if (!g.group) g.group = 'G1'; });
  }
  S.overrides = {};
  (P.overrides || []).forEach(o => { const s = S.samples[o.sample]; if (s && gateById(o.gate)) S.overrides[s.id + ':' + o.gate] = { pts: o.pts }; });
  S.statGroup = P.statGroup || 'all'; S.statSummary = !!P.statSummary;
  const v = P.view || {};
  if (S.channels.includes(v.x)) S.view.x = v.x;
  if (v.y === '' || S.channels.includes(v.y)) S.view.y = v.y;
  S.view.pop = v.pop === 'root' || gateById(v.pop) ? v.pop : 'root'; S.view.pt = v.pt || 2;
  S.active = Math.min(Math.max(0, P.active || 0), S.samples.length - 1);
  (P.overlays || []).forEach(i => S.samples[i] && S.overlays.add(S.samples[i].id));
  S.statChans = P.statChans ? P.statChans.filter(c => S.channels.includes(c)) : null;
  if (P.statKind) $('#statKind').value = P.statKind;
  restoreExportSettings(P.exportSettings);
  invalidate({ comp: true });
  projHandle = handle; S.tab = ['gate', 'scheme', 'comp', 'stats', 'export'].includes(P.tab) ? P.tab : 'gate';
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === S.tab));
  markSaved(file.name);
  renderAll(); $('#ptSize').value = S.view.pt;
  toast(problems.length ? `Opened ${file.name}, with problems: ${problems.join(' ')}` : `Opened ${file.name}: ${S.samples.length} samples, ${S.gates.length} gates.`, problems.length > 0);
}

// file menu
function toggleMenu(open) {
  const m = $('#fileMenu'), b = $('#btnFile');
  const on = open ?? m.classList.contains('hidden');
  m.classList.toggle('hidden', !on); b.setAttribute('aria-expanded', on);
  if (on) { const first = m.querySelector('button:not(:disabled)'); first && first.focus(); }
}

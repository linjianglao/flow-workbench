// ------------------------------------------------------------- groups ---
/* A group is a named set of samples that share one gating tree. Groups own their gates
   (gate.group), a sample may belong to several groups, and the active group decides which
   tree the Gate tab shows. Because two groups can gate the same file differently, a
   population is identified by the pair (group, gate) rather than by gate alone.

   Within a group a sample may carry per-gate overrides: the group defines the shape, and one
   file can have that shape nudged where its population sat differently. Overrides are keyed
   by sample and gate, so they survive renaming and regrouping. */
const GROUP_COLORS = ['#0A73B8', '#D8342C', '#2E8B57', '#7A3FD1', '#E08A00', '#C2185B', '#14A6C8', '#6D7A2A'];

S.groups = []; S.activeGroup = null; S.overrides = {}; S.gateEditScope = 'group';

const groupById = id => S.groups.find(g => g.id === id);
const activeGroup = () => groupById(S.activeGroup) || S.groups[0] || null;
const groupMembers = g => (g ? g.members.map(id => S.samples.find(s => s.id === id)).filter(Boolean) : []);
const groupsOf = s => S.groups.filter(g => g.members.includes(s.id));
const inActiveGroup = s => { const g = activeGroup(); return !!g && g.members.includes(s.id); };

function newGroupId() { let n = 1; while (S.groups.some(g => g.id === 'G' + n)) n++; return 'G' + n; }
function ensureGroups() {
  if (S.groups.length) { if (!groupById(S.activeGroup)) S.activeGroup = S.groups[0].id; return; }
  S.groups = [{ id: 'G1', name: 'All samples', color: GROUP_COLORS[0], members: S.samples.map(s => s.id) }];
  S.activeGroup = 'G1';
  // Gates drawn before groups existed (or loaded from a 1.0 project) belong to that first group.
  S.gates.forEach(g => { if (!g.group) g.group = 'G1'; });
}
function addGroup(name) {
  ensureGroups();
  const g = { id: newGroupId(), name: name || `Group ${S.groups.length + 1}`, color: GROUP_COLORS[S.groups.length % GROUP_COLORS.length], members: [] };
  S.groups.push(g); setActiveGroup(g.id); markDirty();
  return g;
}
function setActiveGroup(id) {
  if (S.activeGroup === id) return;
  S.activeGroup = id;
  S.view.pop = 'root'; S.view.sel = null;
  // Keep the active sample inside the group being viewed, so the plot is never empty by surprise.
  const members = groupMembers(activeGroup());
  if (members.length && !members.includes(activeSample())) S.active = S.samples.indexOf(members[0]);
  renderAll();
}
function renameGroup(g, name) { g.name = name; markDirty(); renderAll(); }
function deleteGroup(id) {
  const g = groupById(id); if (!g) return;
  const gates = S.gates.filter(x => x.group === id);
  if (S.groups.length === 1) return toast('There has to be at least one group. Rename this one instead.', true);
  if (gates.length && !confirm(`Delete "${g.name}" and its ${gates.length} gate${gates.length === 1 ? '' : 's'}? The samples themselves stay loaded.`)) return;
  const ids = new Set(gates.map(x => x.id));
  S.gates = S.gates.filter(x => x.group !== id);
  Object.keys(S.overrides).forEach(k => { if (ids.has(k.split(':')[1])) delete S.overrides[k]; });
  S.groups = S.groups.filter(x => x.id !== id);
  if (S.activeGroup === id) { S.activeGroup = S.groups[0].id; S.view.pop = 'root'; S.view.sel = null; }
  invalidateGates(); renderAll();
}
function toggleMember(g, sampleId, on) {
  const i = g.members.indexOf(sampleId);
  if (on && i < 0) g.members.push(sampleId);
  if (!on && i >= 0) {
    g.members.splice(i, 1);
    // An override only means anything while the sample is in the group that owns the gate.
    S.gates.filter(x => x.group === g.id).forEach(x => delete S.overrides[sampleId + ':' + x.id]);
  }
  markDirty(); invalidateGates(); renderAll();
}
/* Copy a whole gating tree into another group. Ids are reissued so the two trees stay
   independent — editing one must never move the other. */
function copyGatesTo(fromId, toId) {
  const src = S.gates.filter(g => g.group === fromId);
  if (!src.length) return toast('That group has no gates to copy.', true);
  const to = groupById(toId); if (!to) return;
  const existing = S.gates.filter(g => g.group === toId).length;
  if (existing && !confirm(`Replace the ${existing} gate${existing === 1 ? '' : 's'} in "${to.name}"?`)) return;
  S.gates = S.gates.filter(g => g.group !== toId);
  const map = {};
  src.forEach(g => { map[g.id] = 'g' + (S.nextId++); });
  const quadMap = {};
  src.forEach(g => {
    const copy = JSON.parse(JSON.stringify(g));
    copy.id = map[g.id]; copy.group = toId;
    copy.parent = map[g.parent] || g.parent;
    if (g.quadGroup) copy.quadGroup = (quadMap[g.quadGroup] = quadMap[g.quadGroup] || 'q' + (S.nextId++));
    S.gates.push(copy);
  });
  markDirty(); invalidateGates(); renderAll();
  toast(`Copied ${src.length} gate${src.length === 1 ? '' : 's'} into ${to.name}.`);
}

// ----------------------------------------------------------- overrides ---
const ovKey = (s, g) => s.id + ':' + g.id;
const hasOverride = (s, g) => !!S.overrides[ovKey(s, g)];
/* The gate as it applies to this sample: the group's shape unless this file overrides it. */
function effGate(s, g) {
  const o = S.overrides[ovKey(s, g)];
  return o ? Object.assign({}, g, { pts: o.pts }) : g;
}
/* The mutable object a drag should write into, creating an override seeded from the group shape. */
function editTarget(s, g) {
  if (S.gateEditScope !== 'sample') return g;
  const k = ovKey(s, g);
  if (!S.overrides[k]) S.overrides[k] = { pts: JSON.parse(JSON.stringify(g.pts)) };
  const o = S.overrides[k];
  // Mirror the fields the editing helpers read, so they can treat this like a gate.
  return Object.assign(o, { id: g.id, name: g.name, parent: g.parent, group: g.group, type: g.type, x: g.x, y: g.y, quadrant: g.quadrant, quadGroup: g.quadGroup, _ov: s.id });
}
function clearOverride(s, g, quiet) {
  const gates = g.quadGroup ? S.gates.filter(x => x.quadGroup === g.quadGroup) : [g];
  let n = 0;
  gates.forEach(x => { if (S.overrides[ovKey(s, x)]) { delete S.overrides[ovKey(s, x)]; n++; } });
  if (!n) return;
  markDirty(); invalidateGates(); renderGateTab(); renderTree();
  if (!quiet) toast(`${popName(g.id)} on ${s.name} is back to the group shape.`);
}
function clearGroupOverrides(groupId) {
  const ids = new Set(S.gates.filter(g => g.group === groupId).map(g => g.id));
  const hits = Object.keys(S.overrides).filter(k => ids.has(k.split(':')[1]));
  if (!hits.length) return toast('No samples in this group have adjusted gates.', true);
  if (!confirm(`Reset ${hits.length} adjusted gate${hits.length === 1 ? '' : 's'} back to the group shape?`)) return;
  hits.forEach(k => delete S.overrides[k]);
  markDirty(); invalidateGates(); renderAll();
}
const overrideCount = groupId => {
  const ids = new Set(S.gates.filter(g => g.group === groupId).map(g => g.id));
  return Object.keys(S.overrides).filter(k => ids.has(k.split(':')[1])).length;
};
const sampleOverrides = s => Object.keys(S.overrides).filter(k => k.startsWith(s.id + ':')).length;

// --------------------------------------------------------------- panel ---
function renderGroups() {
  ensureGroups();
  const ul = $('#groupList'); if (!ul) return;
  ul.replaceChildren();
  S.groups.forEach(g => {
    const n = g.members.length, ov = overrideCount(g.id), gates = S.gates.filter(x => x.group === g.id).length;
    const li = el('li', {
      class: g.id === S.activeGroup ? 'on' : '',
      title: `${n} sample${n === 1 ? '' : 's'}, ${gates} gate${gates === 1 ? '' : 's'}${ov ? `, ${ov} adjusted` : ''}`,
      onclick: () => setActiveGroup(g.id),
      ondblclick: e => askName({ left: e.clientX, top: e.clientY }, 'Rename group', g.name, v => { if (v) renameGroup(g, v); })
    },
      el('span', { class: 'gdot', style: `background:${g.color}` }),
      el('span', { class: 'gname' }, g.name),
      el('span', { class: 'gmeta' }, `${n} / ${gates}g`),
      el('button', { class: 'iconbtn', title: 'Rename', 'aria-label': `Rename ${g.name}`, onclick: e => { e.stopPropagation(); renameGroup2(g, e.currentTarget); } }, '✎'),
      el('button', { class: 'iconbtn', title: 'Delete group', 'aria-label': `Delete ${g.name}`, onclick: e => { e.stopPropagation(); deleteGroup(g.id); } }, '×'));
    ul.append(li);
  });
  const act = activeGroup();
  const box = $('#groupActions'); box.replaceChildren(...[
    el('button', { class: 'btn', onclick: () => addGroup() }, '+ Group'),
    el('button', { class: 'btn', title: 'Put every loaded sample in this group', onclick: () => { act.members = S.samples.map(s => s.id); markDirty(); invalidateGates(); renderAll(); } }, 'Add all'),
    S.groups.length > 1 ? el('button', { class: 'btn', title: 'Copy this group’s gating tree into another group', onclick: e => copyMenu(e.currentTarget) }, 'Copy gating →') : null,
    overrideCount(S.activeGroup) ? el('button', { class: 'btn', title: 'Discard every per-sample adjustment in this group', onclick: () => clearGroupOverrides(S.activeGroup) }, 'Reset adjusted') : null].filter(Boolean));
  const hint = $('#groupHint');
  hint.textContent = act && act.members.length
    ? 'Gates you draw belong to this group and apply to every sample ticked below.'
    : 'Tick samples below to add them to this group.';
}
function renameGroup2(g, anchor) {
  const r = anchor.getBoundingClientRect();
  askName({ left: r.left - 120, top: r.bottom + 6 }, 'Rename group', g.name, v => { if (v) renameGroup(g, v); });
}
function copyMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const others = S.groups.filter(g => g.id !== S.activeGroup);
  const pop = el('div', { class: 'pop', style: `position:fixed;left:${Math.max(8, r.left - 60)}px;top:${r.bottom + 6}px;width:220px` },
    el('label', {}, `Copy gating from ${activeGroup().name} into`),
    ...others.map(g => el('button', { class: 'btn', style: 'width:100%;margin-top:5px;text-align:left', onclick: () => { pop.remove(); copyGatesTo(S.activeGroup, g.id); } },
      el('span', { class: 'gdot', style: `background:${g.color};margin-right:7px` }), g.name)),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => pop.remove() }, 'Cancel')));
  const off = e => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); } };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
  document.body.append(pop);
}

/* The scope switch lives with the selected gate, because that is where it changes what a drag does. */
function editScopeControl() {
  const s = activeSample(), g = gateById(S.view.sel);
  if (!g || !s) return null;
  const on = hasOverride(s, g);
  return el('div', { class: 'scopebox' },
    el('div', { class: 'sublabel', style: 'margin:0 0 4px' }, 'Dragging this gate edits'),
    el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Gate edit scope' },
      ...[['group', `All of ${activeGroup().name}`], ['sample', 'Only ' + (s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name)]].map(([v, t]) =>
        el('button', { role: 'radio', 'aria-checked': S.gateEditScope === v, class: S.gateEditScope === v ? 'on' : '', onclick: () => { S.gateEditScope = v; renderInspector(); } }, t))),
    on ? el('p', { class: 'hint', style: 'padding:6px 0 0' }, `Adjusted for ${s.name}.`) : null,
    on ? el('button', { class: 'btn', style: 'margin-top:4px', onclick: () => clearOverride(s, g) }, 'Reset to group shape') : null);
}

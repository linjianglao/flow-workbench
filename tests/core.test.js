/* Unit tests for src/core.js, which is deliberately DOM-free so it runs under Node.
   Run: node tests/core.test.js   (exit code 1 on failure) */
const Core = require('../src/core.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const section = s => console.log('\n' + s);

// ---------------------------------------------------------------- logicle ---
section('Logicle transform');
{
  const L = Core.makeLogicle(262144, 0.5, 4.5, 0);
  let worst = 0;
  for (const x of [-5000, -100, -1, 0, 1, 10, 1000, 1e4, 1e5, 262144]) {
    worst = Math.max(worst, Math.abs(L.inv(L.fwd(x)) - x) / (Math.abs(x) + 1));
  }
  ok('forward/inverse round trip within 1e-6', worst < 1e-6, `worst rel err ${worst.toExponential(2)}`);
  ok('monotonically increasing', [-1e4, -100, 0, 100, 1e4, 1e5].every((v, i, a) => i === 0 || L.fwd(v) > L.fwd(a[i - 1])));
  ok('top of scale maps to 1', near(L.fwd(262144), 1, 1e-3), String(L.fwd(262144)));
  ok('negative values map below the zero point', L.fwd(-1000) < L.zero);
}

// ----------------------------------------------------------- linear algebra ---
section('Matrix inversion');
{
  const M = [[1, 0.22, 0.004], [0.012, 1, 0.03], [0.001, 0.008, 1]];
  const I = Core.invert(M);
  let worst = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += M[i][k] * I[k][j];
    worst = Math.max(worst, Math.abs(s - (i === j ? 1 : 0)));
  }
  ok('M * inv(M) is the identity', worst < 1e-12, `worst ${worst.toExponential(2)}`);
  let threw = false;
  try { Core.invert([[1, 2], [2, 4]]); } catch (e) { threw = true; }
  ok('singular matrix raises rather than returning nonsense', threw);
}

// ------------------------------------------------------------- statistics ---
section('Statistics');
{
  const v = Float32Array.from({ length: 101 }, (_, i) => i); // 0..100
  ok('median of 0..100 is 50', Core.quantile(v, 0.5) === 50);
  ok('quantiles interpolate', near(Core.quantile(v, 0.25), 25, 1e-6));
  ok('mean of 0..100 is 50', near(Core.mean(v), 50, 1e-9));
  ok('stdev matches closed form', near(Core.stdev(v), Math.sqrt(101 * 102 / 12), 1e-6), String(Core.stdev(v)));
  const idx = Int32Array.from([0, 1, 2, 3, 4]);
  ok('subset indexing respected', Core.mean(v, idx) === 2);
}

// ---------------------------------------------------- compensation recovery ---
section('Compensation');
{
  const set = Core.demoSet();
  const ctrlNames = Core.DEMO_FL;
  const colsOf = s => Object.fromEntries(s.params.map((p, i) => [p.name, s.cols[i]]));
  // Find the controls by name: their position in demoSet() is not part of the contract.
  const byName = n => set.find(s => s.name === n);
  const singles = ['FITC single stain', 'PE single stain', 'APC single stain', 'Pacific Blue single stain'];
  const controls = singles.map((n, k) => ({ primary: ctrlNames[k], cols: colsOf(byName(n)) }));
  ok('demo set carries an unstained and four single-stain controls',
     !!byName('Unstained') && singles.every(byName));
  const res = Core.spilloverFromControls(ctrlNames, controls, { cols: colsOf(byName('Unstained')) });
  let worst = 0;
  res.matrix.forEach((row, i) => row.forEach((v, j) => { worst = Math.max(worst, Math.abs(v - Core.DEMO_SPILL[i][j])); }));
  ok('recovers the known spillover matrix within 0.005', worst < 0.005, `worst abs err ${worst.toFixed(5)}`);

  // compensating data built with a known matrix should restore the true signal ordering
  const s = set[0], comp = Core.compensate(s, s.spill);
  const peIdx = s.params.findIndex(p => p.name === 'PE-A');
  const fitcIdx = s.params.findIndex(p => p.name === 'FITC-A');
  const rawSpill = Core.quantile(s.cols[peIdx], 0.5);
  const compSpill = Core.quantile(comp[peIdx], 0.5);
  ok('compensation reduces PE median spillover from FITC', compSpill < rawSpill, `${rawSpill.toFixed(1)} -> ${compSpill.toFixed(1)}`);
  ok('compensated array is a new buffer', comp[fitcIdx] !== s.cols[fitcIdx]);
}

// ------------------------------------------------------------------- gates ---
section('Gates');
{
  const s = Core.demoSet()[0];
  const xi = s.params.findIndex(p => p.name === 'FSC-A'), yi = s.params.findIndex(p => p.name === 'SSC-A');
  const tx = Core.defaultTransform('FSC-A', s.cols[xi], 262144);
  const ty = Core.defaultTransform('SSC-A', s.cols[yi], 262144);
  ok('scatter channels default to a linear transform', tx.type === 'linear' && ty.type === 'linear');
  const X = Core.applyTransform(tx, s.cols[xi]), Y = Core.applyTransform(ty, s.cols[yi]);
  const all = Int32Array.from({ length: s.N }, (_, i) => i);
  const fx = Core.transformFns(tx), fy = Core.transformFns(ty);

  const rect = { type: 'rect', pts: [[40000, 5000], [90000, 35000]] };
  const poly = { type: 'poly', pts: [[40000, 5000], [90000, 5000], [90000, 35000], [40000, 35000]] };
  const r = Core.applyGate(rect, X, Y, fx, fy, all), p = Core.applyGate(poly, X, Y, fx, fy, all);
  ok('rectangle and equivalent polygon select the same events', r.length === p.length, `${r.length} vs ${p.length}`);
  ok('gate captures a plausible lymphocyte fraction', r.length / s.N > 0.2 && r.length / s.N < 0.8, (r.length / s.N).toFixed(3));

  const q = ['++', '+-', '-+', '--'].map(quadrant =>
    Core.applyGate({ type: 'quad', quadrant, pts: [[60000, 20000]] }, X, Y, fx, fy, all).length);
  ok('four quadrants partition every event exactly once', q.reduce((a, b) => a + b, 0) === s.N, q.join('+'));

  const child = Core.applyGate(rect, X, Y, fx, fy, p);
  ok('gating a parent population never grows it', child.length <= p.length);

  const fluor = s.params.findIndex(pp => pp.name === 'FITC-A');
  const tf = Core.defaultTransform('FITC-A', s.cols[fluor], 262144);
  ok('fluorescence channels default to logicle', tf.type === 'logicle');
  const Xf = Core.applyTransform(tf, s.cols[fluor]);
  const iv = Core.applyGate({ type: 'interval', pts: [[2000, 0], [262144, 0]] }, Xf, null, Core.transformFns(tf), null, all);
  ok('interval gate selects a subset', iv.length > 0 && iv.length < s.N, String(iv.length));
}

// ------------------------------------------------------------ FCS writing ---
section('FCS writer / reader round trip');
{
  const s = Core.demoSet()[0];
  const keep = Int32Array.from({ length: 500 }, (_, i) => i * 7);
  const bytes = Core.writeFCS(s, keep);
  const back = Core.parseFCS(bytes.buffer, 'roundtrip.fcs');
  ok('event count preserved', back.N === keep.length, `${back.N} vs ${keep.length}`);
  ok('channel count preserved', back.params.length === s.params.length);
  ok('channel names preserved', back.params.map(p => p.name).join() === s.params.map(p => p.name).join());
  ok('marker names preserved', back.params[4].stain === s.params[4].stain);
  let worst = 0;
  for (let j = 0; j < s.params.length; j++) for (let e = 0; e < keep.length; e += 37) {
    worst = Math.max(worst, Math.abs(back.cols[j][e] - s.cols[j][keep[e]]));
  }
  ok('event values identical after a round trip', worst === 0, `worst delta ${worst}`);
}

// ------------------------------------------------------------- axis ticks ---
section('Axis ticks');
{
  const lin = Core.ticksFor({ type: 'linear', range: [0, 262144] });
  ok('linear axis produces labelled major ticks', lin.major.length >= 3 && lin.major.every(t => t.label));
  const log = Core.ticksFor(Core.buildTransform('log', 'x', Float32Array.from([1, 10, 1e3, 1e5]), 262144));
  ok('log axis labels are powers of ten', log.major.every(t => /^10|^1$|^0$/.test(t.label)), log.major.map(t => t.label).join(' '));
  ok('number formatting is compact', Core.fmtLinear(50000) === '50K' && Core.fmtLinear(1500000) === '1.5M',
     `${Core.fmtLinear(50000)} ${Core.fmtLinear(1500000)}`);
}

// ------------------------------------------------------- grouped demo ---
section('Grouped demo and worked example');
{
  const set = Core.demoSet(), groups = Core.demoGroups(), { gates, overrides } = Core.demoAnalysis();
  ok('every group member points at a real sample', groups.every(g => g.members.every(i => set[i])));
  const covered = new Set(groups.flatMap(g => g.members));
  ok('every demo sample belongs to a group', set.every((_, i) => covered.has(i)), `${covered.size} of ${set.length}`);
  ok('each donor group gets its own tree', ['G1', 'G2'].every(id => gates.filter(g => g.group === id).length === 8));
  ok('gate ids are unique across groups', new Set(gates.map(g => g.id)).size === gates.length);
  const ids = new Set(gates.map(g => g.id));
  ok('every parent link resolves inside its own group',
     gates.every(g => g.parent === 'root' || (ids.has(g.parent) && gates.find(x => x.id === g.parent).group === g.group)));
  ok('the override names a real sample and a real gate',
     overrides.every(o => set[o.sample] && ids.has(o.gate)));

  // The two donors must genuinely need separate gates, or the demo teaches nothing.
  const ref = set[0], tf = {};
  ref.params.map(p => p.name).forEach(ch => {
    tf[ch] = Core.defaultTransform(ch, Core.compensate(ref, ref.spill)[ref.params.findIndex(p => p.name === ch)], 262144);
  });
  const frac = (smp, g) => {
    const cols = Core.compensate(smp, smp.spill), col = ch => cols[smp.params.findIndex(p => p.name === ch)];
    const all = Int32Array.from({ length: smp.N }, (_, i) => i);
    return Core.applyGate(g, Core.applyTransform(tf[g.x], col(g.x)), Core.applyTransform(tf[g.y], col(g.y)),
      Core.transformFns(tf[g.x]), Core.transformFns(tf[g.y]), all).length / smp.N;
  };
  const lymphA = gates.find(g => g.id === 'd1a'), lymphB = gates.find(g => g.id === 'd1b');
  const aOnA = frac(set[0], lymphA), aOnB = frac(set[3], lymphA), bOnB = frac(set[3], lymphB);
  ok('donor A gate fits donor A', aOnA > 0.35 && aOnA < 0.6, aOnA.toFixed(3));
  ok('donor B gate fits donor B', bOnB > 0.35 && bOnB < 0.6, bOnB.toFixed(3));
  ok('donor A gate clearly misses donor B, so the groups are needed', aOnB < bOnB * 0.5, `${aOnB.toFixed(3)} vs ${bOnB.toFixed(3)}`);

  const drifted = set[overrides[0].sample];
  const nudged = { ...lymphB, pts: overrides[0].pts };
  ok('the override recovers cells the group gate misses on the drifted file',
     frac(drifted, nudged) > frac(drifted, lymphB), `${frac(drifted, lymphB).toFixed(3)} -> ${frac(drifted, nudged).toFixed(3)}`);
  ok('that override is specific to its file, not a better group gate',
     frac(set[3], nudged) < frac(set[3], lymphB), 'it should fit the other donor B files worse');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

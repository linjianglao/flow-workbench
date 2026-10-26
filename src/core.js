/* Flow Workbench core: DOM-free logic. Exposed as `Core`. */
const Core = (() => {
  'use strict';

  // ---------------------------------------------------------------- FCS ---
  const dec = new TextDecoder('utf-8');
  const latin = new TextDecoder('latin1');

  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return latin.decode(bytes); }
  }

  function parseTextSegment(str) {
    const delim = str[0];
    const tokens = [];
    let cur = '';
    for (let i = 1; i < str.length; i++) {
      const ch = str[i];
      if (ch === delim) {
        if (str[i + 1] === delim) { cur += delim; i++; continue; }
        tokens.push(cur); cur = '';
      } else cur += ch;
    }
    if (cur.trim().length) tokens.push(cur);
    const kv = {};
    for (let i = 0; i + 1 < tokens.length; i += 2) kv[tokens[i].trim().toUpperCase()] = tokens[i + 1].trim();
    return kv;
  }

  function parseSpill(kw, paramNames) {
    const key = ['$SPILLOVER', 'SPILL', '$SPILL', 'SPILLOVER', '$COMP', 'COMP'].find(k => kw[k]);
    if (!key) return null;
    const parts = kw[key].split(',').map(s => s.trim());
    const n = parseInt(parts[0], 10);
    if (!(n > 0) || parts.length < 1 + n + n * n) return null;
    let names = parts.slice(1, n + 1);
    // Some instruments store parameter indices instead of names
    if (names.every(s => /^\d+$/.test(s) && +s >= 1 && +s <= paramNames.length)) names = names.map(s => paramNames[+s - 1]);
    const vals = parts.slice(n + 1, n + 1 + n * n).map(Number);
    if (vals.some(v => !isFinite(v))) return null;
    const matrix = [];
    for (let i = 0; i < n; i++) matrix.push(vals.slice(i * n, i * n + n));
    return { channels: names, matrix, source: key };
  }

  function parseFCS(buf, fileName) {
    const bytes = new Uint8Array(buf);
    const head = latin.decode(bytes.subarray(0, 58));
    if (!head.startsWith('FCS')) throw new Error(`${fileName}: not an FCS file (missing FCS header).`);
    const off = k => parseInt(head.slice(k, k + 8).trim() || '0', 10) || 0;
    const ts = off(10), te = off(18);
    let ds = off(26), de = off(34);
    const kw = parseTextSegment(decodeText(bytes.subarray(ts, te + 1)));
    if (!ds || !de) { ds = parseInt(kw.$BEGINDATA, 10); de = parseInt(kw.$ENDDATA, 10); }
    if ((kw.$MODE || 'L').toUpperCase() !== 'L') throw new Error(`${fileName}: only list-mode FCS files are supported.`);
    const dtype = (kw.$DATATYPE || '').toUpperCase();
    if (!'FDI'.includes(dtype) || !dtype) throw new Error(`${fileName}: data type "${dtype}" is not supported (need F, D or I).`);
    const P = parseInt(kw.$PAR, 10);
    let N = parseInt(kw.$TOT, 10);
    const little = (kw.$BYTEORD || '1,2,3,4').trim().startsWith('1');
    const params = [];
    for (let i = 1; i <= P; i++) {
      const name = kw[`$P${i}N`] || `P${i}`;
      const stain = kw[`$P${i}S`] || '';
      const bits = parseInt(kw[`$P${i}B`], 10) || (dtype === 'D' ? 64 : 32);
      const range = parseFloat(kw[`$P${i}R`]) || 262144;
      const e = (kw[`$P${i}E`] || '0,0').split(',').map(Number);
      params.push({ name, stain, bits, range, e1: e[0] || 0, e2: e[1] || 0 });
    }
    const widths = params.map(p => dtype === 'F' ? 4 : dtype === 'D' ? 8 : p.bits / 8);
    if (widths.some(w => ![1, 2, 4, 8].includes(w))) throw new Error(`${fileName}: unsupported bit width.`);
    const rowBytes = widths.reduce((a, b) => a + b, 0);
    // Resolve HEADER vs TEXT data-offset discrepancies: prefer whichever matches $TOT x row size
    const tds = parseInt(kw.$BEGINDATA, 10), tde = parseInt(kw.$ENDDATA, 10), need = N * rowBytes;
    if (tds > 0 && tde > 0 && (tds !== ds || tde !== de)) {
      const hOK = (de - ds + 1) === need, tOK = (tde - tds + 1) === need;
      if ((tOK && !hOK) || (!hOK && ds + need > buf.byteLength)) { ds = tds; de = tde; }
    }
    if (de >= buf.byteLength) de = buf.byteLength - 1;
    const avail = de - ds + 1;
    if (!(N > 0) || N * rowBytes > avail) N = Math.floor(avail / rowBytes);
    const cols = params.map(() => new Float32Array(N));
    const dv = new DataView(buf);
    let p = ds;
    if (dtype === 'F') {
      for (let e = 0; e < N; e++) for (let j = 0; j < P; j++) { cols[j][e] = dv.getFloat32(p, little); p += 4; }
    } else if (dtype === 'D') {
      for (let e = 0; e < N; e++) for (let j = 0; j < P; j++) { cols[j][e] = dv.getFloat64(p, little); p += 8; }
    } else {
      const masks = params.map(pr => {
        const r = pr.range; const isPow2 = r > 0 && (Math.log2(r) % 1 === 0);
        return isPow2 && r <= Math.pow(2, pr.bits) ? r - 1 : null;
      });
      for (let e = 0; e < N; e++) for (let j = 0; j < P; j++) {
        const w = widths[j]; let v;
        if (w === 1) v = dv.getUint8(p);
        else if (w === 2) v = dv.getUint16(p, little);
        else if (w === 4) v = dv.getUint32(p, little);
        else v = Number(dv.getBigUint64(p, little));
        p += w;
        if (masks[j] !== null) v = masks[j] === 0xFFFFFFFF ? v : (v % (masks[j] + 1));
        cols[j][e] = v;
      }
      params.forEach((pr, j) => { // $PnE log amplification
        if (pr.e1 > 0) {
          const f2 = pr.e2 > 0 ? pr.e2 : 1, c = cols[j];
          for (let e = 0; e < N; e++) c[e] = Math.pow(10, pr.e1 * c[e] / pr.range) * f2;
          pr.range = Math.pow(10, pr.e1) * f2;
        }
      });
    }
    const names = params.map(p => p.name);
    return {
      name: (kw.$FIL || fileName || 'sample').replace(/\.fcs$/i, ''),
      fileName, version: head.slice(0, 6), N, params, cols, keywords: kw,
      spill: parseSpill(kw, names)
    };
  }

  // Minimal FCS 3.1 writer (float32, little endian) - used for exporting subsets
  function writeFCS(sample, indices, channelCols) {
    const P = sample.params.length, N = indices ? indices.length : sample.N;
    const kw = [['$BEGINANALYSIS', '0'], ['$ENDANALYSIS', '0'], ['$BEGINSTEXT', '0'], ['$ENDSTEXT', '0'],
      ['$BYTEORD', '1,2,3,4'], ['$DATATYPE', 'F'], ['$MODE', 'L'], ['$NEXTDATA', '0'], ['$PAR', String(P)], ['$TOT', String(N)],
      ['$FIL', sample.name + '.fcs']];
    sample.params.forEach((p, i) => {
      kw.push([`$P${i + 1}N`, p.name], [`$P${i + 1}B`, '32'], [`$P${i + 1}E`, '0,0'], [`$P${i + 1}R`, String(Math.round(p.range))]);
      if (p.stain) kw.push([`$P${i + 1}S`, p.stain]);
    });
    const esc = s => String(s).replace(/\|/g, '||');
    const build = (bd, ed) => '|' + kw.concat([['$BEGINDATA', String(bd)], ['$ENDDATA', String(ed)]]).map(([k, v]) => esc(k) + '|' + esc(v)).join('|') + '|';
    const dataLen = N * P * 4;
    let text = build(0, 0), ts = 58, bd, ed;
    for (let k = 0; k < 4; k++) { bd = ts + new TextEncoder().encode(text).length; ed = bd + dataLen - 1; text = build(bd, ed); }
    const tbytes = new TextEncoder().encode(text);
    bd = ts + tbytes.length; ed = bd + dataLen - 1;
    const pad = n => String(n > 99999999 ? 0 : n).padStart(8, ' ');
    const header = 'FCS3.1    ' + pad(ts) + pad(ts + tbytes.length - 1) + pad(bd) + pad(ed) + pad(0) + pad(0);
    const out = new Uint8Array(bd + dataLen);
    out.set(new TextEncoder().encode(header), 0); out.set(tbytes, ts);
    const dv = new DataView(out.buffer); let q = bd;
    const cols = channelCols || sample.cols;
    for (let e = 0; e < N; e++) { const idx = indices ? indices[e] : e; for (let j = 0; j < P; j++) { dv.setFloat32(q, cols[j][idx], true); q += 4; } }
    return out;
  }

  // ------------------------------------------------------ linear algebra ---
  function invert(M) {
    const n = M.length, A = M.map((r, i) => r.concat(Array.from({ length: n }, (_, j) => i === j ? 1 : 0)));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) throw new Error('Spillover matrix is singular and cannot be inverted.');
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c];
      for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = A[r][c]; if (f === 0) continue;
        for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map(r => r.slice(n));
  }

  /* Returns new array of columns; compensated channels replaced. comp = raw %*% solve(S) */
  function compensate(sample, spill) {
    const cols = sample.cols.slice();
    if (!spill) return cols;
    const names = sample.params.map(p => p.name);
    const idx = spill.channels.map(c => names.indexOf(c));
    if (idx.some(i => i < 0)) return cols;
    const inv = invert(spill.matrix), n = idx.length, N = sample.N;
    const src = idx.map(i => sample.cols[i]);
    const out = idx.map(() => new Float32Array(N));
    const x = new Float64Array(n);
    for (let e = 0; e < N; e++) {
      for (let k = 0; k < n; k++) x[k] = src[k][e];
      for (let j = 0; j < n; j++) { let s = 0; for (let k = 0; k < n; k++) s += x[k] * inv[k][j]; out[j][e] = s; }
    }
    idx.forEach((i, j) => { cols[i] = out[j]; });
    return cols;
  }

  // ------------------------------------------------------------ stats ---
  function quantile(arr, q, idx) {
    let v;
    if (idx) { v = new Float32Array(idx.length); for (let i = 0; i < idx.length; i++) v[i] = arr[idx[i]]; }
    else v = Float32Array.from(arr);
    if (!v.length) return NaN;
    v.sort();
    const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return v[lo] + (v[hi] - v[lo]) * (pos - lo);
  }
  function quantiles(arr, qs, idx) {
    let v;
    if (idx) { v = new Float32Array(idx.length); for (let i = 0; i < idx.length; i++) v[i] = arr[idx[i]]; }
    else v = Float32Array.from(arr);
    v.sort();
    return qs.map(q => { if (!v.length) return NaN; const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return v[lo] + (v[hi] - v[lo]) * (pos - lo); });
  }
  function mean(arr, idx) {
    let s = 0, n = idx ? idx.length : arr.length;
    if (idx) for (let i = 0; i < n; i++) s += arr[idx[i]]; else for (let i = 0; i < n; i++) s += arr[i];
    return n ? s / n : NaN;
  }
  function stdev(arr, idx) {
    const m = mean(arr, idx); let s = 0, n = idx ? idx.length : arr.length;
    if (idx) for (let i = 0; i < n; i++) s += (arr[idx[i]] - m) ** 2; else for (let i = 0; i < n; i++) s += (arr[i] - m) ** 2;
    return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
  }

  // ------------------------------------------------------- transforms ---
  function solveD(b, w) {
    if (w === 0) return b;
    let lo = 0, hi = b;
    for (let k = 0; k < 200; k++) {
      const d = (lo + hi) / 2, f = 2 * (Math.log(d) - Math.log(b)) + w * (b + d);
      if (f > 0) hi = d; else lo = d;
    }
    return (lo + hi) / 2;
  }

  // Parks, Roederer & Moore (2006) logicle. Output scale: T -> 1, zero -> x1.
  function makeLogicle(T, W, M, A) {
    const w = W / (M + A), x2 = A / (M + A), x1 = x2 + w, x0 = x2 + 2 * w, b = (M + A) * Math.LN10;
    const d = solveD(b, w);
    const ca = Math.exp(x0 * (b + d)), mfa = Math.exp(b * x1) - ca / Math.exp(d * x1);
    const a = T / ((Math.exp(b) - mfa) - ca / Math.exp(d)), c = ca * a, f = -mfa * a;
    const inv = y => {
      const neg = y < x1, s = neg ? 2 * x1 - y : y;
      const v = a * Math.exp(b * s) - c * Math.exp(-d * s) + f;
      return neg ? -v : v;
    };
    const Y0 = -0.4, Y1 = 1.4, K = 16384;
    const ys = new Float64Array(K), xs = new Float64Array(K);
    for (let k = 0; k < K; k++) { ys[k] = Y0 + (Y1 - Y0) * k / (K - 1); xs[k] = inv(ys[k]); }
    xs[0] = -Infinity; xs[K - 1] = Infinity;
    const fwd = x => {
      if (x <= xs[1]) return ys[1];
      if (x >= xs[K - 2]) return ys[K - 2];
      let lo = 1, hi = K - 2;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
      return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
    };
    return { fwd, inv, zero: x1 };
  }

  function estimateLogicleW(values, T, M) {
    const neg = []; for (let i = 0; i < values.length; i++) if (values[i] < 0) neg.push(values[i]);
    if (neg.length < 10) return 0.5;
    const r = quantile(Float32Array.from(neg), 0.05);
    let w = (M - Math.log10(T / Math.abs(r))) / 2;
    if (!isFinite(w) || w < 0) w = 0;
    return Math.min(w, M / 2 - 0.05, 2);
  }

  /* cfg: {type, cofactor?, T?, W?, M?, A?, range:[lo,hi]} -> {f, inv} */
  function transformFns(cfg) {
    switch (cfg.type) {
      case 'log': return { f: x => Math.log10(Math.max(x, 1e-3)), inv: y => Math.pow(10, y) };
      case 'arcsinh': { const c = cfg.cofactor || 150; return { f: x => Math.asinh(x / c), inv: y => Math.sinh(y) * c }; }
      case 'logicle': { const L = makeLogicle(cfg.T, cfg.W, cfg.M, cfg.A || 0); return { f: L.fwd, inv: L.inv }; }
      default: return { f: x => x, inv: y => y };
    }
  }

  function defaultTransform(name, values, range) {
    const isScatter = /^(FSC|SSC|FS|SS)/i.test(name), isTime = /time/i.test(name);
    const [q0, q1] = quantiles(values, [0.0005, 0.9995]);
    let max = -Infinity; for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    if (isScatter || isTime) return linearCfg(q0, q1, max, range);
    const T = Math.max(range || 262144, max);
    const M = 4.5, W = estimateLogicleW(values, T, M);
    return logicleCfg(values, T, M, W, 0);
  }
  function logicleCfg(values, T, M, W, A) {
    const L = makeLogicle(T, W, M, A), lo = Math.max(-0.2, Math.min(0, L.fwd(quantile(values, 0.0005)) - 0.01));
    return { type: 'logicle', T, W, M, A, range: [lo, 1] };
  }
  function linearCfg(q0, q1, max, range) {
    const hi = (range && q1 > 0.6 * range) ? range : q1 * 1.05;
    return { type: 'linear', range: [Math.min(0, q0), hi > 0 ? hi : (max || 1)] };
  }
  function buildTransform(type, name, values, range, opts = {}) {
    const [q0, q1] = quantiles(values, [0.0005, 0.9995]);
    let max = -Infinity; for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
    const T = Math.max(range || 262144, max);
    if (type === 'linear') return linearCfg(q0, q1, max, range);
    if (type === 'log') return { type: 'log', range: [Math.max(0, Math.floor(Math.log10(Math.max(1, quantile(values, 0.02))))), Math.log10(T)] };
    if (type === 'arcsinh') {
      const c = opts.cofactor || 150;
      return { type: 'arcsinh', cofactor: c, range: [Math.asinh(Math.min(q0, -c) / c) - 0.25, Math.asinh(T / c)] };
    }
    const M = opts.M || 4.5, W = opts.W != null ? opts.W : estimateLogicleW(values, T, M);
    return logicleCfg(values, T, M, W, opts.A || 0);
  }

  /* Transform and clamp into the display range so off-scale events pile on the axis (what you see is what you gate). */
  function applyTransform(cfg, values) {
    const { f } = transformFns(cfg), out = new Float32Array(values.length);
    const [lo, hi] = cfg.range;
    for (let i = 0; i < values.length; i++) { let y = f(values[i]); out[i] = y < lo ? lo : y > hi ? hi : y; }
    return out;
  }

  function ticksFor(cfg) {
    const [lo, hi] = cfg.range, { f } = transformFns(cfg), major = [], minor = [];
    if (cfg.type === 'linear') {
      const span = hi - lo, raw = span / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= 6);
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) major.push({ v, y: v, label: fmtLinear(v) });
      for (let v = Math.ceil(lo / (step / 5)) * (step / 5); v <= hi; v += step / 5) minor.push({ y: v });
      return { major, minor };
    }
    const cand = [];
    if (cfg.type !== 'log') cand.push(0);
    for (let k = 0; k <= 8; k++) {
      cand.push(Math.pow(10, k)); if (cfg.type !== 'log') cand.push(-Math.pow(10, k));
    }
    cand.forEach(v => { const y = f(v); if (y >= lo - 1e-9 && y <= hi + 1e-9) major.push({ v, y, label: fmtPow(v) }); });
    for (let k = 0; k <= 8; k++) for (let m = 2; m <= 9; m++) {
      [m * Math.pow(10, k), -m * Math.pow(10, k)].forEach(v => {
        if (cfg.type === 'log' && v < 0) return;
        const y = f(v); if (y > lo && y < hi) minor.push({ y });
      });
    }
    major.sort((a, b) => a.y - b.y);
    return { major, minor };
  }
  const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
  function fmtPow(v) {
    if (v === 0) return '0';
    const k = Math.round(Math.log10(Math.abs(v)));
    if (k === 0) return v < 0 ? '−1' : '1';
    if (k === 1) return v < 0 ? '−10' : '10';
    return (v < 0 ? '−' : '') + '10' + String(k).split('').map(c => SUP[c]).join('');
  }
  function fmtLinear(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(a % 1e3 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return String(+v.toFixed(3));
  }

  // ----------------------------------------------------------- gates ---
  function pointInPoly(x, y, px, py) {
    let inside = false;
    for (let i = 0, j = px.length - 1; i < px.length; j = i++) {
      if (((py[i] > y) !== (py[j] > y)) && (x < (px[j] - px[i]) * (y - py[i]) / (py[j] - py[i]) + px[i])) inside = !inside;
    }
    return inside;
  }

  /* gate points are raw values; tx/ty are transform fns; X/Y transformed+clamped columns; parent: Int32Array of indices */
  function applyGate(gate, X, Y, tfx, tfy, parent) {
    const out = new Int32Array(parent.length); let n = 0;
    if (gate.type === 'interval') {
      let a = tfx.f(gate.pts[0][0]), b = tfx.f(gate.pts[1][0]); if (a > b) [a, b] = [b, a];
      for (let i = 0; i < parent.length; i++) { const e = parent[i], x = X[e]; if (x >= a && x <= b) out[n++] = e; }
    } else if (gate.type === 'rect') {
      let x0 = tfx.f(gate.pts[0][0]), x1 = tfx.f(gate.pts[1][0]), y0 = tfy.f(gate.pts[0][1]), y1 = tfy.f(gate.pts[1][1]);
      if (x0 > x1) [x0, x1] = [x1, x0]; if (y0 > y1) [y0, y1] = [y1, y0];
      for (let i = 0; i < parent.length; i++) { const e = parent[i], x = X[e], y = Y[e]; if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out[n++] = e; }
    } else if (gate.type === 'quad') {
      const cx = tfx.f(gate.pts[0][0]), cy = tfy.f(gate.pts[0][1]), q = gate.quadrant; // e.g. '+-' = x high, y low
      const xh = q[0] === '+', yh = q[1] === '+';
      for (let i = 0; i < parent.length; i++) {
        const e = parent[i], x = X[e], y = Y[e];
        if ((xh ? x > cx : x <= cx) && (yh ? y > cy : y <= cy)) out[n++] = e;
      }
    } else if (gate.type === 'poly' || gate.type === 'ellipse') {
      const pts = gate.type === 'ellipse' ? ellipsePoints(gate, tfx, tfy, true) : gate.pts.map(p => [tfx.f(p[0]), tfy.f(p[1])]);
      const px = pts.map(p => p[0]), py = pts.map(p => p[1]);
      let bx0 = Math.min(...px), bx1 = Math.max(...px), by0 = Math.min(...py), by1 = Math.max(...py);
      for (let i = 0; i < parent.length; i++) {
        const e = parent[i], x = X[e], y = Y[e];
        if (x < bx0 || x > bx1 || y < by0 || y > by1) continue;
        if (pointInPoly(x, y, px, py)) out[n++] = e;
      }
    }
    return out.slice(0, n);
  }

  // Ellipse stored as center + two axis endpoints in raw space; rendered in transformed space
  function ellipsePoints(gate, tfx, tfy, transformed) {
    const [c, a, b] = gate.pts.map(p => [tfx.f(p[0]), tfy.f(p[1])]);
    const ax = [a[0] - c[0], a[1] - c[1]], bx = [b[0] - c[0], b[1] - c[1]], pts = [];
    for (let k = 0; k < 72; k++) {
      const t = 2 * Math.PI * k / 72;
      pts.push([c[0] + ax[0] * Math.cos(t) + bx[0] * Math.sin(t), c[1] + ax[1] * Math.cos(t) + bx[1] * Math.sin(t)]);
    }
    return pts;
  }

  // ---------------------------------------------- spillover from controls ---
  /* controls: [{primary: channelName, cols: {ch: Float32Array}}]; unstained: {cols}|null */
  function spilloverFromControls(channels, controls, unstained) {
    const n = channels.length;
    const S = channels.map((_, i) => channels.map((__, j) => i === j ? 1 : 0));
    const report = [];
    controls.forEach(ctrl => {
      const i = channels.indexOf(ctrl.primary); if (i < 0) return;
      const prim = ctrl.cols[ctrl.primary];
      const [qa, qb, qm] = quantiles(prim, [0.95, 0.998, 0.5]);
      const pos = [], negIdx = [];
      for (let e = 0; e < prim.length; e++) { if (prim[e] >= qa && prim[e] <= qb) pos.push(e); if (prim[e] <= qm) negIdx.push(e); }
      const posI = Int32Array.from(pos), negI = Int32Array.from(negIdx);
      const negMed = channels.map(ch => unstained ? quantile(unstained.cols[ch], 0.5) : quantile(ctrl.cols[ch], 0.5, negI));
      const denom = quantile(prim, 0.5, posI) - negMed[i];
      channels.forEach((ch, j) => { if (j !== i) S[i][j] = (quantile(ctrl.cols[ch], 0.5, posI) - negMed[j]) / denom; });
      report.push({ channel: ctrl.primary, nPos: pos.length, signal: denom });
    });
    return { matrix: S, report };
  }

  // -------------------------------------------------------- demo data ---
  function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const n = () => { let x = 0; while (x === 0) x = u(); return Math.sqrt(-2 * Math.log(x)) * Math.cos(2 * Math.PI * u()); };
    return { u, n };
  }
  const DEMO_CH = [
    { name: 'FSC-A' }, { name: 'FSC-H' }, { name: 'SSC-A' },
    { name: 'FITC-A', stain: 'CD3' }, { name: 'PE-A', stain: 'CD4' }, { name: 'APC-A', stain: 'CD8' },
    { name: 'Pacific Blue-A', stain: 'Live/Dead' }, { name: 'Time' }];
  const DEMO_FL = ['FITC-A', 'PE-A', 'APC-A', 'Pacific Blue-A'];
  const DEMO_SPILL = [[1, 0.22, 0.004, 0.01], [0.012, 1, 0.03, 0.002], [0.001, 0.008, 1, 0.0], [0.03, 0.006, 0.001, 1]];

  function demoSample(name, seed, N, spec) {
    const R = rng(seed), P = DEMO_CH.length, cols = DEMO_CH.map(() => new Float32Array(N));
    const pos = (m, s) => Math.exp(Math.log(m) + s * R.n());
    const neg = () => 60 * R.n() + 20;
    for (let e = 0; e < N; e++) {
      const u = R.u(); let fsc, ssc, cd3 = neg(), cd4 = neg(), cd8 = neg(), ld = pos(300, 0.5), doublet = false;
      if (u < spec.debris) { fsc = Math.abs(8000 + 9000 * R.n()); ssc = Math.abs(6000 + 8000 * R.n()); ld = pos(8000, 0.5); }
      else {
        const v = R.u();
        if (v < spec.lymph) {
          fsc = 62000 + 7000 * R.n(); ssc = 18000 + 4000 * R.n();
          if (R.u() < spec.t) {
            cd3 = pos(9000, 0.35); const w = R.u();
            if (w < spec.cd4) cd4 = pos(12000, 0.3); else if (w < spec.cd4 + spec.cd8) cd8 = pos(20000, 0.35);
          }
        } else if (v < spec.lymph + 0.25) { fsc = 95000 + 10000 * R.n(); ssc = 60000 + 10000 * R.n(); cd4 = pos(1800, 0.4); }
        else { fsc = 115000 + 12000 * R.n(); ssc = 150000 + 22000 * R.n(); }
        if (R.u() < spec.dead) ld = pos(9000, 0.4);
        if (R.u() < 0.05) doublet = true;
      }
      const fscA = doublet ? fsc * (1.7 + 0.2 * R.u()) : fsc;
      const fscH = doublet ? fsc * 1.05 : fsc * (0.8 + 0.02 * R.n());
      const truth = [cd3, cd4, cd8, ld];
      const raw = DEMO_FL.map((_, j) => truth.reduce((s, t, k) => s + t * DEMO_SPILL[k][j], 0) + 40 * R.n());
      const row = [fscA, fscH, ssc * (doublet ? 1.6 : 1), ...raw, e * 0.05];
      for (let j = 0; j < P; j++) cols[j][e] = Math.min(row[j], 262143);
    }
    return makeSample(name, cols, N);
  }
  function demoControl(name, seed, N, which) {
    const R = rng(seed), cols = DEMO_CH.map(() => new Float32Array(N));
    for (let e = 0; e < N; e++) {
      const fsc = 62000 + 7000 * R.n(), ssc = 18000 + 4000 * R.n();
      const truth = DEMO_FL.map((_, k) => (k === which && R.u() < 0.5) ? Math.exp(Math.log(15000) + 0.5 * R.n()) : 60 * R.n() + 20);
      const raw = DEMO_FL.map((_, j) => truth.reduce((s, t, k) => s + t * DEMO_SPILL[k][j], 0) + 40 * R.n());
      const row = [fsc, fsc * 0.8, ssc, ...raw, e * 0.05];
      row.forEach((v, j) => { cols[j][e] = Math.min(v, 262143); });
    }
    return makeSample(name, cols, N);
  }
  function makeSample(name, cols, N) {
    const params = DEMO_CH.map(c => ({ name: c.name, stain: c.stain || '', bits: 32, range: c.name === 'Time' ? 262144 : 262144, e1: 0, e2: 0 }));
    const spillStr = [DEMO_FL.length, ...DEMO_FL, ...DEMO_SPILL.flat()].join(',');
    const kw = { $FIL: name + '.fcs', $SPILLOVER: spillStr, $CYT: 'Demo cytometer' };
    return { name, fileName: name + '.fcs', version: 'DEMO', N, params, cols, keywords: kw, spill: parseSpill(kw, params.map(p => p.name)) };
  }
  function demoSet() {
    return [
      demoSample('Donor A resting', 11, 40000, { debris: 0.12, lymph: 0.55, t: 0.72, cd4: 0.62, cd8: 0.3, dead: 0.06 }),
      demoSample('Donor A stimulated', 12, 40000, { debris: 0.18, lymph: 0.6, t: 0.75, cd4: 0.5, cd8: 0.42, dead: 0.14 }),
      demoSample('Donor A stim + inhibitor', 13, 40000, { debris: 0.2, lymph: 0.52, t: 0.7, cd4: 0.58, cd8: 0.33, dead: 0.25 }),
      demoControl('Unstained', 21, 15000, -1),
      demoControl('FITC single stain', 22, 15000, 0),
      demoControl('PE single stain', 23, 15000, 1),
      demoControl('APC single stain', 24, 15000, 2),
      demoControl('Pacific Blue single stain', 25, 15000, 3)
    ];
  }

  return {
    parseFCS, parseTextSegment, writeFCS, invert, compensate, quantile, quantiles, mean, stdev,
    makeLogicle, estimateLogicleW, logicleCfg, transformFns, defaultTransform, buildTransform, applyTransform, ticksFor,
    fmtPow, fmtLinear, applyGate, pointInPoly, ellipsePoints, spilloverFromControls, demoSet, DEMO_SPILL, DEMO_FL
  };
})();
if (typeof module !== 'undefined') module.exports = Core;

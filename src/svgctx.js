// ------------------------------------------------------------ SVG recorder ---
/* Implements the subset of CanvasRenderingContext2D used by the plotting code and records it as SVG,
   so the same drawing routines produce editable vector figures (text stays text, gates stay paths). */
class SvgCtx {
  constructor(w, h) {
    this.w = w; this.h = h; this.out = []; this.defs = []; this.stack = []; this.groups = 0; this.nClip = 0;
    this.m = [1, 0, 0, 1, 0, 0]; this.path = ''; this.dash = [];
    this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; this.font = '10px sans-serif';
    this.textAlign = 'start'; this.textBaseline = 'alphabetic'; this.imageSmoothingEnabled = true;
    this._mc = document.createElement('canvas').getContext('2d');
  }
  static n(v) { return +(+v).toFixed(2); }
  static esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  static paint(c, kind) {
    c = String(c).trim();
    const m = c.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(',').map(s => s.trim());
      const a = p.length > 3 ? parseFloat(p[3]) : 1;
      return `${kind}="rgb(${p.slice(0, 3).join(',')})"${a < 1 ? ` ${kind}-opacity="${+a.toFixed(3)}"` : ''}`;
    }
    return `${kind}="${SvgCtx.esc(c)}"`;
  }
  tf() { const m = this.m; return (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0) ? '' : ` transform="matrix(${m.map(SvgCtx.n).join(' ')})"`; }
  save() { this.stack.push({ m: this.m.slice(), fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline, dash: this.dash.slice(), groups: this.groups }); this.groups = 0; }
  restore() { for (let i = 0; i < this.groups; i++) this.out.push('</g>'); const s = this.stack.pop(); if (s) Object.assign(this, s); }
  transform(a, b, c, d, e, f) { const m = this.m; this.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]; }
  translate(x, y) { this.transform(1, 0, 0, 1, x, y); }
  scale(x, y) { this.transform(x, 0, 0, y, 0, 0); }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this.transform(c, s, -s, c, 0, 0); }
  setTransform(a, b, c, d, e, f) { this.m = [a, b, c, d, e, f]; }
  setLineDash(d) { this.dash = d.slice(); }
  beginPath() { this.path = ''; }
  moveTo(x, y) { this.path += `M${SvgCtx.n(x)} ${SvgCtx.n(y)}`; }
  lineTo(x, y) { this.path += (this.path ? 'L' : 'M') + `${SvgCtx.n(x)} ${SvgCtx.n(y)}`; }
  closePath() { this.path += 'Z'; }
  rect(x, y, w, h) { const n = SvgCtx.n; this.path += `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`; }
  arc(cx, cy, r, a0, a1, ccw = false) {
    const n = SvgCtx.n, T = 2 * Math.PI, sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
    this.path += (this.path ? 'L' : 'M') + `${n(sx)} ${n(sy)}`;
    let sweep = ccw ? a0 - a1 : a1 - a0; const f = ccw ? 0 : 1;
    if (sweep >= T - 1e-9) {
      const mx = cx - r * Math.cos(a0), my = cy - r * Math.sin(a0);
      this.path += `A${n(r)} ${n(r)} 0 1 ${f} ${n(mx)} ${n(my)}A${n(r)} ${n(r)} 0 1 ${f} ${n(sx)} ${n(sy)}`; return;
    }
    sweep = ((sweep % T) + T) % T;
    this.path += `A${n(r)} ${n(r)} 0 ${sweep > Math.PI ? 1 : 0} ${f} ${n(cx + r * Math.cos(a1))} ${n(cy + r * Math.sin(a1))}`;
  }
  strokeAttrs() { return `fill="none" ${SvgCtx.paint(this.strokeStyle, 'stroke')} stroke-width="${SvgCtx.n(this.lineWidth)}"${this.dash.length ? ` stroke-dasharray="${this.dash.join(' ')}"` : ''}`; }
  fill() { if (this.path) this.out.push(`<path d="${this.path}" ${SvgCtx.paint(this.fillStyle, 'fill')}${this.tf()}/>`); }
  stroke() { if (this.path) this.out.push(`<path d="${this.path}" ${this.strokeAttrs()} stroke-linejoin="round"${this.tf()}/>`); }
  fillRect(x, y, w, h) { const n = SvgCtx.n; this.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${SvgCtx.paint(this.fillStyle, 'fill')}${this.tf()}/>`); }
  strokeRect(x, y, w, h) { const n = SvgCtx.n; this.out.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${this.strokeAttrs()}${this.tf()}/>`); }
  clip() {
    const id = 'clip' + (++this.nClip);
    this.defs.push(`<clipPath id="${id}"><path d="${this.path}"${this.tf()}/></clipPath>`);
    this.out.push(`<g clip-path="url(#${id})">`); this.groups++;
  }
  parseFont() {
    const m = this.font.match(/^\s*(?:(\d{3}|bold|normal)\s+)?([\d.]+)px\s+(.+)$/);
    return m ? { weight: m[1] || '400', size: parseFloat(m[2]), family: m[3] } : { weight: '400', size: 10, family: 'sans-serif' };
  }
  measureText(t) { this._mc.font = this.font; return this._mc.measureText(t); }
  fillText(t, x, y) {
    const f = this.parseFont(), n = SvgCtx.n;
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.textAlign] || 'start';
    const dy = this.textBaseline === 'top' || this.textBaseline === 'hanging' ? f.size * 0.8 : this.textBaseline === 'middle' ? f.size * 0.35 : this.textBaseline === 'bottom' ? -f.size * 0.2 : 0;
    this.out.push(`<text x="${n(x)}" y="${n(y + dy)}" font-family="${SvgCtx.esc(f.family)}" font-size="${n(f.size)}"${f.weight !== '400' && f.weight !== 'normal' ? ` font-weight="${f.weight}"` : ''} text-anchor="${anchor}" ${SvgCtx.paint(this.fillStyle, 'fill')}${this.tf()}>${SvgCtx.esc(t)}</text>`);
  }
  drawImage(img, x, y, w, h) {
    const n = SvgCtx.n, url = img.toDataURL('image/png');
    this.out.push(`<image x="${n(x)}" y="${n(y)}" width="${n(w ?? img.width)}" height="${n(h ?? img.height)}" preserveAspectRatio="none"${this.imageSmoothingEnabled ? '' : ' style="image-rendering:pixelated;image-rendering:crisp-edges"'} href="${url}" xlink:href="${url}"${this.tf()}/>`);
  }
  toString() {
    while (this.stack.length) this.restore();
    for (let i = 0; i < this.groups; i++) this.out.push('</g>'); this.groups = 0;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}">\n<defs>${this.defs.join('')}</defs>\n${this.out.join('\n')}\n</svg>`;
  }
}

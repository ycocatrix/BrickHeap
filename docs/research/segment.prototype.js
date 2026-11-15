'use strict';
/**
 * BrickHeap - pile segmentation prototype (pure JS, no deps, Hermes-friendly: typed arrays only).
 * Input : RGBA Uint8Array (w*h*4), ideally downscaled to ~320 px on the long side.
 * Output: { boxes: [{x,y,w,h (px, padded), nx,ny,nw,nh (0..1), area, partial, fromSplit, suspectMerged, lab, rgb}],
 *           background: { quality: 'plain'|'textured'|'patterned', sigmaL, sigmaC }, ms }
 *
 * Pipeline: Lab + log-chromaticity -> quadratic background surface fitted on the border ring (robust, 2 passes)
 *  -> foreground = chroma residual OR lightness residual -> shadow pruning (achromatic darker pixels attached
 *  to a "core") -> open/close -> connected components -> colour split (2-means) -> shape split (distance
 *  transform seeds) -> boxes + dominant colour.
 */

const DEFAULTS = {
  ring: 0.035,        // border ring width (fraction of min dim) used to learn the background
  kSigma: 4.5,        // threshold = max(min, kSigma * robust sigma of border residuals)
  minTc: 0.16,        // min log-chroma distance
  minTL: 9,           // min |dL| (Lab L units)
  shadowFrac: 0.5,    // a pixel darker than bg by < shadowFrac*bgL with bg chroma is a shadow candidate
  coreFrac: 0.25,     // component must have >= coreFrac non-shadow pixels for its shadow to be pruned
  minAreaFrac: 0.0012,// min component area (fraction of image)
  maxAreaFrac: 0.55,
  colorSplitDist: 0.30, // min centroid distance in (a,b)/(L+25) chromaticity to accept a 2-means colour split
  lightSplitDist: 0.42, // min centroid distance in L/100 for the lightness-only split
  colorSplitMinFrac: 0.12,
  shapeSeedFrac: 0.62,  // seeds = {DT >= frac * maxDT}
  shapeSplitRelArea: 1.6, // shape split only for blobs >= 1.6 x median blob area (needs >= 3 blobs)
  nestedFrac: 0.7,    // merge a piece into a bigger one when >= 70 % of its box is inside the bigger box
  pad: 0.08,
  maxDepth: 3,
};

// ---------- colour helpers ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgb2lab(r, g, b, out, o) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B);
  let z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  x = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
  out[o] = 116 * y - 16; out[o + 1] = 500 * (x - y); out[o + 2] = 200 * (y - z);
}
function lab2rgb(L, a, b) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
  x = 0.95047 * f(x); y = f(y); z = 1.08883 * f(z);
  const lin = [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.9692660 * x + 1.8760108 * y + 0.0415560 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
  return lin.map((c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); });
}
function median(arr, n) { // arr: Float32Array (mutated copy)
  const a = arr.slice(0, n); a.sort(); return n ? a[n >> 1] : 0;
}

// ---------- quadratic surface least squares (6 params) ----------
function fitQuad(xs, ys, vs, keep, n) {
  const A = new Float64Array(36), bv = new Float64Array(6), p = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x = xs[i], y = ys[i];
    p[0] = 1; p[1] = x; p[2] = y; p[3] = x * x; p[4] = y * y; p[5] = x * y;
    for (let r = 0; r < 6; r++) { bv[r] += p[r] * vs[i]; for (let c = 0; c < 6; c++) A[r * 6 + c] += p[r] * p[c]; }
  }
  for (let r = 0; r < 6; r++) A[r * 6 + r] += 1e-6; // ridge
  for (let c = 0; c < 6; c++) { // gaussian elimination with partial pivoting
    let piv = c; for (let r = c + 1; r < 6; r++) if (Math.abs(A[r * 6 + c]) > Math.abs(A[piv * 6 + c])) piv = r;
    if (piv !== c) { for (let k = 0; k < 6; k++) { const t = A[c * 6 + k]; A[c * 6 + k] = A[piv * 6 + k]; A[piv * 6 + k] = t; } const t = bv[c]; bv[c] = bv[piv]; bv[piv] = t; }
    const d = A[c * 6 + c];
    for (let r = c + 1; r < 6; r++) { const f = A[r * 6 + c] / d; if (!f) continue; for (let k = c; k < 6; k++) A[r * 6 + k] -= f * A[c * 6 + k]; bv[r] -= f * bv[c]; }
  }
  const sol = new Float64Array(6);
  for (let r = 5; r >= 0; r--) { let s = bv[r]; for (let k = r + 1; k < 6; k++) s -= A[r * 6 + k] * sol[k]; sol[r] = s / A[r * 6 + r]; }
  return sol;
}
const evalQuad = (s, x, y) => s[0] + s[1] * x + s[2] * y + s[3] * x * x + s[4] * y * y + s[5] * x * y;

// ---------- morphology / labelling ----------
function erode(m, w, h) { const o = new Uint8Array(w * h); for (let y = 1; y < h - 1; y++) for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w]; return o; }
function dilate(m, w, h) { const o = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0, i = y * w; x < w; x++, i++) o[i] = m[i] | (x > 0 ? m[i - 1] : 0) | (x < w - 1 ? m[i + 1] : 0) | (y > 0 ? m[i - w] : 0) | (y < h - 1 ? m[i + w] : 0); return o; }
/** 4-connected labelling. returns {labels:Int32Array (0 = none), comps:[{id,area,x0,y0,x1,y1}]} */
function label(m, w, h) {
  const labels = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || labels[s]) continue;
    id++; let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0; stack[sp++] = s; labels[s] = id;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && m[i - w] && !labels[i - w]) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && m[i + w] && !labels[i + w]) { labels[i + w] = id; stack[sp++] = i + w; }
    }
    comps.push({ id, area, x0, y0, x1, y1 });
  }
  return { labels, comps };
}

// ---------- main ----------
function segmentPile(rgba, w, h, options) {
  const t0 = Date.now();
  const o = Object.assign({}, DEFAULTS, options || {});
  const N = w * h;
  const lab = new Float32Array(N * 3), c1 = new Float32Array(N), c2 = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    rgb2lab(r, g, b, lab, i * 3);
    const lg = Math.log(g + 12); c1[i] = Math.log(r + 12) - lg; c2[i] = Math.log(b + 12) - lg;
  }
  // 1. background model from border ring
  const ring = Math.max(2, Math.round(Math.min(w, h) * o.ring));
  const idx = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < ring || y < ring || x >= w - ring || y >= h - ring) idx.push(y * w + x);
  const n = idx.length, xs = new Float32Array(n), ys = new Float32Array(n), vL = new Float32Array(n), v1 = new Float32Array(n), v2 = new Float32Array(n);
  for (let k = 0; k < n; k++) { const i = idx[k], x = i % w, y = (i - x) / w; xs[k] = (2 * x) / w - 1; ys[k] = (2 * y) / h - 1; vL[k] = lab[i * 3]; v1[k] = c1[i]; v2[k] = c2[i]; }
  let keep = new Uint8Array(n).fill(1), sL, s1, s2, sigL = 0, sigC = 0;
  const resL = new Float32Array(n), resC = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    sL = fitQuad(xs, ys, vL, keep, n); s1 = fitQuad(xs, ys, v1, keep, n); s2 = fitQuad(xs, ys, v2, keep, n);
    for (let k = 0; k < n; k++) { resL[k] = Math.abs(vL[k] - evalQuad(sL, xs[k], ys[k])); resC[k] = Math.hypot(v1[k] - evalQuad(s1, xs[k], ys[k]), v2[k] - evalQuad(s2, xs[k], ys[k])); }
    sigL = 1.4826 * median(resL, n); sigC = 1.4826 * median(resC, n);
    if (pass < 2) for (let k = 0; k < n; k++) keep[k] = resL[k] <= 3 * sigL + 2 && resC[k] <= 3 * sigC + 0.03 ? 1 : 0;
  }
  const TL = Math.max(o.minTL, o.kSigma * sigL), Tc = Math.max(o.minTc, o.kSigma * sigC);
  const quality = sigL > 9 || sigC > 0.12 ? 'patterned' : sigL > 3.5 || sigC > 0.05 ? 'textured' : 'plain';

  // 2. foreground + shadow candidates
  const fg = new Uint8Array(N), cand = new Uint8Array(N);
  for (let y = 0, i = 0; y < h; y++) {
    const ny = (2 * y) / h - 1;
    for (let x = 0; x < w; x++, i++) {
      const nx = (2 * x) / w - 1;
      const bL = evalQuad(sL, nx, ny), dL = lab[i * 3] - bL;
      const dc = Math.hypot(c1[i] - evalQuad(s1, nx, ny), c2[i] - evalQuad(s2, nx, ny));
      if (dc > Tc) fg[i] = 1;
      else if (dL > TL) fg[i] = 1;
      else if (dL < -TL) { fg[i] = 1; if (dL > -o.shadowFrac * bL) cand[i] = 1; }
    }
  }
  // 3. shadow pruning: drop candidates in components that have enough "core" pixels
  let L0 = label(fg, w, h);
  const core = new Int32Array(L0.comps.length + 1);
  for (let i = 0; i < N; i++) if (fg[i] && !cand[i]) core[L0.labels[i]]++;
  for (let i = 0; i < N; i++) if (cand[i]) { const c = L0.comps[L0.labels[i] - 1]; if (core[c.id] >= o.coreFrac * c.area) fg[i] = 0; }
  // 4. open (remove specks) then close (fill stud highlights / thin gaps)
  let m = dilate(erode(fg, w, h), w, h);
  m = erode(dilate(m, w, h), w, h);
  // border pixels are zeroed by erode(): restore from the pre-morph mask so that cut-off pieces still touch the edge
  for (let x = 0; x < w; x++) { m[x] = fg[x] & m[x + w]; m[(h - 1) * w + x] = fg[(h - 1) * w + x] & m[(h - 2) * w + x]; }
  for (let y = 0; y < h; y++) { m[y * w] = fg[y * w] & m[y * w + 1]; m[y * w + w - 1] = fg[y * w + w - 1] & m[y * w + w - 2]; }

  const minArea = Math.max(12, Math.round(o.minAreaFrac * N));
  const { labels, comps } = label(m, w, h);
  // 5. split blobs
  const pieces = []; // {pix:Int32Array, fromSplit}
  const okAreas = comps.filter((c) => c.area >= minArea && c.area <= o.maxAreaFrac * N).map((c) => c.area).sort((p, q) => p - q);
  const medArea = okAreas.length >= 3 ? okAreas[okAreas.length >> 1] : Infinity;
  for (const c of comps) {
    if (c.area < minArea || c.area > o.maxAreaFrac * N) continue;
    const pix = new Int32Array(c.area); let k = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0, i = y * w + c.x0; x <= c.x1; x++, i++) if (labels[i] === c.id) pix[k++] = i;
    splitRec(pix, 0, false);
  }
  function splitRec(pix, depth, fromSplit) {
    if (depth < o.maxDepth && pix.length >= 2 * minArea) {
      // shape split is noisy on single pieces (studs, concave parts): only try it on blobs clearly bigger than the typical one
      const parts = colorSplit(pix) || (pix.length >= o.shapeSplitRelArea * medArea ? shapeSplit(pix) : null);
      if (parts) { for (const p of parts) splitRec(p, depth + 1, true); return; }
    }
    pieces.push({ pix, fromSplit });
  }
  function subComponents(pix, sel, want) { // connected comps of pixels where sel[k]===want; returns arrays sorted by size desc
    const tmp = new Uint8Array(N); for (let k = 0; k < pix.length; k++) if (sel[k] === want) tmp[pix[k]] = 1;
    const out = []; const stack = [];
    for (let k = 0; k < pix.length; k++) {
      const s = pix[k]; if (tmp[s] !== 1) continue;
      const acc = []; stack.push(s); tmp[s] = 2;
      while (stack.length) {
        const i = stack.pop(), x = i % w; acc.push(i);
        if (x > 0 && tmp[i - 1] === 1) { tmp[i - 1] = 2; stack.push(i - 1); }
        if (x < w - 1 && tmp[i + 1] === 1) { tmp[i + 1] = 2; stack.push(i + 1); }
        if (i >= w && tmp[i - w] === 1) { tmp[i - w] = 2; stack.push(i - w); }
        if (i < N - w && tmp[i + w] === 1) { tmp[i + w] = 2; stack.push(i + w); }
      }
      out.push(Int32Array.from(acc));
    }
    return out.sort((a, b) => b.length - a.length);
  }
  function colorSplit(pix) {
    // pass 1: illumination-invariant chromaticity (a,b)/(L+25): faces of one piece share it, different colours do not.
    // pass 2 (only if pass 1 fails): lightness alone, with a large gap (white vs black/dark pieces).
    const byChroma = twoMeans(pix, 0); if (byChroma) return byChroma;
    // lightness split only for achromatic blobs (a coloured piece has lit/shaded faces with a big L gap)
    const cs = new Float32Array(pix.length); for (let k = 0; k < pix.length; k++) cs[k] = Math.hypot(lab[pix[k] * 3 + 1], lab[pix[k] * 3 + 2]);
    return median(cs, pix.length) < 12 ? twoMeans(pix, 1) : null;
  }
  function twoMeans(pix, mode) {
    const n = pix.length, f = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) {
      const i = pix[k] * 3;
      if (mode === 0) { const s = 1 / (lab[i] + 25); f[k * 2] = lab[i + 1] * s; f[k * 2 + 1] = lab[i + 2] * s; }
      else { f[k * 2] = lab[i] / 100; f[k * 2 + 1] = 0; }
    }
    let mx = 0, my = 0; for (let k = 0; k < n; k++) { mx += f[k * 2]; my += f[k * 2 + 1]; } mx /= n; my /= n;
    const d2 = (k, cx, cy) => { const a = f[k * 2] - cx, b = f[k * 2 + 1] - cy; return a * a + b * b; };
    let lo = 0, hi = 0, dmax = -1;
    for (let k = 0; k < n; k++) { const d = d2(k, mx, my); if (d > dmax) { dmax = d; lo = k; } }
    let ax = f[lo * 2], ay = f[lo * 2 + 1]; dmax = -1;
    for (let k = 0; k < n; k++) { const d = d2(k, ax, ay); if (d > dmax) { dmax = d; hi = k; } }
    let bx = f[hi * 2], by = f[hi * 2 + 1];
    const sel = new Uint8Array(n); let na = 0, nb = 0;
    for (let it = 0; it < 8; it++) {
      let sax = 0, say = 0, sbx = 0, sby = 0; na = 0; nb = 0;
      for (let k = 0; k < n; k++) {
        if (d2(k, ax, ay) <= d2(k, bx, by)) { sel[k] = 0; na++; sax += f[k * 2]; say += f[k * 2 + 1]; }
        else { sel[k] = 1; nb++; sbx += f[k * 2]; sby += f[k * 2 + 1]; }
      }
      if (!na || !nb) return null;
      ax = sax / na; ay = say / na; bx = sbx / nb; by = sby / nb;
    }
    const dist = Math.hypot(ax - bx, ay - by);
    if (dist < (mode === 0 ? o.colorSplitDist : o.lightSplitDist)) return null;
    const minPart = Math.max(minArea, o.colorSplitMinFrac * n);
    if (na < minPart || nb < minPart) return null;
    const A = subComponents(pix, sel, 0), B = subComponents(pix, sel, 1);
    // each cluster must be spatially compact (otherwise it is shading/print of a single piece)
    if (A[0].length < 0.75 * na || B[0].length < 0.75 * nb) return null;
    return [...A, ...B].filter((p) => p.length >= minArea);
  }
  function shapeSplit(pix) {
    // chamfer distance transform inside the blob bbox
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let k = 0; k < pix.length; k++) { const i = pix[k], x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3, dt = new Float32Array(bw * bh);
    const loc = new Int32Array(pix.length);
    for (let k = 0; k < pix.length; k++) { const i = pix[k], x = i % w, y = (i - x) / w; loc[k] = (y - y0 + 1) * bw + (x - x0 + 1); dt[loc[k]] = 1e6; }
    for (let y = 1; y < bh - 1; y++) for (let x = 1, i = y * bw + 1; x < bw - 1; x++, i++) if (dt[i]) dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - bw] + 1, dt[i - bw - 1] + 1.414, dt[i - bw + 1] + 1.414);
    let M = 0;
    for (let y = bh - 2; y > 0; y--) for (let x = bw - 2, i = y * bw + x; x > 0; x--, i--) if (dt[i]) { dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + bw] + 1, dt[i + bw + 1] + 1.414, dt[i + bw - 1] + 1.414); if (dt[i] > M) M = dt[i]; }
    if (M < 3) return null;
    const sel = new Uint8Array(pix.length); const thr = o.shapeSeedFrac * M;
    for (let k = 0; k < pix.length; k++) sel[k] = dt[loc[k]] >= thr ? 1 : 0;
    const seeds = subComponents(pix, sel, 1).filter((s) => s.length >= 3);
    if (seeds.length < 2 || seeds.length > 4) return null;
    // multi-source BFS growth (nearest seed, geodesic)
    const owner = new Int8Array(N).fill(-2); for (let k = 0; k < pix.length; k++) owner[pix[k]] = -1;
    let frontier = [];
    seeds.forEach((s, si) => { for (let k = 0; k < s.length; k++) { owner[s[k]] = si; frontier.push(s[k]); } });
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        const x = i % w, ow = owner[i];
        if (x > 0 && owner[i - 1] === -1) { owner[i - 1] = ow; next.push(i - 1); }
        if (x < w - 1 && owner[i + 1] === -1) { owner[i + 1] = ow; next.push(i + 1); }
        if (i >= w && owner[i - w] === -1) { owner[i - w] = ow; next.push(i - w); }
        if (i < N - w && owner[i + w] === -1) { owner[i + w] = ow; next.push(i + w); }
      }
      frontier = next;
    }
    const parts = seeds.map(() => []);
    for (let k = 0; k < pix.length; k++) { const ow = owner[pix[k]]; if (ow >= 0) parts[ow].push(pix[k]); }
    const res = parts.filter((p) => p.length >= minArea).map((p) => Int32Array.from(p));
    return res.length >= 2 ? res : null;
  }

  // 5b. merge nested pieces: a piece whose tight box lies mostly inside another one is a face/shade of it
  const tb = pieces.map((p) => { let x0 = w, y0 = h, x1 = 0, y1 = 0; for (let k = 0; k < p.pix.length; k++) { const i = p.pix[k], x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1 + 1, y1 + 1]; });
  const order = pieces.map((_, i) => i).sort((i, j) => pieces[i].pix.length - pieces[j].pix.length);
  const gone = new Uint8Array(pieces.length);
  for (const i of order) {
    for (let j = 0; j < pieces.length; j++) {
      if (j === i || gone[j] || pieces[j].pix.length < pieces[i].pix.length) continue;
      const A = tb[i], B = tb[j], iw = Math.min(A[2], B[2]) - Math.max(A[0], B[0]), ih = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      if (iw > 0 && ih > 0 && iw * ih >= o.nestedFrac * (A[2] - A[0]) * (A[3] - A[1])) {
        const merged = new Int32Array(pieces[i].pix.length + pieces[j].pix.length); merged.set(pieces[j].pix); merged.set(pieces[i].pix, pieces[j].pix.length);
        pieces[j].pix = merged; tb[j] = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[2], B[2]), Math.max(A[3], B[3])]; gone[i] = 1; break;
      }
    }
  }
  for (let i = pieces.length - 1; i >= 0; i--) if (gone[i]) pieces.splice(i, 1);

  // 6. boxes + dominant colour
  const boxes = pieces.map((p) => {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let k = 0; k < p.pix.length; k++) { const i = p.pix[k], x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const partial = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
    const pad = Math.round(o.pad * Math.max(x1 - x0 + 1, y1 - y0 + 1));
    const px0 = Math.max(0, x0 - pad), py0 = Math.max(0, y0 - pad), px1 = Math.min(w - 1, x1 + pad), py1 = Math.min(h - 1, y1 + pad);
    const col = dominantLab(lab, p.pix);
    return {
      x: px0, y: py0, w: px1 - px0 + 1, h: py1 - py0 + 1,
      nx: px0 / w, ny: py0 / h, nw: (px1 - px0 + 1) / w, nh: (py1 - py0 + 1) / h,
      tight: [x0, y0, x1 + 1, y1 + 1], area: p.pix.length, partial, fromSplit: p.fromSplit, suspectMerged: false,
      lab: col, rgb: lab2rgb(col[0], col[1], col[2]),
    };
  });
  if (boxes.length >= 3) { const ar = boxes.map((b) => b.area).sort((a, b) => a - b), med = ar[ar.length >> 1]; for (const b of boxes) b.suspectMerged = b.area > 3 * med; }
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  return { boxes, background: { quality, sigmaL: sigL, sigmaC: sigC }, ms: Date.now() - t0 };
}

/**
 * Dominant colour of a piece: median Lab of the pixels in the mid/upper lightness band
 * (rejects shadowed faces = darkest 40 % and specular glare = brightest 10 % + low-chroma highlights).
 */
function dominantLab(lab, pix) {
  const n = pix.length, Ls = new Float32Array(n), Cs = new Float32Array(n);
  for (let k = 0; k < n; k++) { const i = pix[k] * 3; Ls[k] = lab[i]; Cs[k] = Math.hypot(lab[i + 1], lab[i + 2]); }
  const sorted = Ls.slice().sort(); const lo = sorted[Math.floor(n * 0.4)], hi = sorted[Math.min(n - 1, Math.floor(n * 0.9))];
  const medC = median(Cs, n);
  const a = [], b = [], l = [];
  for (let k = 0; k < n; k++) {
    if (Ls[k] < lo || Ls[k] > hi) continue;
    if (medC > 12 && Cs[k] < 0.5 * medC) continue; // glare / desaturated highlight on a coloured piece
    const i = pix[k] * 3; l.push(lab[i]); a.push(lab[i + 1]); b.push(lab[i + 2]);
  }
  if (l.length < 5) { for (let k = 0; k < n; k++) { const i = pix[k] * 3; l.push(lab[i]); a.push(lab[i + 1]); b.push(lab[i + 2]); } }
  const med = (v) => { v.sort((p, q) => p - q); return v[v.length >> 1]; };
  return [med(l), med(a), med(b)];
}

// ---------- CIEDE2000 + nearest catalogue colour ----------
function ciede2000(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2, rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cm, 7) / (Math.pow(Cm, 7) + 6103515625)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (y, x) => { if (!x && !y) return 0; const d = Math.atan2(y, x) / rad; return d < 0 ? d + 360 : d; };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0; if (C1p * C2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lm = (L1 + L2) / 2, Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p; if (C1p * C2p) { hm = Math.abs(h1p - h2p) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2; }
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hm - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cmp, 7) / (Math.pow(Cmp, 7) + 6103515625));
  const Sl = 1 + (0.015 * Math.pow(Lm - 50, 2)) / Math.sqrt(20 + Math.pow(Lm - 50, 2)), Sc = 1 + 0.045 * Cmp, Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(Math.pow(dLp / Sl, 2) + Math.pow(dCp / Sc, 2) + Math.pow(dHp / Sh, 2) + Rt * (dCp / Sc) * (dHp / Sh));
}
function hexToLab(hex) { const out = [0, 0, 0]; rgb2lab(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), out, 0); return out; }
/** colors: Rebrickable colour rows [{id,name,rgb,is_trans}]; allowedIds optional Set (colours the part exists in). Returns ranked [{id,name,dE}] */
function nearestColors(labv, colors, allowedIds, k) {
  const res = [];
  for (const c of colors) {
    if (c.id < 0 || c.id === 9999) continue; // [Unknown] / [No Color/Any Color]
    if (allowedIds && !allowedIds.has(c.id)) continue;
    if (c.is_trans) continue; // transparent colours cannot be measured against an unknown background: leave to the API/user
    res.push({ id: c.id, name: c.name, dE: ciede2000(labv, c._lab || (c._lab = hexToLab(c.rgb))) });
  }
  return res.sort((a, b) => a.dE - b.dE).slice(0, k || 3);
}

module.exports = { segmentPile, dominantLab, ciede2000, nearestColors, hexToLab, rgb2lab, lab2rgb, DEFAULTS };

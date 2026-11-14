// Pile segmentation: TypeScript port of docs/research/segment.prototype.js (Appendix A). Pure, typed arrays only.
//
// Pipeline: Lab + log-chromaticity -> quadratic background surface fitted on the border ring (robust, 3 passes)
// -> foreground = chroma residual OR lightness residual -> shadow pruning -> open/close -> connected components
// -> colour split (2-means) -> shape split (distance-transform seeds) -> nested merge -> boxes + dominant colour.
//
// Written as a generator that yields between stages so that `segmentPileAsync` can hand the JS thread back to the
// UI (touches, animations) while a thumbnail is being analysed.
import type { BackgroundQuality, Lab, SegBox, SegmentationResult } from '../types';
import { labToRgb, rgbToLabInto } from './lab';

export interface SegmentOptions {
  ring?: number; kSigma?: number; minTc?: number; minTL?: number; shadowFrac?: number;
  coreFrac?: number; minAreaFrac?: number; maxAreaFrac?: number; colorSplitDist?: number; lightSplitDist?: number;
  colorSplitMinFrac?: number; shapeSeedFrac?: number; shapeSplitRelArea?: number; nestedFrac?: number; pad?: number;
  maxDepth?: number;
}

export const SEGMENT_DEFAULTS: Required<SegmentOptions> = {
  ring: 0.035, kSigma: 4.5, minTc: 0.16, minTL: 9, shadowFrac: 0.5, coreFrac: 0.25, minAreaFrac: 0.0012,
  maxAreaFrac: 0.55, colorSplitDist: 0.3, lightSplitDist: 0.42, colorSplitMinFrac: 0.12, shapeSeedFrac: 0.62,
  shapeSplitRelArea: 1.6, nestedFrac: 0.7, pad: 0.08, maxDepth: 3,
};

const MIN_SIDE = 16;

// Hoisted Math functions: hot loops call these directly (avoids a global property lookup per pixel, which is very
// slow in some JS sandboxes such as Jest's VM context).
const { log: mLog, hypot: mHypot, abs: mAbs, min: mMin, max: mMax, round: mRound, floor: mFloor } = Math;

// ---------- helpers ----------

/** Median of the first n values (numeric typed-array sort on a copy). */
function median(arr: Float32Array, n: number): number {
  if (!n) return 0;
  const a = arr.slice(0, n);
  a.sort();
  return a[n >> 1];
}

/** Least-squares quadratic surface a + bx + cy + dx² + ey² + fxy (1e-6 ridge, Gaussian elimination). */
function fitQuad(xs: Float32Array, ys: Float32Array, vs: Float32Array, keep: Uint8Array, n: number): Float64Array {
  const A = new Float64Array(36), bv = new Float64Array(6), p = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const x = xs[i], y = ys[i];
    p[0] = 1; p[1] = x; p[2] = y; p[3] = x * x; p[4] = y * y; p[5] = x * y;
    for (let r = 0; r < 6; r++) {
      bv[r] += p[r] * vs[i];
      for (let c = 0; c < 6; c++) A[r * 6 + c] += p[r] * p[c];
    }
  }
  for (let r = 0; r < 6; r++) A[r * 6 + r] += 1e-6;
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let r = c + 1; r < 6; r++) if (mAbs(A[r * 6 + c]) > mAbs(A[piv * 6 + c])) piv = r;
    if (piv !== c) {
      for (let k = 0; k < 6; k++) { const t = A[c * 6 + k]; A[c * 6 + k] = A[piv * 6 + k]; A[piv * 6 + k] = t; }
      const t = bv[c]; bv[c] = bv[piv]; bv[piv] = t;
    }
    const d = A[c * 6 + c];
    for (let r = c + 1; r < 6; r++) {
      const f = A[r * 6 + c] / d;
      if (!f) continue;
      for (let k = c; k < 6; k++) A[r * 6 + k] -= f * A[c * 6 + k];
      bv[r] -= f * bv[c];
    }
  }
  const sol = new Float64Array(6);
  for (let r = 5; r >= 0; r--) {
    let s = bv[r];
    for (let k = r + 1; k < 6; k++) s -= A[r * 6 + k] * sol[k];
    sol[r] = s / A[r * 6 + r];
  }
  return sol;
}

function evalQuad(s: Float64Array, x: number, y: number): number {
  return s[0] + s[1] * x + s[2] * y + s[3] * x * x + s[4] * y * y + s[5] * x * y;
}

/** 3×3 cross erosion (border pixels become 0). */
function erode(m: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) o[i] = m[i] & m[i - 1] & m[i + 1] & m[i - w] & m[i + w];
  }
  return o;
}

/** 3×3 cross dilation. */
function dilate(m: Uint8Array, w: number, h: number): Uint8Array {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w; x < w; x++, i++) {
      o[i] = m[i] | (x > 0 ? m[i - 1] : 0) | (x < w - 1 ? m[i + 1] : 0) | (y > 0 ? m[i - w] : 0) | (y < h - 1 ? m[i + w] : 0);
    }
  }
  return o;
}

interface Comp { id: number; area: number; x0: number; y0: number; x1: number; y1: number }

/** 4-connected labelling (0 = background). */
function label(m: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Comp[] } {
  const N = w * h;
  const labels = new Int32Array(N), stack = new Int32Array(N), comps: Comp[] = [];
  let id = 0;
  for (let s = 0; s < N; s++) {
    if (!m[s] || labels[s]) continue;
    id++;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack[sp++] = s; labels[s] = id;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && m[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && m[i - w] && !labels[i - w]) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && m[i + w] && !labels[i + w]) { labels[i + w] = id; stack[sp++] = i + w; }
    }
    comps.push({ id, area, x0, y0, x1, y1 });
  }
  return { labels, comps };
}

/** Dominant colour of a mask: median Lab of the pixels between the 40th and 90th lightness percentile, dropping
 *  desaturated highlights on a coloured piece; fewer than 5 pixels left → all pixels. */
function dominantLab(lab: Float32Array, pix: Int32Array): Lab {
  const n = pix.length, Ls = new Float32Array(n), Cs = new Float32Array(n);
  for (let k = 0; k < n; k++) { const i = pix[k] * 3; Ls[k] = lab[i]; Cs[k] = mHypot(lab[i + 1], lab[i + 2]); }
  const sorted = Ls.slice().sort();
  const lo = sorted[mFloor(n * 0.4)], hi = sorted[mMin(n - 1, mFloor(n * 0.9))];
  const medC = median(Cs, n);
  const l = new Float32Array(n), a = new Float32Array(n), b = new Float32Array(n);
  let m = 0;
  for (let k = 0; k < n; k++) {
    if (Ls[k] < lo || Ls[k] > hi) continue;
    if (medC > 12 && Cs[k] < 0.5 * medC) continue;
    const i = pix[k] * 3;
    l[m] = lab[i]; a[m] = lab[i + 1]; b[m] = lab[i + 2]; m++;
  }
  if (m < 5) {
    // the prototype appends every pixel to the (< 5) kept ones; replicate exactly
    const total = m + n;
    const l2 = new Float32Array(total), a2 = new Float32Array(total), b2 = new Float32Array(total);
    l2.set(l.subarray(0, m)); a2.set(a.subarray(0, m)); b2.set(b.subarray(0, m));
    for (let k = 0; k < n; k++) { const i = pix[k] * 3; l2[m + k] = lab[i]; a2[m + k] = lab[i + 1]; b2[m + k] = lab[i + 2]; }
    return [median(l2, total), median(a2, total), median(b2, total)];
  }
  return [median(l, m), median(a, m), median(b, m)];
}

function validate(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIDE || height < MIN_SIDE) {
    throw new RangeError(`segmentPile: image must be at least ${MIN_SIDE}×${MIN_SIDE} px (got ${width}×${height})`);
  }
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`segmentPile: expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  }
}

const now = (): number => Date.now();

// ---------- main generator ----------

/** Yields (void) between stages; returns the result. `ms` counts only the time spent computing, not yielded time. */
function* segmentStages(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number,
  options: SegmentOptions | undefined): Generator<void, SegmentationResult, void> {
  validate(rgba, w, h);
  let active = 0;
  let t = now();
  const o: Required<SegmentOptions> = { ...SEGMENT_DEFAULTS };
  if (options) {
    for (const key of Object.keys(options) as (keyof SegmentOptions)[]) {
      const v = options[key];
      if (v !== undefined) o[key] = v;
    }
  }
  const N = w * h;

  // 0. per-pixel Lab + log-chromaticity
  const lab = new Float32Array(N * 3), c1 = new Float32Array(N), c2 = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    rgbToLabInto(r, g, b, lab, i * 3);
    const lg = mLog(g + 12);
    c1[i] = mLog(r + 12) - lg;
    c2[i] = mLog(b + 12) - lg;
  }
  active += now() - t; yield; t = now();

  // 1. background model from the border ring
  const ring = mMax(2, mRound(mMin(w, h) * o.ring));
  const inRing = (x: number, y: number): boolean => x < ring || y < ring || x >= w - ring || y >= h - ring;
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inRing(x, y)) n++;
  const xs = new Float32Array(n), ys = new Float32Array(n), vL = new Float32Array(n), v1 = new Float32Array(n), v2 = new Float32Array(n);
  for (let y = 0, k = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inRing(x, y)) continue;
      const i = y * w + x;
      xs[k] = (2 * x) / w - 1; ys[k] = (2 * y) / h - 1; vL[k] = lab[i * 3]; v1[k] = c1[i]; v2[k] = c2[i];
      k++;
    }
  }
  const keep = new Uint8Array(n).fill(1);
  const resL = new Float32Array(n), resC = new Float32Array(n);
  let sL: Float64Array = new Float64Array(6), s1 = sL, s2 = sL, sigL = 0, sigC = 0;
  for (let pass = 0; pass < 3; pass++) {
    sL = fitQuad(xs, ys, vL, keep, n); s1 = fitQuad(xs, ys, v1, keep, n); s2 = fitQuad(xs, ys, v2, keep, n);
    for (let k = 0; k < n; k++) {
      resL[k] = mAbs(vL[k] - evalQuad(sL, xs[k], ys[k]));
      resC[k] = mHypot(v1[k] - evalQuad(s1, xs[k], ys[k]), v2[k] - evalQuad(s2, xs[k], ys[k]));
    }
    sigL = 1.4826 * median(resL, n); sigC = 1.4826 * median(resC, n);
    if (pass < 2) for (let k = 0; k < n; k++) keep[k] = resL[k] <= 3 * sigL + 2 && resC[k] <= 3 * sigC + 0.03 ? 1 : 0;
  }
  const TL = mMax(o.minTL, o.kSigma * sigL), Tc = mMax(o.minTc, o.kSigma * sigC);
  const quality: BackgroundQuality = sigL > 9 || sigC > 0.12 ? 'patterned' : sigL > 3.5 || sigC > 0.05 ? 'textured' : 'plain';
  active += now() - t; yield; t = now();

  // 2. foreground + shadow candidates
  const fg = new Uint8Array(N), cand = new Uint8Array(N);
  for (let y = 0, i = 0; y < h; y++) {
    const ny = (2 * y) / h - 1;
    for (let x = 0; x < w; x++, i++) {
      const nx = (2 * x) / w - 1;
      const bL = evalQuad(sL, nx, ny), dL = lab[i * 3] - bL;
      const dc = mHypot(c1[i] - evalQuad(s1, nx, ny), c2[i] - evalQuad(s2, nx, ny));
      if (dc > Tc) fg[i] = 1;
      else if (dL > TL) fg[i] = 1;
      else if (dL < -TL) { fg[i] = 1; if (dL > -o.shadowFrac * bL) cand[i] = 1; }
    }
  }
  active += now() - t; yield; t = now();

  // 3. shadow pruning: drop candidates in components that have enough "core" pixels
  {
    const L0 = label(fg, w, h);
    const core = new Int32Array(L0.comps.length + 1);
    for (let i = 0; i < N; i++) if (fg[i] && !cand[i]) core[L0.labels[i]]++;
    for (let i = 0; i < N; i++) {
      if (!cand[i]) continue;
      const c = L0.comps[L0.labels[i] - 1];
      if (core[c.id] >= o.coreFrac * c.area) fg[i] = 0;
    }
  }
  active += now() - t; yield; t = now();

  // 4. open (remove specks) then close (fill stud highlights / thin gaps); restore border pixels
  let m = dilate(erode(fg, w, h), w, h);
  m = erode(dilate(m, w, h), w, h);
  for (let x = 0; x < w; x++) {
    m[x] = fg[x] & m[x + w];
    m[(h - 1) * w + x] = fg[(h - 1) * w + x] & m[(h - 2) * w + x];
  }
  for (let y = 0; y < h; y++) {
    m[y * w] = fg[y * w] & m[y * w + 1];
    m[y * w + w - 1] = fg[y * w + w - 1] & m[y * w + w - 2];
  }
  const minArea = mMax(12, mRound(o.minAreaFrac * N));
  const maxArea = o.maxAreaFrac * N;
  const { labels, comps } = label(m, w, h);
  active += now() - t; yield; t = now();

  // 5. split blobs
  interface Piece { pix: Int32Array; fromSplit: boolean }
  const pieces: Piece[] = [];
  const okAreas = comps.filter((c) => c.area >= minArea && c.area <= maxArea).map((c) => c.area).sort((p, q) => p - q);
  const medArea = okAreas.length >= 3 ? okAreas[okAreas.length >> 1] : Infinity;

  // scratch buffers reused by subComponents
  const tmp = new Uint8Array(N);
  const stackBuf = new Int32Array(N);
  const accBuf = new Int32Array(N);

  /** Connected regions of pixels where sel[k] === want, sorted by size desc. */
  const subComponents = (pix: Int32Array, sel: Uint8Array, want: number): Int32Array[] => {
    for (let k = 0; k < pix.length; k++) if (sel[k] === want) tmp[pix[k]] = 1;
    const out: Int32Array[] = [];
    for (let k = 0; k < pix.length; k++) {
      const s = pix[k];
      if (tmp[s] !== 1) continue;
      let sp = 0, na = 0;
      stackBuf[sp++] = s; tmp[s] = 2;
      while (sp) {
        const i = stackBuf[--sp], x = i % w;
        accBuf[na++] = i;
        if (x > 0 && tmp[i - 1] === 1) { tmp[i - 1] = 2; stackBuf[sp++] = i - 1; }
        if (x < w - 1 && tmp[i + 1] === 1) { tmp[i + 1] = 2; stackBuf[sp++] = i + 1; }
        if (i >= w && tmp[i - w] === 1) { tmp[i - w] = 2; stackBuf[sp++] = i - w; }
        if (i < N - w && tmp[i + w] === 1) { tmp[i + w] = 2; stackBuf[sp++] = i + w; }
      }
      out.push(accBuf.slice(0, na));
    }
    for (let k = 0; k < pix.length; k++) tmp[pix[k]] = 0; // reset scratch
    return out.sort((a, b) => b.length - a.length);
  };

  const twoMeans = (pix: Int32Array, mode: 0 | 1): Int32Array[] | null => {
    const np = pix.length, f = new Float32Array(np * 2);
    for (let k = 0; k < np; k++) {
      const i = pix[k] * 3;
      if (mode === 0) { const s = 1 / (lab[i] + 25); f[k * 2] = lab[i + 1] * s; f[k * 2 + 1] = lab[i + 2] * s; }
      else { f[k * 2] = lab[i] / 100; f[k * 2 + 1] = 0; }
    }
    let mx = 0, my = 0;
    for (let k = 0; k < np; k++) { mx += f[k * 2]; my += f[k * 2 + 1]; }
    mx /= np; my /= np;
    const d2 = (k: number, cx: number, cy: number): number => { const a = f[k * 2] - cx, b = f[k * 2 + 1] - cy; return a * a + b * b; };
    let lo = 0, hi = 0, dmax = -1;
    for (let k = 0; k < np; k++) { const d = d2(k, mx, my); if (d > dmax) { dmax = d; lo = k; } }
    let ax = f[lo * 2], ay = f[lo * 2 + 1];
    dmax = -1;
    for (let k = 0; k < np; k++) { const d = d2(k, ax, ay); if (d > dmax) { dmax = d; hi = k; } }
    let bx = f[hi * 2], by = f[hi * 2 + 1];
    const sel = new Uint8Array(np);
    let na = 0, nb = 0;
    for (let it = 0; it < 8; it++) {
      let sax = 0, say = 0, sbx = 0, sby = 0;
      na = 0; nb = 0;
      for (let k = 0; k < np; k++) {
        if (d2(k, ax, ay) <= d2(k, bx, by)) { sel[k] = 0; na++; sax += f[k * 2]; say += f[k * 2 + 1]; }
        else { sel[k] = 1; nb++; sbx += f[k * 2]; sby += f[k * 2 + 1]; }
      }
      if (!na || !nb) return null;
      ax = sax / na; ay = say / na; bx = sbx / nb; by = sby / nb;
    }
    const dist = mHypot(ax - bx, ay - by);
    if (dist < (mode === 0 ? o.colorSplitDist : o.lightSplitDist)) return null;
    const minPart = mMax(minArea, o.colorSplitMinFrac * np);
    if (na < minPart || nb < minPart) return null;
    const A = subComponents(pix, sel, 0), B = subComponents(pix, sel, 1);
    // each cluster must be spatially compact (otherwise it is shading or print of a single piece)
    if (A[0].length < 0.75 * na || B[0].length < 0.75 * nb) return null;
    return [...A, ...B].filter((p) => p.length >= minArea);
  };

  const colorSplit = (pix: Int32Array): Int32Array[] | null => {
    const byChroma = twoMeans(pix, 0);
    if (byChroma) return byChroma;
    // lightness split only for achromatic blobs (a coloured piece has lit/shaded faces with a big L gap)
    const cs = new Float32Array(pix.length);
    for (let k = 0; k < pix.length; k++) cs[k] = mHypot(lab[pix[k] * 3 + 1], lab[pix[k] * 3 + 2]);
    return median(cs, pix.length) < 12 ? twoMeans(pix, 1) : null;
  };

  const owner = new Int8Array(N).fill(-2);
  const shapeSplit = (pix: Int32Array): Int32Array[] | null => {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let k = 0; k < pix.length; k++) {
      const i = pix[k], x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const bw = x1 - x0 + 3, bh = y1 - y0 + 3, dt = new Float32Array(bw * bh);
    const loc = new Int32Array(pix.length);
    for (let k = 0; k < pix.length; k++) {
      const i = pix[k], x = i % w, y = (i - x) / w;
      loc[k] = (y - y0 + 1) * bw + (x - x0 + 1);
      dt[loc[k]] = 1e6;
    }
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1, i = y * bw + 1; x < bw - 1; x++, i++) {
        if (dt[i]) dt[i] = mMin(dt[i], dt[i - 1] + 1, dt[i - bw] + 1, dt[i - bw - 1] + 1.414, dt[i - bw + 1] + 1.414);
      }
    }
    let M = 0;
    for (let y = bh - 2; y > 0; y--) {
      for (let x = bw - 2, i = y * bw + x; x > 0; x--, i--) {
        if (dt[i]) {
          dt[i] = mMin(dt[i], dt[i + 1] + 1, dt[i + bw] + 1, dt[i + bw + 1] + 1.414, dt[i + bw - 1] + 1.414);
          if (dt[i] > M) M = dt[i];
        }
      }
    }
    if (M < 3) return null;
    const sel = new Uint8Array(pix.length);
    const thr = o.shapeSeedFrac * M;
    for (let k = 0; k < pix.length; k++) sel[k] = dt[loc[k]] >= thr ? 1 : 0;
    const seeds = subComponents(pix, sel, 1).filter((s) => s.length >= 3);
    if (seeds.length < 2 || seeds.length > 4) return null;
    // multi-source BFS growth (nearest seed, geodesic); a FIFO queue reproduces the prototype's frontier order
    for (let k = 0; k < pix.length; k++) owner[pix[k]] = -1;
    const queue = new Int32Array(pix.length);
    let qh = 0, qt = 0;
    seeds.forEach((s, si) => { for (let k = 0; k < s.length; k++) { owner[s[k]] = si; queue[qt++] = s[k]; } });
    while (qh < qt) {
      const i = queue[qh++], x = i % w, ow = owner[i];
      if (x > 0 && owner[i - 1] === -1) { owner[i - 1] = ow; queue[qt++] = i - 1; }
      if (x < w - 1 && owner[i + 1] === -1) { owner[i + 1] = ow; queue[qt++] = i + 1; }
      if (i >= w && owner[i - w] === -1) { owner[i - w] = ow; queue[qt++] = i - w; }
      if (i < N - w && owner[i + w] === -1) { owner[i + w] = ow; queue[qt++] = i + w; }
    }
    const counts = new Int32Array(seeds.length);
    for (let k = 0; k < pix.length; k++) { const ow = owner[pix[k]]; if (ow >= 0) counts[ow]++; }
    const parts = seeds.map((_, si) => new Int32Array(counts[si]));
    const fill = new Int32Array(seeds.length);
    for (let k = 0; k < pix.length; k++) { const ow = owner[pix[k]]; if (ow >= 0) parts[ow][fill[ow]++] = pix[k]; }
    for (let k = 0; k < pix.length; k++) owner[pix[k]] = -2; // reset scratch
    const res = parts.filter((p) => p.length >= minArea);
    return res.length >= 2 ? res : null;
  };

  const splitRec = (pix: Int32Array, depth: number, fromSplit: boolean): void => {
    if (depth < o.maxDepth && pix.length >= 2 * minArea) {
      // shape split is noisy on single pieces (studs, concave parts): only on blobs clearly bigger than the typical one
      const parts = colorSplit(pix) || (pix.length >= o.shapeSplitRelArea * medArea ? shapeSplit(pix) : null);
      if (parts) { for (const p of parts) splitRec(p, depth + 1, true); return; }
    }
    pieces.push({ pix, fromSplit });
  };

  let work = 0;
  for (const c of comps) {
    if (c.area < minArea || c.area > maxArea) continue;
    const pix = new Int32Array(c.area);
    let k = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0, i = y * w + c.x0; x <= c.x1; x++, i++) if (labels[i] === c.id) pix[k++] = i;
    splitRec(pix, 0, false);
    work += c.area;
    if (work >= N / 4) { work = 0; active += now() - t; yield; t = now(); }
  }
  active += now() - t; yield; t = now();

  // 5b. merge nested pieces: a piece whose tight box lies mostly inside a bigger one is a face/shade of it
  const tightOf = (pix: Int32Array): [number, number, number, number] => {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let k = 0; k < pix.length; k++) {
      const i = pix[k], x = i % w, y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  };
  const tb = pieces.map((p) => { const b = tightOf(p.pix); return [b[0], b[1], b[2] + 1, b[3] + 1]; });
  const order = pieces.map((_, i) => i).sort((i, j) => pieces[i].pix.length - pieces[j].pix.length);
  const gone = new Uint8Array(pieces.length);
  for (const i of order) {
    for (let j = 0; j < pieces.length; j++) {
      if (j === i || gone[j] || pieces[j].pix.length < pieces[i].pix.length) continue;
      const A = tb[i], B = tb[j];
      const iw = mMin(A[2], B[2]) - mMax(A[0], B[0]), ih = mMin(A[3], B[3]) - mMax(A[1], B[1]);
      if (iw > 0 && ih > 0 && iw * ih >= o.nestedFrac * (A[2] - A[0]) * (A[3] - A[1])) {
        const merged = new Int32Array(pieces[i].pix.length + pieces[j].pix.length);
        merged.set(pieces[j].pix);
        merged.set(pieces[i].pix, pieces[j].pix.length);
        pieces[j].pix = merged;
        tb[j] = [mMin(A[0], B[0]), mMin(A[1], B[1]), mMax(A[2], B[2]), mMax(A[3], B[3])];
        gone[i] = 1;
        break;
      }
    }
  }
  const finalPieces = pieces.filter((_, i) => !gone[i]);
  active += now() - t; yield; t = now();

  // 6. boxes + dominant colour
  interface RawBox { px0: number; py0: number; seg: SegBox; area: number }
  const raw: RawBox[] = finalPieces.map((p) => {
    const [x0, y0, x1, y1] = tightOf(p.pix);
    const partial = x0 <= 1 || y0 <= 1 || x1 >= w - 2 || y1 >= h - 2;
    const pad = mRound(o.pad * mMax(x1 - x0 + 1, y1 - y0 + 1));
    const px0 = mMax(0, x0 - pad), py0 = mMax(0, y0 - pad);
    const px1 = mMin(w - 1, x1 + pad), py1 = mMin(h - 1, y1 + pad);
    const col = dominantLab(lab, p.pix);
    return {
      px0, py0, area: p.pix.length,
      seg: {
        box: { x: px0 / w, y: py0 / h, w: (px1 - px0 + 1) / w, h: (py1 - py0 + 1) / h },
        tight: { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h },
        areaFrac: p.pix.length / N,
        partial,
        fromSplit: p.fromSplit,
        suspectMerged: false,
        lab: col,
        rgb: labToRgb(col),
      },
    };
  });
  if (raw.length >= 3) {
    const ar = raw.map((b) => b.area).sort((a, b) => a - b);
    const med = ar[ar.length >> 1];
    for (const b of raw) b.seg.suspectMerged = b.area > 3 * med;
  }
  raw.sort((a, b) => a.py0 - b.py0 || a.px0 - b.px0);
  active += now() - t;
  return {
    boxes: raw.map((r) => r.seg),
    background: { quality, sigmaL: sigL, sigmaC: sigC },
    width: w,
    height: h,
    ms: active,
  };
}

/** Pure and deterministic (except `ms`). Throws RangeError when rgba.length !== width * height * 4 or a side is
 *  < 16 px. Drives the stage generator to completion synchronously. */
export function segmentPile(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  options?: SegmentOptions): SegmentationResult {
  const gen = segmentStages(rgba, width, height, options);
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
  }
}

/** Same generator, awaiting `yieldFn()` at every stage boundary so the JS thread processes touches and animation
 *  frames. Result deep-equals segmentPile's (except `ms`). Rejects with RangeError on invalid input. */
export async function segmentPileAsync(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
  options: SegmentOptions | undefined, yieldFn: () => Promise<void>): Promise<SegmentationResult> {
  const gen = segmentStages(rgba, width, height, options);
  for (;;) {
    const step = gen.next();
    if (step.done) return step.value;
    await yieldFn();
  }
}

// Colour science helpers (sRGB D65 <-> CIE Lab, CIEDE2000). Pure, no allocation in the hot path.
import type { Lab, Rgb } from '../types';

/** sRGB 8-bit -> linear light, as a lookup table (shared with segment.ts). */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

const XN = 0.95047;
const ZN = 1.08883;
const EPS = 0.008856;
const KAPPA = 7.787;
const mCbrt = Math.cbrt; // hoisted: called per pixel by segment.ts

/** Writes Lab of an 8-bit sRGB triple into `out[o..o+2]` (used per pixel by segment.ts). */
export function rgbToLabInto(r: number, g: number, b: number, out: Float32Array | number[], o: number): void {
  const R = SRGB_TO_LINEAR[r];
  const G = SRGB_TO_LINEAR[g];
  const B = SRGB_TO_LINEAR[b];
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN;
  let y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  let z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / ZN;
  x = x > EPS ? mCbrt(x) : KAPPA * x + 16 / 116;
  y = y > EPS ? mCbrt(y) : KAPPA * y + 16 / 116;
  z = z > EPS ? mCbrt(z) : KAPPA * z + 16 / 116;
  out[o] = 116 * y - 16;
  out[o + 1] = 500 * (x - y);
  out[o + 2] = 200 * (y - z);
}

function clampByte(v: number): number {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** sRGB (0..255, values are rounded and clamped) -> CIE Lab, D65. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const out = [0, 0, 0];
  rgbToLabInto(clampByte(r), clampByte(g), clampByte(b), out, 0);
  return [out[0], out[1], out[2]];
}

function finv(t: number): number {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (t - 16 / 116) / KAPPA;
}

function gammaByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clampByte(v * 255);
}

/** CIE Lab (D65) -> sRGB bytes, out-of-gamut values clamped. */
export function labToRgb(lab: Lab): Rgb {
  const fy = (lab[0] + 16) / 116;
  const x = XN * finv(lab[1] / 500 + fy);
  const y = finv(fy);
  const z = ZN * finv(fy - lab[2] / 200);
  return [
    gammaByte(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    gammaByte(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    gammaByte(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

/** 'C91A09' or '#C91A09' -> Lab. Invalid input yields NaN components. */
export function hexToLab(hex: string): Lab {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  return rgbToLab(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

const RAD = Math.PI / 180;
const POW25_7 = 6103515625; // 25^7

function hueDeg(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const d = Math.atan2(y, x) / RAD;
  return d < 0 ? d + 360 : d;
}

/** CIEDE2000 colour difference (kL = kC = kH = 1), Sharma et al. 2005. Symmetric. */
export function ciede2000(a: Lab, b: Lab): number {
  const L1 = a[0], a1 = a[1], b1 = a[2];
  const L2 = b[0], a2 = b[1], b2 = b[2];
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm7 = Math.pow((C1 + C2) / 2, 7);
  const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = hueDeg(b1, a1p);
  const h2p = hueDeg(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const prod = C1p * C2p;
  let dhp = 0;
  if (prod !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(prod) * Math.sin((dhp / 2) * RAD);
  const Lm = (L1 + L2) / 2;
  const Cmp = (C1p + C2p) / 2;
  let hm = h1p + h2p;
  if (prod !== 0) {
    hm = Math.abs(h1p - h2p) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hm - 30) * RAD) + 0.24 * Math.cos(2 * hm * RAD)
    + 0.32 * Math.cos((3 * hm + 6) * RAD) - 0.2 * Math.cos((4 * hm - 63) * RAD);
  const dTheta = 30 * Math.exp(-Math.pow((hm - 275) / 25, 2));
  const Cmp7 = Math.pow(Cmp, 7);
  const Rc = 2 * Math.sqrt(Cmp7 / (Cmp7 + POW25_7));
  const Lm50 = (Lm - 50) * (Lm - 50);
  const Sl = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50);
  const Sc = 1 + 0.045 * Cmp;
  const Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * RAD) * Rc;
  const l = dLp / Sl, c = dCp / Sc, hh = dHp / Sh;
  return Math.sqrt(Math.max(0, l * l + c * c + hh * hh + Rt * c * hh));
}

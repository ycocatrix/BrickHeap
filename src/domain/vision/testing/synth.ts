// Synthetic RGBA scenes for vision tests (not a test file). Deterministic: seeded mulberry32 PRNG.
import type { Rgb } from '../../types';

export type SynthBackground = 'white' | 'grey' | 'wood' | 'gradient' | 'checker';

export interface SynthShadow {
  /** Offset of the shadow relative to the piece, px (default 8, 6). */
  dx?: number;
  dy?: number;
  /** Soft edge width, px (default 6). */
  blur?: number;
  /** Darkening of the background at the shadow core, 0..1 (default 0.3 = 30 % darker). */
  strength?: number;
}

export interface SynthRect {
  x: number; y: number; w: number; h: number;
  rgb: Rgb;
  /** A soft cast shadow on the background (drawn under every rect). */
  shadow?: boolean | SynthShadow;
}

export interface SceneSpec {
  width: number;
  height: number;
  background: SynthBackground;
  /** Drawn in order: later rects paint over earlier ones (use for glare stripes or overlaps). */
  rects?: readonly SynthRect[];
  /** Per-channel noise amplitude (approx. Gaussian, ~σ = noise / 2), default 0. */
  noise?: number;
  seed?: number;
}

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function backgroundAt(bg: SynthBackground, x: number, y: number, w: number, h: number, out: Float32Array): void {
  switch (bg) {
    case 'white':
      out[0] = 244; out[1] = 243; out[2] = 240;
      return;
    case 'grey':
      out[0] = 150; out[1] = 152; out[2] = 155;
      return;
    case 'gradient': {
      // smooth illumination falloff (vignette-like), well modelled by the quadratic background surface
      const t = x / (w - 1), u = y / (h - 1);
      const v = 236 - 40 * t - 18 * u;
      out[0] = v; out[1] = v - 2; out[2] = v - 8;
      return;
    }
    case 'wood': {
      const s = Math.sin(x * 0.35 + Math.sin(y * 0.05) * 3) * 10 + Math.sin(x * 0.07) * 6;
      out[0] = 176 + s; out[1] = 132 + s * 0.8; out[2] = 88 + s * 0.5;
      return;
    }
    case 'checker': {
      const on = ((Math.floor(x / 10) + Math.floor(y / 10)) & 1) === 1;
      const v = on ? 40 : 225;
      out[0] = v; out[1] = on ? 60 : 215; out[2] = on ? 120 : 200;
      return;
    }
  }
}

/** Distance (px) from (x, y) to the rectangle, 0 inside. */
function rectDistance(x: number, y: number, rx: number, ry: number, rw: number, rh: number): number {
  const dx = Math.max(rx - x, 0, x - (rx + rw - 1));
  const dy = Math.max(ry - y, 0, y - (ry + rh - 1));
  return Math.hypot(dx, dy);
}

/** Renders a scene as RGBA bytes (alpha 255). */
export function makeScene(spec: SceneSpec): Uint8Array {
  const { width: w, height: h, background } = spec;
  const rects = spec.rects ?? [];
  const noise = spec.noise ?? 0;
  const rnd = mulberry32(spec.seed ?? 1);
  const rgb = new Float32Array(w * h * 3);
  const px = new Float32Array(3);

  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 3) {
      backgroundAt(background, x, y, w, h, px);
      rgb[i] = px[0]; rgb[i + 1] = px[1]; rgb[i + 2] = px[2];
    }
  }

  // cast shadows first (darken the background, chroma kept)
  for (const r of rects) {
    if (!r.shadow) continue;
    const s: SynthShadow = r.shadow === true ? {} : r.shadow;
    const dx = s.dx ?? 8, dy = s.dy ?? 6, blur = Math.max(1, s.blur ?? 6), strength = s.strength ?? 0.3;
    const sx = r.x + dx, sy = r.y + dy;
    const x0 = Math.max(0, Math.floor(sx - blur)), x1 = Math.min(w - 1, Math.ceil(sx + r.w + blur));
    const y0 = Math.max(0, Math.floor(sy - blur)), y1 = Math.min(h - 1, Math.ceil(sy + r.h + blur));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = rectDistance(x, y, sx, sy, r.w, r.h);
        if (d >= blur) continue;
        const f = 1 - strength * (1 - d / blur);
        const i = (y * w + x) * 3;
        rgb[i] *= f; rgb[i + 1] *= f; rgb[i + 2] *= f;
      }
    }
  }

  for (const r of rects) {
    const x0 = Math.max(0, Math.round(r.x)), x1 = Math.min(w, Math.round(r.x + r.w));
    const y0 = Math.max(0, Math.round(r.y)), y1 = Math.min(h, Math.round(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 3;
        rgb[i] = r.rgb[0]; rgb[i + 1] = r.rgb[1]; rgb[i + 2] = r.rgb[2];
      }
    }
  }

  const out = new Uint8Array(w * h * 4);
  for (let p = 0, i = 0, j = 0; p < w * h; p++, i += 3, j += 4) {
    for (let c = 0; c < 3; c++) {
      const n = noise ? (rnd() + rnd() - 1) * noise : 0;
      const v = Math.round(rgb[i + c] + n);
      out[j + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    out[j + 3] = 255;
  }
  return out;
}

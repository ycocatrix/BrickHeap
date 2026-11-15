// Pixels (D1): expo-image-manipulator context API → PNG → File.bytes() → upng-js. No base64, no JPEG decoder.
// None of these functions reject: expected failures are Result values.
// (verify) on device that takePictureAsync's width/height are post-rotation (no skipProcessing).
import { ImageManipulator, SaveFormat, type ImageManipulatorContext, type ImageRef } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import * as UPNG from 'upng-js';
import type { BoundingBox, Result, ScanFrame } from '@/domain/types';
import { err, ok } from '@/domain/result';
import { VISION } from '@/domain/vision/config';
import { boxToPixelRect } from '@/domain/vision/geometry';
import { scan } from '@/i18n/fr/scan';

const longSide = (s: { width: number; height: number }) => Math.max(s.width, s.height);

/** Resize argument keeping the aspect ratio: only the long side is given. */
const resizeTo = (s: { width: number; height: number }, side: number) =>
  (s.width >= s.height ? { width: Math.round(side) } : { height: Math.round(side) });

function releaseQuietly(...objs: ({ release(): void } | null | undefined)[]): void {
  for (const o of objs) {
    try {
      o?.release();
    } catch {
      // already released
    }
  }
}

/** Runs ONE manipulator context on `uri`, lets `build` schedule the transformations, renders and saves. */
async function render(uri: string, build: (ctx: ImageManipulatorContext) => ImageManipulatorContext,
  format: SaveFormat, compress?: number): Promise<{ uri: string; width: number; height: number }> {
  let ctx: ImageManipulatorContext | null = null;
  let ref: ImageRef | null = null;
  try {
    ctx = ImageManipulator.manipulate(uri);
    ref = await build(ctx).renderAsync();
    const saved = await ref.saveAsync(compress === undefined ? { format } : { format, compress });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } finally {
    releaseQuietly(ref, ctx);
  }
}

/** Captures only. Returns the photo itself when its long side ≤ maxSide (no re-encode); otherwise ONE manipulator
 *  context resizes it to maxSide and saves JPEG 0.85. Live snapshots never call this: the photo is the frame. */
export async function prepareWorkImage(photo: ScanFrame, maxSide: number): Promise<Result<ScanFrame>> {
  if (longSide(photo) <= maxSide) return ok(photo);
  try {
    const out = await render(photo.uri, (c) => c.resize(resizeTo(photo, maxSide)), SaveFormat.JPEG,
      VISION.picture.captureQuality);
    return ok(out);
  } catch (e) {
    return err('unknown', scan.prepareFailed, e);
  }
}

/** ONE manipulator context on `frame.uri`: resize (long side ≤ maxSide) → PNG → File.bytes() →
 *  new Uint8Array(UPNG.toRGBA8(UPNG.decode(bytes))[0]). Deletes the PNG. Decode errors → err('unknown'). */
export async function readThumbnailRgba(frame: ScanFrame, maxSide: number):
  Promise<Result<{ rgba: Uint8Array; width: number; height: number }>> {
  let pngUri: string | null = null;
  try {
    const side = Math.min(maxSide, longSide(frame));
    const png = await render(frame.uri, (c) => c.resize(resizeTo(frame, side)), SaveFormat.PNG);
    pngUri = png.uri;
    const bytes = await new File(png.uri).bytes();          // Uint8Array passed as is, never its .buffer
    const img = UPNG.decode(bytes);
    const frames = UPNG.toRGBA8(img);
    const first = frames[0];
    if (!first) return err('unknown', scan.thumbnailFailed);
    const rgba = new Uint8Array(first);
    if (img.width < 1 || img.height < 1 || rgba.length !== img.width * img.height * 4) {
      return err('unknown', scan.thumbnailFailed);
    }
    return ok({ rgba, width: img.width, height: img.height });
  } catch (e) {
    return err('unknown', scan.thumbnailFailed, e);
  } finally {
    if (pngUri) await deleteTempFiles([pngUri]);
  }
}

/** JPEG crop of `box` from `frame` (the original photo in live mode), long side = VISION.crop.outSide.
 *  err('invalid', scan.tooSmall) when the source rect's long side is smaller than VISION.crop.minSourceSide. */
export async function cropForIdentification(frame: ScanFrame, box: BoundingBox): Promise<Result<{ uri: string }>> {
  try {
    const rect = boxToPixelRect(box, frame);
    if (longSide(rect) < VISION.crop.minSourceSide) return err('invalid', scan.tooSmall);
    const out = await render(frame.uri,
      (c) => c.crop(rect).resize(resizeTo(rect, VISION.crop.outSide)), SaveFormat.JPEG, VISION.crop.quality);
    return ok({ uri: out.uri });
  } catch (e) {
    return err('unknown', scan.noCrop, e);
  }
}

/** The whole frame as one JPEG, long side VISION.wholeImageSide (never upscaled). */
export async function wholeForIdentification(frame: ScanFrame): Promise<Result<{ uri: string }>> {
  try {
    const side = Math.min(VISION.wholeImageSide, longSide(frame));
    const out = await render(frame.uri, (c) => c.resize(resizeTo(frame, side)), SaveFormat.JPEG, VISION.crop.quality);
    return ok({ uri: out.uri });
  } catch (e) {
    return err('unknown', scan.noCrop, e);
  }
}

/** Best effort, never rejects. */
export async function deleteTempFiles(uris: readonly string[]): Promise<void> {
  for (const uri of new Set(uris)) {
    if (!uri) continue;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone or not a local file
    }
  }
}

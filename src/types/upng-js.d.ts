declare module 'upng-js' {
  interface Image { width: number; height: number; depth: number; ctype: number; frames: unknown[]; data: ArrayBuffer }
  /** Pass the Uint8Array from File.bytes() directly: `view.buffer` breaks on a view with a non-zero byteOffset.
   *  Throws on a corrupt or empty file. */
  export function decode(buffer: ArrayBuffer | Uint8Array): Image;
  export function toRGBA8(image: Image): ArrayBuffer[];                // wrap [0] as new Uint8Array(...)
}

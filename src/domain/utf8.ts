// Pure UTF-8 codec: TextEncoder / TextDecoder are not relied upon (unverified under Hermes).

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Invalid or truncated sequences decode to U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  let s = '';
  let chunk: number[] = [];
  const flush = () => {
    s += String.fromCharCode.apply(null, chunk);
    chunk = [];
  };
  const cont = (k: number) => k < bytes.length && (bytes[k] & 0xc0) === 0x80;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && cont(i + 1)) {
      cp = ((b & 31) << 6) | (bytes[i + 1] & 63);
      len = 2;
    } else if (b >= 0xe0 && b < 0xf0 && cont(i + 1) && cont(i + 2)) {
      const v = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      if (v >= 0x800 && (v < 0xd800 || v > 0xdfff)) cp = v;
      len = 3;
    } else if (b >= 0xf0 && b < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
      const v = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      if (v >= 0x10000 && v <= 0x10ffff) cp = v;
      len = 4;
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      chunk.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length > 8192) flush();
    i += len;
  }
  flush();
  return s;
}

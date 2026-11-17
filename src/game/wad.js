/*
 * GoldSrc textures: miptex (8-bit + palette) inside BSPs and WAD3 files.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});
  const latin1 = new TextDecoder('latin1');

  function cstr(u8, start, len) {
    let end = start;
    while (end < start + len && u8[end] !== 0) end++;
    return latin1.decode(u8.subarray(start, end));
  }

  /**
   * Decodes a miptex at offset `off`. Returns null when it has no pixels
   * (texture referenced by name, stored in a WAD).
   */
  function decodeMiptex(u8, dv, off) {
    const name = cstr(u8, off, 16);
    const width = dv.getUint32(off + 16, true);
    const height = dv.getUint32(off + 20, true);
    const ofs0 = dv.getUint32(off + 24, true);
    const ofs3 = dv.getUint32(off + 36, true);
    const info = { name, width, height, rgba: null, masked: name.startsWith('{') };
    if (!ofs0 || !width || !height || width > 4096 || height > 4096) return info;
    const pix = off + ofs0;
    const palOff = off + ofs3 + ((width >> 3) * (height >> 3)) + 2;
    if (palOff + 768 > u8.length || pix + width * height > u8.length) return info;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const c = u8[pix + i];
      const p = palOff + c * 3;
      const o = i * 4;
      if (info.masked && c === 255) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
        rgba[o + 3] = 0;
      } else {
        rgba[o] = u8[p];
        rgba[o + 1] = u8[p + 1];
        rgba[o + 2] = u8[p + 2];
        rgba[o + 3] = 255;
      }
    }
    info.rgba = rgba;
    return info;
  }

  /** Reads a WAD3 and returns Map(lowercase name -> miptex offset) plus an on-demand decoder. */
  function parseWad(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const magic = cstr(u8, 0, 4);
    if (magic !== 'WAD3' && magic !== 'WAD2') throw new Error('invalid WAD');
    const count = dv.getInt32(4, true);
    const dir = dv.getInt32(8, true);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      const e = dir + i * 32;
      if (e + 32 > u8.length) break;
      const filepos = dv.getInt32(e, true);
      const type = u8[e + 12];
      const compression = u8[e + 13];
      const name = cstr(u8, e + 16, 16).toLowerCase();
      if ((type === 0x43 || type === 0x40) && !compression) entries.set(name, filepos);
    }
    return {
      has: (name) => entries.has(name.toLowerCase()),
      get(name) {
        const off = entries.get(name.toLowerCase());
        return off == null ? null : decodeMiptex(u8, dv, off);
      },
    };
  }

  NS.decodeMiptex = decodeMiptex;
  NS.parseWad = parseWad;
  NS.cstr = cstr;
})(typeof window !== 'undefined' ? window : globalThis);

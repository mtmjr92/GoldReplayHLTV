/*
 * Binary readers used by the GoldSrc demo parser.
 *  - MsgReader: byte-by-byte reads (little-endian), like the engine's MSG_Read*.
 *  - BitReader: bit-by-bit reads (LSB first), like the engine's MSG_ReadBits.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  class ParseError extends Error {}

  const latin1 = new TextDecoder('latin1');

  function cString(u8, start, end) {
    let i = start;
    while (i < end && u8[i] !== 0) i++;
    return latin1.decode(u8.subarray(start, i));
  }

  class MsgReader {
    constructor(u8, dv, start, end) {
      this.u8 = u8;
      this.dv = dv;
      this.pos = start;
      this.end = end;
    }
    need(n) {
      if (this.pos + n > this.end) throw new ParseError('unexpected end of message');
    }
    get remaining() { return this.end - this.pos; }
    byte() { this.need(1); return this.u8[this.pos++]; }
    char() { this.need(1); return this.dv.getInt8(this.pos++); }
    short() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
    ushort() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
    long() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
    float() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
    coord() { return this.short() / 8; }
    angle() { return (this.byte() * 360) / 256; }
    skip(n) { this.need(n); this.pos += n; }
    string() {
      let i = this.pos;
      while (i < this.end && this.u8[i] !== 0) i++;
      if (i >= this.end) throw new ParseError('unterminated string');
      const s = latin1.decode(this.u8.subarray(this.pos, i));
      this.pos = i + 1;
      return s;
    }
    bits() { return new BitReader(this.u8, this.pos, this.end); }
    /** Resumes byte reads after a bit section (aligns to the next byte). */
    syncFrom(bitReader) { this.pos = bitReader.alignedBytePos(); }
  }

  class BitReader {
    constructor(u8, startByte, endByte) {
      this.u8 = u8;
      this.pos = startByte * 8;
      this.end = endByte * 8;
    }
    readBits(n) {
      if (n === 0) return 0;
      if (this.pos + n > this.end) throw new ParseError('unexpected end (bits)');
      let result = 0;
      let shift = 0;
      let left = n;
      while (left > 0) {
        const bitOff = this.pos & 7;
        const take = Math.min(8 - bitOff, left);
        const bits = (this.u8[this.pos >> 3] >> bitOff) & ((1 << take) - 1);
        result |= bits << shift;
        shift += take;
        left -= take;
        this.pos += take;
      }
      return result >>> 0;
    }
    readBit() {
      if (this.pos >= this.end) throw new ParseError('unexpected end (bit)');
      const b = (this.u8[this.pos >> 3] >> (this.pos & 7)) & 1;
      this.pos++;
      return b;
    }
    peekBits(n) {
      const p = this.pos;
      const v = this.readBits(n);
      this.pos = p;
      return v;
    }
    readSBits(n) {
      const sign = this.readBit();
      const v = this.readBits(n - 1);
      return sign ? -v : v;
    }
    readString() {
      const bytes = [];
      for (;;) {
        const c = this.readBits(8);
        if (c === 0) break;
        bytes.push(c);
      }
      return latin1.decode(new Uint8Array(bytes));
    }
    readBitCoord() {
      let intval = this.readBit();
      let fractval = this.readBit();
      if (!intval && !fractval) return 0;
      const sign = this.readBit();
      if (intval) intval = this.readBits(12);
      if (fractval) fractval = this.readBits(3);
      const v = intval + fractval / 8;
      return sign ? -v : v;
    }
    readBitVec3Coord() {
      const fx = this.readBit();
      const fy = this.readBit();
      const fz = this.readBit();
      return [fx ? this.readBitCoord() : 0, fy ? this.readBitCoord() : 0, fz ? this.readBitCoord() : 0];
    }
    alignedBytePos() { return (this.pos + 7) >> 3; }
  }

  NS.ParseError = ParseError;
  NS.MsgReader = MsgReader;
  NS.BitReader = BitReader;
  NS.cString = cString;
})(typeof window !== 'undefined' ? window : globalThis);

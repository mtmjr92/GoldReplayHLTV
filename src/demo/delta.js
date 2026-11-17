/*
 * GoldSrc delta encoding (DELTA_ParseDelta).
 *
 * Through svc_deltadescription the server describes each structure
 * (entity_state_t, entity_state_player_t, event_t, clientdata_t...). Every
 * update carries a mask telling which fields changed; the rest is copied
 * from the previous state.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const DT = {
    BYTE: 1,
    SHORT: 2,
    FLOAT: 4,
    INTEGER: 8,
    ANGLE: 16,
    TIMEWINDOW_8: 32,
    TIMEWINDOW_BIG: 64,
    STRING: 128,
    SIGNED: 0x80000000,
  };

  function field(name, type, bits, pre, post) {
    return { name, type, bits, pre: pre || 1, post: post || 1 };
  }

  // Fixed description used to decode the descriptions themselves (g_MetaDescription).
  const META_DECODER = [
    field('fieldType', DT.INTEGER, 32),
    field('fieldName', DT.STRING, 8),
    field('fieldOffset', DT.INTEGER, 16),
    field('fieldSize', DT.INTEGER, 8),
    field('significant_bits', DT.INTEGER, 8),
    field('premultiply', DT.FLOAT, 32, 4000),
    field('postmultiply', DT.FLOAT, 32, 4000),
  ];

  function readField(br, f) {
    const t = f.type;
    const signed = (t & DT.SIGNED) !== 0;
    const base = t & 0x7fffffff;

    if (base & (DT.BYTE | DT.SHORT | DT.INTEGER)) {
      let v;
      if (signed) {
        const s = br.readBit();
        v = br.readBits(f.bits - 1);
        if (s) v = -v;
      } else {
        v = br.readBits(f.bits);
      }
      return Math.trunc((v / f.pre) * f.post);
    }
    if (base & DT.FLOAT) {
      let v;
      if (signed) {
        const s = br.readBit();
        v = br.readBits(f.bits - 1);
        if (s) v = -v;
      } else {
        v = br.readBits(f.bits);
      }
      return (v / f.pre) * f.post;
    }
    if (base & DT.ANGLE) {
      return (br.readBits(f.bits) * 360) / 2 ** f.bits;
    }
    // times are sent relative to the server clock; we return the absolute time
    if (base & DT.TIMEWINDOW_8) {
      const v = br.readSBits(8);
      return (Math.trunc(NS.deltaTime * 100) - v) / 100;
    }
    if (base & DT.TIMEWINDOW_BIG) {
      const v = br.readSBits(f.bits);
      return (NS.deltaTime * f.pre - v) / f.pre;
    }
    if (base & DT.STRING) return br.readString();
    throw new NS.ParseError('tipo de campo delta desconhecido: ' + t);
  }

  /**
   * Reads one delta. Fields not sent keep the value from `from`.
   * inPlace=true updates `from` itself instead of copying it (used when `from` is the
   * entity's own state from the previous frame, to avoid millions of throwaway copies).
   */
  function readDelta(br, decoder, from, inPlace) {
    const out = from ? (inPlace ? from : Object.assign({}, from)) : {};
    const maskBytes = br.readBits(3);
    if (maskBytes === 0) return out;
    const mask = new Array(maskBytes);
    for (let i = 0; i < maskBytes; i++) mask[i] = br.readBits(8);
    const n = Math.min(decoder.length, maskBytes * 8);
    for (let i = 0; i < n; i++) {
      if (mask[i >> 3] & (1 << (i & 7))) {
        const f = decoder[i];
        out[f.name] = readField(br, f);
      }
    }
    for (let i = n; i < maskBytes * 8; i++) {
      if (mask[i >> 3] & (1 << (i & 7))) throw new NS.ParseError('delta mask points to a missing field');
    }
    return out;
  }

  /** Turns the entries read from svc_deltadescription into a decoder. */
  function buildDecoder(entries) {
    return entries.map((e) =>
      field(e.fieldName || '', e.fieldType >>> 0 | 0, e.significant_bits || 0, e.premultiply, e.postmultiply)
    );
  }

  NS.deltaTime = 0;
  NS.DT = DT;
  NS.META_DECODER = META_DECODER;
  NS.readDelta = readDelta;
  NS.buildDecoder = buildDecoder;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * GoldSrc sprites (.spr version 2): smoke, explosions, muzzle flash...
 * Each frame becomes a three.js texture, honoring the sprite's color mode.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const TEX = { NORMAL: 0, ADDITIVE: 1, INDEXALPHA: 2, ALPHATEST: 3 };

  function parseSprite(THREE, buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    if (NS.cstr(u8, 0, 4) !== 'IDSP' || dv.getInt32(4, true) !== 2) throw new Error('invalid sprite');
    const texFormat = dv.getInt32(12, true);
    const width = dv.getInt32(20, true);
    const height = dv.getInt32(24, true);
    const numframes = dv.getInt32(28, true);
    const palCount = dv.getInt16(40, true);
    const pal = 42;
    let p = pal + palCount * 3;
    const frames = [];
    const readFrame = () => {
      const ox = dv.getInt32(p, true), oy = dv.getInt32(p + 4, true);
      const w = dv.getInt32(p + 8, true), h = dv.getInt32(p + 12, true);
      p += 16;
      const rgba = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const c = u8[p + i];
        const o = i * 4;
        if (texFormat === TEX.INDEXALPHA) {
          // single color (last palette entry), alpha = index
          rgba[o] = u8[pal + 255 * 3]; rgba[o + 1] = u8[pal + 255 * 3 + 1]; rgba[o + 2] = u8[pal + 255 * 3 + 2];
          rgba[o + 3] = c;
        } else {
          rgba[o] = u8[pal + c * 3]; rgba[o + 1] = u8[pal + c * 3 + 1]; rgba[o + 2] = u8[pal + c * 3 + 2];
          rgba[o + 3] = texFormat === TEX.ALPHATEST && c === 255 ? 0 : 255;
        }
      }
      p += w * h;
      const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
      tex.flipY = true; // sprite rows are stored top-down; three's Sprite expects v=0 at the bottom
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearFilter;
      tex.onUpdate = NS.dropCpuCopy;
      tex.needsUpdate = true;
      frames.push({ w, h, ox, oy, tex });
    };
    for (let f = 0; f < numframes && p + 4 <= u8.length; f++) {
      const group = dv.getInt32(p, true);
      p += 4;
      if (group === 0) {
        readFrame();
      } else {
        // frame group: use all of them in sequence
        const n = dv.getInt32(p, true);
        p += 4 + n * 4;
        for (let k = 0; k < n; k++) readFrame();
      }
    }
    return { texFormat, width, height, frames };
  }

  /** Creates a THREE.Sprite material with the right blending for the sprite. */
  function makeSpriteMaterial(THREE, spr, opts) {
    const o = opts || {};
    const additive = o.additive != null ? o.additive : spr.texFormat === TEX.ADDITIVE;
    return new THREE.SpriteMaterial({
      map: spr.frames[0].tex,
      color: o.color || 0xffffff,
      transparent: true,
      opacity: o.opacity == null ? 1 : o.opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      alphaTest: spr.texFormat === TEX.ALPHATEST ? 0.5 : 0.01,
    });
  }

  NS.parseSprite = parseSprite;
  NS.makeSpriteMaterial = makeSpriteMaterial;
  NS.SPR_TEX = TEX;
})(typeof window !== 'undefined' ? window : globalThis);

/*
 * BSP v30 maps (GoldSrc): reads geometry, textures and lightmaps and
 * builds a three.js mesh (game coordinates, Z up).
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const LUMP = { ENTITIES: 0, PLANES: 1, TEXTURES: 2, VERTICES: 3, TEXINFO: 6, FACES: 7, LIGHTING: 8, EDGES: 12, SURFEDGES: 13, MODELS: 14 };

  // textures the game does not draw
  const HIDDEN_TEX = new Set(['sky', 'aaatrigger', 'clip', 'origin', 'null', 'hint', 'skip', 'bevel', 'nodraw']);
  // invisible brush entities (logic volumes)
  const HIDDEN_CLASS = /^(trigger_|func_buyzone|func_bomb_target|func_hostage_rescue|func_escapezone|func_vip_safetyzone|func_ladder|func_mortar_field|env_bubbles|func_monsterclip|func_clip)/;

  function parseEntities(text) {
    const out = [];
    const re = /\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(text))) {
      const ent = {};
      const kv = /"([^"]*)"\s*"([^"]*)"/g;
      let p;
      while ((p = kv.exec(m[1]))) ent[p[1]] = p[2];
      out.push(ent);
    }
    return out;
  }

  function parseBsp(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const version = dv.getInt32(0, true);
    if (version !== 30) throw new Error('BSP version ' + version + ' not supported (expected 30).');
    const lumps = [];
    for (let i = 0; i < 15; i++) lumps.push({ off: dv.getInt32(4 + i * 8, true), len: dv.getInt32(8 + i * 8, true) });
    const L = (i) => lumps[i];

    const entities = parseEntities(NS.cstr(u8, L(LUMP.ENTITIES).off, L(LUMP.ENTITIES).len));

    const vtx = new Float32Array(buffer.slice(L(LUMP.VERTICES).off, L(LUMP.VERTICES).off + L(LUMP.VERTICES).len));
    const edgesOff = L(LUMP.EDGES).off;
    const surfOff = L(LUMP.SURFEDGES).off;

    const texinfo = [];
    for (let o = L(LUMP.TEXINFO).off, e = o + L(LUMP.TEXINFO).len; o + 40 <= e; o += 40) {
      texinfo.push({
        s: [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true)],
        t: [dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true), dv.getFloat32(o + 24, true), dv.getFloat32(o + 28, true)],
        miptex: dv.getInt32(o + 32, true),
        flags: dv.getInt32(o + 36, true),
      });
    }

    const textures = [];
    const to = L(LUMP.TEXTURES).off;
    const ntex = dv.getInt32(to, true);
    for (let i = 0; i < ntex; i++) {
      const rel = dv.getInt32(to + 4 + i * 4, true);
      textures.push(rel < 0 ? { name: '', width: 16, height: 16, rgba: null } : NS.decodeMiptex(u8, dv, to + rel));
    }

    const faces = [];
    for (let o = L(LUMP.FACES).off, e = o + L(LUMP.FACES).len; o + 20 <= e; o += 20) {
      faces.push({
        firstedge: dv.getInt32(o + 4, true),
        numedges: dv.getUint16(o + 8, true),
        texinfo: dv.getUint16(o + 10, true),
        style0: u8[o + 12],
        lightofs: dv.getInt32(o + 16, true),
      });
    }

    const models = [];
    for (let o = L(LUMP.MODELS).off, e = o + L(LUMP.MODELS).len; o + 64 <= e; o += 64) {
      models.push({ firstface: dv.getInt32(o + 56, true), numfaces: dv.getInt32(o + 60, true) });
    }

    function faceVerts(f) {
      const out = [];
      for (let i = 0; i < f.numedges; i++) {
        const se = dv.getInt32(surfOff + (f.firstedge + i) * 4, true);
        const ei = Math.abs(se);
        const v = dv.getUint16(edgesOff + ei * 4 + (se >= 0 ? 0 : 2), true);
        out.push(vtx[v * 3], vtx[v * 3 + 1], vtx[v * 3 + 2]);
      }
      return out;
    }

    const lighting = u8.subarray(L(LUMP.LIGHTING).off, L(LUMP.LIGHTING).off + L(LUMP.LIGHTING).len);
    const world = entities.find((e) => e.classname === 'worldspawn') || {};
    const wads = (world.wad || '').split(';').map((w) => w.split(/[\\/]/).pop().trim()).filter(Boolean);

    return { entities, texinfo, textures, faces, models, faceVerts, lighting, wads, skyName: world.skyname || '' };
  }

  /** Empacota lightmaps num atlas (prateleiras). */
  class Atlas {
    constructor(size) {
      this.size = size;
      this.data = new Uint8Array(size * size * 4);
      this.x = 0; this.y = 0; this.rowH = 0;
    }
    alloc(w, h) {
      const pw = w + 2, ph = h + 2;
      if (this.x + pw > this.size) { this.x = 0; this.y += this.rowH; this.rowH = 0; }
      if (this.y + ph > this.size) return null;
      const r = { x: this.x + 1, y: this.y + 1 };
      this.x += pw;
      this.rowH = Math.max(this.rowH, ph);
      return r;
    }
    put(x, y, w, h, src, srcOff, scale) {
      const S = this.size, d = this.data;
      // copy with a repeated 1px border (avoids bleeding between lightmaps)
      for (let yy = -1; yy <= h; yy++) {
        const sy = Math.min(h - 1, Math.max(0, yy));
        for (let xx = -1; xx <= w; xx++) {
          const sx = Math.min(w - 1, Math.max(0, xx));
          const s = srcOff + (sy * w + sx) * 3;
          const o = ((y + yy) * S + (x + xx)) * 4;
          if (src) {
            d[o] = Math.min(255, src[s] * scale);
            d[o + 1] = Math.min(255, src[s + 1] * scale);
            d[o + 2] = Math.min(255, src[s + 2] * scale);
          } else {
            d[o] = d[o + 1] = d[o + 2] = 200;
          }
          d[o + 3] = 255;
        }
      }
    }
  }

  const VERT = `
    attribute vec2 lmuv;
    varying vec2 vUv;
    varying vec2 vLm;
    void main() {
      vUv = uv;
      vLm = lmuv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const FRAG = `
    uniform sampler2D map;
    uniform sampler2D lightmap;
    uniform float opacity;
    uniform float alphaTest;
    uniform float brightness;
    varying vec2 vUv;
    varying vec2 vLm;
    void main() {
      vec4 tex = texture2D(map, vUv);
      if (tex.a < alphaTest) discard;
      vec3 light = texture2D(lightmap, vLm).rgb;
      light = pow(light, vec3(0.8)) * brightness;
      gl_FragColor = vec4(tex.rgb * light, tex.a * opacity);
    }`;

  function makeTexture(THREE, info) {
    let { width, height, rgba } = info;
    if (!rgba) {
      // textura ausente: xadrez
      width = height = 16;
      rgba = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < 256; i++) {
        const c = ((i & 15) < 8) ^ ((i >> 4) < 8) ? 160 : 90;
        rgba.set([c, c, c, 255], i * 4);
      }
    }
    const tex = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.flipY = false;
    tex.anisotropy = 8;
    tex.onUpdate = NS.dropCpuCopy;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Builds the map mesh. `lookupTexture(name)` returns {width,height,rgba}
   * from a WAD when the texture is not embedded in the BSP.
   */
  function buildBspMesh(THREE, bsp, lookupTexture) {
    const group = new THREE.Group();
    const atlas = new Atlas(2048);
    const brightness = { value: 1.25 };

    // which brush models to draw and how
    const drawList = [{ model: 0, mode: 0, amt: 255, origin: [0, 0, 0] }];
    for (const e of bsp.entities) {
      if (!e.model || e.model[0] !== '*') continue;
      if (HIDDEN_CLASS.test(e.classname || '')) continue;
      const mode = parseInt(e.rendermode || '0', 10);
      const amt = e.renderamt == null ? 255 : parseInt(e.renderamt, 10);
      if (mode !== 0 && mode !== 4 && amt === 0) continue;
      const o = (e.origin || '0 0 0').split(/\s+/).map(Number);
      drawList.push({ model: parseInt(e.model.slice(1), 10), mode, amt, origin: o });
    }

    const resolved = new Map();
    function texInfo(i) {
      if (resolved.has(i)) return resolved.get(i);
      const t = bsp.textures[i] || { name: '', width: 16, height: 16 };
      let info = t;
      if (!t.rgba && t.name) info = lookupTexture(t.name) || t;
      resolved.set(i, info);
      return info;
    }

    // geometry grouped by (texture, render mode)
    const batches = new Map();
    for (const item of drawList) {
      const model = bsp.models[item.model];
      if (!model) continue;
      for (let fi = model.firstface; fi < model.firstface + model.numfaces; fi++) {
        const f = bsp.faces[fi];
        const ti = bsp.texinfo[f.texinfo];
        if (!ti) continue;
        const traw = bsp.textures[ti.miptex];
        const tname = traw ? traw.name.toLowerCase() : '';
        if (HIDDEN_TEX.has(tname)) continue;
        const tex = texInfo(ti.miptex);
        const v = bsp.faceVerts(f);
        const n = v.length / 3;
        if (n < 3) continue;

        // texture coordinates and lightmap extents
        const ss = [], ts = [];
        let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
        for (let k = 0; k < n; k++) {
          const x = v[k * 3], y = v[k * 3 + 1], z = v[k * 3 + 2];
          const s = x * ti.s[0] + y * ti.s[1] + z * ti.s[2] + ti.s[3];
          const t = x * ti.t[0] + y * ti.t[1] + z * ti.t[2] + ti.t[3];
          ss.push(s); ts.push(t);
          if (s < minS) minS = s; if (s > maxS) maxS = s;
          if (t < minT) minT = t; if (t > maxT) maxT = t;
        }
        const bminS = Math.floor(minS / 16), bmaxS = Math.ceil(maxS / 16);
        const bminT = Math.floor(minT / 16), bmaxT = Math.ceil(maxT / 16);
        const lw = bmaxS - bminS + 1, lh = bmaxT - bminT + 1;
        let slot = null;
        if (lw > 0 && lh > 0 && lw <= 64 && lh <= 64) slot = atlas.alloc(lw, lh);
        if (slot) {
          const hasLight = f.lightofs >= 0 && f.style0 !== 255 && f.lightofs + lw * lh * 3 <= bsp.lighting.length;
          atlas.put(slot.x, slot.y, lw, lh, hasLight ? bsp.lighting : null, f.lightofs, 1);
        }

        const key = ti.miptex + ':' + item.mode + ':' + item.amt;
        let b = batches.get(key);
        if (!b) {
          b = { tex, mode: item.mode, amt: item.amt, name: tname, pos: [], uv: [], lm: [] };
          batches.set(key, b);
        }
        const tw = tex.width || 16, th = tex.height || 16;
        const A = atlas.size;
        const push = (k) => {
          b.pos.push(v[k * 3] + item.origin[0], v[k * 3 + 1] + item.origin[1], v[k * 3 + 2] + item.origin[2]);
          b.uv.push(ss[k] / tw, ts[k] / th);
          if (slot) {
            b.lm.push((slot.x + (ss[k] / 16 - bminS) + 0.5) / A, (slot.y + (ts[k] / 16 - bminT) + 0.5) / A);
          } else {
            b.lm.push(0, 0);
          }
        };
        for (let k = 1; k + 1 < n; k++) { push(0); push(k); push(k + 1); }
      }
    }

    const lmTex = new THREE.DataTexture(atlas.data, atlas.size, atlas.size, THREE.RGBAFormat);
    lmTex.magFilter = THREE.LinearFilter;
    lmTex.minFilter = THREE.LinearFilter;
    lmTex.flipY = false;
    lmTex.onUpdate = NS.dropCpuCopy;
    lmTex.needsUpdate = true;

    const texCache = new Map();
    for (const b of batches.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      geo.setAttribute('lmuv', new THREE.Float32BufferAttribute(b.lm, 2));
      let map = texCache.get(b.tex);
      if (!map) { map = makeTexture(THREE, b.tex); texCache.set(b.tex, map); }
      const masked = b.name.startsWith('{') || b.mode === 4;
      const translucent = b.mode === 2 || b.mode === 5 || b.name.startsWith('!');
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: map },
          lightmap: { value: lmTex },
          opacity: { value: translucent ? (b.name.startsWith('!') ? 0.8 : b.amt / 255) : 1 },
          alphaTest: { value: masked ? 0.5 : 0 },
          brightness,
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: translucent,
        depthWrite: !translucent,
        blending: b.mode === 5 ? THREE.AdditiveBlending : THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      if (translucent) mesh.renderOrder = 1;
      group.add(mesh);
    }
    group.userData.brightness = brightness;
    return group;
  }

  NS.parseBsp = parseBsp;
  NS.buildBspMesh = buildBspMesh;
})(typeof window !== 'undefined' ? window : globalThis);

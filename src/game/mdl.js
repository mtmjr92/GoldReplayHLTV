/*
 * GoldSrc studio models (.mdl version 10): skeleton, animations, meshes
 * and textures. The pose is computed in JS and applied to the vertices
 * (CPU skinning), like the engine itself does.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const STUDIO_LOOPING = 1;
  const NF_MASKED = 0x40;

  function cstr(u8, off, len) { return NS.cstr(u8, off, len); }

  // angles (rad) -> quaternion, same as the engine's AngleQuaternion
  function angleQuat(ax, ay, az, out, o) {
    const sy = Math.sin(az * 0.5), cy = Math.cos(az * 0.5);
    const sp = Math.sin(ay * 0.5), cp = Math.cos(ay * 0.5);
    const sr = Math.sin(ax * 0.5), cr = Math.cos(ax * 0.5);
    out[o] = sr * cp * cy - cr * sp * sy;
    out[o + 1] = cr * sp * cy + sr * cp * sy;
    out[o + 2] = cr * cp * sy - sr * sp * cy;
    out[o + 3] = cr * cp * cy + sr * sp * sy;
  }

  function slerp(q, o1, p, o2, t, out, o) {
    let ax = q[o1], ay = q[o1 + 1], az = q[o1 + 2], aw = q[o1 + 3];
    let bx = p[o2], by = p[o2 + 1], bz = p[o2 + 2], bw = p[o2 + 3];
    let cos = ax * bx + ay * by + az * bz + aw * bw;
    if (cos < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; cos = -cos; }
    let s0, s1;
    if (1 - cos > 0.001) {
      const om = Math.acos(cos), sin = Math.sin(om);
      s0 = Math.sin((1 - t) * om) / sin;
      s1 = Math.sin(t * om) / sin;
    } else { s0 = 1 - t; s1 = t; }
    out[o] = s0 * ax + s1 * bx;
    out[o + 1] = s0 * ay + s1 * by;
    out[o + 2] = s0 * az + s1 * bz;
    out[o + 3] = s0 * aw + s1 * bw;
  }

  class MdlModel {
    /**
     * @param buffer      ArrayBuffer of the .mdl
     * @param texBuffer   ArrayBuffer of "<name>T.mdl" when textures are stored separately
     */
    constructor(THREE, buffer, texBuffer) {
      this.THREE = THREE;
      const u8 = (this.u8 = new Uint8Array(buffer));
      const dv = (this.dv = new DataView(buffer));
      if (cstr(u8, 0, 4) !== 'IDST') throw new Error('invalid MDL');
      if (dv.getInt32(4, true) !== 10) throw new Error('MDL version ' + dv.getInt32(4, true) + ' not supported');
      const i32 = (o) => dv.getInt32(o, true);
      const f32 = (o) => dv.getFloat32(o, true);

      // ossos
      this.bones = [];
      const nb = i32(140), bi = i32(144);
      for (let i = 0; i < nb; i++) {
        const o = bi + i * 112;
        const value = [], scale = [];
        for (let k = 0; k < 6; k++) { value.push(f32(o + 64 + k * 4)); scale.push(f32(o + 88 + k * 4)); }
        this.bones.push({ name: cstr(u8, o, 32), parent: i32(o + 32), value, scale });
      }
      this.boneIndex = new Map(this.bones.map((b, i) => [b.name, i]));

      // sequences
      this.seqs = [];
      const ns = i32(164), si = i32(168);
      for (let i = 0; i < ns; i++) {
        const o = si + i * 176;
        this.seqs.push({
          label: cstr(u8, o, 32), fps: f32(o + 32), flags: i32(o + 36), numframes: i32(o + 56),
          motiontype: i32(o + 68), motionbone: i32(o + 72), linearX: f32(o + 76),
          numblends: i32(o + 120), animindex: i32(o + 124), seqgroup: i32(o + 156),
          blendstart: f32(o + 136), blendend: f32(o + 144),
          events: this.readEvents(i32(o + 48), i32(o + 52)),
        });
      }

      // attachment points (e.g. the barrel, where the muzzle flash comes from)
      this.attachments = [];
      const na = i32(212), ai = i32(216);
      for (let i = 0; i < na; i++) {
        const o = ai + i * 88;
        this.attachments.push({ bone: i32(o + 36), org: [f32(o + 40), f32(o + 44), f32(o + 48)] });
      }

      // textures (from the file itself or from the T.mdl)
      let tu8 = u8, tdv = dv;
      if (i32(180) === 0 && texBuffer) { tu8 = new Uint8Array(texBuffer); tdv = new DataView(texBuffer); }
      const ti32 = (o) => tdv.getInt32(o, true);
      this.textures = [];
      const nt = ti32(180), tix = ti32(184);
      for (let i = 0; i < nt; i++) {
        const o = tix + i * 80;
        const flags = ti32(o + 64), w = ti32(o + 68), h = ti32(o + 72), idx = ti32(o + 76);
        const rgba = new Uint8Array(w * h * 4);
        const pal = idx + w * h;
        const masked = (flags & NF_MASKED) !== 0;
        for (let p = 0; p < w * h; p++) {
          const c = tu8[idx + p];
          rgba[p * 4] = tu8[pal + c * 3];
          rgba[p * 4 + 1] = tu8[pal + c * 3 + 1];
          rgba[p * 4 + 2] = tu8[pal + c * 3 + 2];
          rgba[p * 4 + 3] = masked && c === 255 ? 0 : 255;
        }
        const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        tex.onUpdate = NS.dropCpuCopy;
        tex.needsUpdate = true;
        this.textures.push({ tex, w, h, masked });
      }
      const nsr = ti32(192), skinIdx = ti32(200);
      this.skin = [];
      for (let i = 0; i < nsr; i++) this.skin.push(tdv.getInt16(skinIdx + i * 2, true));

      this.buildTemplate();
    }

    /** Animation events (5001 = muzzle flash, 5004 = sound...). */
    readEvents(count, index) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const o = index + i * 76;
        out.push({ frame: this.dv.getInt32(o, true), event: this.dv.getInt32(o + 4, true), options: NS.cstr(this.u8, o + 12, 64) });
      }
      return out;
    }

    findSeq(re) {
      return this.seqs.findIndex((s) => re.test(s.label));
    }

    /** Builds the body-0 meshes: per texture, vertices with bone, normal and UV. */
    buildTemplate() {
      const { u8, dv } = this;
      const i32 = (o) => dv.getInt32(o, true);
      const groups = new Map();
      const nbp = i32(204), bpi = i32(208);
      for (let b = 0; b < nbp; b++) {
        const bp = bpi + b * 76;
        const nummodels = i32(bp + 64);
        const modelindex = i32(bp + 72);
        if (nummodels < 1) continue;
        const m = modelindex; // corpo 0 -> primeiro submodelo
        const nummesh = i32(m + 72), meshindex = i32(m + 76);
        const vertinfo = i32(m + 84), vertindex = i32(m + 88);
        const norminfo = i32(m + 96), normindex = i32(m + 100);
        for (let k = 0; k < nummesh; k++) {
          const me = meshindex + k * 20;
          let ti = i32(me + 4);
          const skinref = i32(me + 8);
          const texId = this.skin[skinref] != null ? this.skin[skinref] : skinref;
          const tex = this.textures[texId];
          if (!tex) continue;
          let g = groups.get(texId);
          if (!g) { g = { texId, pos: [], nrm: [], bone: [], nbone: [], uv: [] }; groups.set(texId, g); }
          const addVert = (vi, ni, s, t) => {
            g.pos.push(dv.getFloat32(vertindex + vi * 12, true), dv.getFloat32(vertindex + vi * 12 + 4, true), dv.getFloat32(vertindex + vi * 12 + 8, true));
            g.nrm.push(dv.getFloat32(normindex + ni * 12, true), dv.getFloat32(normindex + ni * 12 + 4, true), dv.getFloat32(normindex + ni * 12 + 8, true));
            g.bone.push(u8[vertinfo + vi]);
            g.nbone.push(u8[norminfo + ni]);
            g.uv.push(s / tex.w, t / tex.h);
          };
          for (;;) {
            let count = dv.getInt16(ti, true);
            ti += 2;
            if (count === 0) break;
            const fan = count < 0;
            count = Math.abs(count);
            const vs = [];
            for (let c = 0; c < count; c++) {
              vs.push([dv.getInt16(ti, true), dv.getInt16(ti + 2, true), dv.getInt16(ti + 4, true), dv.getInt16(ti + 6, true)]);
              ti += 8;
            }
            for (let c = 2; c < count; c++) {
              let tri;
              if (fan) tri = [vs[0], vs[c - 1], vs[c]];
              else tri = c % 2 === 0 ? [vs[c - 2], vs[c - 1], vs[c]] : [vs[c - 1], vs[c - 2], vs[c]];
              for (const v of tri) addVert(v[0], v[1], v[2], v[3]);
            }
          }
        }
      }
      this.groups = [...groups.values()].map((g) => ({
        texId: g.texId,
        pos: Float32Array.from(g.pos), nrm: Float32Array.from(g.nrm),
        bone: Uint8Array.from(g.bone), nbone: Uint8Array.from(g.nbone), uv: Float32Array.from(g.uv),
      }));
    }

    /** Animated value of a channel at `frame` (mstudioanimvalue_t RLE). */
    animValue(base, frame) {
      const { u8, dv } = this;
      let k = frame;
      let p = base;
      for (let guard = 0; guard < 4096; guard++) {
        const total = u8[p + 1];
        if (total > k) break;
        k -= total;
        p += (u8[p] + 1) * 2;
        if (total === 0) return 0;
      }
      const valid = u8[p];
      return valid > k ? dv.getInt16(p + (k + 1) * 2, true) : dv.getInt16(p + valid * 2, true);
    }

    /** Computes local position/rotation of every bone for one blend of the sequence. */
    calcBlend(seq, blend, frame, pos, quat) {
      const nb = this.bones.length;
      const animBase = seq.animindex + blend * nb * 12;
      const f0 = Math.floor(frame);
      const s = frame - f0;
      const f1 = Math.min(seq.numframes - 1, f0 + 1);
      const q0 = this._q0 || (this._q0 = new Float32Array(4));
      const q1 = this._q1 || (this._q1 = new Float32Array(4));
      for (let i = 0; i < nb; i++) {
        const bone = this.bones[i];
        const a = animBase + i * 12;
        const v0 = [0, 0, 0, 0, 0, 0], v1 = [0, 0, 0, 0, 0, 0];
        for (let j = 0; j < 6; j++) {
          const off = this.dv.getUint16(a + j * 2, true);
          let x0 = 0, x1 = 0;
          if (off) {
            x0 = this.animValue(a + off, f0);
            x1 = f1 === f0 ? x0 : this.animValue(a + off, f1);
          }
          v0[j] = bone.value[j] + x0 * bone.scale[j];
          v1[j] = bone.value[j] + x1 * bone.scale[j];
        }
        pos[i * 3] = v0[0] + (v1[0] - v0[0]) * s;
        pos[i * 3 + 1] = v0[1] + (v1[1] - v0[1]) * s;
        pos[i * 3 + 2] = v0[2] + (v1[2] - v0[2]) * s;
        angleQuat(v0[3], v0[4], v0[5], q0, 0);
        angleQuat(v1[3], v1[4], v1[5], q1, 0);
        slerp(q0, 0, q1, 0, s, quat, i * 4);
      }
      // remove the animation root motion (the game moves the entity, not the bone)
      if (seq.motiontype & 7) {
        const mb = seq.motionbone * 3;
        if (seq.motiontype & 1) pos[mb] = 0;
        if (seq.motiontype & 2) pos[mb + 1] = 0;
        if (seq.motiontype & 4) pos[mb + 2] = 0;
      }
    }

    /** Pose of a sequence with CS-style blending. */
    calcSeq(seqIndex, frame, s, t, pos, quat) {
      const seq = this.seqs[seqIndex] || this.seqs[0];
      const nb = this.bones.length;
      const n = seq.numframes;
      let f = frame;
      if (n <= 1) f = 0;
      else if (seq.flags & STUDIO_LOOPING) f = ((f % (n - 1)) + (n - 1)) % (n - 1);
      else f = Math.min(Math.max(0, f), n - 1.001);

      if (seq.numblends <= 1 || seq.seqgroup !== 0) {
        this.calcBlend(seq, 0, f, pos, quat);
        return seq;
      }
      const tmpP = () => new Float32Array(nb * 3), tmpQ = () => new Float32Array(nb * 4);
      if (seq.numblends === 9) {
        // grade 3x3: s = horizontal, t = vertical (mira)
        let ids, fs, ft;
        if (s <= 127) {
          fs = (s * 2) / 255;
          if (t <= 127) { ft = (t * 2) / 255; ids = [0, 1, 3, 4]; } else { ft = (2 * (t - 127)) / 255; ids = [3, 4, 6, 7]; }
        } else {
          fs = (2 * (s - 127)) / 255;
          if (t <= 127) { ft = (t * 2) / 255; ids = [1, 2, 4, 5]; } else { ft = (2 * (t - 127)) / 255; ids = [4, 5, 7, 8]; }
        }
        const P = ids.map(tmpP), Q = ids.map(tmpQ);
        ids.forEach((id, k) => this.calcBlend(seq, id, f, P[k], Q[k]));
        const qa = tmpQ(), qb = tmpQ();
        for (let i = 0; i < nb; i++) {
          slerp(Q[0], i * 4, Q[1], i * 4, fs, qa, i * 4);
          slerp(Q[2], i * 4, Q[3], i * 4, fs, qb, i * 4);
          slerp(qa, i * 4, qb, i * 4, ft, quat, i * 4);
          for (let j = 0; j < 3; j++) {
            const a = P[0][i * 3 + j] + (P[1][i * 3 + j] - P[0][i * 3 + j]) * fs;
            const b = P[2][i * 3 + j] + (P[3][i * 3 + j] - P[2][i * 3 + j]) * fs;
            pos[i * 3 + j] = a + (b - a) * ft;
          }
        }
        return seq;
      }
      // two blends: interpolate by s
      const P1 = tmpP(), Q1 = tmpQ();
      this.calcBlend(seq, 0, f, pos, quat);
      this.calcBlend(seq, 1, f, P1, Q1);
      const k = s / 255;
      for (let i = 0; i < nb; i++) {
        slerp(quat, i * 4, Q1, i * 4, k, quat, i * 4);
        for (let j = 0; j < 3; j++) pos[i * 3 + j] += (P1[i * 3 + j] - pos[i * 3 + j]) * k;
      }
      return seq;
    }
  }

  /** A drawable copy of the model with its own pose. */
  class MdlInstance {
    constructor(model, tint) {
      const THREE = model.THREE;
      this.model = model;
      const nb = model.bones.length;
      this.pos = new Float32Array(nb * 3);
      this.quat = new Float32Array(nb * 4);
      this.gpos = new Float32Array(nb * 3);
      this.gquat = new Float32Array(nb * 4);
      this.mat = new Float32Array(nb * 12); // matrizes 3x4 globais
      this.group = new THREE.Group();
      this.meshes = model.groups.map((g) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(g.pos.length), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(g.nrm.length), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
        const t = model.textures[g.texId];
        const mat = new THREE.MeshLambertMaterial({
          map: t.tex, alphaTest: t.masked ? 0.5 : 0, side: THREE.DoubleSide,
          color: tint || 0xffffff,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        return { mesh, g };
      });
    }

    /** Computes global matrices from local pos/quat. */
    buildMatrices(merge) {
      const { model, pos, quat, mat } = this;
      const nb = model.bones.length;
      for (let i = 0; i < nb; i++) {
        const name = model.bones[i].name;
        if (merge && merge.model.boneIndex.has(name)) {
          const j = merge.model.boneIndex.get(name);
          mat.set(merge.mat.subarray(j * 12, j * 12 + 12), i * 12);
          continue;
        }
        const x = quat[i * 4], y = quat[i * 4 + 1], z = quat[i * 4 + 2], w = quat[i * 4 + 3];
        // matriz local (linhas)
        const l = [
          1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), pos[i * 3],
          2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), pos[i * 3 + 1],
          2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), pos[i * 3 + 2],
        ];
        const p = model.bones[i].parent;
        if (p < 0) { mat.set(l, i * 12); continue; }
        const P = mat.subarray(p * 12, p * 12 + 12);
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            let v = P[r * 4] * l[c] + P[r * 4 + 1] * l[4 + c] + P[r * 4 + 2] * l[8 + c];
            if (c === 3) v += P[r * 4 + 3];
            mat[i * 12 + r * 4 + c] = v;
          }
        }
      }
    }

    /** Applies the matrices to vertices and normals. */
    skin() {
      const M = this.mat;
      for (const { mesh, g } of this.meshes) {
        const P = mesh.geometry.attributes.position.array;
        const N = mesh.geometry.attributes.normal.array;
        const n = g.bone.length;
        for (let v = 0; v < n; v++) {
          const b = g.bone[v] * 12;
          const x = g.pos[v * 3], y = g.pos[v * 3 + 1], z = g.pos[v * 3 + 2];
          P[v * 3] = M[b] * x + M[b + 1] * y + M[b + 2] * z + M[b + 3];
          P[v * 3 + 1] = M[b + 4] * x + M[b + 5] * y + M[b + 6] * z + M[b + 7];
          P[v * 3 + 2] = M[b + 8] * x + M[b + 9] * y + M[b + 10] * z + M[b + 11];
          const nb = g.nbone[v] * 12;
          const nx = g.nrm[v * 3], ny = g.nrm[v * 3 + 1], nz = g.nrm[v * 3 + 2];
          N[v * 3] = M[nb] * nx + M[nb + 1] * ny + M[nb + 2] * nz;
          N[v * 3 + 1] = M[nb + 4] * nx + M[nb + 5] * ny + M[nb + 6] * nz;
          N[v * 3 + 2] = M[nb + 8] * nx + M[nb + 9] * ny + M[nb + 10] * nz;
        }
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.attributes.normal.needsUpdate = true;
      }
    }

    /**
     * Player pose: main sequence (torso/arms) + gait (legs), merged the
     * same way the CS client does.
     */
    posePlayer(seq, frame, s, t, gait, gaitFrame) {
      const m = this.model;
      m.calcSeq(seq, frame, s, t, this.pos, this.quat);
      if (gait > 0 && m.seqs[gait]) {
        m.calcSeq(gait, gaitFrame, 127, 127, this.gpos, this.gquat);
        let copy = true;
        for (let i = 0; i < m.bones.length; i++) {
          const b = m.bones[i];
          if (b.name === 'Bip01 Spine') copy = false;
          else if (b.parent >= 0 && m.bones[b.parent].name === 'Bip01 Pelvis') copy = true;
          if (copy) {
            this.pos.set(this.gpos.subarray(i * 3, i * 3 + 3), i * 3);
            this.quat.set(this.gquat.subarray(i * 4, i * 4 + 4), i * 4);
          }
        }
      }
      this.buildMatrices(null);
      this.skin();
    }

    /** Weapon attached to a player: reuses the bones with the same name. */
    poseMerged(parent) {
      this.model.calcSeq(0, 0, 127, 127, this.pos, this.quat);
      this.buildMatrices(parent);
      this.skin();
    }

    /** Simple pose (ground objects, corpses): sequence only, no gait. */
    poseStatic(seq, frame) {
      this.model.calcSeq(seq, frame, 127, 127, this.pos, this.quat);
      this.buildMatrices(null);
      this.skin();
    }

    /** Position (model space) of an attachment point with the current pose. */
    attachment(i) {
      const a = this.model.attachments[i];
      if (!a) return null;
      const M = this.mat, b = a.bone * 12, [x, y, z] = a.org;
      return [
        M[b] * x + M[b + 1] * y + M[b + 2] * z + M[b + 3],
        M[b + 4] * x + M[b + 5] * y + M[b + 6] * z + M[b + 7],
        M[b + 8] * x + M[b + 9] * y + M[b + 10] * z + M[b + 11],
      ];
    }

    /**
     * Glow (like CS:GO demos/GOTV): flat-color copy of the model used as a
     * mask; View3D lights only its edge (see drawXray). It shares the
     * geometry, so it follows the animation at no extra cost.
     */
    setXray(on, color) {
      const THREE = this.model.THREE;
      if (on && !this.xray) {
        this.xray = this.meshes.map(({ mesh }) => {
          // glow mask: flat color, no depth test (seen through walls)
          const m = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
            color, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
          }));
          // layer 1: drawn only in the mask pass (see View3D.drawXray)
          m.layers.set(1);
          m.frustumCulled = false;
          m.renderOrder = 5;
          this.group.add(m);
          return m;
        });
      }
      if (this.xray) {
        for (const m of this.xray) {
          m.visible = on;
          if (on && color != null) m.material.color.set(color);
        }
      }
    }

    dispose() {
      for (const { mesh } of this.meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
      if (this.xray) for (const m of this.xray) m.material.dispose();
    }
  }

  NS.MdlModel = MdlModel;
  NS.MdlInstance = MdlInstance;
})(typeof window !== 'undefined' ? window : globalThis);

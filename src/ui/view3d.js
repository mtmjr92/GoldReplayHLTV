/*
 * 3D view: everything comes from the game files.
 *  - BSP map with WAD textures and lightmaps, TGA sky
 *  - players (.mdl) with animations, p_*.mdl weapons attached to the hand
 *  - first-person weapon (v_*.mdl) with idle/draw/shoot/reload and muzzle flash (muzzleflash.spr)
 *  - grenades, C4 and dropped weapons (w_*.mdl), corpses (ClCorpse)
 *  - explosions and smoke with the sprites the demo itself names (TE_EXPLOSION/TE_SMOKE)
 *  - smoke grenade clouds with gas_puff_01.spr at the event positions
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});
  const THREE = root.THREE;

  const DEG = Math.PI / 180;
  const SKY_SIDES = [
    ['rt', (s, t) => [1, -s, t]],
    ['bk', (s, t) => [-1, s, t]],
    ['lf', (s, t) => [s, 1, t]],
    ['ft', (s, t) => [-s, -1, t]],
    ['up', (s, t) => [-t, -s, 1]],
    ['dn', (s, t) => [t, -s, -1]],
  ];
  const SMOKE_SPRITE = 'sprites/gas_puff_01.spr';
  const MUZZLE_SPRITES = ['sprites/muzzleflash1.spr', 'sprites/muzzleflash2.spr', 'sprites/muzzleflash3.spr'];
  const SMOKE_PUFF_LIFE = 24; // s (approximate; the demo only says when and where each puff spawns)

  function lerpAngle(a, b, f) {
    const d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }
  const norm180 = (a) => (a > 180 ? a - 360 : a);
  const wrap180 = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a; };
  // Catmull-Rom curve: passes through the recorded points without straight-line corners
  const catmull = (a, b, c, d, f) => 0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);

  /** Frees GPU geometry, materials and textures of an object tree. */
  function disposeTree(root) {
    const textures = new Set();
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (m.map) textures.add(m.map);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isTexture) textures.add(u.value);
        m.dispose();
      }
    });
    for (const t of textures) t.dispose();
  }

  function nameSprite(text, color) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    g.font = '600 28px ui-sans-serif, system-ui, sans-serif';
    const w = Math.ceil(g.measureText(text).width) + 20;
    c.width = w; c.height = 40;
    g.font = '600 28px ui-sans-serif, system-ui, sans-serif';
    g.fillStyle = 'rgba(8,10,14,0.65)';
    g.fillRect(0, 0, w, 40);
    g.fillStyle = color;
    g.fillRect(0, 36, w, 4);
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(text, 10, 19);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    sp.userData.aspect = w / 40;
    sp.center.set(0.5, 0);
    return sp;
  }

  function lights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(0.4, 1, 0.3);
    scene.add(sun);
  }

  class View3D {
    constructor(container) {
      this.container = container;
      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.autoClear = false;
      this.canvas = this.renderer.domElement;
      this.canvas.className = 'view3d';
      this.canvas.hidden = true;
      container.appendChild(this.canvas);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x6f7f95);
      this.world = new THREE.Group(); // game coordinates (Z up)
      this.world.rotation.x = -Math.PI / 2;
      this.scene.add(this.world);
      lights(this.scene);

      // first-person weapon: own scene drawn on top (does not clip into walls)
      this.vmScene = new THREE.Scene();
      this.vmWorld = new THREE.Group();
      this.vmWorld.rotation.x = -Math.PI / 2;
      this.vmScene.add(this.vmWorld);
      lights(this.vmScene);

      this.camera = new THREE.PerspectiveCamera(74, 1, 2, 20000);
      this.mode = 'first';
      this.showNames = true;
      this.showViewModel = true; // first-person weapon (like cl_drawviewmodel)
      // view options (menu). X-ray and tracers exist only in the demo player.
      this.opts = { xrayPlayers: false, xrayWeapons: false, xrayBomb: false, xrayGrenades: false, tracers: false };
      this.selected = null;
      this.free = { x: 0, y: 0, z: 400, yaw: 0, pitch: 20 };
      this.keys = new Set();
      this.models = new Map(); // caminho -> Promise<MdlModel|null>
      this.loadedModels = new Map();
      this.sprites = new Map(); // caminho -> Promise<sprite|null>
      this.loadedSprites = new Map();
      this.players = new Map();
      this.fx = new THREE.Group();
      this.world.add(this.fx);
      this.pools = new Map(); // path -> [MdlInstance] (objects and corpses)
      this.issues = [];
      this.files = null;
      this.match = null;
      this.mapGroup = null;
      this.sky = null;
      this.camInfo = '';

      this.bindInput();
      new ResizeObserver(() => this.resize()).observe(container);
      this.resize();
    }

    get active() { return !this.canvas.hidden; }
    set active(v) { this.canvas.hidden = !v; if (v) this.resize(); }

    resize() {
      const r = this.container.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    toScene(x, y, z) { return new THREE.Vector3(x, z, -y); }

    /** Warning for the diagnostics panel (translated when shown). */
    issue(level, key, vars) {
      const id = key + JSON.stringify(vars || {});
      if (!this.issues.some((i) => i.id === id)) this.issues.push({ level, id, msg: { key, vars } });
    }

    // ---------------- carregamento ----------------

    async load(files, match, onStatus) {
      this.files = files;
      this.match = match;
      this.ready = false;
      this.issues = [];
      const st = onStatus || (() => {});
      const status = (key, vars) => st(key ? NS.tr(key, vars) : '');
      const mapName = match.header.mapName;
      const where = files.source === 'assets/' ? 'assets/cstrike/' : 'cstrike/';

      status('stReadingMap', { map: mapName });
      const bspBuf = await files.read('maps/' + mapName + '.bsp');
      if (!bspBuf) {
        throw NS.i18nError('errMapNotFound', { path: where + 'maps/' + mapName + '.bsp' }, files.source === 'assets/' ? 'hintAssets' : 'hintFolder');
      }
      let bsp;
      try { bsp = NS.parseBsp(bspBuf); } catch (e) { throw NS.i18nError('errMapCorrupt', { map: mapName, msg: e.message }); }

      status('stReadingTex', { list: bsp.wads.join(', ') });
      const wads = [];
      for (const w of bsp.wads) {
        const buf = await files.read(w);
        if (!buf) { this.issue('warn', 'wadMissing', { wad: w }); continue; }
        try { wads.push(NS.parseWad(buf)); } catch (e) { this.issue('warn', 'wadCorrupt', { wad: w, msg: e.message }); }
      }
      for (const w of ['halflife.wad', 'cstrike.wad', 'decals.wad']) {
        if (bsp.wads.includes(w)) continue;
        const buf = await files.read(w);
        if (buf) { try { wads.push(NS.parseWad(buf)); } catch (e) { /* opcional */ } }
      }
      const missingTex = new Set();
      const lookup = (name) => {
        for (const w of wads) { const t = w.get(name); if (t && t.rgba) return t; }
        missingTex.add(name);
        return null;
      };

      status('stBuildingMap');
      if (this.mapGroup) { this.world.remove(this.mapGroup); disposeTree(this.mapGroup); this.mapGroup = null; }
      this.mapGroup = NS.buildBspMesh(THREE, bsp, lookup);
      this.world.add(this.mapGroup);
      if (missingTex.size) {
        this.issue('warn', 'texMissing', { n: missingTex.size, list: [...missingTex].slice(0, 6).join(', ') + (missingTex.size > 6 ? '…' : '') });
      }

      await this.loadSky(bsp.skyName);

      const b = match.bounds;
      this.free = { x: (b.minX + b.maxX) / 2, y: b.minY - 300, z: b.maxZ + 900, yaw: 90, pitch: 40 };

      // everything the demo uses: players, weapons (p_ and v_), objects (w_), corpses, sprites
      status('stLoadingModels');
      const models = new Set();
      for (const p of match.players) {
        for (let i = 0; i < p.present.length; i += 20) {
          const a = p.animAt(i);
          if (a && match.models[a[7]]) models.add(match.models[a[7]]);
          const w = match.models[p.wpn[i]];
          if (w) { models.add(w); models.add(w.replace('models/p_', 'models/v_')); }
        }
      }
      for (let f = 0; f < match.frameTimes.length; f++) {
        const it = match.itemsAt(f);
        if (!it) continue;
        for (let k = 0; k < it.length; k += match.itemStride) if (match.models[it[k]]) models.add(match.models[it[k]]);
      }
      for (const c of match.corpses) models.add(this.corpsePath(c.model));
      await Promise.all([...models].map((m) => this.model(m)));
      const missingModels = [...models].filter((m) => !this.loadedModels.has(m));
      if (missingModels.length) {
        this.issue('warn', 'modelsMissing', { n: missingModels.length, list: missingModels.slice(0, 5).join(', ') + (missingModels.length > 5 ? '…' : '') });
      }

      const sprites = new Set([SMOKE_SPRITE, ...MUZZLE_SPRITES]);
      for (const s of match.tempSprites) if (s.model) sprites.add(s.model);
      await Promise.all([...sprites].map((s) => this.sprite(s)));
      const missingSpr = [...sprites].filter((s) => !this.loadedSprites.has(s));
      if (missingSpr.length) this.issue('warn', 'spritesMissing', { list: missingSpr.join(', ') });

      this.shotsBySlot = new Map();
      for (const s of match.shots) {
        if (!this.shotsBySlot.has(s.slot)) this.shotsBySlot.set(s.slot, { t: [], s: [] });
        const e = this.shotsBySlot.get(s.slot);
        e.t.push(s.t);
        e.s.push(s);
      }
      this.puffTimes = Float64Array.from(match.smokePuffs, (p) => p.t);
      this.computeGait();
      this.ready = true;
      this.clearAll();
      status(null);
    }

    /**
     * Legs as the CS client computes them (StudioEstimateGait / CalculateYawBlend):
     * when moving they point along the movement; when standing they slowly turn
     * toward the aim; if the aim is more than 120° from the legs they flip 180° and
     * the walk animation plays backwards. Precomputed per frame so any point of
     * the demo can be jumped to.
     */
    computeGait() {
      const m = this.match;
      const ft = m.frameTimes;
      const F = ft.length;
      this.gait = new Map();
      for (const p of m.players) {
        const gy = new Float32Array(F), gd = new Float32Array(F);
        let yaw = null, dist = 0, px = null, py = null;
        for (let i = 0; i < F; i++) {
          if (!p.present[i]) { gy[i] = yaw == null ? 0 : yaw; gd[i] = dist; px = null; continue; }
          const aim = p.yaw[i];
          if (yaw == null) yaw = aim;
          const dt = i > 0 ? Math.min(1, ft[i] - ft[i - 1]) : 0;
          let vx = 0, vy = 0, mv = 0;
          if (px != null && dt > 0) {
            vx = p.x[i] - px; vy = p.y[i] - py; mv = Math.hypot(vx, vy);
            if (mv / dt < 5 || mv > 100) { mv = 0; vx = vy = 0; }
          }
          if (mv === 0) {
            let d = wrap180(aim - yaw);
            d *= dt < 0.25 ? dt * 4 : dt;
            yaw = wrap180(yaw + d);
          } else {
            yaw = (Math.atan2(vy, vx) * 180) / Math.PI;
          }
          const fl = wrap180(aim - yaw);
          let sign = 1;
          if (fl > 120) { yaw = wrap180(yaw - 180); sign = -1; } else if (fl < -120) { yaw = wrap180(yaw + 180); sign = -1; }
          dist += sign * mv;
          gy[i] = yaw; gd[i] = dist;
          px = p.x[i]; py = p.y[i];
        }
        this.gait.set(p.slot, { yaw: gy, dist: gd });
      }
    }

    corpsePath(name) { return 'models/player/' + name + '/' + name + '.mdl'; }

    async loadSky(name) {
      if (this.sky) { this.scene.remove(this.sky); disposeTree(this.sky); this.sky = null; }
      if (!name) return;
      const group = new THREE.Group();
      let ok = 0;
      for (const [suf, dir] of SKY_SIDES) {
        const buf = await this.files.read('gfx/env/' + name + suf + '.tga');
        if (!buf) continue;
        let img;
        try { img = NS.decodeTga(buf); } catch (e) { continue; }
        const tex = new THREE.DataTexture(img.rgba, img.width, img.height, THREE.RGBAFormat);
        tex.flipY = false;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.onUpdate = NS.dropCpuCopy;
        tex.needsUpdate = true;
        const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
        const pos = [], uv = [];
        const eps = 1 / img.width;
        for (const [s, t] of [c[0], c[1], c[2], c[0], c[2], c[3]]) {
          const d = dir(s, t);
          pos.push(d[0], d[1], d[2]);
          uv.push(Math.min(1 - eps, Math.max(eps, (s + 1) / 2)), Math.min(1 - eps, Math.max(eps, 1 - (t + 1) / 2)));
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, depthWrite: false, depthTest: false })));
        ok++;
      }
      if (ok < 6) this.issue('warn', 'skyIncomplete', { name, n: ok });
      if (!ok) return;
      group.scale.setScalar(1000);
      group.rotation.x = -Math.PI / 2;
      group.traverse((o) => { o.renderOrder = -1; o.frustumCulled = false; });
      this.sky = group;
      this.scene.add(group);
    }

    model(path) {
      if (!this.models.has(path)) {
        this.models.set(path, (async () => {
          try {
            const buf = await this.files.read(path);
            if (!buf) return null;
            let tbuf = null;
            if (new DataView(buf).getInt32(180, true) === 0) tbuf = await this.files.read(path.replace(/\.mdl$/i, 't.mdl'));
            const m = new NS.MdlModel(THREE, buf, tbuf);
            this.loadedModels.set(path, m);
            return m;
          } catch (e) {
            console.warn('modelo', path, e);
            this.issue('warn', 'modelError', { path, msg: e.message });
            return null;
          }
        })());
      }
      return this.models.get(path);
    }

    sprite(path) {
      if (!this.sprites.has(path)) {
        this.sprites.set(path, (async () => {
          try {
            const buf = await this.files.read(path);
            if (!buf) return null;
            const s = NS.parseSprite(THREE, buf);
            this.loadedSprites.set(path, s);
            return s;
          } catch (e) {
            console.warn('sprite', path, e);
            return null;
          }
        })());
      }
      return this.sprites.get(path);
    }

    clearAll() {
      for (const pl of this.players.values()) {
        for (const k of ['inst', 'wpnInst']) if (pl[k]) { this.world.remove(pl[k].group); pl[k].dispose(); }
        if (pl.sprite) this.world.remove(pl.sprite);
        if (pl.capsule) this.world.remove(pl.capsule);
      }
      this.players.clear();
      for (const list of this.pools.values()) for (const inst of list) { this.world.remove(inst.group); inst.dispose(); }
      this.pools.clear();
      if (this.vm) { this.vmWorld.remove(this.vm.group); this.vm.dispose(); this.vm = null; }
    }

    // ---------------- entrada ----------------

    bindInput() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY };
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag = { x: e.clientX, y: e.clientY };
        if (this.mode === 'free') {
          this.free.yaw -= dx * 0.25;
          this.free.pitch = Math.max(-89, Math.min(89, this.free.pitch + dy * 0.25));
        } else if (this.mode === 'third') {
          this.orbitYaw = (this.orbitYaw || 0) - dx * 0.3;
          this.orbitPitch = Math.max(-10, Math.min(80, (this.orbitPitch == null ? 15 : this.orbitPitch) + dy * 0.3));
        }
      });
      c.addEventListener('pointerup', () => { drag = null; });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (this.mode === 'third') this.orbitDist = Math.max(40, Math.min(800, (this.orbitDist || 120) * Math.exp(e.deltaY * 0.001)));
        else if (this.mode === 'free') this.freeSpeed = Math.max(100, Math.min(4000, (this.freeSpeed || 600) * Math.exp(-e.deltaY * 0.001)));
      }, { passive: false });
      window.addEventListener('keydown', (e) => {
        if (!this.active || (e.target instanceof Element && e.target.closest('input, select, textarea'))) return;
        const k = e.key.toLowerCase();
        if (['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(k)) this.keys.add(k);
      });
      window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
      window.addEventListener('blur', () => this.keys.clear());
    }

    stepFree(dt) {
      if (this.mode !== 'free' || !this.keys.size) return;
      const sp = (this.freeSpeed || 600) * (this.keys.has('shift') ? 3 : 1) * dt;
      const yaw = this.free.yaw * DEG, pitch = this.free.pitch * DEG;
      const fx = Math.cos(yaw) * Math.cos(pitch), fy = Math.sin(yaw) * Math.cos(pitch), fz = -Math.sin(pitch);
      const rx = Math.sin(yaw), ry = -Math.cos(yaw);
      const k = this.keys;
      const m = (a, b) => (k.has(a) ? 1 : 0) - (k.has(b) ? 1 : 0);
      const f = m('w', 's'), r = m('d', 'a'), u = m('e', 'q');
      this.free.x += (fx * f + rx * r) * sp;
      this.free.y += (fy * f + ry * r) * sp;
      this.free.z += (fz * f + u) * sp;
    }

    // ---------------- desenho ----------------

    /** Frame of the main animation (StudioEstimateFrame). */
    seqFrame(model, a, t) {
      const seq = model.seqs[a[0]];
      if (!seq) return 0;
      const n = seq.numframes;
      let f = n > 1 ? (a[2] * (n - 1)) / 256 : 0;
      const dt = t - a[3];
      if (dt > 0) f += dt * a[4] * seq.fps;
      return f;
    }

    pooled(path, used) {
      const model = this.loadedModels.get(path);
      if (!model) return null;
      let list = this.pools.get(path);
      if (!list) { list = []; this.pools.set(path, list); }
      const n = used.get(path) || 0;
      used.set(path, n + 1);
      if (!list[n]) {
        list[n] = new NS.MdlInstance(model);
        this.world.add(list[n].group);
      }
      list[n].group.visible = true;
      return list[n];
    }

    draw(t, dtReal) {
      const m = this.match;
      this.renderer.clear();
      if (!m || !this.mapGroup || !this.ready) {
        this.renderer.render(this.scene, this.camera);
        return;
      }
      if (dtReal) this.stepFree(dtReal);

      const ft = m.frameTimes;
      let i = NS.upperBound(ft, t) - 1;
      if (i < 0) i = 0;
      if (i > ft.length - 2) i = ft.length - 2;
      const span = ft[i + 1] - ft[i];
      const fr = span > 0 ? Math.min(1, Math.max(0, (t - ft[i]) / span)) : 0;

      const seen = new Set();
      let camTarget = null;
      for (const p of m.players) {
        const a0 = p.present[i], a1 = p.present[i + 1];
        if (!a0 && !a1) continue;
        const k = a0 ? i : i + 1;
        const anim = p.animAt(k);
        if (!anim) continue;
        let x, y, z, yaw;
        if (a0 && a1 && Math.hypot(p.x[i + 1] - p.x[i], p.y[i + 1] - p.y[i]) < 160) {
          // also uses the previous and next points for a smooth curve
          const i0 = i > 0 && p.present[i - 1] && Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]) < 160 ? i - 1 : i;
          const i3 = i + 2 < ft.length && p.present[i + 2] && Math.hypot(p.x[i + 2] - p.x[i + 1], p.y[i + 2] - p.y[i + 1]) < 160 ? i + 2 : i + 1;
          x = catmull(p.x[i0], p.x[i], p.x[i + 1], p.x[i3], fr);
          y = catmull(p.y[i0], p.y[i], p.y[i + 1], p.y[i3], fr);
          z = catmull(p.z[i0], p.z[i], p.z[i + 1], p.z[i3], fr);
          const yb = p.yaw[i];
          const ya = yb + wrap180(p.yaw[i0] - yb), yc = yb + wrap180(p.yaw[i + 1] - yb), yd = yc + wrap180(p.yaw[i3] - p.yaw[i + 1]);
          yaw = catmull(ya, yb, yc, yd, fr);
        } else { x = p.x[k]; y = p.y[k]; z = p.z[k]; yaw = p.yaw[k]; }
        const next = p.animAt(i + 1);
        const pitchEnt = a0 && a1 && next ? norm180(anim[8]) + (norm180(next[8]) - norm180(anim[8])) * fr : norm180(anim[8]);
        const pitch = -pitchEnt * 3; // o servidor manda -mira/3
        // legs (gait) like the CS client: movement direction and signed distance
        const g = this.gait && this.gait.get(p.slot);
        const both = a0 && a1;
        const modelYaw = g ? (both ? lerpAngle(g.yaw[i], g.yaw[i + 1], fr) : g.yaw[k]) : yaw;
        const gaitDist = g ? (both ? g.dist[i] + (g.dist[i + 1] - g.dist[i]) * fr : g.dist[k]) : 0;
        seen.add(p.slot);

        const team = p.team.at(t);
        const color = team === 'T' ? '#ff3f3f' : team === 'CT' ? '#99ccff' : '#9aa3b0'; // original CS colors
        let pl = this.players.get(p.slot);
        if (!pl) { pl = { name: '' }; this.players.set(p.slot, pl); }
        const path = m.models[anim[7]] || '';
        const model = this.loadedModels.get(path);
        const firstPerson = this.mode === 'first' && this.selected === p.slot;
        const dead = p.dead.at(t);
        let ducking = false;

        if (model) {
          if (pl.path !== path) {
            if (pl.inst) { this.world.remove(pl.inst.group); pl.inst.dispose(); }
            pl.inst = new NS.MdlInstance(model);
            pl.path = path;
            this.world.add(pl.inst.group);
          }
          if (pl.capsule) pl.capsule.visible = false;
          const gseq = model.seqs[anim[1]];
          let gaitFrame = 0;
          if (gseq) gaitFrame = gseq.linearX > 0 ? (gaitDist / gseq.linearX) * gseq.numframes : t * gseq.fps;
          // aim blend computed like the CS client (CalculateYawBlend / CalculatePitchBlend)
          const flYaw = wrap180(yaw - modelYaw);
          const sBlend = 255 - Math.max(0, Math.min(255, (flYaw / 90) * 128 + 127));
          const sd = model.seqs[anim[0]];
          let tBlend = 127;
          if (sd && sd.numblends > 1) {
            const b = pitchEnt * 3;
            if (b <= sd.blendstart) tBlend = 0;
            else if (b >= sd.blendend) tBlend = 255;
            else tBlend = sd.blendend - sd.blendstart < 0.1 ? 127 : (255 * (b - sd.blendstart)) / (sd.blendend - sd.blendstart);
          }
          pl.inst.posePlayer(anim[0], this.seqFrame(model, anim, t), sBlend, tBlend, anim[1], gaitFrame);
          pl.inst.group.position.set(x, y, z);
          pl.inst.group.rotation.set(0, 0, modelYaw * DEG);
          pl.inst.group.visible = !firstPerson;
          pl.inst.setXray(this.opts.xrayPlayers && !p.dead.at(t), color);
          ducking = !!(model.seqs[anim[0]] && /crouch/.test(model.seqs[anim[0]].label)) ||
            !!(gseq && /crouch/.test(gseq.label));

          const wpath = m.models[p.wpn[k]] || '';
          const wmodel = this.loadedModels.get(wpath);
          if (wmodel && pl.wpnPath !== wpath) {
            if (pl.wpnInst) { this.world.remove(pl.wpnInst.group); pl.wpnInst.dispose(); }
            pl.wpnInst = new NS.MdlInstance(wmodel);
            pl.wpnPath = wpath;
            this.world.add(pl.wpnInst.group);
          }
          if (pl.wpnInst) {
            pl.wpnInst.group.visible = !!wmodel && !firstPerson;
            if (wmodel) {
              pl.wpnInst.setXray(this.opts.xrayPlayers && !p.dead.at(t), color);
              pl.wpnInst.poseMerged(pl.inst);
              pl.wpnInst.group.position.copy(pl.inst.group.position);
              pl.wpnInst.group.rotation.copy(pl.inst.group.rotation);
            }
          }
        } else {
          if (!pl.capsule) {
            pl.capsule = new THREE.Mesh(new THREE.CylinderGeometry(14, 14, 72, 12), new THREE.MeshLambertMaterial({ color }));
            pl.capsule.rotation.x = Math.PI / 2;
            this.world.add(pl.capsule);
          }
          pl.capsule.visible = !firstPerson;
          pl.capsule.position.set(x, y, z);
        }

        if (pl.name !== p.name + color) {
          if (pl.sprite) this.world.remove(pl.sprite);
          pl.sprite = nameSprite(p.name, color);
          pl.name = p.name + color;
          this.world.add(pl.sprite);
        }
        pl.sprite.visible = this.showNames && !firstPerson && !dead;
        pl.sprite.position.set(x, y, z + 44);
        const d = Math.max(60, this.camera.position.distanceTo(this.toScene(x, y, z + 44)));
        const h = d * 0.022;
        pl.sprite.scale.set(h * pl.sprite.userData.aspect, h, 1);

        pl.state = { x, y, z, yaw, pitch, k, wpath: m.models[p.wpn[k]] || '', anim, model };
        if (p.slot === this.selected) camTarget = { slot: p.slot, name: p.name, x, y, z, yaw, pitch, eye: ducking ? 12 : 17, dead, player: p, state: pl.state };
      }
      for (const [slot, pl] of this.players) {
        if (seen.has(slot)) continue;
        for (const o of [pl.inst && pl.inst.group, pl.wpnInst && pl.wpnInst.group, pl.sprite, pl.capsule]) if (o) o.visible = false;
      }

      // objects (w_*.mdl) and corpses: instances reused every frame
      for (const list of this.pools.values()) for (const inst of list) inst.group.visible = false;
      const used = new Map();
      const items = m.itemsAt(i);
      if (items) {
        for (let q = 0; q < items.length; q += m.itemStride) {
          const ipath = m.models[items[q]];
          const inst = this.pooled(ipath, used);
          if (!inst) continue;
          inst.poseStatic(items[q + 7], 0);
          // x-ray per object kind
          const kind = /w_(c4|backpack)\.mdl/.test(ipath) ? 'bomb' : /w_(hegrenade|flashbang|smokegrenade)\.mdl/.test(ipath) ? 'grenade' : 'weapon';
          const xo = kind === 'bomb' ? this.opts.xrayBomb : kind === 'grenade' ? this.opts.xrayGrenades : this.opts.xrayWeapons;
          inst.setXray(xo, kind === 'bomb' ? 0xff3b3b : kind === 'grenade' ? 0xffd23f : 0xe8e8e8);
          inst.group.position.set(items[q + 1], items[q + 2], items[q + 3]);
          inst.group.rotation.set(items[q + 6] * DEG, -items[q + 4] * DEG, items[q + 5] * DEG, 'ZYX');
        }
      }
      const roundStart = m.roundRestarts.length ? m.roundRestarts[Math.max(0, NS.upperBound(m.roundRestarts, t) - 1)] : -Infinity;
      for (const c of m.corpses) {
        if (c.t > t || c.t < roundStart) continue;
        const inst = this.pooled(this.corpsePath(c.model), used);
        if (!inst) continue;
        inst.setXray(false);
        const seq = inst.model.seqs[c.seq];
        inst.poseStatic(c.seq, seq ? (t - c.animtime) * seq.fps : 0);
        inst.group.position.set(c.x, c.y, c.z);
        inst.group.rotation.set(0, 0, c.yaw * DEG);
      }

      this.drawEffects(t);
      this.placeCamera(camTarget, t);
      if (this.sky) this.sky.position.copy(this.camera.position);
      this.renderer.render(this.scene, this.camera);
      this.drawXray();

      // first-person weapon on top of everything
      const showVm = this.showViewModel && this.mode === 'first' && camTarget && !camTarget.dead && this.updateViewModel(camTarget, t);
      if (this.vm) this.vm.group.visible = !!showVm;
      if (showVm) {
        this.renderer.clearDepth();
        this.renderer.render(this.vmScene, this.camera);
      }
    }

    /**
     * Edge-only glow (the CS:GO demo/GOTV effect):
     *  1) draw the marked objects (layer 1) in flat color into a texture (mask)
     *  2) a full-screen filter lights the pixels around the mask (outline)
     * Seen through walls and does not paint the body: only the edge.
     */
    drawXray() {
      const o = this.opts;
      if (!(o.xrayPlayers || o.xrayWeapons || o.xrayBomb || o.xrayGrenades)) return;
      const r = this.renderer;
      const size = r.getDrawingBufferSize(new THREE.Vector2());
      if (!this.glowRT || this.glowRT.width !== size.x || this.glowRT.height !== size.y) {
        if (this.glowRT) this.glowRT.dispose();
        this.glowRT = new THREE.WebGLRenderTarget(size.x, size.y);
        this.glowQuad = null;
      }
      if (!this.glowQuad) {
        this.glowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.glowScene = new THREE.Scene();
        this.glowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
          uniforms: { tMask: { value: this.glowRT.texture }, texel: { value: new THREE.Vector2(1 / size.x, 1 / size.y) }, width: { value: Math.max(2, Math.round(3 * r.getPixelRatio())) } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: `
            uniform sampler2D tMask; uniform vec2 texel; uniform float width; varying vec2 vUv;
            void main() {
              vec4 c = texture2D(tMask, vUv);
              if (c.a > 0.5) discard;              // inside the model: do not paint (edge only)
              vec3 col = vec3(0.0); float best = 0.0;
              for (int x = -6; x <= 6; x++) {
                for (int y = -6; y <= 6; y++) {
                  vec2 d = vec2(float(x), float(y));
                  float dist = length(d);
                  if (dist > width + 0.5) continue;
                  vec4 s = texture2D(tMask, vUv + d * texel);
                  float w = s.a * clamp(1.0 - (dist - 1.0) / width, 0.0, 1.0);
                  if (w > best) { best = w; col = s.rgb; }
                }
              }
              if (best <= 0.0) discard;
              gl_FragColor = vec4(col, best);
            }`,
          transparent: true, depthTest: false, depthWrite: false,
        }));
        this.glowScene.add(this.glowQuad);
      }
      // 1) mask
      const bg = this.scene.background;
      const prevClear = r.getClearColor(new THREE.Color()), prevAlpha = r.getClearAlpha();
      this.scene.background = null;
      r.setRenderTarget(this.glowRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, true);
      this.camera.layers.set(1);
      r.render(this.scene, this.camera);
      this.camera.layers.set(0);
      r.setRenderTarget(null);
      r.setClearColor(prevClear, prevAlpha);
      this.scene.background = bg;
      // 2) outline over the image
      r.render(this.glowScene, this.glowCam);
    }

    /** Picks and places the first-person weapon (v_*.mdl) and the right animation. */
    updateViewModel(target, t) {
      const st = target.state;
      const vpath = st.wpath.replace('models/p_', 'models/v_');
      const vm = this.loadedModels.get(vpath);
      if (!vm) { this.vmFlash && (this.vmFlash.visible = false); return false; }
      if (!this.vm || this.vmPath !== vpath) {
        if (this.vm) { this.vmWorld.remove(this.vm.group); this.vm.dispose(); }
        this.vm = new NS.MdlInstance(vm);
        this.vmPath = vpath;
        this.vmWorld.add(this.vm.group);
      }
      const p = target.player;
      const m = this.match;
      const ft = m.frameTimes;

      // when the current weapon was drawn
      let j = st.k, guard = 0;
      while (j > 0 && guard < 200 && p.present[j - 1] && p.wpn[j - 1] === p.wpn[st.k]) { j--; guard++; }
      const drawStart = guard < 200 ? ft[j] : -Infinity;
      // reloading? (player animation)
      let reloadStart = -Infinity;
      if (st.model && st.model.seqs[st.anim[0]] && /reload/.test(st.model.seqs[st.anim[0]].label)) {
        let r = st.k;
        while (r > 0 && p.animAt(r - 1) && p.animAt(r - 1)[0] === st.anim[0]) r--;
        reloadStart = ft[r];
      }
      // last shot and silencer state (event bparam1, like CS)
      let shotStart = -Infinity, shotIdx = 0, silenced = false;
      const shots = this.shotsBySlot && this.shotsBySlot.get(p.slot);
      const weapon = vpath.replace(/^models\/v_|\.mdl$/g, '');
      if (shots) {
        const s = NS.upperBound(shots.t, t) - 1;
        if (s >= 0 && shots.t[s] >= drawStart - 0.05) { shotStart = shots.t[s]; shotIdx = s; }
        for (let q = s; q >= 0 && q > s - 400; q--) {
          if (shots.s[q].weapon === weapon) { silenced = !!shots.s[q].b1; break; }
        }
      }
      const hasSil = vm.seqs.some((x) => /_unsil$/.test(x.label));
      const pick = (base) => {
        if (hasSil && !silenced) { const u = vm.findSeq(new RegExp('^' + base + '_unsil$')); if (u >= 0) return u; }
        const n = vm.findSeq(new RegExp('^' + base + '$'));
        return n >= 0 ? n : vm.findSeq(new RegExp('^' + base));
      };

      const cand = [
        { start: drawStart, seq: pick('draw') },
        { start: reloadStart, seq: pick('reload') },
        { start: shotStart, seq: this.shootSeq(vm, shotIdx, hasSil && !silenced) },
      ].filter((c) => c.seq >= 0 && c.start <= t).sort((a, b) => b.start - a.start);

      let seq = pick('idle');
      if (seq < 0) seq = vm.findSeq(/idle/);
      if (seq < 0) seq = 0;
      let frame = t * (vm.seqs[seq].fps || 30);
      let flashFrame = null;
      for (const c of cand) {
        const sd = vm.seqs[c.seq];
        const el = t - c.start;
        if (el < (sd.numframes - 1) / sd.fps) {
          seq = c.seq;
          frame = el * sd.fps;
          // 5001/5011/5021/5031 = muzzle flash at attachment 0/1/2/3
          const ev = sd.events.find((e) => e.event >= 5001 && e.event <= 5031 && (e.event - 5001) % 10 === 0);
          if (ev && frame >= ev.frame && frame < ev.frame + 1.5) flashFrame = ev;
          break;
        }
      }
      this.vmSoundEvents(vpath, seq, frame);
      this.vm.poseStatic(seq, frame);
      this.vm.group.position.set(target.x, target.y, target.z + target.eye);
      this.vm.group.rotation.set(0, Math.max(-89, Math.min(89, target.pitch)) * DEG, target.yaw * DEG, 'ZYX');
      // CS 1.6 v_*.mdl models are left-handed; the game mirrors them (cl_righthand 1)
      this.vm.group.scale.set(1, -1, 1);
      this.drawMuzzleFlash(flashFrame, t);
      return true;
    }

    /** Weapon animation sounds (event 5004: reload, bolt...), only while playing. */
    vmSoundEvents(path, seq, frame) {
      const last = this.vmLast;
      this.vmLast = { path, seq, frame };
      if (!this.playing || !this.onVmSound || !last || last.path !== path) return;
      const evs = this.vm.model.seqs[seq].events;
      let from;
      if (last.seq === seq && frame >= last.frame) from = last.frame;
      else if (last.seq !== seq && frame < 3) from = -1;
      else return;
      for (const e of evs) if (e.event === 5004 && e.frame > from && e.frame <= frame) this.onVmSound(e.options);
    }

    /** Camera position and direction in game coordinates (sound listener). */
    listenerPose() {
      const p = this.camera.position;
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      return { x: p.x, y: -p.z, z: p.y, yaw: Math.atan2(-d.z, d.x) / DEG };
    }

    shootSeq(vm, idx, unsil) {
      const list = vm.seqs.map((s, n) => (/^(shoot\d|slash|midslash|stab)/.test(s.label) && /_unsil$/.test(s.label) === !!unsil ? n : -1)).filter((n) => n >= 0);
      return list.length ? list[idx % list.length] : -1;
    }

    /** Muzzle flash from v_*.mdl event 5001: muzzleflash<n>.spr sprite at the barrel. */
    drawMuzzleFlash(ev, t) {
      if (!this.vmFlash) {
        this.vmFlash = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
        this.vmFlash.renderOrder = 10;
      }
      const fl = this.vmFlash;
      if (fl.parent !== this.vm.group) this.vm.group.add(fl);
      if (!ev) { fl.visible = false; return; }
      const opt = parseInt(ev.options, 10) || 0;
      const spr = this.loadedSprites.get(MUZZLE_SPRITES[Math.min(2, opt % 10)]);
      const pos = this.vm.attachment((ev.event - 5001) / 10);
      if (!spr || !pos) { fl.visible = false; return; }
      let scale = Math.floor(opt / 10) * 0.1;
      if (!scale) scale = 0.5;
      const frame = spr.frames[Math.floor(t * 100) % spr.frames.length];
      fl.material.map = frame.tex;
      fl.material.needsUpdate = true;
      fl.position.set(pos[0], pos[1], pos[2]);
      fl.scale.set(frame.w * scale, frame.h * scale, 1);
      fl.visible = true;
    }

    spriteObj(spr, frameIdx, opts) {
      const frame = spr.frames[Math.max(0, Math.min(spr.frames.length - 1, frameIdx))];
      const mat = NS.makeSpriteMaterial(THREE, spr, opts);
      mat.map = frame.tex;
      mat.userData.own = true;
      const s = new THREE.Sprite(mat);
      s.userData.frame = frame;
      return s;
    }

    drawEffects(t) {
      const m = this.match;
      const fx = this.fx;
      while (fx.children.length) {
        const o = fx.children.pop();
        if (o.material && o.material.userData.own) o.material.dispose();
        if (o.userData.ownGeo) o.geometry.dispose();
      }
      // grenade explosions and smoke: sprites named by the demo itself
      for (const e of m.tempSprites) {
        const dt = t - e.t;
        if (dt < 0 || dt > 6) continue;
        const spr = this.loadedSprites.get(e.model);
        if (!spr) continue;
        const f = Math.floor(dt * (e.fps || 10));
        if (f >= spr.frames.length) continue;
        let o;
        if (e.kind === 'smoke') {
          // R_Smoke: sobe devagar, mistura alfa
          o = this.spriteObj(spr, f, { additive: false });
          o.position.set(e.x, e.y, e.z + dt * 30);
        } else {
          const additive = !(e.flags & 1);
          o = this.spriteObj(spr, f, { additive, opacity: e.kind === 'sprite' ? (e.brightness || 255) / 255 : 1 });
          o.position.set(e.x, e.y, e.z);
        }
        const fr = o.userData.frame;
        o.scale.set(fr.w * e.scale, fr.h * e.scale, 1);
        o.renderOrder = 3;
        fx.add(o);
      }
      // tracers (study option; not a game effect): from the eye to the wall
      if (this.opts.tracers && this.shotsBySlot) {
        if (!this.tracerMats) this.tracerMats = { T: new THREE.LineBasicMaterial({ color: 0xff3f3f }), CT: new THREE.LineBasicMaterial({ color: 0x99ccff }), '': new THREE.LineBasicMaterial({ color: 0xffe7a3 }) };
        const times = this.allShotTimes || (this.allShotTimes = Float64Array.from(m.shots, (s) => s.t));
        for (let k = NS.upperBound(times, t) - 1; k >= 0; k--) {
          const s = m.shots[k];
          if (t - s.t > 0.12) break;
          const pl = this.players.get(s.slot);
          if (!pl || !pl.state) continue;
          const st = pl.state;
          const yaw = st.yaw * DEG, pitch = st.pitch * DEG;
          const dir = [Math.cos(yaw) * Math.cos(pitch), Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch)];
          const from = [st.x, st.y, st.z + 17];
          const len = this.clipDistance(from, dir, 4096);
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute([from[0] + dir[0] * 20, from[1] + dir[1] * 20, from[2] + dir[2] * 20, from[0] + dir[0] * len, from[1] + dir[1] * len, from[2] + dir[2] * len], 3));
          const team = this.match.playerBySlot(s.slot);
          const line = new THREE.Line(geo, this.tracerMats[team ? team.team.at(t) : ''] || this.tracerMats['']);
          line.userData.ownGeo = true;
          fx.add(line);
        }
      }

      // smoke grenade cloud: one gas_puff_01 per createsmoke event
      const puff = this.loadedSprites.get(SMOKE_SPRITE);
      if (puff) {
        const hi = NS.upperBound(this.puffTimes, t);
        const lo = NS.upperBound(this.puffTimes, t - SMOKE_PUFF_LIFE);
        for (let q = lo; q < hi; q++) {
          const p = m.smokePuffs[q];
          const age = t - p.t;
          const a = Math.min(1, age / 0.6) * Math.min(1, (SMOKE_PUFF_LIFE - age) / 3);
          const o = this.spriteObj(puff, q % puff.frames.length, { additive: false, opacity: a, color: 0xdcdcdc });
          o.position.set(p.x + p.vx * age, p.y + p.vy * age, p.z + 20);
          const fr = o.userData.frame;
          o.scale.set(fr.w * 5, fr.h * 5, 1);
          o.renderOrder = 2;
          fx.add(o);
        }
      }
    }

    placeCamera(target, t) {
      const cam = this.camera;
      let pos, look;
      this.camInfo = '';
      const wantsPlayer = this.mode === 'first' || this.mode === 'third';
      if (wantsPlayer && target) {
        const yaw = target.yaw * DEG;
        if (this.mode === 'first' && !target.dead) {
          const pitch = Math.max(-89, Math.min(89, target.pitch)) * DEG;
          pos = [target.x, target.y, target.z + target.eye];
          look = [pos[0] + Math.cos(yaw) * Math.cos(pitch), pos[1] + Math.sin(yaw) * Math.cos(pitch), pos[2] - Math.sin(pitch)];
        } else {
          if (this.mode === 'first') this.camInfo = target.name + ' died';
          const oy = yaw + (this.orbitYaw || 0) * DEG;
          const op = (this.orbitPitch == null ? 15 : this.orbitPitch) * DEG;
          look = [target.x, target.y, target.z + 20];
          const dir = [-Math.cos(oy) * Math.cos(op), -Math.sin(oy) * Math.cos(op), Math.sin(op)];
          const d = this.clipDistance(look, dir, this.orbitDist || 120);
          pos = [look[0] + dir[0] * d, look[1] + dir[1] * d, look[2] + dir[2] * d];
        }
      } else {
        if (wantsPlayer) this.camInfo = this.selected == null ? 'No player selected' : 'Player not in game right now';
        const f = this.free;
        const yaw = f.yaw * DEG, pitch = f.pitch * DEG;
        pos = [f.x, f.y, f.z];
        look = [f.x + Math.cos(yaw) * Math.cos(pitch), f.y + Math.sin(yaw) * Math.cos(pitch), f.z - Math.sin(pitch)];
      }
      cam.position.copy(this.toScene(pos[0], pos[1], pos[2]));
      cam.up.set(0, 1, 0);
      cam.lookAt(this.toScene(look[0], look[1], look[2]));
    }

    clipDistance(from, dir, dist) {
      if (!this.mapGroup) return dist;
      if (!this.ray) this.ray = new THREE.Raycaster();
      const o = this.toScene(from[0], from[1], from[2]);
      const d = new THREE.Vector3(dir[0], dir[2], -dir[1]).normalize();
      this.ray.set(o, d);
      this.ray.far = dist + 8;
      for (const h of this.ray.intersectObjects(this.mapGroup.children, false)) {
        if (h.object.material.transparent) continue;
        return Math.max(16, h.distance - 8);
      }
      return dist;
    }

    syncFreeFromCamera() {
      const p = this.camera.position;
      const dir = new THREE.Vector3();
      this.camera.getWorldDirection(dir);
      const gx = dir.x, gy = -dir.z, gz = dir.y;
      this.free = {
        x: p.x, y: -p.z, z: p.y,
        yaw: Math.atan2(gy, gx) / DEG,
        pitch: -Math.asin(Math.max(-1, Math.min(1, gz))) / DEG,
      };
    }
  }

  NS.View3D = View3D;
})(typeof window !== 'undefined' ? window : globalThis);

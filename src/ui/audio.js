/*
 * Demo sound with the game's original .wav files:
 *  - server sounds recorded in the demo (svc_sound): steps, hits, grenades, deaths...
 *  - shots: the CS client plays them from the weapon event; we use the same files
 *  - radio (SendAudio): "%!MRAD_ctwin" -> sound/radio/ctwin.wav
 *  - first-person weapon sounds (event 5004 of v_*.mdl)
 * Volume falls off with distance like GoldSrc: gain = vol * (1 - dist * atten / 1000).
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  // files the CS 1.6 client uses for each shot event
  const FIRE = {
    ak47: ['weapons/ak47-1.wav', 'weapons/ak47-2.wav'],
    m4a1: { sil: ['weapons/m4a1-1.wav'], unsil: ['weapons/m4a1_unsil-1.wav', 'weapons/m4a1_unsil-2.wav'] },
    usp: { sil: ['weapons/usp1.wav', 'weapons/usp2.wav'], unsil: ['weapons/usp_unsil-1.wav'] },
    glock18: ['weapons/glock18-1.wav', 'weapons/glock18-2.wav'],
    deagle: ['weapons/deagle-1.wav', 'weapons/deagle-2.wav'],
    awp: ['weapons/awp1.wav'],
    scout: ['weapons/scout_fire-1.wav'],
    famas: ['weapons/famas-1.wav', 'weapons/famas-2.wav'],
    galil: ['weapons/galil-1.wav', 'weapons/galil-2.wav'],
    mp5n: ['weapons/mp5-1.wav', 'weapons/mp5-2.wav'],
    p90: ['weapons/p90-1.wav'],
    ump45: ['weapons/ump45-1.wav'],
    mac10: ['weapons/mac10-1.wav'],
    tmp: ['weapons/tmp-1.wav', 'weapons/tmp-2.wav'],
    aug: ['weapons/aug-1.wav'],
    sg552: ['weapons/sg552-1.wav', 'weapons/sg552-2.wav'],
    sg550: ['weapons/sg550-1.wav'],
    g3sg1: ['weapons/g3sg1-1.wav'],
    m249: ['weapons/m249-1.wav', 'weapons/m249-2.wav'],
    m3: ['weapons/m3-1.wav'],
    xm1014: ['weapons/xm1014-1.wav'],
    p228: ['weapons/p228-1.wav'],
    fiveseven: ['weapons/fiveseven-1.wav'],
    elite_left: ['weapons/elite_fire.wav'],
    elite_right: ['weapons/elite_fire.wav'],
  };

  class DemoAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.volume = 0.8;
      this.muted = false;
      this.files = null;
      this.match = null;
      this.buffers = new Map(); // caminho -> AudioBuffer | null | Promise
      this.events = [];
      this.times = new Float64Array(0);
      this.lastT = null;
      this.missing = new Set();
      this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    }

    /** Needs a user click (browser autoplay rule). */
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.applyVolume();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    applyVolume() {
      if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    }

    setVolume(v) { this.volume = v; this.applyVolume(); }
    setMuted(m) { this.muted = m; this.applyVolume(); }

    setSource(files, match) {
      this.files = files;
      this.match = match;
      this.missing.clear();
      this.lastT = null;
      if (!files || !match) { this.events = []; this.times = new Float64Array(0); return; }
      const ev = [];
      for (const s of match.sounds) ev.push({ t: s.t, name: s.name, x: s.x, y: s.y, z: s.z, vol: s.vol, atten: s.atten, pitch: s.pitch });
      match.shots.forEach((s, i) => {
        const def = FIRE[s.weapon];
        if (!def) return;
        const list = Array.isArray(def) ? def : s.b1 ? def.sil : def.unsil;
        ev.push({ t: s.t, name: list[i % list.length], slot: s.slot, vol: 1, atten: 0.8, pitch: 100 });
      });
      for (const r of match.radio) ev.push({ t: r.t, name: 'radio/' + r.code + '.wav', vol: 1, atten: 0, pitch: 100 });
      ev.sort((a, b) => a.t - b.t);
      this.events = ev;
      this.times = Float64Array.from(ev, (e) => e.t);
      // preload the files in use (in the background)
      const names = new Set(ev.map((e) => e.name));
      for (const n of names) this.buffer(n);
    }

    buffer(name) {
      if (this.buffers.has(name)) return this.buffers.get(name);
      const p = (async () => {
        if (!this.files) return null;
        const data = await this.files.read('sound/' + name);
        if (!data) { this.missing.add(name); return null; }
        try {
          if (!this.ctx) {
            // decode even before the click, in an offline context
            const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 22050);
            return await off.decodeAudioData(data);
          }
          return await this.ctx.decodeAudioData(data);
        } catch (e) {
          this.missing.add(name);
          return null;
        }
      })();
      this.buffers.set(name, p);
      p.then((b) => this.buffers.set(name, b));
      return p;
    }

    /** Called every frame with the demo time. Plays the sounds that were passed. */
    tick(t, playing, speed, positionOf) {
      const last = this.lastT;
      this.lastT = t;
      if (!this.ctx || this.muted || !playing || last == null) return;
      if (t < last || t - last > 0.5 || speed > 2) return; // seek or too fast: do not dump a burst of sounds
      const lo = NS.upperBound(this.times, last);
      const hi = NS.upperBound(this.times, t);
      for (let i = lo; i < hi && i - lo < 40; i++) {
        const e = this.events[i];
        let pos = null;
        if (e.slot != null) pos = positionOf(e.slot, e.t);
        else if (e.x != null && (e.x || e.y || e.z)) pos = e;
        this.play(e.name, pos, e.vol, e.atten, e.pitch * (speed !== 1 ? speed : 1));
      }
    }

    /** Plays a sound; `pos` in game coordinates (null = no position, e.g. radio). */
    play(name, pos, vol, atten, pitch) {
      if (!this.ctx || this.muted) return;
      const b = this.buffers.get(name);
      if (!b || b instanceof Promise) { if (!this.buffers.has(name)) this.buffer(name); return; }
      let gain = vol == null ? 1 : vol;
      let pan = 0;
      if (pos && atten) {
        const L = this.listener;
        const dx = pos.x - L.x, dy = pos.y - L.y, dz = (pos.z || 0) - L.z;
        const dist = Math.hypot(dx, dy, dz);
        gain *= Math.max(0, 1 - (dist * atten) / 1000);
        if (gain <= 0.01) return;
        if (dist > 1) {
          // left/right relative to where the listener looks
          const yaw = (L.yaw * Math.PI) / 180;
          const right = dx * Math.sin(yaw) - dy * Math.cos(yaw);
          pan = Math.max(-1, Math.min(1, right / dist)) * 0.8;
        }
      }
      const src = this.ctx.createBufferSource();
      src.buffer = b;
      src.playbackRate.value = (pitch || 100) / 100;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      let node = src.connect(g);
      if (this.ctx.createStereoPanner) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        node = node.connect(p);
      }
      node.connect(this.master);
      src.start();
    }
  }

  NS.DemoAudio = DemoAudio;
})(typeof window !== 'undefined' ? window : globalThis);

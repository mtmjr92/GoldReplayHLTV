/*
 * 2D radar: draws the map (generated from trajectories), players, grenades,
 * smokes, explosions and kill marks on a <canvas>.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const COLORS = {
    T: '#ff3f3f', // original CS 1.6 team colors
    CT: '#99ccff',
    other: '#9aa3b0',
    bg: '#0b0e13',
    shot: '#ffe7a3',
  };
  const ITEM_STYLE = {
    he: { color: '#ff6b4a', label: 'HE' },
    flash: { color: '#f5f7fa', label: 'FL' },
    smoke: { color: '#a9b2bf', label: 'SM' },
    c4: { color: '#ff3b3b', label: 'C4' },
  };
  const SMOKE_RADIUS = 115;

  function teamColor(team) { return COLORS[team] || COLORS.other; }

  function upperBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function lerpAngle(a, b, f) {
    let d = ((b - a + 540) % 360) - 180;
    return a + d * f;
  }

  /** Interpolated state of every player at time t. */
  function samplePlayers(match, t) {
    const ft = match.frameTimes;
    const F = ft.length;
    let i = upperBound(ft, t) - 1;
    if (i < 0) i = 0;
    if (i > F - 2) i = F - 2;
    const span = ft[i + 1] - ft[i];
    const f = span > 0 ? Math.min(1, Math.max(0, (t - ft[i]) / span)) : 0;
    const out = [];
    for (const p of match.players) {
      const a = p.present[i], b = p.present[i + 1];
      let team = p.team.at(t);
      if (team !== 'T' && team !== 'CT') {
        const k = p.present[i] ? i : i + 1;
        const code = p.present[k] ? p.mteam[k] : 0;
        if (code) team = code === 1 ? 'T' : 'CT';
      }
      const dead = p.dead.at(t);
      const base = {
        slot: p.slot, name: p.name, team, dead,
        health: dead ? 0 : p.health.at(t), bomb: p.bomb.at(t),
        frags: p.frags.at(t), deaths: p.deaths.at(t),
        weapon: '', present: false, x: 0, y: 0, z: 0, yaw: 0,
      };
      if (a || b) {
        const k = a ? i : i + 1;
        base.present = true;
        base.weapon = p.weaponName(k);
        if (a && b && Math.hypot(p.x[i + 1] - p.x[i], p.y[i + 1] - p.y[i]) < 160) {
          base.x = p.x[i] + (p.x[i + 1] - p.x[i]) * f;
          base.y = p.y[i] + (p.y[i + 1] - p.y[i]) * f;
          base.z = p.z[i] + (p.z[i + 1] - p.z[i]) * f;
          base.yaw = lerpAngle(p.yaw[i], p.yaw[i + 1], f);
        } else {
          base.x = p.x[k]; base.y = p.y[k]; base.z = p.z[k]; base.yaw = p.yaw[k];
        }
      }
      out.push(base);
    }
    return { players: out, frame: i };
  }

  /** Position (not interpolated) of a player at time t, or null. */
  function positionAt(match, slot, t) {
    const p = match.playerBySlot(slot);
    if (!p) return null;
    let i = upperBound(match.frameTimes, t) - 1;
    for (let k = 0; k < 40 && i >= 0; k++, i--) {
      if (p.present[i]) return { x: p.x[i], y: p.y[i] };
    }
    return null;
  }

  /**
   * Builds the map image from where players walked in the whole demo: each
   * visited cell becomes "floor", shaded by height.
   */
  function buildBackground(match) {
    const CELL = 8;
    const M = 96;
    const b = match.bounds;
    const x0 = b.minX - M, y1 = b.maxY + M;
    const W = Math.ceil((b.maxX - b.minX + 2 * M) / CELL);
    const H = Math.ceil((b.maxY - b.minY + 2 * M) / CELL);
    const hit = new Uint8Array(W * H);
    const zmax = new Float32Array(W * H).fill(-1e9);
    const R = 2;
    const stamp = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= R * R + 1) stamp.push([dx, dy]);

    for (const p of match.players) {
      const n = p.present.length;
      for (let i = 0; i < n; i++) {
        if (!p.present[i]) continue;
        const cx = ((p.x[i] - x0) / CELL) | 0;
        const cy = ((y1 - p.y[i]) / CELL) | 0;
        const z = p.z[i];
        for (const [dx, dy] of stamp) {
          const xx = cx + dx, yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const idx = yy * W + xx;
          hit[idx] = 1;
          if (z > zmax[idx]) zmax[idx] = z;
        }
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    const img = g.createImageData(W, H);
    const d = img.data;
    const zr = Math.max(1, b.maxZ - b.minZ);
    const low = [44, 47, 52], high = [128, 120, 100], edge = [160, 150, 122];
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        const idx = yy * W + xx;
        if (!hit[idx]) continue;
        const isEdge = xx === 0 || yy === 0 || xx === W - 1 || yy === H - 1 ||
          !hit[idx - 1] || !hit[idx + 1] || !hit[idx - W] || !hit[idx + W];
        const v = Math.min(1, Math.max(0, (zmax[idx] - b.minZ) / zr));
        const c = isEdge ? edge : [0, 1, 2].map((k) => low[k] + (high[k] - low[k]) * v);
        const o = idx * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return { canvas, x0, y1, cell: CELL, W, H };
  }

  class Radar {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cam = { x: 0, y: 0, zoom: 0.2 };
      this.match = null;
      this.bg = null;
      this.showNames = true;
      this.followSlot = null;
      this.onPick = null;
      this.onUserPan = null;
      this.last = null;
      this.dpr = 1;
      this.w = 1;
      this.h = 1;
      this.bindInput();
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
      this.resize();
    }

    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      if (this.match && !this.userMoved) this.fit();
      if (this.redraw) this.redraw();
    }

    setMatch(match) {
      this.match = match;
      this.bg = buildBackground(match);
      this.shotTimes = Float64Array.from(match.shots, (s) => s.t);
      this.followSlot = null;
      this.userMoved = false;
      this.fit();
    }

    fit() {
      if (!this.match) return;
      const b = this.match.bounds;
      const ww = (b.maxX - b.minX) * 1.1 + 200;
      const wh = (b.maxY - b.minY) * 1.1 + 200;
      this.cam.zoom = Math.min(this.w / ww, this.h / wh);
      this.cam.x = (b.minX + b.maxX) / 2;
      this.cam.y = (b.minY + b.maxY) / 2;
    }

    toScreen(x, y) {
      return [(x - this.cam.x) * this.cam.zoom + this.w / 2, -(y - this.cam.y) * this.cam.zoom + this.h / 2];
    }

    toWorld(sx, sy) {
      return [(sx - this.w / 2) / this.cam.zoom + this.cam.x, -(sy - this.h / 2) / this.cam.zoom + this.cam.y];
    }

    zoomAt(sx, sy, factor) {
      const [wx, wy] = this.toWorld(sx, sy);
      this.cam.zoom = Math.min(4, Math.max(0.03, this.cam.zoom * factor));
      const [nx, ny] = this.toWorld(sx, sy);
      this.cam.x += wx - nx;
      this.cam.y += wy - ny;
      this.userMoved = true;
      if (this.redraw) this.redraw();
    }

    bindInput() {
      const c = this.canvas;
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      }, { passive: false });

      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y, moved: false };
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!drag.moved && this.onUserPan) this.onUserPan();
        drag.moved = true;
        this.userMoved = true;
        this.cam.x = drag.cx - dx / this.cam.zoom;
        this.cam.y = drag.cy + dy / this.cam.zoom;
        if (this.redraw) this.redraw();
      });
      c.addEventListener('pointerup', (e) => {
        if (drag && !drag.moved && this.last && this.onPick) {
          const r = c.getBoundingClientRect();
          const sx = e.clientX - r.left, sy = e.clientY - r.top;
          let best = null, bestD = 16;
          for (const p of this.last.players) {
            if (!p.present || p.dead) continue;
            const [px, py] = this.toScreen(p.x, p.y);
            const dd = Math.hypot(px - sx, py - sy);
            if (dd < bestD) { bestD = dd; best = p.slot; }
          }
          this.onPick(best);
        }
        drag = null;
      });
    }

    draw(t) {
      const m = this.match;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      if (!m) return;

      const snap = samplePlayers(m, t);
      this.last = snap;

      if (this.followSlot != null) {
        const fp = snap.players.find((p) => p.slot === this.followSlot);
        if (fp && fp.present && !fp.dead) {
          this.cam.x += (fp.x - this.cam.x) * 0.15;
          this.cam.y += (fp.y - this.cam.y) * 0.15;
        }
      }

      const z = this.cam.zoom;
      // map
      const bg = this.bg;
      const [bx, by] = this.toScreen(bg.x0, bg.y1);
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = 1;
      ctx.drawImage(bg.canvas, bx, by, bg.W * bg.cell * z, bg.H * bg.cell * z);

      const round = m.rounds.find((r) => t >= r.start && t < r.next) || null;
      const roundStart = round ? round.start : -Infinity;

      // smokes
      for (const s of m.smokes) {
        if (t < s.t || t > s.end + 2) continue;
        const fadeIn = Math.min(1, (t - s.t) / 1.2);
        const fadeOut = t > s.end ? 1 - (t - s.end) / 2 : 1;
        const a = 0.55 * fadeIn * fadeOut;
        const [sx, sy] = this.toScreen(s.x, s.y);
        const r = SMOKE_RADIUS * z * (0.6 + 0.4 * fadeIn);
        const grad = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r);
        grad.addColorStop(0, 'rgba(200,206,214,' + a + ')');
        grad.addColorStop(1, 'rgba(200,206,214,' + a * 0.35 + ')');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // explosions
      for (const ex of m.explosions) {
        const dt = t - ex.t;
        if (dt < 0 || dt > 0.8) continue;
        const [sx, sy] = this.toScreen(ex.x, ex.y);
        const r = Math.max(4, 200 * z * (dt / 0.8));
        ctx.strokeStyle = 'rgba(255,140,60,' + (1 - dt / 0.8) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,190,90,' + 0.35 * (1 - dt / 0.8) + ')';
        ctx.fill();
      }

      // this round's kill marks
      ctx.lineWidth = 2.5;
      for (const k of m.kills) {
        if (k.t < roundStart || k.t > t) continue;
        const pos = positionAt(m, k.victim, k.t);
        if (!pos) continue;
        const vp = m.playerBySlot(k.victim);
        const [sx, sy] = this.toScreen(pos.x, pos.y);
        ctx.strokeStyle = teamColor(vp ? vp.team.at(k.t - 0.05) : '');
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5);
        ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // grenades and bomb
      const items = m.itemsAt(snap.frame);
      if (items) {
        ctx.font = '600 9px ui-sans-serif, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let k = 0; k < items.length; k += m.itemStride) {
          const kind = m.itemKind(items[k]);
          const st = ITEM_STYLE[kind];
          if (!st) continue;
          const [sx, sy] = this.toScreen(items[k + 1], items[k + 2]);
          if (kind === 'c4') {
            const blink = (Math.floor(t * 2) % 2) === 0;
            ctx.fillStyle = blink ? st.color : '#8a1f1f';
            ctx.fillRect(sx - 6, sy - 6, 12, 12);
            ctx.fillStyle = '#fff';
            ctx.fillText('C4', sx, sy + 0.5);
          } else {
            ctx.fillStyle = st.color;
            ctx.beginPath();
            ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      // tiros recentes
      const recentShots = new Map();
      for (let k = upperBound(this.shotTimes, t) - 1; k >= 0; k--) {
        const s = m.shots[k];
        if (t - s.t > 0.09) break;
        recentShots.set(s.slot, s);
      }

      // players
      const list = snap.players.filter((p) => p.present && !p.dead && p.team !== 'SPEC');
      const labelBoxes = []; // names already drawn (to avoid overlap)
      list.sort((a, b) => (a.slot === this.followSlot) - (b.slot === this.followSlot));
      for (const p of list) {
        const [sx, sy] = this.toScreen(p.x, p.y);
        const col = teamColor(p.team);
        const yaw = (-p.yaw * Math.PI) / 180;

        // field of view
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.13;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.arc(sx, sy, 64, yaw - 0.78, yaw + 0.78);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        if (recentShots.has(p.slot)) {
          ctx.strokeStyle = COLORS.shot;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(yaw) * 10, sy + Math.sin(yaw) * 10);
          ctx.lineTo(sx + Math.cos(yaw) * 46, sy + Math.sin(yaw) * 46);
          ctx.stroke();
        }

        // facing
        ctx.strokeStyle = col;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(yaw) * 7, sy + Math.sin(yaw) * 7);
        ctx.lineTo(sx + Math.cos(yaw) * 15, sy + Math.sin(yaw) * 15);
        ctx.stroke();

        // corpo
        ctx.fillStyle = col;
        ctx.strokeStyle = '#0b0e13';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (p.slot === this.followSlot) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx, sy, 11, 0, Math.PI * 2);
          ctx.stroke();
        }

        if (p.bomb) {
          ctx.fillStyle = '#ff3b3b';
          ctx.strokeStyle = '#0b0e13';
          ctx.lineWidth = 1.5;
          ctx.fillRect(sx + 4, sy - 10, 7, 7);
          ctx.strokeRect(sx + 4, sy - 10, 7, 7);
        }

        // vida
        const hw = 18;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(sx - hw / 2, sy + 10, hw, 3);
        ctx.fillStyle = p.health > 50 ? '#5fd37a' : p.health > 20 ? '#f2c94c' : '#ff5a4f';
        ctx.fillRect(sx - hw / 2, sy + 10, (hw * Math.max(0, Math.min(100, p.health))) / 100, 3);

        if (this.showNames) {
          ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
          // players close together: draw the name only if it does not land on another
          const w = ctx.measureText(p.name).width + 4;
          const box = [sx - w / 2, sy - 24, sx + w / 2, sy - 11];
          const hit = labelBoxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
          if (hit && p.slot !== this.followSlot) continue;
          labelBoxes.push(box);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(8,10,14,0.85)';
          ctx.strokeText(p.name, sx, sy - 11);
          ctx.fillStyle = '#eef1f5';
          ctx.fillText(p.name, sx, sy - 11);
        }
      }
    }
  }

  NS.Radar = Radar;
  NS.samplePlayers = samplePlayers;
  NS.teamColor = teamColor;
  NS.upperBound = upperBound;
})(typeof window !== 'undefined' ? window : globalThis);

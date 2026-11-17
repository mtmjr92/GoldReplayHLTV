/*
 * CS 1.6 HUD graphics, cut from the original sprites.
 *  - sprites/hud.txt: digits, health cross, armor, stopwatch, kill icons (d_*)...
 *  - sprites/weapon_<name>.txt: ammo icon of each weapon
 * HUD sprites are additive and the game tints them with a color; here they
 * become transparent PNG images ready to use in HTML.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});

  const TINT_DEATH = [255, 80, 0]; // kill feed icons
  const TINT_HUD = [255, 160, 0]; // default HUD color
  const TINT_LOW = [255, 16, 16]; // low health

  /** Reads a file in hud.txt format; prefers the 640x480 entries. */
  function parseHudTxt(text) {
    const rows = {};
    for (const line of text.split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 7 || !/^\d+$/.test(p[1])) continue;
      const res = parseInt(p[1], 10);
      const row = { sprite: p[2], x: +p[3], y: +p[4], w: +p[5], h: +p[6], res };
      if (!rows[p[0]] || res === 640) rows[p[0]] = row;
    }
    return rows;
  }

  async function readText(files, path) {
    const buf = await files.read(path);
    return buf ? new TextDecoder('latin1').decode(buf) : null;
  }

  /** Cuts and tints icons. `rows`: name -> rectangle; returns name -> {url,w,h}. */
  async function cutIcons(THREE, files, rows, tint, sheets) {
    const icons = new Map();
    for (const [name, r] of Object.entries(rows)) {
      if (!sheets.has(r.sprite)) {
        const sbuf = await files.read('sprites/' + r.sprite + '.spr');
        let spr = null;
        try { spr = sbuf ? NS.parseSprite(THREE, sbuf) : null; } catch (e) { spr = null; }
        sheets.set(r.sprite, spr);
      }
      const spr = sheets.get(r.sprite);
      if (!spr || !spr.frames.length) continue;
      const f = spr.frames[0];
      const src = f.tex.image.data; // rows top to bottom
      const c = document.createElement('canvas');
      c.width = r.w;
      c.height = r.h;
      const g = c.getContext('2d');
      const img = g.createImageData(r.w, r.h);
      const additive = spr.texFormat === NS.SPR_TEX.ADDITIVE;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const sx = r.x + x, sy = r.y + y;
          if (sx >= f.w || sy >= f.h) continue;
          const s = (sy * f.w + sx) * 4, o = (y * r.w + x) * 4;
          if (additive) {
            // additive tinted with the HUD color -> color + alpha
            const R = (src[s] * tint[0]) / 255, G = (src[s + 1] * tint[1]) / 255, B = (src[s + 2] * tint[2]) / 255;
            const a = Math.max(R, G, B);
            if (a < 1) continue;
            img.data[o] = (R * 255) / a; img.data[o + 1] = (G * 255) / a; img.data[o + 2] = (B * 255) / a;
            img.data[o + 3] = a;
          } else {
            img.data[o] = src[s]; img.data[o + 1] = src[s + 1]; img.data[o + 2] = src[s + 2]; img.data[o + 3] = src[s + 3];
          }
        }
      }
      g.putImageData(img, 0, 0);
      icons.set(name, { url: c.toDataURL(), w: r.w, h: r.h });
    }
    return icons;
  }

  const HUD_NAMES = ['cross', 'suit_full', 'suit_empty', 'suithelmet_full', 'suithelmet_empty', 'stopwatch', 'dollar', 'c4', 'defuser', 'divider'];
  for (let i = 0; i < 10; i++) HUD_NAMES.push('number_' + i);

  /**
   * Loads everything: kill icons, HUD (normal and red) and per-weapon ammo.
   * `weapons`: names of the weapon_*.txt files (e.g. ['ak47', 'm4a1']).
   */
  async function loadHudIcons(THREE, files, weapons, hudTint) {
    const tint = hudTint || TINT_HUD;
    const text = await readText(files, 'sprites/hud.txt');
    if (!text) return null;
    const rows = parseHudTxt(text);
    const sheets = new Map();
    const pick = (names) => Object.fromEntries(names.filter((n) => rows[n]).map((n) => [n, rows[n]]));
    const death = await cutIcons(THREE, files, pick(Object.keys(rows).filter((n) => /^d_/.test(n))), TINT_DEATH, sheets);
    const hud = await cutIcons(THREE, files, pick(HUD_NAMES), tint, sheets);
    const low = await cutIcons(THREE, files, pick(['cross', ...HUD_NAMES.filter((n) => /^number_/.test(n))]), TINT_LOW, sheets);
    const ammoRows = {};
    for (const w of weapons || []) {
      const t = await readText(files, 'sprites/weapon_' + w + '.txt');
      const r = t && parseHudTxt(t).ammo;
      if (r) ammoRows[w] = r;
    }
    const ammo = await cutIcons(THREE, files, ammoRows, tint, sheets);
    return {
      death, hud, low, ammo,
      /** Re-tints the HUD graphics with another color (user option). */
      async retint(newTint) {
        this.hud = await cutIcons(THREE, files, pick(HUD_NAMES), newTint, sheets);
        this.ammo = await cutIcons(THREE, files, ammoRows, newTint, sheets);
      },
    };
  }

  NS.loadHudIcons = loadHudIcons;
  NS.HUD_TINT_DEFAULT = TINT_HUD;
})(typeof window !== 'undefined' ? window : globalThis);

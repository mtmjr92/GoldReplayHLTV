/*
 * Reads a whole demo (.dem, GoldSrc) and builds the match timeline:
 * every player's position per frame, health, team, alive/dead, kills,
 * rounds, score, shots, grenades and the bomb.
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});
  const { NetParser, cString } = NS;

  const HEADER_SIZE = 544;
  const DIR_ENTRY_SIZE = 92;

  /** A value that changes over time; `at(t)` returns the last value with time <= t. */
  class Track {
    constructor(initial) {
      this.initial = initial;
      this.t = [];
      this.v = [];
    }
    set(t, v) {
      const n = this.t.length;
      if (n && this.v[n - 1] === v) return;
      if (n && this.t[n - 1] === t) { this.v[n - 1] = v; return; }
      this.t.push(t);
      this.v.push(v);
    }
    at(t) {
      const ts = this.t;
      let lo = 0, hi = ts.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return idx < 0 ? this.initial : this.v[idx];
    }
  }

  function parseUserInfo(info) {
    const parts = info.split('\\');
    const out = {};
    for (let i = 1; i + 1 < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
  }

  const GRENADE_MODELS = {
    'models/w_hegrenade.mdl': 'he',
    'models/w_flashbang.mdl': 'flash',
    'models/w_smokegrenade.mdl': 'smoke',
    'models/w_c4.mdl': 'c4',
    'models/w_backpack.mdl': 'c4',
  };
  const ITEM_STRIDE = 9; // modelindex, x, y, z, pitch, yaw, roll, sequence, frame

  // Team from the player model (used when the demo has no TeamInfo).
  const MODEL_TEAM = {
    terror: 1, leet: 1, arctic: 1, guerilla: 1, militia: 1,
    urban: 2, gsg9: 2, sas: 2, gign: 2, spetsnaz: 2, vip: 2,
  };
  function teamCodeFromModel(name) {
    const m = /models\/player\/(\w+)\//.exec(name || '');
    return m ? MODEL_TEAM[m[1].toLowerCase()] || 0 : 0;
  }

  function weaponFromModel(name) {
    if (!name) return '';
    const m = /models\/p_(\w+)\.mdl/.exec(name);
    return m ? m[1] : '';
  }

  function teamFromInfo(team) {
    if (team === 'TERRORIST') return 'T';
    if (team === 'CT') return 'CT';
    if (team === 'SPECTATOR') return 'SPEC';
    return '';
  }

  const ANIM_STRIDE = 9; // seq, gait, frame, animtime, framerate, blend0, blend1, modelindex, pitch

  /** Accessors for the match object, defined outside buildMatch on purpose (see above). */
  function attachMatchMethods(m) {
    m.itemsAt = function (i) {
      const a = this.itemOffsets[i], b = this.itemOffsets[i + 1];
      return b > a ? this.itemData.subarray(a, b) : null;
    };
    m.itemKind = function (modelindex) { return GRENADE_MODELS[this.models[modelindex]] || ''; };
    const bySlot = new Map(m.players.map((p) => [p.slot, p]));
    m.playerBySlot = (n) => bySlot.get(n) || null;
    return m;
  }

  /** Adds accessors to a packed player record without capturing parse-time data. */
  function makePlayer(p, models) {
    const weaponNames = {};
    p.weaponName = function (i) {
      const idx = this.wpn[i];
      if (!(idx in weaponNames)) weaponNames[idx] = weaponFromModel(models[idx]);
      return weaponNames[idx];
    };
    /** Animation state at frame i as a 9-value view, or null when the player is absent. */
    p.animAt = function (i) {
      return i >= 0 && i < this.present.length && this.present[i] ? this.animData.subarray(i * ANIM_STRIDE, i * ANIM_STRIDE + ANIM_STRIDE) : null;
    };
    return p;
  }

  /**
   * Typed array that grows as frames are read, so per-frame data never lives in plain
   * JS arrays (those were most of the peak memory while loading a demo).
   */
  class GrowList {
    constructor(Type, initial) { this.Type = Type; this.a = new Type(initial || 4096); this.length = 0; }
    reserve(n) {
      if (n <= this.a.length) return;
      let c = this.a.length * 2;
      while (c < n) c *= 2;
      const b = new this.Type(c);
      b.set(this.a.subarray(0, this.length));
      this.a = b;
    }
    push(v) { if (this.length === this.a.length) this.reserve(this.length + 1); this.a[this.length++] = v; }
    /** Extends with zeros up to n values (new typed-array space is already zero). */
    padTo(n) { if (n > this.length) { this.reserve(n); this.length = n; } }
    toArray() { return this.a.slice(0, this.length); }
  }

  /** Cumulative distance travelled (used to sync the leg animation). */
  function cumulativeDistance(present, x, y, F) {
    const out = new Float32Array(F);
    let acc = 0;
    for (let i = 1; i < F; i++) {
      if (present[i] && present[i - 1]) {
        const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
        if (d < 100) acc += d;
      }
      out[i] = acc;
    }
    return out;
  }

  function buildMatch(buffer, onProgress) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    const size = buffer.byteLength;
    const err = (key, vars) => (NS.i18nError ? NS.i18nError(key, vars) : new Error(key));
    if (size < HEADER_SIZE) throw err('errTooSmall');
    const magic = cString(u8, 0, 8);
    if (magic !== 'HLDEMO') {
      throw err('errNotDemo', { magic });
    }
    const header = {
      demoProtocol: dv.getInt32(8, true),
      netProtocol: dv.getInt32(12, true),
      mapName: cString(u8, 16, 276),
      gameDir: cString(u8, 276, 536),
    };

    // ---- sections (directory) ----
    const sections = [];
    const dOff = dv.getInt32(540, true);
    if (dOff >= HEADER_SIZE && dOff + 4 <= size) {
      const count = dv.getInt32(dOff, true);
      if (count >= 1 && count <= 64 && dOff + 4 + count * DIR_ENTRY_SIZE <= size) {
        for (let k = 0; k < count; k++) {
          const e = dOff + 4 + k * DIR_ENTRY_SIZE;
          sections.push({ type: dv.getInt32(e, true), offset: dv.getInt32(e + 84, true) });
        }
      }
    }
    const warnings = [];
    let sequential = false;
    if (!sections.length || sections.some((s) => s.offset < HEADER_SIZE || s.offset >= size)) {
      sections.length = 0;
      sections.push({ type: 1, offset: HEADER_SIZE });
      sequential = true;
      warnings.push('Demo has no directory (interrupted recording?): read sequentially.');
    }

    // ---- estado acumulado ----
    const slots = []; // slot -> player data
    function slot(n) {
      if (!slots[n]) {
        slots[n] = {
          slot: n, name: '', userId: -1, isHltv: false,
          name_: new Track(''), team: new Track(''), health: new Track(100),
          dead: new Track(false), bomb: new Track(false),
          frags: new Track(0), deaths: new Track(0),
          x: new GrowList(Float32Array), y: new GrowList(Float32Array), z: new GrowList(Float32Array),
          yaw: new GrowList(Float32Array), wpn: new GrowList(Int16Array), mteam: new GrowList(Int8Array),
          present: new GrowList(Uint8Array), anim: new GrowList(Float32Array, 4096 * ANIM_STRIDE),
        };
      }
      return slots[n];
    }

    const frameTimes = [];
    const itemData = new GrowList(Float32Array, 1 << 16);
    const itemOffsets = new GrowList(Uint32Array);
    const kills = [];
    const shots = [];
    const explosions = [];
    const smokes = [];
    const smokePuffs = [];
    const sounds = [];
    const armorHits = []; // {t, slot, kind: 'kevlar'|'helmet'|'flesh'} from the hit sound
    // the recording player's own values, only present in first-person demos
    const pov = { armor: new Track(null), money: new Track(null), health: new Track(null), clip: new Track(null), weaponId: new Track(0), ammo: {}, weaponAmmoType: {}, weaponNames: {} };
    const radio = [];
    const tempSprites = [];
    const corpses = [];
    const chat = [];
    const roundRestarts = [];
    const roundTimes = [];
    const roundEnds = [];
    const bombEvents = [];
    const scoreT = new Track(0);
    const scoreCT = new Track(0);
    let serverInfo = null;
    let time = 0;
    let recording = false;
    let pendingEndReason = '';
    let lastGlobalHealth = -Infinity;

    const parser = new NetParser({
      onServerInfo(info) { if (!serverInfo) serverInfo = info; },
      onUserInfo(n, userId, info) {
        if (!info) return;
        const kv = parseUserInfo(info);
        const s = slot(n);
        s.userId = userId;
        s.isHltv = '*hltv' in kv;
        if (kv.name) { s.name = kv.name; s.name_.set(time, kv.name); }
      },
      onEvent(index, args) {
        if (!recording || !args) return;
        const name = parser.resources.events[index] || '';
        const ent = args.entindex || 0;
        if (name === 'events/createsmoke.sc') {
          const x = args['origin[0]'] || 0, y = args['origin[1]'] || 0, z = args['origin[2]'] || 0;
          // each event with bparam2 is one gas_puff_01 sprite "puff" (the client's EV_CreateSmoke)
          if (args.bparam2) {
            smokePuffs.push({ t: time, x, y, z, vx: args.fparam1 || 0, vy: args.fparam2 || 0, gray: args.iparam1 || 150 });
          }
          const last = smokes.find((s) => time - s.t < 20 && Math.hypot(s.x - x, s.y - y) < 220);
          if (last) last.end = Math.max(last.end, time + 2);
          else smokes.push({ t: time, end: time + 18, x, y, z });
          return;
        }
        if (ent >= 1 && ent <= parser.maxClients && name.startsWith('events/') && name !== 'events/decal_reset.sc') {
          shots.push({ t: time, slot: ent, weapon: name.slice(7, -3), b1: args.bparam1 || 0, b2: args.bparam2 || 0, i1: args.iparam1 || 0, i2: args.iparam2 || 0 });
        }
      },
      onExplosion(x, y, z) { if (recording) explosions.push({ t: time, x, y, z }); },
      onSound(snd) {
        if (!recording) return;
        // 16 = sentence (index into sentences.txt), 32 = stop sound
        if (snd.flags & (16 | 32)) return;
        const name = parser.resources.sounds[snd.index];
        if (!name) return;
        sounds.push({ t: time, name, x: snd.origin[0], y: snd.origin[1], z: snd.origin[2], vol: snd.volume, atten: snd.atten, ent: snd.entity, pitch: snd.pitch, channel: snd.channel });
        const hit = /player\/bhit_(kevlar|helmet|flesh)/.exec(name);
        if (hit && snd.entity >= 1 && snd.entity <= parser.maxClients) armorHits.push({ t: time, slot: snd.entity, kind: hit[1] });
      },
      onTempSprite(e) {
        if (!recording) return;
        e.t = time;
        e.model = parser.resources.models[e.sprite] || '';
        tempSprites.push(e);
      },
      onUserMessage(name, r) {
        switch (name) {
          case 'TeamInfo': { const n = r.byte(); slot(n).team.set(time, teamFromInfo(r.string())); break; }
          case 'ScoreAttrib': {
            const n = r.byte(); const f = r.byte();
            const s = slot(n);
            s.dead.set(time, (f & 1) !== 0);
            s.bomb.set(time, (f & 2) !== 0);
            break;
          }
          case 'ScoreInfo': {
            const n = r.byte(); const frags = r.short(); const deaths = r.short();
            slot(n).frags.set(time, frags); slot(n).deaths.set(time, deaths);
            break;
          }
          case 'HLTV': {
            const n = r.byte(); const h = r.byte();
            if (n === 0) {
              // 0 = all players; 0x80 marks the round restart (everyone at 100)
              lastGlobalHealth = time;
              if (h & 0x80) {
                roundRestarts.push(time);
                for (const s of slots) if (s) s.dead.set(time, false);
                for (const s of slots) if (s) s.health.set(time, h & 0x7f);
              }
            } else if (time - lastGlobalHealth > 1) {
              // right after the restart the server sends director camera flags, not health
              slot(n).health.set(time, h & 0x7f);
            }
            break;
          }
          case 'DeathMsg': {
            const killer = r.byte(); const victim = r.byte(); const headshot = r.byte();
            const weapon = r.string();
            kills.push({ t: time, killer, victim, headshot: !!headshot, weapon });
            slot(victim).dead.set(time, true);
            slot(victim).health.set(time, 0);
            break;
          }
          case 'TeamScore': {
            const team = r.string(); const score = r.short();
            if (team === 'TERRORIST') scoreT.set(time, score);
            else if (team === 'CT') scoreCT.set(time, score);
            break;
          }
          case 'RoundTime': roundTimes.push({ t: time, value: r.short() }); break;
          case 'SendAudio': {
            r.byte();
            const code = r.string();
            if (recording && code.startsWith('%!MRAD_')) radio.push({ t: time, code: code.slice(7).toLowerCase() });
            const m = /MRAD_(terwin|ctwin|rounddraw)/.exec(code);
            if (m) roundEnds.push({ t: time, winner: m[1] === 'terwin' ? 'T' : m[1] === 'ctwin' ? 'CT' : '', reason: pendingEndReason });
            if (/MRAD_BOMBPL/.test(code)) bombEvents.push({ t: time, type: 'planted' });
            if (/MRAD_BOMBDEF/.test(code)) bombEvents.push({ t: time, type: 'defused' });
            break;
          }
          case 'TextMsg': {
            r.byte();
            const msg = r.string();
            if (/^#(Target_Saved|Bomb_Defused|Target_Bombed|Terrorists_Win|CTs_Win|Round_Draw|Hostages_Not_Rescued|All_Hostages_Rescued|VIP_Escaped|VIP_Assassinated)/.test(msg)) {
              pendingEndReason = msg.slice(1);
            }
            if (msg === '#Bomb_Planted') bombEvents.push({ t: time, type: 'planted' });
            if (msg === '#Bomb_Defused') bombEvents.push({ t: time, type: 'defused' });
            break;
          }
          case 'SayText': {
            // byte remetente, string formato (#Cstrike_Chat_All), string nome, string texto
            const n = r.byte();
            const fmt = r.string();
            let text = fmt;
            if (fmt.startsWith('#') && r.remaining > 0) { r.string(); text = r.remaining > 0 ? r.string() : ''; }
            chat.push({ t: time, slot: n, text: text.trim() });
            break;
          }
          // --- messages the server only sends to the player itself (first-person demos) ---
          case 'Battery': pov.armor.set(time, r.short()); break;
          case 'Money': pov.money.set(time, r.long()); break;
          case 'Health': pov.health.set(time, r.byte()); break;
          case 'CurWeapon': {
            const st = r.byte(); const id = r.char(); const clip = r.char();
            if (st) { pov.weaponId.set(time, id); pov.clip.set(time, clip); }
            break;
          }
          case 'AmmoX': {
            const type = r.byte(); const n = r.byte();
            (pov.ammo[type] || (pov.ammo[type] = new Track(0))).set(time, n);
            break;
          }
          case 'WeaponList': {
            const wname = r.string(); const ammo1 = r.char(); r.byte(); r.char(); r.byte(); r.char(); r.char();
            const id = r.char();
            pov.weaponAmmoType[id] = ammo1;
            pov.weaponNames[id] = wname.replace(/^weapon_/, '');
            break;
          }
          case 'ClCorpse': {
            // body left on the ground (the CS client draws it until the next round)
            const model = r.string();
            const x = r.long() / 128, y = r.long() / 128, z = r.long() / 128;
            const ax = r.coord(), ay = r.coord(), az = r.coord();
            const animOffset = r.long() / 100;
            const seq = r.byte(); const body = r.byte(); const team = r.byte(); const slot = r.byte();
            if (recording) corpses.push({ t: time, model, x, y, z, yaw: ay, pitch: ax, roll: az, animtime: time + animOffset, seq, body, team, slot });
            break;
          }
          case 'BombDrop': {
            const x = r.coord(), y = r.coord(), z = r.coord(); const planted = r.byte();
            bombEvents.push({ t: time, type: planted ? 'planted-pos' : 'dropped', x, y, z });
            break;
          }
          default:
        }
      },
    });

    // ---- frame reading ----
    const maxPlayers = () => parser.maxClients;
    let lastProgress = 0;

    function recordSnapshot() {
      const ents = parser.entities;
      frameTimes.push(time);
      const fi = frameTimes.length - 1;
      const n = maxPlayers();
      for (let i = 1; i <= n; i++) {
        const s = slot(i);
        // fill earlier frames with zeros (players that appeared later)
        padSlot(s, fi);
        const e = ents.get(i);
        if (e && !s.isHltv && !(e.effects & 128)) {
          s.x.push(e['origin[0]'] || 0);
          s.y.push(e['origin[1]'] || 0);
          s.z.push(e['origin[2]'] || 0);
          s.yaw.push(e['angles[1]'] || 0);
          s.wpn.push(e.weaponmodel || 0);
          s.mteam.push(teamCodeFromModel(parser.resources.models[e.modelindex]));
          const an = s.anim;
          an.push(e.sequence || 0); an.push(e.gaitsequence || 0); an.push(e.frame || 0); an.push(e.animtime || 0);
          an.push(e.framerate == null ? 1 : e.framerate);
          an.push(e['blending[0]'] == null ? 127 : e['blending[0]']);
          an.push(e['blending[1]'] == null ? 127 : e['blending[1]']);
          an.push(e.modelindex || 0); an.push(e['angles[0]'] || 0);
          s.present.push(1);
        } else {
          padSlot(s, fi + 1);
        }
      }
      // entities with a studio model (grenades, C4, dropped weapons, hostages...)
      itemOffsets.push(itemData.length);
      const models = parser.resources.models;
      for (const [num, e] of ents) {
        if (num <= n) continue;
        const name = models[e.modelindex];
        if (!name || !name.endsWith('.mdl')) continue;
        if (e.effects & 128) continue;
        if (e.movetype === 12) continue; // MOVETYPE_FOLLOW: presa a outra entidade
        itemData.push(e.modelindex); itemData.push(e['origin[0]'] || 0); itemData.push(e['origin[1]'] || 0);
        itemData.push(e['origin[2]'] || 0); itemData.push(e['angles[0]'] || 0); itemData.push(e['angles[1]'] || 0);
        itemData.push(e['angles[2]'] || 0); itemData.push(e.sequence || 0); itemData.push(e.frame || 0);
      }
    }

    /** Grows every per-frame list of a slot to n frames (zeros = player absent). */
    function padSlot(s, n) {
      for (const k of ['x', 'y', 'z', 'yaw', 'wpn', 'mteam', 'present']) s[k].padTo(n);
      s.anim.padTo(n * ANIM_STRIDE);
    }

    function readSection(start, isPlayback) {
      let p = start;
      while (p + 9 <= size) {
        const type = u8[p];
        const t = dv.getFloat32(p + 1, true);
        p += 9;
        if (Number.isFinite(t)) time = t;
        switch (type) {
          case 2: break;
          case 3: p += 64; break;
          case 4: p += 32; break;
          case 5: return p;
          case 6: p += 84; break;
          case 7: p += 8; break;
          case 8: {
            if (p + 8 > size) return size;
            const len = dv.getInt32(p + 4, true);
            if (len < 0 || len > 1024) return size;
            p += 8 + len + 16;
            break;
          }
          case 9: {
            if (p + 4 > size) return size;
            const len = dv.getInt32(p, true);
            if (len < 0) return size;
            p += 4 + len;
            break;
          }
          default: {
            if (p + 468 > size) return size;
            const seq = dv.getInt32(p + 436, true);
            const len = dv.getInt32(p + 464, true);
            if (len < 0 || len > 131072 || p + 468 + len > size) return size;
            recording = isPlayback;
            const updated = parser.parse(u8, dv, p + 468, p + 468 + len, seq, time);
            if (updated && isPlayback) recordSnapshot();
            p += 468 + len;
          }
        }
        if (onProgress && p - lastProgress > 1 << 20) { lastProgress = p; onProgress(p / size); }
      }
      return p;
    }

    if (sequential) {
      let p = HEADER_SIZE;
      while (p < size) {
        const next = readSection(p, true);
        if (next <= p) break;
        p = next;
      }
    } else {
      for (const s of sections) readSection(s.offset, s.type !== 0);
    }

    if (frameTimes.length < 2) {
      throw err('errNoPositions');
    }

    // ---- build the player records ----
    const F = frameTimes.length;
    const players = [];
    for (const s of slots) {
      if (!s || s.isHltv) continue;
      padSlot(s, F);
      let seen = 0;
      for (let i = 0; i < F; i++) seen += s.present.a[i];
      if (!seen) continue;
      const present = s.present.toArray(), x = s.x.toArray(), y = s.y.toArray();
      players.push(makePlayer({
        slot: s.slot,
        name: s.name || 'Player ' + s.slot,
        nameTrack: s.name_, team: s.team, health: s.health, dead: s.dead, bomb: s.bomb,
        frags: s.frags, deaths: s.deaths,
        x, y, z: s.z.toArray(), yaw: s.yaw.toArray(), wpn: s.wpn.toArray(), mteam: s.mteam.toArray(),
        animData: s.anim.toArray(), dist: cumulativeDistance(present, x, y, F), present,
      }, parser.resources.models));
    }
    // release the temporary parse lists (they were the bulk of the memory)
    for (const s of slots) if (s) { s.x = s.y = s.z = s.yaw = s.wpn = s.mteam = s.present = s.anim = null; }

    // ---- objects on the ground: one Float32Array + per-frame offsets ----
    itemOffsets.push(itemData.length);

    // ---- map bounds ----
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const pl of players) {
      for (let i = 0; i < F; i++) {
        if (!pl.present[i]) continue;
        const x = pl.x[i], y = pl.y[i], z = pl.z[i];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
    }

    // ---- rodadas ----
    const startTime = frameTimes[0];
    const endTime = frameTimes[F - 1];
    const restarts = [];
    for (const t of roundRestarts) if (!restarts.length || t - restarts[restarts.length - 1] > 1) restarts.push(t);
    // restarts less than 5 s apart (repeated sv_restart) do not count as rounds
    for (let i = restarts.length - 2; i >= 0; i--) {
      if (restarts[i + 1] - restarts[i] < 5) restarts.splice(i, 1);
    }
    const rounds = [];
    for (let i = 0; i < restarts.length; i++) {
      const start = restarts[i];
      const next = i + 1 < restarts.length ? restarts[i + 1] : endTime + 1;
      const rt = roundTimes.filter((r) => r.t >= start - 0.5 && r.t < next);
      const freeze = rt[0] ? rt[0].value : 0;
      const live = rt.find((r) => r.t > start + 0.5);
      const end = roundEnds.find((e) => e.t > start && e.t < next);
      rounds.push({
        index: i + 1,
        start,
        freezeEnd: live ? live.t : start + freeze,
        roundTime: live ? live.value : 0,
        end: end ? end.t : null,
        winner: end ? end.winner : '',
        reason: end ? end.reason : '',
        next: Math.min(next, endTime),
        scoreT: end ? scoreT.at(end.t + 0.01) : null,
        scoreCT: end ? scoreCT.at(end.t + 0.01) : null,
      });
    }

    const st = parser.stats;
    if (st.aborted) warnings.push(st.aborted + ' network frames could not be fully read.');

    // Methods are attached outside this function (attachMatchMethods) so the result does
    // not keep this scope alive — it holds the whole demo buffer and the network parser.
    return attachMatchMethods({
      header,
      server: serverInfo,
      isHltv: !!parser.isHltv,
      warnings,
      frameTimes: Float64Array.from(frameTimes),
      /** Studio-model objects at frame i (ITEM_STRIDE floats each), or null. */
      itemOffsets: itemOffsets.toArray(),
      itemData: itemData.toArray(),
      itemStride: ITEM_STRIDE,
      smokePuffs,
      sounds,
      armorHits,
      pov: !parser.isHltv && serverInfo ? Object.assign(pov, { slot: serverInfo.playerNum + 1 }) : null,
      radio,
      tempSprites,
      corpses,
      roundRestarts: restarts,
      players,
      kills,
      shots,
      explosions,
      smokes,
      chat,
      bombEvents,
      rounds,
      scoreT,
      scoreCT,
      startTime,
      endTime,
      duration: endTime - startTime,
      bounds: { minX, minY, minZ, maxX, maxY, maxZ },
      maxClients: parser.maxClients,
      models: parser.resources.models,

    });
  }

  NS.Track = Track;
  NS.buildMatch = buildMatch;
})(typeof window !== 'undefined' ? window : globalThis);

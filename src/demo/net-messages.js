/*
 * Parser for GoldSrc server -> client messages (svc_*), protocols 47/48.
 *
 * Each network frame of the demo carries a buffer with several messages in a
 * row and no explicit sizes: every message must be understood to reach the
 * next one. If something unknown shows up, the rest of that frame is dropped
 * (the next frame starts aligned again, so damage stays local).
 */
(function (root) {
  'use strict';
  const NS = (root.CSDemo = root.CSDemo || {});
  const { ParseError, MsgReader, readDelta, buildDecoder, META_DECODER } = NS;

  const SVC = {
    BAD: 0, NOP: 1, DISCONNECT: 2, EVENT: 3, VERSION: 4, SETVIEW: 5, SOUND: 6, TIME: 7,
    PRINT: 8, STUFFTEXT: 9, SETANGLE: 10, SERVERINFO: 11, LIGHTSTYLE: 12, UPDATEUSERINFO: 13,
    DELTADESCRIPTION: 14, CLIENTDATA: 15, STOPSOUND: 16, PINGS: 17, PARTICLE: 18, DAMAGE: 19,
    SPAWNSTATIC: 20, EVENT_RELIABLE: 21, SPAWNBASELINE: 22, TEMPENTITY: 23, SETPAUSE: 24,
    SIGNONNUM: 25, CENTERPRINT: 26, KILLEDMONSTER: 27, FOUNDSECRET: 28, SPAWNSTATICSOUND: 29,
    INTERMISSION: 30, FINALE: 31, CDTRACK: 32, RESTORE: 33, CUTSCENE: 34, WEAPONANIM: 35,
    DECALNAME: 36, ROOMTYPE: 37, ADDANGLE: 38, NEWUSERMSG: 39, PACKETENTITIES: 40,
    DELTAPACKETENTITIES: 41, CHOKE: 42, RESOURCELIST: 43, NEWMOVEVARS: 44, RESOURCEREQUEST: 45,
    CUSTOMIZATION: 46, CROSSHAIRANGLE: 47, SOUNDFADE: 48, FILETXFERFAILED: 49, HLTV: 50,
    DIRECTOR: 51, VOICEINIT: 52, VOICEDATA: 53, SENDEXTRAINFO: 54, TIMESCALE: 55,
    RESOURCELOCATION: 56, SENDCVARVALUE: 57, SENDCVARVALUE2: 58,
  };

  // Fixed size (in bytes, after the type byte) of the simple temp entities.
  const TE_FIXED = {
    0: 24, 1: 20, 2: 6, 3: 11, 4: 6, 5: 10, 6: 12, 7: 17, 8: 16, 9: 6, 10: 6, 11: 6, 12: 8,
    14: 9, 15: 19, 17: 10, 18: 16, 19: 24, 20: 24, 21: 24, 22: 10, 23: 11, 24: 16, 25: 19,
    27: 12, 28: 16, 30: 17, 31: 17, 99: 2, 100: 10, 101: 14, 102: 12, 103: 14, 104: 9,
    105: 5, 106: 17, 107: 13, 108: 24, 109: 9, 110: 17, 111: 7, 112: 10, 113: 19, 114: 19,
    115: 12, 116: 7, 117: 7, 118: 9, 119: 16, 120: 18, 121: 5, 122: 10, 123: 13, 124: 7,
    125: 1, 126: 18, 127: 15,
  };
  const TE_EXPLOSION = 3;
  const TE_SMOKE = 5;
  const TE_SPRITE = 17;
  const TE_BSPDECAL = 13;
  const TE_TEXTMESSAGE = 29;

  const MAX_EDICTS_BITS = 11;

  class NetParser {
    constructor(handlers) {
      this.h = handlers || {};
      this.decoders = {}; // nome -> decodificador
      this.userMsgs = {}; // id -> { name, size }
      this.maxClients = 32;
      this.baselines = new Map(); // num -> estado
      this.instanced = []; // baselines instanciadas
      this.frames = new Map(); // sequence & 0xff -> Map(num -> estado)
      this.entities = new Map(); // estado corrente
      this.lastFrameEntities = new Map();
      this.resources = { models: [], sounds: [], events: [] };
      this.stats = { aborted: 0, unknown: {} };
    }

    decoder(name) {
      const d = this.decoders[name];
      if (!d) throw new ParseError('decoder "' + name + '" not received yet');
      return d;
    }

    entityDecoder(num, custom) {
      if (custom) return this.decoder('custom_entity_state_t');
      if (num >= 1 && num <= this.maxClients) return this.decoder('entity_state_player_t');
      return this.decoder('entity_state_t');
    }

    /** Reads every message of one frame. `seq` = the frame's incoming_sequence. */
    parse(u8, dv, start, end, seq, time) {
      this.seq = seq;
      this.time = time;
      NS.deltaTime = time;
      this.entitiesUpdated = false;
      const r = new MsgReader(u8, dv, start, end);
      let lastType = -1;
      try {
        while (r.remaining > 0) {
          const type = r.byte();
          lastType = type;
          if (type >= 64) this.userMessage(r, type);
          else this.message(r, type);
        }
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        this.stats.aborted++;
        const key = (lastType >= 64 ? 'user:' + lastType : 'svc:' + lastType) + ' ' + err.message;
        this.stats.unknown[key] = (this.stats.unknown[key] || 0) + 1;
      }
      return this.entitiesUpdated;
    }

    message(r, type) {
      const h = this.h;
      switch (type) {
        case SVC.NOP: case SVC.KILLEDMONSTER: case SVC.FOUNDSECRET: case SVC.INTERMISSION:
        case SVC.CHOKE: case SVC.DAMAGE:
          return;
        case SVC.DISCONNECT: case SVC.PRINT: case SVC.STUFFTEXT: case SVC.CENTERPRINT:
        case SVC.FINALE: case SVC.CUTSCENE: case SVC.FILETXFERFAILED: case SVC.RESOURCELOCATION:
        case SVC.SENDCVARVALUE: {
          const s = r.string();
          if (type === SVC.PRINT && h.onPrint) h.onPrint(s);
          return;
        }
        case SVC.VERSION: r.long(); return;
        case SVC.SETVIEW: r.short(); return;
        case SVC.TIME: r.float(); return;
        case SVC.SETANGLE: r.skip(6); return;
        case SVC.STOPSOUND: r.short(); return;
        case SVC.PARTICLE: r.skip(11); return;
        case SVC.SETPAUSE: r.byte(); return;
        case SVC.SIGNONNUM: r.byte(); return;
        case SVC.CDTRACK: r.skip(2); return;
        case SVC.WEAPONANIM: r.skip(2); return;
        case SVC.ROOMTYPE: r.short(); return;
        case SVC.ADDANGLE: r.short(); return;
        case SVC.CROSSHAIRANGLE: r.skip(2); return;
        case SVC.SOUNDFADE: r.skip(4); return;
        case SVC.TIMESCALE: r.float(); return;
        case SVC.RESOURCEREQUEST: r.skip(8); return;
        case SVC.SPAWNSTATICSOUND: r.skip(14); return;
        case SVC.LIGHTSTYLE: r.byte(); r.string(); return;
        case SVC.DECALNAME: r.byte(); r.string(); return;
        case SVC.SENDEXTRAINFO: r.string(); r.byte(); return;
        case SVC.VOICEINIT: r.string(); r.byte(); return;
        case SVC.VOICEDATA: { r.byte(); const n = r.ushort(); r.skip(n); return; }
        case SVC.DIRECTOR: { const n = r.byte(); r.skip(n); return; }
        case SVC.SENDCVARVALUE2: r.long(); r.string(); return;
        case SVC.RESTORE: { r.string(); const n = r.byte(); for (let i = 0; i < n; i++) r.string(); return; }
        case SVC.SERVERINFO: return this.serverInfo(r);
        case SVC.UPDATEUSERINFO: {
          const slot = r.byte();
          const userId = r.long();
          const info = r.string();
          r.skip(16);
          if (h.onUserInfo) h.onUserInfo(slot + 1, userId, info);
          return;
        }
        case SVC.DELTADESCRIPTION: return this.deltaDescription(r);
        case SVC.CLIENTDATA: return this.clientData(r);
        case SVC.PINGS: {
          const br = r.bits();
          while (br.readBit()) { br.readBits(5); br.readBits(12); br.readBits(7); }
          r.syncFrom(br);
          return;
        }
        case SVC.SPAWNSTATIC: {
          r.skip(7 + 9);
          const rendermode = r.byte();
          if (rendermode) r.skip(5);
          return;
        }
        case SVC.EVENT: return this.event(r);
        case SVC.EVENT_RELIABLE: return this.eventReliable(r);
        case SVC.SOUND: return this.sound(r);
        case SVC.SPAWNBASELINE: return this.spawnBaseline(r);
        case SVC.TEMPENTITY: return this.tempEntity(r);
        case SVC.NEWUSERMSG: {
          const id = r.byte();
          const size = r.byte();
          const name = NS.cString(r.u8, r.pos, r.pos + 16);
          r.skip(16);
          this.userMsgs[id] = { name, size: size === 255 ? -1 : size };
          return;
        }
        case SVC.PACKETENTITIES: return this.packetEntities(r, false);
        case SVC.DELTAPACKETENTITIES: return this.packetEntities(r, true);
        case SVC.RESOURCELIST: return this.resourceList(r);
        case SVC.NEWMOVEVARS: r.skip(64 + 4 + 32); r.string(); return;
        case SVC.CUSTOMIZATION: {
          r.byte(); r.byte(); r.string(); r.short(); r.long();
          const flags = r.byte();
          if (flags & 4) r.skip(16);
          return;
        }
        case SVC.HLTV: {
          this.isHltv = true;
          const mode = r.byte();
          if (mode === 1) r.skip(20);
          return;
        }
        default:
          throw new ParseError('mensagem desconhecida');
      }
    }

    serverInfo(r) {
      const info = {
        protocol: r.long(),
        spawnCount: r.long(),
        mapCrc: r.long(),
      };
      r.skip(16);
      info.maxClients = r.byte();
      info.playerNum = r.byte();
      r.byte();
      info.gameDir = r.string();
      info.hostName = r.string();
      info.mapFile = r.string();
      info.mapCycle = r.string();
      r.byte();
      if (info.maxClients > 0) this.maxClients = info.maxClients;
      if (this.h.onServerInfo) this.h.onServerInfo(info);
    }

    deltaDescription(r) {
      const name = r.string();
      const br = r.bits();
      const count = br.readBits(16);
      const entries = [];
      for (let i = 0; i < count; i++) entries.push(readDelta(br, META_DECODER, null));
      r.syncFrom(br);
      this.decoders[name] = buildDecoder(entries);
    }

    clientData(r) {
      // The server sends no clientdata body to HLTV proxies.
      if (this.isHltv) return;
      const br = r.bits();
      if (br.readBit()) br.readBits(8);
      readDelta(br, this.decoder('clientdata_t'), null);
      while (br.readBit()) {
        br.readBits(6);
        readDelta(br, this.decoder('weapon_data_t'), null);
      }
      r.syncFrom(br);
    }

    event(r) {
      const br = r.bits();
      const count = br.readBits(5);
      const dec = this.decoder('event_t');
      for (let i = 0; i < count; i++) {
        const index = br.readBits(10);
        let args = null;
        if (br.readBit()) {
          // index of the entity inside this frame's entity packet
          const packetIndex = br.readBits(11);
          if (br.readBit()) args = readDelta(br, dec, null);
          if (!args) args = {};
          if (!args.entindex) {
            if (!this.sortedEntityNums) this.sortedEntityNums = [...this.entities.keys()].sort((a, b) => a - b);
            args.entindex = this.sortedEntityNums[packetIndex] || 0;
          }
        }
        if (br.readBit()) br.readBits(16); // delay
        if (this.h.onEvent) this.h.onEvent(index, args);
      }
      r.syncFrom(br);
    }

    eventReliable(r) {
      const br = r.bits();
      const index = br.readBits(10);
      const args = readDelta(br, this.decoder('event_t'), null);
      if (br.readBit()) br.readBits(16);
      r.syncFrom(br);
      if (this.h.onEvent) this.h.onEvent(index, args);
    }

    sound(r) {
      const br = r.bits();
      const flags = br.readBits(9);
      const volume = flags & 1 ? br.readBits(8) : 255;
      const atten = flags & 2 ? br.readBits(8) / 64 : 1;
      const channel = br.readBits(3);
      const entity = br.readBits(11);
      const index = flags & 4 ? br.readBits(16) : br.readBits(8);
      const origin = br.readBitVec3Coord();
      const pitch = flags & 8 ? br.readBits(8) : 100;
      r.syncFrom(br);
      if (this.h.onSound) this.h.onSound({ index, entity, origin, flags, volume: volume / 255, atten, channel, pitch });
    }

    spawnBaseline(r) {
      const br = r.bits();
      for (;;) {
        const num = br.readBits(MAX_EDICTS_BITS);
        if (num === (1 << MAX_EDICTS_BITS) - 1) break;
        const type = br.readBits(2);
        const custom = (type & 2) !== 0;
        this.baselines.set(num, readDelta(br, this.entityDecoder(num, custom), null));
      }
      const footer = br.readBits(5);
      if (footer !== 31) throw new ParseError('invalid spawnbaseline');
      const extra = br.readBits(6);
      this.instanced = [];
      for (let i = 0; i < extra; i++) this.instanced.push(readDelta(br, this.decoder('entity_state_t'), null));
      r.syncFrom(br);
    }

    packetEntities(r, isDelta) {
      r.short(); // number of entities (informational)
      let oldEntities = null;
      if (isDelta) {
        const deltaSeq = r.byte();
        oldEntities = this.frames.get(deltaSeq) || this.lastFrameEntities;
      }
      const br = r.bits();
      const result = new Map();
      const list = []; // arrival order (for the baseline "offset")
      const touched = new Set();
      let numbase = 0;
      for (;;) {
        if (br.peekBits(16) === 0) { br.readBits(16); break; }
        let num;
        let remove = false;
        if (!isDelta) {
          if (br.readBit()) num = numbase + 1;
          else num = br.readBit() ? br.readBits(11) : numbase + br.readBits(6);
        } else {
          remove = br.readBit() === 1;
          num = br.readBit() ? br.readBits(11) : numbase + br.readBits(6);
        }
        numbase = num;
        touched.add(num);
        if (remove) continue;

        const custom = br.readBit() === 1;
        let base = null;
        let newbl = false;
        if (this.instanced.length > 0) {
          newbl = br.readBit() === 1;
          if (newbl) base = this.instanced[br.readBits(6)];
        }
        if (!isDelta && !newbl && br.readBit()) {
          const offset = br.readBits(6);
          base = list[list.length - offset];
        }
        let inPlace = false;
        if (!base) {
          const prev = oldEntities && oldEntities.get(num);
          // previous frame's own state can be updated in place (no copy); baselines must not
          if (prev) { base = prev; inPlace = isDelta && oldEntities === this.lastFrameEntities; }
          else base = this.baselines.get(num) || null;
        }
        const state = readDelta(br, this.entityDecoder(num, custom), base, inPlace);
        state.custom = custom;
        result.set(num, state);
        list.push(state);
      }
      r.syncFrom(br);

      if (isDelta && oldEntities) {
        for (const [num, st] of oldEntities) if (!touched.has(num)) result.set(num, st);
      }
      this.entities = result;
      this.sortedEntityNums = null;
      this.lastFrameEntities = result;
      this.frames.set(this.seq & 0xff, result);
      this.entitiesUpdated = true;
    }

    resourceList(r) {
      const br = r.bits();
      const count = br.readBits(12);
      for (let i = 0; i < count; i++) {
        const type = br.readBits(4);
        const name = br.readString();
        const index = br.readBits(12);
        br.readBits(24); // tamanho
        const flags = br.readBits(3);
        if (flags & 4) for (let k = 0; k < 16; k++) br.readBits(8);
        if (br.readBit()) for (let k = 0; k < 32; k++) br.readBits(8);
        if (type === 2) this.resources.models[index] = name;
        else if (type === 0) this.resources.sounds[index] = name;
        else if (type === 5) this.resources.events[index] = name;
      }
      if (br.readBit()) {
        while (br.readBit()) {
          if (br.readBit()) br.readBits(5);
          else br.readBits(10);
        }
      }
      r.syncFrom(br);
    }

    tempEntity(r) {
      const type = r.byte();
      if (type === TE_EXPLOSION) {
        const x = r.coord(), y = r.coord(), z = r.coord();
        const sprite = r.short(), scale = r.byte(), framerate = r.byte(), flags = r.byte();
        if (this.h.onExplosion) this.h.onExplosion(x, y, z);
        if (this.h.onTempSprite) this.h.onTempSprite({ kind: 'explosion', x, y, z, sprite, scale: scale / 10, fps: framerate, flags });
        return;
      }
      if (type === TE_SMOKE) {
        const x = r.coord(), y = r.coord(), z = r.coord();
        const sprite = r.short(), scale = r.byte(), framerate = r.byte();
        if (this.h.onTempSprite) this.h.onTempSprite({ kind: 'smoke', x, y, z, sprite, scale: scale / 10, fps: framerate, flags: 0 });
        return;
      }
      if (type === TE_SPRITE) {
        const x = r.coord(), y = r.coord(), z = r.coord();
        const sprite = r.short(), scale = r.byte(), brightness = r.byte();
        if (this.h.onTempSprite) this.h.onTempSprite({ kind: 'sprite', x, y, z, sprite, scale: scale / 10, fps: 10, flags: 0, brightness });
        return;
      }
      if (type === TE_BSPDECAL) {
        r.skip(8);
        const ent = r.short();
        if (ent) r.short();
        return;
      }
      if (type === TE_TEXTMESSAGE) {
        r.skip(5);
        const effect = r.byte();
        r.skip(14);
        if (effect === 2) r.short();
        r.string();
        return;
      }
      const size = TE_FIXED[type];
      if (size === undefined) throw new ParseError('temp entity desconhecido ' + type);
      r.skip(size);
    }

    userMessage(r, type) {
      const def = this.userMsgs[type];
      if (!def) throw new ParseError('unregistered user message');
      const size = def.size === -1 ? r.byte() : def.size;
      const start = r.pos;
      r.need(size);
      if (this.h.onUserMessage) {
        const sub = new MsgReader(r.u8, r.dv, start, start + size);
        try {
          this.h.onUserMessage(def.name, sub);
        } catch (err) {
          if (!(err instanceof ParseError)) throw err;
        }
      }
      r.pos = start + size;
    }
  }

  NS.SVC = SVC;
  NS.NetParser = NetParser;
})(typeof window !== 'undefined' ? window : globalThis);

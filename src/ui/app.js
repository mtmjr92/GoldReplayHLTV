/*
 * Application: loads the demo, drives playback (play/pause/speed/seek) and
 * updates the HUD, scoreboard, kill list and timeline.
 */
(function () {
  'use strict';
  const NS = window.CSDemo;
  const $ = (id) => document.getElementById(id);

  const WEAPON_LABELS = {
    ak47: 'AK-47', m4a1: 'M4A1', awp: 'AWP', deagle: 'Deagle', usp: 'USP', glock18: 'Glock',
    knife: '', hegrenade: 'HE', grenade: 'HE', flashbang: 'Flash', smokegrenade: 'Smoke',
    c4: 'C4', famas: 'FAMAS', galil: 'Galil', mp5navy: 'MP5', mp5: 'MP5', p90: 'P90',
    scout: 'Scout', sg552: 'SG552', aug: 'AUG', sg550: 'SG550', g3sg1: 'G3SG1', m249: 'M249',
    m3: 'M3', xm1014: 'XM1014', tmp: 'TMP', mac10: 'MAC-10', ump45: 'UMP45',
    fiveseven: 'Five-SeveN', p228: 'P228', elite: 'Elites', world: '',
  };
  const tr = NS.tr;
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];

  const state = {
    match: null,
    t: 0,
    playing: false,
    speed: 1,
    lastTs: 0,
    selected: null,
    follow: false,
    fileName: '',
    uiTick: 0,
  };

  const radar = new NS.Radar($('radar'));
  radar.redraw = () => { if (!state.playing && state.view === '2d') radar.draw(state.t); };
  radar.onPick = (slot) => select(slot);
  radar.onUserPan = () => setFollow(false);

  const view3d = new NS.View3D($('radarWrap'));
  const gameFiles = new NS.GameFiles();
  const audio = new NS.DemoAudio();
  view3d.onVmSound = (name) => audio.play(name, null, 1, 0, 100);
  // browsers only allow sound after a click/key press
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => audio.unlock(), { capture: true });

  function connectAudio() {
    if (state.match && gameFiles.size) audio.setSource(gameFiles, state.match);
    if (state.match && state.match !== state.iconsMatch) { hudIcons = null; deathIcons = null; state.iconsMatch = state.match; }
    loadIcons();
  }

  function positionOf(slot, t) {
    const p = state.match.playerBySlot(slot);
    if (!p) return null;
    let i = NS.upperBound(state.match.frameTimes, t) - 1;
    for (let k = 0; k < 6 && i >= 0; k++, i--) if (p.present[i]) return { x: p.x[i], y: p.y[i], z: p.z[i] };
    return null;
  }

  function updateListener() {
    if (state.view === '3d' && state.game3dReady) { audio.listener = view3d.listenerPose(); return; }
    const sel = state.selected != null ? positionOf(state.selected, state.t) : null;
    if (sel) audio.listener = { x: sel.x, y: sel.y, z: sel.z, yaw: 90 };
    else audio.listener = { x: radar.cam.x, y: radar.cam.y, z: 0, yaw: 90 };
  }
  state.view = '2d';
  state.game3dReady = false;

  // ---------- utilidades ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt(sec) {
    sec = Math.max(0, sec);
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function weaponLabel(w) {
    if (!w) return '';
    if (w === 'knife') return tr('wKnife');
    if (w === 'world') return tr('wWorld');
    return WEAPON_LABELS[w] || w.toUpperCase();
  }

  /** Team tag = common name prefix (e.g. "mibr | x", "mibr | y" -> "mibr"). */
  function clanTag(names) {
    if (names.length < 2) return '';
    let prefix = names[0];
    for (const n of names) {
      let i = 0;
      while (i < prefix.length && i < n.length && prefix[i].toLowerCase() === n[i].toLowerCase()) i++;
      prefix = prefix.slice(0, i);
    }
    prefix = prefix.replace(/[\s|.\-_:/\\[\]()]+$/, '').trim();
    return prefix.length >= 2 ? prefix : '';
  }

  function currentRound(t) {
    const rs = state.match.rounds;
    for (let i = rs.length - 1; i >= 0; i--) if (t >= rs[i].start) return rs[i];
    return null;
  }

  // ---------- carregamento ----------
  function showLoading(text) {
    $('loading').hidden = false;
    $('loadingText').textContent = text;
  }

  function loadBuffer(buffer, name) {
    pause();
    $('dropzone').hidden = true;
    showLoading(tr('reading', { name }));
    // let the browser paint "loading" before the heavy work
    requestAnimationFrame(() => setTimeout(() => {
      try {
        const t0 = performance.now();
        const match = NS.buildMatch(buffer);
        console.info('[demo] lida em', Math.round(performance.now() - t0), 'ms', match);
        setMatch(match, name);
      } catch (err) {
        console.error(err);
        $('loading').hidden = true;
        if (!state.match) $('dropzone').hidden = false;
        alertBox(err.i18n ? NS.trMsg(err.i18n) : err.message || String(err));
      }
    }, 30));
  }

  function alertBox(msg) {
    $('matchInfo').innerHTML = '<span style="color:var(--bad)">' + esc(tr('error', { msg })) + '</span>';
  }

  function loadFile(file) {
    if (!file) return;
    showLoading(tr('opening', { name: file.name }));
    $('dropzone').hidden = true;
    file.arrayBuffer().then((buf) => loadBuffer(buf, file.name), (err) => alertBox(err.message));
  }

  /** Start of the first round with full teams (skips warmup and restarts). */
  function firstRealRound(match) {
    const visible = (t) => NS.samplePlayers(match, t).players
      .filter((p) => p.present && !p.dead && p.team !== 'SPEC').length;
    let best = null;
    for (const r of match.rounds) {
      const n = visible(r.freezeEnd + 3);
      if (!best || n > best.n) best = { r, n };
      if (n >= 8) return r.start;
    }
    return best ? best.r.start : match.startTime;
  }

  function setMatch(match, name) {
    $('app').classList.remove('no-demo');
    $('radarLegend').hidden = state.view !== '2d';
    state.match = match;
    state.fileName = name;
    state.selected = null;
    state.follow = false;
    radar.setMatch(match);
    state.t = firstRealRound(match);
    $('loading').hidden = true;
    $('hud').hidden = false;
    $('radarTools').hidden = false;
    for (const id of ['btnPrevRound', 'btnBack', 'btnPlay', 'btnFwd', 'btnNextRound', 'btnStop', 'speed']) $(id).disabled = false;

    const h = match.header;
    const server = match.server ? match.server.hostName : '';
    $('matchInfo').innerHTML =
      '<b>' + esc(h.mapName) + '</b> · ' + esc(name) +
      (server ? ' · ' + esc(server) : '') +
      ' · ' + (match.isHltv ? 'HLTV' : 'POV') +
      ' · ' + fmt(match.duration) + ' · ' + tr('nRounds', { n: match.rounds.length });
    if (match.warnings.length) console.warn('[demo]', match.warnings.join(' | '));

    state.progressKey = null;
    buildTimeline();
    buildRoundList();
    buildStats();
    setFollow(false);
    view3d.selected = null;
    if (state.view === '3d') ensureSelected();
    if (gameFiles.hasGame()) load3d();
    connectAudio();
    renderAll(true);
  }

  // ---------- 3D view ----------
  function aliveSlots() {
    if (!state.match) return [];
    return NS.samplePlayers(state.match, state.t).players
      .filter((p) => p.present && !p.dead && (p.team === 'T' || p.team === 'CT'))
      .map((p) => p.slot);
  }

  function isAlive(slot) { return slot != null && aliveSlots().includes(slot); }

  function ensureSelected() {
    const alive = aliveSlots();
    if (state.selected == null || !alive.includes(state.selected)) {
      if (alive.length) select(alive[0]);
    }
  }

  function cyclePlayer(dir) {
    const alive = aliveSlots();
    if (!alive.length) return;
    const i = alive.indexOf(state.selected);
    select(alive[(i + dir + alive.length) % alive.length]);
  }

  function setView(v) {
    state.view = v;
    $('btnView2d').setAttribute('aria-pressed', String(v === '2d'));
    $('btnView3d').setAttribute('aria-pressed', String(v === '3d'));
    view3d.active = v === '3d';
    $('radar').hidden = v === '3d';
    document.querySelector('.cam3d').hidden = v !== '3d';
    document.querySelector('.radar2d-tools').hidden = v === '3d';
    $('radarLegend').hidden = v !== '2d';
    $('gamePrompt').hidden = !(v === '3d' && !state.game3dReady);
    updateDiag();
    if (v === '3d' && !state.game3dReady && !gameFiles.hasGame()) {
      gameStatus(tr(location.protocol === 'file:' ? 'fileProtocol' : 'noManifest'), true);
    }
    if (v === '3d' && view3d.mode !== 'free') ensureSelected();
    renderAll(true);
  }

  function setCam(mode) {
    if (mode === 'free' && view3d.mode !== 'free') view3d.syncFreeFromCamera();
    view3d.mode = mode;
    for (const b of document.querySelectorAll('[data-cam]')) b.setAttribute('aria-pressed', String(b.dataset.cam === mode));
    if (mode !== 'free') ensureSelected();
    renderAll(true);
  }

  function gameStatus(text, isErr) {
    const el = $('gameStatus');
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }

  async function load3d() {
    if (!state.match || !gameFiles.hasGame()) return;
    const match = state.match;
    state.game3dReady = false;
    if (state.view === '3d') $('gamePrompt').hidden = false;
    try {
      await view3d.load(gameFiles, match, (s) => gameStatus(s));
      if (match !== state.match) return;
      state.game3dReady = true;
      $('gamePrompt').hidden = true;
      updateDiag();
      renderAll(true);
    } catch (err) {
      console.error(err);
      gameStatus(err.i18n ? NS.trMsg(err.i18n) : err.message || String(err), true);
      $('gamePrompt').hidden = state.view !== '3d';
    }
  }

  /** Like the CS spectator: watched player died -> 2 s later switch to a living teammate. */
  function spectatorRules(alive) {
    if (view3d.mode === 'free') { state.deadSince = null; return; }
    if (alive) { state.deadSince = null; return; }
    if (state.deadSince == null || state.t < state.deadSince) state.deadSince = state.t;
    if (state.playing && state.t - state.deadSince < 2 && state.selected != null) return;
    const snap = NS.samplePlayers(state.match, state.t).players;
    const me = snap.find((p) => p.slot === state.selected);
    const living = snap.filter((p) => p.present && !p.dead && (p.team === 'T' || p.team === 'CT'));
    if (!living.length) return;
    const mate = living.find((p) => me && p.team === me.team) || living[0];
    const from = me ? me.name : '';
    select(mate.slot);
    state.deadSince = null;
    toast((from ? tr('died', { name: from }) + ' ' : '') + tr('watching', { name: mate.name }));
  }

  let toastTimer = 0;
  function toast(text, force) {
    const el = $('toast');
    el.classList.toggle('force', !!force); // force: shown even with the clean screen
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
  }

  /** 3D view diagnostics panel (missing-file warnings etc.). */
  function updateDiag() {
    const box = $('diag');
    const list = view3d.issues.slice();
    if (audio.missing.size) list.push({ level: 'warn', msg: { key: 'missingSounds', vars: { n: audio.missing.size, list: [...audio.missing].slice(0, 5).join(', ') + (audio.missing.size > 5 ? '…' : '') } } });
    const src = gameFiles.source ? tr('gameFilesFrom', { src: gameFiles.source === 'assets/' ? 'assets/' : tr('chosenFolder') }) : '';
    $('diagSummary').textContent = list.length ? (list.length > 1 ? tr('nWarnings', { n: list.length }) : tr('oneWarning')) : tr('allLoaded');
    $('diagSummary').classList.toggle('warn', list.length > 0);
    $('diagList').innerHTML = (src ? '<li class="src">' + esc(src) + '</li>' : '') +
      list.map((i) => '<li class="' + i.level + '">' + esc(NS.trMsg(i.msg || i.text)) + '</li>').join('');
    // no warnings: show "all loaded" for 4 s and hide; with warnings, stay visible
    const can = state.view === '3d' && state.game3dReady;
    clearTimeout(state.diagTimer);
    if (!can) { box.hidden = true; return; }
    // problem warnings stay in the corner until read; "all loaded" shows centered and fades
    if (list.length) { box.hidden = false; return; }
    box.hidden = true;
    if (state.diagShownFor === state.match) return;
    state.diagShownFor = state.match;
    toast(tr('allLoaded'));
  }

  // ---------- playback ----------
  function play() {
    if (!state.match) return;
    if (state.t >= state.match.endTime) state.t = state.match.startTime;
    state.playing = true;
    $('btnPlay').classList.add('playing');
  }

  function pause() {
    state.playing = false;
    $('btnPlay').classList.remove('playing');
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function seek(t) {
    const m = state.match;
    if (!m) return;
    state.t = Math.min(m.endTime, Math.max(m.startTime, t));
    renderAll(true);
  }

  function setSpeed(v) {
    state.speed = v;
    $('speed').value = String(v);
  }

  function stepSpeed(dir) {
    const i = SPEEDS.indexOf(state.speed);
    const n = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 2 : i) + dir));
    setSpeed(SPEEDS[n]);
  }

  function stepFrame(dir) {
    const ft = state.match.frameTimes;
    let i = NS.upperBound(ft, state.t) - 1;
    i = Math.min(ft.length - 1, Math.max(0, i + dir));
    pause();
    seek(ft[i]);
  }

  function jumpRound(dir) {
    const rs = state.match.rounds;
    if (!rs.length) return;
    const cur = currentRound(state.t);
    let idx = cur ? rs.indexOf(cur) : -1;
    if (dir < 0 && cur && state.t - cur.start > 3) idx += 1; // back to the start of the current round
    idx = Math.min(rs.length - 1, Math.max(0, idx + dir));
    seek(rs[idx].start);
  }

  // single loop: advances time while playing and redraws
  function loop(ts) {
    const dt = state.lastTs ? Math.min(0.25, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;
    state.dt = dt;
    if (state.match) {
      if (state.playing) {
        state.t += dt * state.speed;
        if (state.t >= state.match.endTime) {
          state.t = state.match.endTime;
          pause();
        }
      }
      // 3D always redraws (free camera moves even when paused)
      try {
        if (state.playing || state.view === '3d') renderAll(false);
      } catch (err) {
        if (!state.loopErrorShown) { console.error('[player] error drawing frame', err); state.loopErrorShown = true; }
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // ---------- selection ----------
  function select(slot) {
    state.selected = slot;
    view3d.selected = slot;
    radar.followSlot = state.follow ? slot : null;
    if (slot == null) setFollow(false);
    renderAll(true);
  }

  function setFollow(on) {
    state.follow = on && state.selected != null;
    radar.followSlot = state.follow ? state.selected : null;
    $('btnFollow').setAttribute('aria-pressed', String(state.follow));
    if (!state.playing && state.match) radar.draw(state.t);
  }

  // ---------- rendering ----------
  function renderAll(force) {
    const m = state.match;
    if (!m) return;
    radar.followSlot = state.follow ? state.selected : null;
    view3d.playing = state.playing;
    if (state.view === '3d') view3d.draw(state.t, state.dt || 0);
    else radar.draw(state.t);
    updateListener();
    audio.tick(state.t, state.playing, state.speed, positionOf);
    const alive = state.view === '3d' ? isAlive(state.selected) : false;
    $('crosshair').hidden = !(showsGameHud('crosshair') && state.view === '3d' && state.game3dReady && view3d.mode === 'first' && alive);
    updatePlayerHud(alive);
    updateSpecBar(alive);
    if (state.view === '3d' && state.game3dReady) spectatorRules(alive);
    updateTimelineHead();
    const now = performance.now();
    if (force || now - state.uiTick > 120) {
      state.uiTick = now;
      updatePanels();
    }
  }

  let lastScoreHtml = '';
  let lastFeedKey = '';
  let lastHudKey = '';
  let deathIcons = null;
  let hudIcons = null;

  // p_ model -> name of sprites/weapon_<name>.txt
  const WEAPON_TXT = { mp5: 'mp5navy' };

  /** Original HUD graphics (sprites/hud.txt, weapon_*.txt, 640hud*.spr). */
  async function loadIcons() {
    if (hudIcons || !gameFiles.size || !state.match || state.iconsLoading) return;
    state.iconsLoading = true;
    try {
      const weapons = new Set();
      for (const name of state.match.models) {
        const mm = /models\/p_(\w+)\.mdl/.exec(name || '');
        if (mm) weapons.add(WEAPON_TXT[mm[1]] || mm[1]);
      }
      const tintAtStart = state.opts.hudColor;
      hudIcons = await NS.loadHudIcons(THREE, gameFiles, [...weapons], hexToRgb(tintAtStart));
      if (hudIcons) {
        hudIcons.tintApplied = tintAtStart;
        // the color may have changed while the graphics loaded
        if (state.opts.hudColor !== tintAtStart) await retintHud();
      }
      deathIcons = hudIcons ? hudIcons.death : null;
    } catch (e) {
      console.warn('HUD icons', e);
    }
    state.iconsLoading = false;
    buildRoundList();
    updatePanels();
  }

  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

  // ---------- who is on camera (like the CS:GO spectator bar) ----------
  function updateSpecBar(alive) {
    const el = $('specBar');
    const show = state.opts.specbar && !state.opts.clean && state.view === '3d' && state.game3dReady && view3d.mode !== 'free' && state.selected != null;
    el.hidden = !show;
    if (!show) return;
    const p = NS.samplePlayers(state.match, state.t).players.find((q) => q.slot === state.selected);
    if (!p) { el.hidden = true; return; }
    const team = p.team === 'T' ? 't' : p.team === 'CT' ? 'ct' : '';
    const html = '<span class="sb-label">' + esc(tr('watchingLabel')) + '</span>' +
      '<span class="sb-name ' + team + '">' + esc(p.name) + '</span>' +
      (alive ? '<span class="sb-info">' + weaponIcon(p.weapon) + hpBadge(p.health) + '</span>' : '<span class="sb-info">' + esc(tr('dead')) + '</span>') +
      '<span class="sb-kd">' + p.frags + ' / ' + p.deaths + '</span>' +
      '<span class="sb-keys">Tab ⇄</span>';
    if (html !== state.lastSpecHtml) { state.lastSpecHtml = html; el.innerHTML = html; }
  }

  // ---------- player HUD (first person) ----------
  function hudImg(ic, cls) {
    return ic ? '<img class="' + (cls || 'hi') + '" src="' + ic.url + '" width="' + ic.w + '" height="' + ic.h + '" alt="">' : '';
  }
  function hudNum(n, set) {
    return String(Math.max(0, Math.round(n))).split('').map((d) => hudImg(set.get('number_' + d), 'hd')).join('');
  }

  /** Builds the HUD with the game graphics. Only values the demo actually records are shown. */
  function updatePlayerHud(alive) {
    const el = $('playerHud');
    const show = showsGameHud('hud') && state.view === '3d' && state.game3dReady && view3d.mode === 'first' && alive && hudIcons;
    el.hidden = !show;
    if (!show) return;
    const m = state.match, t = state.t, slot = state.selected;
    const H = hudIcons.hud, L = hudIcons.low;
    const p = NS.samplePlayers(m, t).players.find((q) => q.slot === slot);
    if (!p) { el.hidden = true; return; }
    const pov = m.pov && m.pov.slot === slot ? m.pov : null;
    const round = currentRound(t);

    // health (real: HLTV message, or Health in first-person demos)
    const hp = pov && pov.health.at(t) != null ? pov.health.at(t) : p.health;
    const low = hp <= 25;
    let html = '<div class="ph-left"><span class="ph-item">' + hudImg((low ? L : H).get('cross')) + hudNum(hp, low ? L : H) + '</span>';

    // armor: real only in first-person demos; on HLTV, indicated by hit sounds
    if (pov && pov.armor.at(t) != null) {
      const ar = pov.armor.at(t);
      html += '<span class="ph-item">' + hudImg(H.get(ar > 0 ? 'suit_full' : 'suit_empty')) + hudNum(ar, H) + '</span>';
    } else {
      let kind = null;
      const start = round ? round.start : -Infinity;
      for (const h of m.armorHits) {
        if (h.t > t) break;
        if (h.slot === slot && h.t >= start && h.kind !== 'flesh') kind = kind === 'helmet' ? 'helmet' : h.kind;
      }
      // only what the demo records: the armor/helmet hit sound of this player
      if (kind) {
        const icon = kind === 'helmet' ? 'suithelmet_full' : 'suit_full';
        html += '<span class="ph-item" title="' + esc(tr('armorSeen')) + '">' + hudImg(H.get(icon)) + '</span>';
      }
    }
    html += '</div>';

    // round timer
    const clock = $('hudClock').textContent;
    if (/^\d+:\d\d$/.test(clock)) {
      const [mm, ss] = clock.split(':');
      html += '<div class="ph-center"><span class="ph-item">' + hudImg(H.get('stopwatch')) + hudNum(+mm, H) + '<span class="hcolon"></span>' + hudNum(+ss[0], H) + hudNum(+ss[1], H) + '</span></div>';
    }

    // money (first-person demos only), C4, ammo
    html += '<div class="ph-right">';
    if (pov && pov.money.at(t) != null) html += '<span class="ph-item">' + hudImg(H.get('dollar')) + hudNum(pov.money.at(t), H) + '</span>';
    if (p.bomb) html += '<span class="ph-item">' + hudImg(H.get('c4')) + '</span>';
    const wkey = WEAPON_TXT[p.weapon] || p.weapon;
    // ammo: only in first-person demos (HLTV does not receive it)
    let clip = null, reserve = null;
    if (pov && pov.clip.at(t) != null) {
      clip = pov.clip.at(t);
      const type = pov.weaponAmmoType[pov.weaponId.at(t)];
      if (type != null && pov.ammo[type]) reserve = pov.ammo[type].at(t);
    }
    if (clip != null && clip >= 0) {
      html += '<span class="ph-item">' + hudNum(clip, H) +
        (reserve != null ? hudImg(H.get('divider'), 'hdiv') + hudNum(reserve, H) : '') + hudImg(hudIcons.ammo.get(wkey)) + '</span>';
    }
    html += '</div>';
    if (html !== state.lastHudHtml) { state.lastHudHtml = html; el.innerHTML = html; }
  }

  function updatePanels() {
    const m = state.match;
    const t = state.t;
    const snap = NS.samplePlayers(m, t);
    const round = currentRound(t);

    // times
    const teams = { T: [], CT: [] };
    for (const p of snap.players) if (teams[p.team]) teams[p.team].push(p);
    const tagT = clanTag(teams.T.map((p) => p.name)) || tr('teamT');
    const tagCT = clanTag(teams.CT.map((p) => p.name)) || tr('teamCT');
    const sT = m.scoreT.at(t), sCT = m.scoreCT.at(t);

    $('hudTName').textContent = tagT;
    $('hudCTName').textContent = tagCT;
    $('hudTScore').textContent = sT;
    $('hudCTScore').textContent = sCT;

    // round clock
    const clock = $('hudClock');
    const sub = $('hudSub');
    clock.className = 'hud-clock';
    sub.className = 'hud-sub';
    let subText = '';
    if (round) {
      const planted = m.bombEvents.filter((b) => b.type === 'planted' && b.t >= round.start && b.t <= t).pop();
      const defused = m.bombEvents.find((b) => b.type === 'defused' && b.t >= round.start && b.t <= t);
      if (round.end != null && t >= round.end) {
        clock.textContent = fmt(Math.max(0, round.roundTime - (round.end - round.freezeEnd)));
        const who = round.winner === 'T' ? tagT : round.winner === 'CT' ? tagCT : '';
        const reason = round.reason ? tr('reasons.' + round.reason) : '';
        subText = (who ? tr('wonRound', { team: who }) : tr('roundOver')) + (reason && reason !== 'reasons.' + round.reason ? ' (' + reason + ')' : '');
        state.roundWon = true;
        if (round.winner) sub.classList.add(round.winner === 'T' ? 'win-t' : 'win-ct');
      } else if (t < round.freezeEnd) {
        clock.textContent = fmt(round.freezeEnd - t);
        clock.classList.add('freeze');
        subText = tr('freeze');
      } else if (planted && !defused) {
        clock.textContent = fmt(t - planted.t);
        clock.classList.add('bomb');
        subText = tr('bombPlantedAgo', { time: fmt(t - planted.t) });
      } else {
        clock.textContent = fmt(round.roundTime - (t - round.freezeEnd));
      }
      if (defused && !(round.end != null && t >= round.end)) subText = tr('bombDefused');
    } else {
      clock.textContent = '–:––';
      subText = tr('warmup');
    }
    sub.textContent = subText;

    $('roundLabel').textContent = round ? tr('roundOf', { i: round.index, n: m.rounds.length }) : tr('beforeFirst');
    $('timeLabel').textContent = fmt(t - m.startTime) + ' / ' + fmt(m.duration);

    // placar lateral
    const block = (list, side, tag, score) => {
      list.sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
      let html = '<div class="team-head"><span class="team-name">' + esc(tag) +
        '<span class="team-side">' + tr(side === 'T' ? 'sideT' : 'sideCT') + '</span></span><span class="team-score">' + score + '</span></div>';
      if (!list.length) html += '<div class="empty-team">' + esc(tr('noPlayers')) + '</div>';
      for (const p of list) {
        const alive = !p.dead && p.present;
        const hp = alive ? p.health : 0;
        const cls = hp > 50 ? '' : hp > 20 ? 'mid' : 'low';
        html += '<div class="prow' + (alive ? '' : ' dead') + (p.slot === state.selected ? ' sel' : '') + '" data-slot="' + p.slot + '">' +
          '<div class="pname">' + esc(p.name) + (p.bomb && alive ? bombIcon() : '') +
          '<span class="pwpn">' + (alive ? weaponIcon(p.weapon) : esc(tr('dead'))) + '</span></div>' +
          '<div class="hpnum">' + (alive ? hpDigits(hp) : '') + '</div>' +
          '<div class="kd">' + p.frags + '/' + p.deaths + '</div></div>';
      }
      return html;
    };
    const scoreHtml = block(teams.T, 'T', tagT, sT) + '\u0000' + block(teams.CT, 'CT', tagCT, sCT);
    if (scoreHtml !== lastScoreHtml) {
      lastScoreHtml = scoreHtml;
      const [a, b] = scoreHtml.split('\u0000');
      $('teamT').innerHTML = a;
      $('teamCT').innerHTML = b;
    }

    let killsDone = 0;
    for (const k of m.kills) { if (k.t <= t) killsDone++; else break; }
    const roundsDone = m.rounds.filter((r) => r.end != null && r.end <= t).length;
    const started = m.rounds.filter((r) => r.start <= t).length;
    const progressKey = killsDone + '|' + roundsDone + '|' + started;
    if (progressKey !== state.progressKey) {
      state.progressKey = progressKey;
      buildTimeline();
      buildRoundList();
      buildStats();
    }
    markCurrentRound(false);

    // missing sounds show up later (audio loads in the background)
    if (audio.missing.size !== state.lastMissing) { state.lastMissing = audio.missing.size; updateDiag(); }

    // round kills (side) and in-game kill feed (over the image)
    const start = round ? round.start : -Infinity;
    const kills = m.kills.filter((k) => k.t >= start && k.t <= t);
    const feedKey = start + ':' + kills.length + ':' + (deathIcons ? 1 : 0);
    if (feedKey !== lastFeedKey) {
      lastFeedKey = feedKey;
      $('killFeed').innerHTML = kills.length
        ? kills.slice().reverse().map((k) => '<li data-t="' + k.t + '">' + killRow(k) +
          '<span class="ft">' + (round ? fmt(k.t - round.freezeEnd) : fmt(k.t - m.startTime)) + '</span></li>').join('')
        : '<li class="empty">' + esc(tr('noKills')) + '</li>';
    }
    // like CS hud_deathnotice: last 6 s, at most 5 rows
    const recent = m.kills.filter((k) => k.t <= t && t - k.t < 6).slice(-5);
    const hudKey = recent.map((k) => k.t).join(',') + ':' + (deathIcons ? 1 : 0);
    if (hudKey !== lastHudKey) {
      lastHudKey = hudKey;
      $('killHud').innerHTML = recent.map((k) => '<div class="kh-row">' + killRow(k) + '</div>').join('');
    }
  }

  // p_ model name -> kill icon (d_*) from hud.txt
  const WEAPON_ICON = { mp5: 'mp5navy', hegrenade: 'grenade' };

  /** Small weapon icon (original game icon); falls back to the name. */
  function weaponIcon(w) {
    const ic = w === 'c4' ? hudIcons && hudIcons.hud.get('c4') : deathIcons && w && deathIcons.get('d_' + (WEAPON_ICON[w] || w));
    if (!ic) return '<span class="wname">' + esc(weaponLabel(w)) + '</span>';
    return '<img class="wicon" src="' + ic.url + '" width="' + ic.w + '" height="' + ic.h + '" alt="' + esc(weaponLabel(w)) + '" title="' + esc(weaponLabel(w)) + '">';
  }

  /** Health with the CS HUD cross (red when low, like the game). */
  function hpBadge(hp) {
    const set = hudIcons ? (hp <= 25 ? hudIcons.low : hudIcons.hud) : null;
    const ic = set && set.get('cross');
    return '<span class="php' + (hp <= 25 ? ' low' : '') + '">' + (ic ? '<img class="hpicon" src="' + ic.url + '" alt="HP" title="HP">' : '') + hp + (ic ? '' : ' HP') + '</span>';
  }

  /** Health with the game HUD digits (red when low). */
  function hpDigits(hp) {
    const set = hudIcons ? (hp <= 25 ? hudIcons.low : hudIcons.hud) : null;
    if (!set) return '<span class="hptext' + (hp <= 25 ? ' low' : '') + '">' + hp + '</span>';
    return String(hp).split('').map((d) => {
      const ic = set.get('number_' + d);
      return ic ? '<img class="hdig" src="' + ic.url + '" alt="' + d + '">' : d;
    }).join('');
  }

  /** HUD C4 icon for the bomb carrier. */
  function bombIcon() {
    const ic = hudIcons && hudIcons.hud.get('c4');
    if (!ic) return '<span class="bomb">C4</span>';
    return '<img class="bicon" src="' + ic.url + '" alt="C4" title="C4">';
  }

  /** One kill row: killer, weapon icon, headshot icon, victim. */
  function killRow(k) {
    const m = state.match;
    const kp = m.playerBySlot(k.killer);
    const vp = m.playerBySlot(k.victim);
    const kt = kp ? kp.team.at(k.t - 0.05) : '';
    const vt = vp ? vp.team.at(k.t - 0.05) : '';
    const self = k.killer === k.victim || !kp;
    const key = k.weapon === 'world' || (self && !k.weapon) ? 'd_skull' : 'd_' + k.weapon;
    const icon = deathIcons && (deathIcons.get(key) || (self ? deathIcons.get('d_skull') : null));
    const hs = deathIcons && k.headshot ? deathIcons.get('d_headshot') : null;
    const img = (ic, alt) => '<img class="kicon" src="' + ic.url + '" width="' + ic.w + '" height="' + ic.h + '" alt="' + esc(alt) + '">';
    return (self ? '' : '<span class="k ' + kt.toLowerCase() + '">' + esc(kp.name) + '</span>') +
      (icon ? img(icon, weaponLabel(k.weapon)) : '<span class="w">' + esc(weaponLabel(k.weapon)) + '</span>') +
      (k.headshot ? (hs ? img(hs, 'HS') : '<span class="hs">HS</span>') : '') +
      '<span class="k ' + vt.toLowerCase() + '">' + esc(vp ? vp.name : '#' + k.victim) + '</span>';
  }

  // ---------- timeline ----------
  function buildTimeline() {
    const m = state.match;
    const span = m.duration || 1;
    const pct = (t) => ((t - m.startTime) / span) * 100;
    const t = state.t;
    // no spoilers: only paint finished rounds and mark kills that already happened
    $('tlTrack').innerHTML = m.rounds.map((r) => {
      const done = r.end != null && r.end <= t;
      return '<div class="tl-seg win-' + (done ? r.winner || 'none' : 'none') + '" style="left:' + pct(r.start) + '%;width:' + Math.max(0.1, pct(r.next) - pct(r.start)) + '%"></div>';
    }).join('');
    $('tlTicks').innerHTML = m.kills.filter((k) => k.t <= t).map((k) => '<div class="tl-tick" style="left:' + pct(k.t) + '%"></div>').join('');
    // round number under the bar (only where it fits)
    $('tlLabels').innerHTML = m.rounds.map((r) => {
      const w = pct(r.next) - pct(r.start);
      if (w < 2.2) return '';
      return '<span class="tl-lab' + (r.start <= t ? '' : ' future') + '" style="left:' + (pct(r.start) + w / 2) + '%">' + r.index + '</span>';
    }).join('');
  }

  function updateTimelineHead() {
    const m = state.match;
    const p = ((state.t - m.startTime) / (m.duration || 1)) * 100;
    $('tlHead').style.left = p + '%';
    $('tlProgress').style.width = p + '%';
  }

  function timelineTime(e) {
    const r = $('timeline').getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return state.match.startTime + f * state.match.duration;
  }

  (function bindTimeline() {
    const tl = $('timeline');
    let dragging = false;
    tl.addEventListener('pointerdown', (e) => {
      if (!state.match) return;
      dragging = true;
      tl.setPointerCapture(e.pointerId);
      seek(timelineTime(e));
    });
    tl.addEventListener('pointermove', (e) => {
      if (!state.match) return;
      const t = timelineTime(e);
      if (dragging) seek(t);
      const tip = $('tlTip');
      const r = tl.getBoundingClientRect();
      const round = currentRound(t);
      tip.hidden = false;
      tip.style.left = (e.clientX - r.left) + 'px';
      tip.textContent = fmt(t - state.match.startTime) + (round ? ' · ' + tr('roundN', { i: round.index }) : '');
    });
    tl.addEventListener('pointerup', () => { dragging = false; });
    tl.addEventListener('pointerleave', () => { $('tlTip').hidden = true; });
  })();

  // ---------- UI events ----------
  $('fileInput').addEventListener('change', (e) => loadFile(e.target.files[0]));
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnBack').addEventListener('click', () => seek(state.t - 5));
  $('btnFwd').addEventListener('click', () => seek(state.t + 5));
  $('btnPrevRound').addEventListener('click', () => jumpRound(-1));
  $('btnNextRound').addEventListener('click', () => jumpRound(1));
  $('btnStop').addEventListener('click', () => { pause(); seek(state.match.startTime); });
  $('speed').addEventListener('change', (e) => setSpeed(parseFloat(e.target.value)));
  $('btnSound').addEventListener('click', () => {
    audio.unlock();
    audio.setMuted(!audio.muted);
    $('btnSound').setAttribute('aria-pressed', String(!audio.muted));
    $('btnSound').classList.toggle('muted', audio.muted);
  });
  $('volume').addEventListener('input', (e) => { audio.unlock(); audio.setVolume(parseFloat(e.target.value)); });
  $('btnFit').addEventListener('click', () => { setFollow(false); radar.userMoved = false; radar.fit(); radar.draw(state.t); });
  $('btnFollow').addEventListener('click', () => setFollow(!state.follow));
  // ---------- view options menu ----------
  const OPT_DEFAULTS = { xrayPlayers: false, xrayWeapons: false, xrayBomb: false, xrayGrenades: false, tracers: false, names: true, hud: true, killfeed: true, crosshair: true, specbar: true, scoreboard: true, viewmodel: true, cleanKeepHud: false, hudColor: '#ffa000', crosshairColor: '#50ff50', clean: false };
  state.opts = Object.assign({}, OPT_DEFAULTS);
  try { Object.assign(state.opts, JSON.parse(localStorage.getItem('csdemo.opts') || '{}')); } catch (e) { /* no localStorage */ }

  function applyOpts() {
    const o = state.opts;
    // Clean screen = only the game image: turns off extras without erasing saved choices
    for (const k of ['xrayPlayers', 'xrayWeapons', 'xrayBomb', 'xrayGrenades', 'tracers']) view3d.opts[k] = !!o[k] && !o.clean;
    $('optsMenu').classList.toggle('clean-active', !!o.clean);
    // HUD/Clean modes have their own config: checkboxes apply only to Normal
    const keep = !!o.clean && !!o.cleanKeepHud;
    for (const cb of document.querySelectorAll('[data-opt]')) cb.disabled = !!o.clean;
    for (const sel of document.querySelectorAll('[data-color]')) sel.disabled = !!o.clean && !keep;
    radar.showNames = view3d.showNames = !!o.names && !o.clean;
    view3d.showViewModel = showsGameHud('viewmodel');
    $('app').classList.toggle('clean', !!o.clean);
    $('app').classList.toggle('clean-all', !!o.clean && !o.cleanKeepHud);
    const mode = !o.clean ? 'off' : o.cleanKeepHud ? 'hud' : 'all';
    for (const b of document.querySelectorAll('[data-clean]')) {
      b.setAttribute('aria-checked', String(b.dataset.clean === mode));
      b.setAttribute('aria-pressed', String(b.dataset.clean === mode));
    }
    $('killHud').hidden = !showsGameHud('killfeed');
    $('app').classList.toggle('no-scoreboard', !o.scoreboard);
    for (const cb of document.querySelectorAll('[data-opt]')) cb.checked = !!o[cb.dataset.opt];
    // colors: crosshair via CSS; HUD by re-tinting the sprites
    document.documentElement.style.setProperty('--xhair', o.crosshairColor);
    document.documentElement.style.setProperty('--hud', o.hudColor); // timer ":"
    for (const sel of document.querySelectorAll('[data-color]')) {
      const key = sel.dataset.color === 'hud' ? 'hudColor' : 'crosshairColor';
      const has = [...sel.options].some((op) => op.value === o[key]);
      sel.value = has ? o[key] : 'custom';
      const pick = document.querySelector('[data-color-pick="' + sel.dataset.color + '"]');
      pick.hidden = has;
      pick.value = o[key];
    }
    if (hudIcons && hudIcons.tintApplied !== o.hudColor) retintHud();
    try { localStorage.setItem('csdemo.opts', JSON.stringify(o)); } catch (e) { /* ignora */ }
    if (!state.playing && state.match) renderAll(true);
  }
  function setOpt(k, v) { state.opts[k] = v; applyOpts(); }
  for (const cb of document.querySelectorAll('[data-opt]')) cb.addEventListener('change', () => setOpt(cb.dataset.opt, cb.checked));
  for (const sel of document.querySelectorAll('[data-color]')) {
    const key = sel.dataset.color === 'hud' ? 'hudColor' : 'crosshairColor';
    const pick = document.querySelector('[data-color-pick="' + sel.dataset.color + '"]');
    sel.addEventListener('change', () => {
      if (sel.value === 'custom') { pick.hidden = false; pick.click(); return; }
      setOpt(key, sel.value);
    });
    pick.addEventListener('input', () => setOpt(key, pick.value));
  }
  async function retintHud() {
    const want = state.opts.hudColor;
    hudIcons.tintApplied = want;
    await hudIcons.retint(hexToRgb(want));
    state.lastHudHtml = '';
  }
  function toggleOptsMenu(force) {
    const menu = $('optsMenu');
    const open = force != null ? force : menu.hidden;
    menu.hidden = !open;
    $('btnOpts').setAttribute('aria-expanded', String(open));
  }
  $('btnOpts').addEventListener('click', (e) => { e.stopPropagation(); toggleOptsMenu(); });
  $('optsMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => toggleOptsMenu(false));
  applyOpts();
  $('btnView2d').addEventListener('click', () => setView('2d'));
  $('btnView3d').addEventListener('click', () => setView('3d'));
  for (const b of document.querySelectorAll('[data-cam]')) b.addEventListener('click', () => setCam(b.dataset.cam));
  setCam('first');
  $('gameDirInput').addEventListener('change', (e) => {
    gameFiles.add(e.target.files);
    if (!gameFiles.hasGame()) {
      gameStatus(tr('noCstrike'), true);
      return;
    }
    connectAudio();
    if (!state.match) { gameStatus(tr('folderReady')); return; }
    load3d();
  });

  // ---------- side panel tabs ----------
  function setTab(tab) {
    state.tab = tab;
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
    if (tab === 'rounds') markCurrentRound(true);
  }
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));

  /** Round history: winner, reason, score and every kill. */
  function buildRoundList() {
    const m = state.match;
    if (!m) return;
    const now = state.t;
    const html = m.rounds.filter((r) => r.start <= now).map((r) => {
      const ended = r.end != null && r.end <= now;
      const at = r.end != null ? r.end : r.next;
      const names = { T: [], CT: [] };
      for (const p of m.players) { const tm = p.team.at(at - 0.1); if (names[tm]) names[tm].push(p.name); }
      const winner = ended ? r.winner : '';
      const winName = winner ? clanTag(names[winner]) || tr(winner === 'T' ? 'teamT' : 'teamCT') : '';
      const reason = ended && r.reason ? tr('reasons.' + r.reason) : '';
      const kills = m.kills.filter((k) => k.t >= r.start && k.t < r.next && k.t <= now);
      const score = ended && r.scoreT != null ? '<span class="rl-score"><b class="t">' + r.scoreT + '</b>–<b class="ct">' + r.scoreCT + '</b></span>' : '';
      const reasonText = reason && reason !== 'reasons.' + r.reason ? reason : '';
      return '<li class="rl-round" data-round="' + r.index + '" data-t="' + r.start + '">' +
        '<div class="rl-head win-' + (winner || 'none') + '" title="' + esc(reasonText) + '">' +
          '<span class="rl-num">' + r.index + '</span>' +
          '<span class="rl-win ' + (winner === 'T' ? 't' : winner === 'CT' ? 'ct' : '') + '">' + esc(winName || (ended ? '—' : tr('inProgress'))) + '</span>' +
          reasonIcon(ended ? r.reason : '', reasonText) +
          '<span class="rl-count" title="' + esc(tr('stKills')) + '">' + kills.length + '</span>' + score +
        '</div>' +
        '<ol class="rl-kills">' + (kills.length ? kills.map((k) => '<li data-t="' + k.t + '">' + killRow(k) + '<span class="ft">' + fmt(k.t - r.freezeEnd) + '</span></li>').join('') : '<li class="empty">' + esc(tr('noKillsRound')) + '</li>') + '</ol>' +
      '</li>';
    }).join('');
    const pinned = new Set([...document.querySelectorAll('#roundList .rl-round.pinned')].map((li) => li.dataset.round));
    $('roundList').innerHTML = html;
    for (const li of document.querySelectorAll('#roundList .rl-round')) if (pinned.has(li.dataset.round)) li.classList.add('open', 'pinned');
    state.markedRound = null;
    markCurrentRound(false);
  }

  /** Round-end reason icon, using the game HUD graphics. */
  function reasonIcon(reason, text) {
    const H = hudIcons && hudIcons.hud, D = deathIcons;
    let ic = null;
    if (reason === 'Target_Bombed') ic = H && H.get('c4');
    else if (reason === 'Bomb_Defused') ic = H && H.get('defuser');
    else if (reason === 'Target_Saved' || reason === 'Hostages_Not_Rescued') ic = H && H.get('stopwatch');
    else if (reason) ic = D && D.get('d_skull');
    return ic ? '<img class="rl-icon" src="' + ic.url + '" alt="' + esc(text) + '">' : '<span class="rl-icon"></span>';
  }

  function markCurrentRound(scroll) {
    if (!state.match) return;
    const r = currentRound(state.t);
    const idx = r ? r.index : null;
    if (idx === state.markedRound && !scroll) return;
    state.markedRound = idx;
    for (const li of document.querySelectorAll('#roundList .rl-round')) {
      const cur = Number(li.dataset.round) === idx;
      li.classList.toggle('current', cur);
      // only the current round is expanded (others expand on click)
      if (cur) li.classList.add('open');
      else if (!li.classList.contains('pinned')) li.classList.remove('open');
      if (cur && scroll && state.tab === 'rounds') li.scrollIntoView({ block: 'nearest' });
    }
  }

  /** Per-player stats from the demo's kills. */
  function buildStats() {
    const m = state.match;
    if (!m) return;
    const st = new Map();
    for (const p of m.players) st.set(p.slot, { p, k: 0, d: 0, hs: 0, entry: 0, m3: 0, m4: 0, m5: 0 });
    const now = state.t;
    for (const r of m.rounds) {
      if (r.start > now) break;
      const kills = m.kills.filter((k) => k.t >= r.start && k.t < r.next && k.t <= now);
      const per = new Map();
      let first = true;
      for (const k of kills) {
        const v = st.get(k.victim);
        if (v) v.d++;
        if (k.killer === k.victim || !st.has(k.killer)) continue;
        const kp = m.playerBySlot(k.killer), vp = m.playerBySlot(k.victim);
        const teamKill = kp && vp && kp.team.at(k.t - 0.05) === vp.team.at(k.t - 0.05);
        const s = st.get(k.killer);
        if (teamKill) { s.k--; continue; }
        s.k++;
        if (k.headshot) s.hs++;
        if (first) { s.entry++; first = false; }
        per.set(k.killer, (per.get(k.killer) || 0) + 1);
      }
      for (const [slot, n] of per) { const s = st.get(slot); if (n === 3) s.m3++; else if (n === 4) s.m4++; else if (n >= 5) s.m5++; }
    }
    const rows = [...st.values()].sort((a, b) => b.k - a.k || a.d - b.d);
    const last = Math.min(now, m.endTime - 1);
    $('statsTable').innerHTML = '<table class="stats"><thead><tr>' +
      '<th>' + esc(tr('stPlayer')) + '</th><th title="' + esc(tr('stKills')) + '">K</th><th title="' + esc(tr('stDeaths')) + '">D</th><th>+/-</th>' +
      '<th>' + esc(tr('stHs')) + '</th><th title="' + esc(tr('stEntry')) + '">1º</th><th title="' + esc(tr('stMulti')) + '">3K/4K/5K</th></tr></thead><tbody>' +
      rows.map((s) => {
        const team = s.p.team.at(last);
        const diff = s.k - s.d;
        return '<tr data-slot="' + s.p.slot + '"><td class="sname ' + (team === 'T' ? 't' : team === 'CT' ? 'ct' : '') + '">' + esc(s.p.name) + '</td>' +
          '<td>' + s.k + '</td><td>' + s.d + '</td><td class="' + (diff > 0 ? 'pos' : diff < 0 ? 'neg' : '') + '">' + (diff > 0 ? '+' : '') + diff + '</td>' +
          '<td>' + (s.k > 0 ? Math.round((s.hs / s.k) * 100) + '%' : '–') + '</td><td>' + s.entry + '</td>' +
          '<td>' + s.m3 + '/' + s.m4 + '/' + s.m5 + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  $('roundList').addEventListener('click', (e) => {
    e.stopPropagation();
    const kill = e.target.closest('.rl-kills li[data-t]');
    if (kill) { seek(Number(kill.dataset.t) - 3); return; }
    const li = e.target.closest('.rl-round');
    if (!li) return;
    if (li.classList.contains('current')) { li.classList.toggle('open'); return; }
    // click toggles that round's kills in place; double click seeks to it
    li.classList.toggle('open');
    li.classList.toggle('pinned', li.classList.contains('open'));
  });
  $('roundList').addEventListener('dblclick', (e) => {
    const li = e.target.closest('.rl-round');
    if (li) seek(Number(li.dataset.t));
  });
  $('statsTable').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-slot]');
    if (row) { select(Number(row.dataset.slot)); setTab('score'); }
  });

  $('sidebar').addEventListener('click', (e) => {
    const row = e.target.closest('.prow');
    if (row) {
      const slot = Number(row.dataset.slot);
      select(state.selected === slot ? null : slot);
      return;
    }
    const kill = e.target.closest('li[data-t]');
    if (kill) seek(Number(kill.dataset.t) - 3);
  });

  document.addEventListener('keydown', (e) => {
    if (!state.match) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); e.shiftKey ? stepFrame(-1) : seek(state.t - 5); break;
      case 'ArrowRight': e.preventDefault(); e.shiftKey ? stepFrame(1) : seek(state.t + 5); break;
      case 'ArrowUp': case '+': case '=': e.preventDefault(); stepSpeed(1); break;
      case 'ArrowDown': case '-': e.preventDefault(); stepSpeed(-1); break;
      case 'PageUp': case '[': e.preventDefault(); jumpRound(-1); break;
      case 'PageDown': case ']': e.preventDefault(); jumpRound(1); break;
      case 'Home': e.preventDefault(); seek(state.match.startTime); break;
      case 'f': case 'F': setFollow(!state.follow); break;
      case 'v': case 'V': setView(state.view === '3d' ? '2d' : '3d'); break;
      case '1': if (state.view === '3d') setCam('first'); break;
      case '2': if (state.view === '3d') setCam('third'); break;
      case '3': if (state.view === '3d') setCam('free'); break;
      case 'Tab': if (state.view === '3d') { e.preventDefault(); cyclePlayer(e.shiftKey ? -1 : 1); } break;
      case 'n': case 'N': setOpt('names', !state.opts.names); break;
      case 'm': case 'M': $('btnSound').click(); break;
      case 'p': case 'P': togglePanel(); break;
      case 'h': case 'H': cycleClean(); break;
      case 'x': case 'X': setOpt('xrayPlayers', !state.opts.xrayPlayers); break;
      case 'o': case 'O': toggleOptsMenu(); break;
      case 'Enter': if (e.altKey) { e.preventDefault(); toggleFullscreen(); } break;
      case 'Escape':
        if (!$('helpModal').hidden) showHelp(false);
        else if (!$('optsMenu').hidden) toggleOptsMenu(false);
        else select(null);
        break;
      case '?': showHelp($('helpModal').hidden); break;
      default:
    }
  });

  // drag and drop
  const dz = $('dropzone');
  window.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // ?demo=demos/file.dem (when served over HTTP)
  const qs = new URLSearchParams(location.search).get('demo');
  if (qs) {
    showLoading(tr('downloading', { name: qs }));
    $('dropzone').hidden = true;
    fetch(qs)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => loadBuffer(buf, qs.split('/').pop()))
      .catch((err) => { $('loading').hidden = true; $('dropzone').hidden = false; alertBox(tr('cantOpen', { name: qs, msg: err.message })); });
  }

  // ---------- idioma ----------
  const langSel = $('langSelect');
  for (const [code, label] of Object.entries(NS.LANGS)) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = label;
    langSel.appendChild(o);
  }
  langSel.value = NS.getLang();
  langSel.addEventListener('change', () => {
    NS.setLang(langSel.value);
    refreshTexts();
  });
  function refreshTexts() {
    NS.applyI18n();
    lastScoreHtml = '';
    lastFeedKey = '';
    lastHudKey = '';
    if (state.match) {
      const h = state.match.header;
      const server = state.match.server ? state.match.server.hostName : '';
      $('matchInfo').innerHTML = '<b>' + esc(h.mapName) + '</b> · ' + esc(state.fileName) + (server ? ' · ' + esc(server) : '') +
        ' · ' + (state.match.isHltv ? 'HLTV' : 'POV') + ' · ' + fmt(state.match.duration) + ' · ' + tr('nRounds', { n: state.match.rounds.length });
      updatePanels();
      buildRoundList();
      buildStats();
    }
    updateDiag();
  }
  NS.applyI18n();

  // ---------- fullscreen and side panel ----------
  function toggleFullscreen() {
    const el = $('app');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    $('app').classList.toggle('is-fullscreen', on);
    $('btnFullscreen').classList.toggle('on', on);
    if (on) { pokeUi(); toast(tr('fsHint')); } else $('app').classList.remove('ui-visible');
  });

  // Netflix-style fullscreen: image only; controls appear on mouse move
  let uiTimer = 0;
  function pokeUi() {
    const app = $('app');
    if (!app.classList.contains('is-fullscreen')) return;
    app.classList.add('ui-visible');
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => {
      const busy = !$('optsMenu').hidden || document.querySelector('.controls:hover, .viewbar:hover, select:focus');
      if (busy) pokeUi();
      else app.classList.remove('ui-visible');
    }, 2500);
  }
  for (const ev of ['mousemove', 'pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, pokeUi, { passive: true });
  $('btnFullscreen').addEventListener('click', toggleFullscreen);
  /** Clean screen: hides everything over the image, only the game. */
  /** Clean screen mode: 'off' | 'hud' (keeps the game HUD) | 'all' (clears everything). */
  function cleanMode() { return !state.opts.clean ? 'off' : state.opts.cleanKeepHud ? 'hud' : 'all'; }
  function setCleanMode(mode) {
    state.opts.clean = mode !== 'off';
    state.opts.cleanKeepHud = mode === 'hud';
    applyOpts();
    // the game HUD (crosshair, health, weapon) only exists in first person, like CS
    if (mode === 'hud' && (state.view !== '3d' || view3d.mode !== 'first')) toast(tr('hudFirstPersonHint'), true);
  }
  // the button and H key cycle three states: off -> HUD -> all -> off
  function cycleClean() {
    const m = cleanMode();
    setCleanMode(m === 'off' ? 'hud' : m === 'hud' ? 'all' : 'off');
    toast(tr(cleanMode() === 'off' ? 'cleanOffToast' : cleanMode() === 'hud' ? 'cleanHudToast' : 'cleanAllToast'));
  }
  for (const b of document.querySelectorAll('[data-clean]')) b.addEventListener('click', () => setCleanMode(b.dataset.clean));
  /**
   * Is the game HUD (weapon, crosshair, health/armor/timer, kills) shown?
   * Normal: follows the menu checkbox. HUD: always (own config). Clean: never.
   */
  function showsGameHud(key) {
    const o = state.opts;
    if (!o.clean) return !!o[key];
    return !!o.cleanKeepHud;
  }

  function togglePanel() {
    const hidden = $('app').classList.toggle('no-panel');
    $('btnPanel').setAttribute('aria-pressed', String(!hidden));
  }
  $('btnPanel').addEventListener('click', togglePanel);
  // double click on the image also toggles fullscreen
  $('radarWrap').addEventListener('dblclick', (e) => { if (e.target.closest('canvas')) toggleFullscreen(); });

  // ---------- Options menu tabs ----------
  function setOmTab(tab) {
    for (const b of document.querySelectorAll('[data-omtab]')) b.setAttribute('aria-selected', String(b.dataset.omtab === tab));
    for (const g of document.querySelectorAll('[data-ompanel]')) g.hidden = g.dataset.ompanel !== tab;
  }
  for (const b of document.querySelectorAll('[data-omtab]')) b.addEventListener('click', () => setOmTab(b.dataset.omtab));
  setOmTab('visual');

  // ---------- shortcuts panel (? key) ----------
  function showHelp(open) {
    if (open) {
      $('helpList').innerHTML = tr('helpKeys').map(([k, d]) => '<div class="hk"><kbd>' + esc(k) + '</kbd><span>' + esc(d) + '</span></div>').join('');
    }
    $('helpModal').hidden = !open;
  }
  $('btnHelp').addEventListener('click', () => showHelp(true));
  $('helpClose').addEventListener('click', () => showHelp(false));
  $('helpModal').addEventListener('click', (e) => { if (e.target === $('helpModal')) showHelp(false); });

  // ---------- start screen: demos from the demos/ folder ----------
  async function loadDemoList() {
    if (!/^https?:/.test(location.protocol)) return;
    try {
      const r = await fetch('demos/', { cache: 'no-cache' });
      if (!r.ok) return;
      const html = await r.text();
      const names = [...new Set([...html.matchAll(/href="([^"]+\.dem)"/gi)].map((m) => decodeURIComponent(m[1])))];
      if (!names.length) return;
      $('demoListItems').innerHTML = names.map((n) => '<li><button class="dl-item" data-demo="' + esc(n) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg><span>' + esc(n) + '</span></button></li>').join('');
      $('demoList').hidden = false;
    } catch (e) { /* no folder listing */ }
  }
  $('demoListItems').addEventListener('click', (e) => {
    const b = e.target.closest('[data-demo]');
    if (!b) return;
    const name = b.dataset.demo;
    showLoading(tr('downloading', { name }));
    $('dropzone').hidden = true;
    fetch('demos/' + encodeURIComponent(name))
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => loadBuffer(buf, name))
      .catch((err) => { $('loading').hidden = true; $('dropzone').hidden = false; alertBox(tr('cantOpen', { name, msg: err.message })); });
  });
  $('app').classList.add('no-demo');
  loadDemoList();

  // debug handle for the browser console
  window.csPlayer = { state, view3d, radar, audio, seek, select, setView, setCam, play, pause };

  // game files in assets/ (when served over HTTP)
  gameFiles.loadManifest('assets/').then((ok) => {
    if (!ok) return;
    connectAudio();
    if (state.match) load3d();
    else gameStatus(tr('assetsFound'));
  });

  radar.draw(0);
})();

# GoldReplayHLTV

> Browser-based Counter-Strike 1.6 demo player — 2D radar and 3D view using your own game files.

A Counter-Strike 1.6 demo (`.dem`) player that runs in the browser, with nothing to install besides Python to serve the files. It parses the whole demo in JavaScript and shows the match as a **2D radar** or in **3D using the original game files** (map, models, sprites, HUD and sounds).

Project rule: **only show what the demo recorded.** If the server did not send a piece of information (for example, ammo in an HLTV demo), the player does not invent or estimate it.

---

## How to use

### 1. Copy the game files (once, optional)

The 2D radar works without anything else. For the 3D view and sound, copy the files from your CS 1.6 installation into the `assets/` folder:

```bash
python3 tools/copy_game_files.py "/path/to/Half-Life"
```

The path is the folder that contains `cstrike` and `valve`. Without an argument, the script looks in the usual Steam locations (Linux and Windows). It copies about 3,900 files (~380 MB): maps, WADs, sky, models, sprites, overviews and sounds. File names are written in lowercase and the script generates `assets/manifest.json`.

> These files belong to Valve: they stay on your machine only. The `assets/` folder is in `.gitignore`.

### 2. Open the player

| System        | Command                                          |
|---------------|--------------------------------------------------|
| Linux / macOS | `./start.sh` (optional port: `./start.sh 8080`)  |
| Windows       | double-click `start.bat`                         |

The script starts a local server (`python3 -m http.server`, bound to `127.0.0.1`) and opens `http://localhost:8000/`. Opening `index.html` directly (`file://`) does not work, because the browser blocks reading the `assets/` folder.

### 3. Pick a demo

- Put `.dem` files in the `demos/` folder and click one on the start screen;
- or drag a `.dem` file onto the window, or use **Open demo**;
- or open it straight from the URL: `http://localhost:8000/?demo=demos/file.dem`.

---

## Features

**Playback**
- Play/pause, seek forward/back, frame by frame, speed from 0.25× to 16×, jump round by round.
- Timeline with numbered rounds colored by winner, plus kill markers. No spoilers: only what has already happened up to the current point is shown.

**3D view** (original game files)
- BSP map with WAD textures, lightmaps and sky.
- Players with the CS models and animations: legs (gait), aim pitch and yaw blending computed as in the game client, with smoothed movement.
- First-person weapon (`v_*.mdl`): draw, shoot, reload, silencer, muzzle flash and animation sounds.
- Grenades, C4, dropped weapons and bodies. Explosions and smoke use the sprites referenced by the demo itself.
- Cameras: first person, third person and free (WASD).
- Glow (outline through walls, like CS:GO demos) for players, weapons, bomb and grenades. Optional tracers, as a study aid.

**2D radar**
- Map built from player trajectories, with field of view, grenades, smokes, explosions and kill markers. Can follow a player.

**HUD and interface**
- In-game HUD with the original artwork: health, armor, timer, C4, ammo and money (the last two only in first-person demos), plus a kill feed identical to the game's.
- Spectated-player bar, scoreboard, round history and stats (kills, deaths, HS%, first kill, multi-kills).
- Screen mode (key **H**):
  - **Normal**: follows the menu options.
  - **HUD**: shows only the game HUD.
  - **Clean**: shows only the game image.
- Netflix-style fullscreen: controls hide and reappear when you move the mouse.
- Configurable HUD and crosshair colors. Options are saved in the browser.
- Interface in Portuguese, English and Spanish.
- Diagnostics panel: tells you which game file is missing and what stops showing because of it.

---

## Shortcuts

| Key | Action |
|---|---|
| Space | Play / pause |
| ← → | Back / forward 5 s |
| Shift + ← → | Frame by frame |
| ↑ ↓ | Speed |
| PageUp / PageDown | Previous / next round |
| Home | Start of demo |
| V | Toggle 2D / 3D |
| 1 · 2 · 3 | Camera: first person · third person · free |
| Tab / Shift+Tab | Next / previous player |
| W A S D · Q E | Move free camera |
| H | Screen mode: Normal → HUD → Clean |
| X | Player glow |
| N | Names |
| O | Options |
| P | Side panel |
| M | Sound |
| F | Follow player (2D) |
| Alt+Enter · double-click | Fullscreen |
| Esc | Close / exit |
| ? | Shortcut list |

---

## What the demo contains (and what it doesn't)

| Data | HLTV demo | First-person demo |
|---|---|---|
| Position, aim, animation, weapon for everyone | yes | yes |
| Health | yes (HLTV message) | yes |
| Kills, rounds, score, bomb, radio, sounds | yes | yes |
| Armor | no (the player only plays the armor-hit sound) | yes |
| Ammo and money | no | yes, only for the recording player |

---

## Project structure

```
index.html, styles.css     interface
start.sh, start.bat        local server
tools/copy_game_files.py   copies the game files into assets/
assets/                    game files (local, not versioned)
demos/                     your .dem files (local, not versioned)
vendor/three.min.js        three.js r149
src/demo/                  demo parsing
  readers.js               byte and bit readers
  delta.js                 GoldSrc delta encoding
  net-messages.js          svc_* messages and user messages
  match.js                 builds the match timeline
src/game/                  game formats
  bsp.js, wad.js           maps and textures
  mdl.js                   models, skeleton and animations
  spr.js, hud-icons.js     sprites and HUD artwork
  game-files.js            assets/ access and TGA reader
src/ui/                    interface
  app.js                   playback, HUD, scoreboard, menus
  view3d.js                3D view
  radar.js                 2D radar
  audio.js                 positional audio
  i18n.js                  pt / en / es strings
```

All code (names, comments, scripts) is in English. Interface strings live in `src/ui/i18n.js`.

**Memory:** per-frame data is stored in typed arrays, written directly during parsing. A 40-minute demo takes about 50 MB once parsed, peaking at ~45 MB of JS heap while parsing. Textures drop their RAM copy after being uploaded to the GPU.

---

## Requirements

- A modern browser with WebGL (Chrome, Edge, Firefox).
- Python 3 (for the local server and the copy script).
- Counter-Strike 1.6 installed, only for the 3D view and sound.

**Supported format:** GoldSrc demos (`HLDEMO`), protocols 47/48, HLTV and first person.

---

## Legal

Counter-Strike, Half-Life and their assets are property of Valve Corporation. This project does not include or distribute any game files; you must own the game to use the 3D view and sound.

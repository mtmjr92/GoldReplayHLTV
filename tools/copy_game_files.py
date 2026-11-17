#!/usr/bin/env python3
"""
Copies the files the player needs for the 3D view and sound from your
CS 1.6 installation into the project's assets/ folder.

Usage:
    python3 tools/copy_game_files.py "/path/to/Half-Life"

The path is the folder that contains "cstrike" and "valve", for example:
    Steam (Linux):   ~/.steam/steam/steamapps/common/Half-Life
    Steam (Windows): C:\\Program Files (x86)\\Steam\\steamapps\\common\\Half-Life

File names are written in lowercase (the game is case-insensitive, web servers
are not) and assets/manifest.json is generated with the list of files.
"""
import json
import os
import shutil
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
TARGET_DIR = PROJECT_DIR / "assets"

# (game folder, subfolder, extensions, recursive)
WHAT_TO_COPY = [
    ("cstrike", "maps", {".bsp"}, False),
    ("cstrike", "", {".wad"}, False),
    ("valve", "", {".wad"}, False),
    ("cstrike", "gfx/env", {".tga"}, False),
    ("cstrike", "models", {".mdl"}, True),
    ("valve", "models", {".mdl"}, False),  # some CS objects come from Half-Life (e.g. w_9mmclip.mdl)
    ("cstrike", "sprites", {".spr", ".txt"}, True),  # hud.txt says where each HUD icon is
    ("valve", "sprites", {".spr"}, True),
    ("cstrike", "overviews", {".bmp", ".txt"}, False),
    ("cstrike", "sound", {".wav", ".txt"}, True),
    ("valve", "sound", {".wav", ".txt"}, True),
]

DEFAULT_LOCATIONS = [
    "~/.steam/steam/steamapps/common/Half-Life",
    "~/.local/share/Steam/steamapps/common/Half-Life",
    "C:/Program Files (x86)/Steam/steamapps/common/Half-Life",
    "C:/Program Files/Steam/steamapps/common/Half-Life",
]


def find_game_dir(arg):
    candidates = [arg] if arg else DEFAULT_LOCATIONS
    for candidate in candidates:
        path = Path(os.path.expanduser(candidate))
        if (path / "cstrike").is_dir() and (path / "valve").is_dir():
            return path
    return None


def main():
    game_dir = find_game_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    if not game_dir:
        print("Game folder not found.")
        print('Run it like this: python3 tools/copy_game_files.py "/path/to/Half-Life"')
        print('(the folder that contains "cstrike" and "valve")')
        sys.exit(1)

    print(f"Game:   {game_dir}")
    print(f"Target: {TARGET_DIR}")
    copied = 0
    total_bytes = 0
    for mod, sub, extensions, recursive in WHAT_TO_COPY:
        source = game_dir / mod / sub if sub else game_dir / mod
        if not source.is_dir():
            print(f"  (no {mod}/{sub})")
            continue
        entries = source.rglob("*") if recursive else source.glob("*")
        for file in entries:
            if not file.is_file() or file.suffix.lower() not in extensions:
                continue
            rel = file.relative_to(game_dir).as_posix().lower()
            target = TARGET_DIR / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.stat().st_size != file.stat().st_size:
                shutil.copy2(file, target)
                copied += 1
            total_bytes += file.stat().st_size

    files = sorted(
        p.relative_to(TARGET_DIR).as_posix()
        for p in TARGET_DIR.rglob("*")
        if p.is_file() and p.name not in ("manifest.json", "README.txt")
    )
    (TARGET_DIR / "manifest.json").write_text(json.dumps({"files": files}, indent=0))
    maps = sorted(Path(f).stem for f in files if f.startswith("cstrike/maps/"))
    print(f"Done: {len(files)} files in assets/ ({copied} copied now, {total_bytes / 1e6:.0f} MB).")
    print(f"Maps available: {', '.join(maps)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Install Hermes Eyes: the Desktop plugin and the "eyes" pet.

    python3 install.py                      plugin + pet for the default profile
    python3 install.py --profile NAME       ...pet for that profile instead (repeatable)
    python3 install.py --all-profiles       ...pet for every profile
    python3 install.py --select             also make "eyes" the active pet
    python3 install.py --no-pet | --no-desktop
    python3 install.py --uninstall          remove what this installs
    python3 install.py --dry-run            say what would happen, change nothing
    python3 install.py --hermes-home PATH   default: $HERMES_HOME or ~/.hermes

Standard library only; works on Linux, macOS and Windows. It copies files and,
with --select, runs `hermes pets select eyes`. Nothing else: no network, no
keys, no changes outside the Hermes home.
"""
import argparse, os, shutil, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_SRC = HERE / "desktop" / "plugin.js"
PET_SRC = HERE / "pet" / "eyes"
PET_FILES = ("pet.json", "spritesheet.webp")


def hermes_home(arg):
    if arg:
        return Path(arg).expanduser()
    env = os.environ.get("HERMES_HOME")
    return Path(env).expanduser() if env else Path.home() / ".hermes"


def profiles(home):
    found = ["default"] if (home / "config.yaml").is_file() else []
    root = home / "profiles"
    if root.is_dir():
        found += sorted(p.name for p in root.iterdir() if (p / "config.yaml").is_file())
    return found


def profile_home(home, name):
    return home if name == "default" else home / "profiles" / name


class Plan:
    def __init__(self, dry):
        self.dry = dry

    def say(self, verb, what):
        print(f"{'would ' if self.dry else ''}{verb} {what}")

    def copy(self, src, dst):
        self.say("copy", f"{src.name} -> {dst}")
        if not self.dry:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)

    def remove(self, path):
        if not path.exists():
            return
        self.say("remove", path)
        if not self.dry:
            shutil.rmtree(path) if path.is_dir() else path.unlink()

    def run(self, cmd):
        self.say("run", " ".join(cmd))
        if self.dry:
            return True
        try:
            return subprocess.run(cmd).returncode == 0
        except FileNotFoundError:
            return False


def main():
    ap = argparse.ArgumentParser(description="Install Hermes Eyes.")
    ap.add_argument("--profile", action="append", default=[], help="profile to give the pet (repeatable)")
    ap.add_argument("--all-profiles", action="store_true")
    ap.add_argument("--select", action="store_true", help='make "eyes" the active pet')
    ap.add_argument("--no-pet", action="store_true")
    ap.add_argument("--no-desktop", action="store_true")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--hermes-home")
    a = ap.parse_args()

    home = hermes_home(a.hermes_home)
    if not home.is_dir():
        sys.exit(f"No Hermes home at {home}. Install Hermes Agent first, or pass --hermes-home.")
    known = profiles(home)
    if a.all_profiles:
        targets = known
    else:
        targets = a.profile or ["default"]
        missing = [p for p in targets if p not in known]
        if missing and not a.no_pet:
            sys.exit(f"No such profile: {', '.join(missing)}. Known: {', '.join(known) or 'none'}")

    plan = Plan(a.dry_run)
    hermes = shutil.which("hermes")

    if not a.no_desktop:
        dst = home / "desktop-plugins" / "hermes-eyes"
        if a.uninstall:
            plan.remove(dst)
        else:
            plan.copy(PLUGIN_SRC, dst / "plugin.js")

    if not a.no_pet:
        for name in targets:
            pets = profile_home(home, name) / "pets" / "eyes"
            if a.uninstall:
                plan.remove(pets)
                continue
            for f in PET_FILES:
                plan.copy(PET_SRC / f, pets / f)
            if a.select:
                cmd = [hermes or "hermes"] + ([] if name == "default" else ["-p", name]) + ["pets", "select", "eyes"]
                if not hermes and not a.dry_run:
                    print(f'hermes is not on PATH; select it yourself: {" ".join(cmd[1:])}')
                elif not plan.run(cmd):
                    print(f"could not select the pet for {name}; run: hermes {' '.join(cmd[1:])}")

    if a.dry_run:
        print("dry run: nothing changed")
    elif a.uninstall:
        print("Removed. Hermes Desktop drops the eyes within a few seconds.")
    else:
        print("Done. Hermes Desktop picks the eyes up within a few seconds; if not, restart it.")
        if not a.no_pet and not a.select:
            print('For the pet in the CLI and TUI: hermes pets select eyes  (add -p NAME for a profile)')


if __name__ == "__main__":
    main()

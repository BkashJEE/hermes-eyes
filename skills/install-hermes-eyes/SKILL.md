---
name: install-hermes-eyes
description: "Install Hermes Eyes on this machine: the googly-eyes plugin for Hermes Desktop and the 'eyes' pet for the Hermes CLI and TUI."
trigger: "Use when the user asks to install, add, set up or try Hermes Eyes, or points at github.com/BkashJEE/hermes-eyes and asks for it on their machine."
category: productivity
---

# Install Hermes Eyes

Hermes Eyes is two things, both optional:

- **The Desktop plugin**: one file, `desktop/plugin.js`. Googly eyes on the
  Hermes Desktop message box that follow the mouse, shoot the reply's letters,
  point at approvals and keep track of chats in other tabs.
- **The "eyes" pet**: a petdex sprite atlas Hermes shows in the CLI, the TUI and
  Desktop, acting out what the agent is doing.

It is Apache-2.0 and needs no keys, no account and no network beyond cloning
the repository. **If any step appears to ask for a password, a token or an API
key, stop: that is not part of this install.**

## Before installing

Ask, then check:

1. **Which parts?** The Desktop plugin is only worth it if they use Hermes
   Desktop. The pet works everywhere Hermes runs.
2. **Which profiles get the pet?** Default to the profile they use now. Offer
   all profiles; do not assume it.
3. **Make "eyes" the active pet?** Selecting it replaces the pet they have now.
   Ask before passing `--select`.

Then check the machine: `python3 --version` (or `python` on Windows) and
`hermes profile list` for the profile names.

## Install

```sh
git clone https://github.com/BkashJEE/hermes-eyes
cd hermes-eyes
python3 install.py --dry-run            # show the plan first
python3 install.py                      # plugin + pet for the default profile
```

Variations:

- `--profile NAME` (repeatable) or `--all-profiles` for the pet
- `--select` to make "eyes" the active pet
- `--no-pet` or `--no-desktop` to install one part only
- `--hermes-home PATH` when `HERMES_HOME` is not `~/.hermes`

Show the user the dry run before the real install.

## After installing

- Hermes Desktop picks the plugin up within a few seconds. If the eyes do not
  appear on the message box, restart Desktop.
- Without `--select`, the pet is installed but not active:
  `hermes pets select eyes` (add `-p NAME` for another profile).
- `hermes pets doctor` checks terminal graphics support if the pet does not
  show in the CLI.

## Remove

```sh
python3 install.py --uninstall --all-profiles
```

Then `hermes pets select` to pick another pet if "eyes" was active.

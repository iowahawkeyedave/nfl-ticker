# NFL Ticker for Hermes Desktop

A live NFL score ticker that lives in the Hermes desktop app's **bottom status bar**.
Team-coloured tags, scores, game clock, down & distance, possession marker and the
last play — scrolling past while you work, with a full scoreboard page one click away.

It's a port of the idea behind [krypdoh/NFL-TCKR](https://github.com/krypdoh/NFL-TCKR)
(a Windows desktop-AppBar ticker) into a Hermes desktop plugin, so nothing has to
reserve screen space on your desktop — it rides the app's own status bar.

```
NFL  HOU 17 – LAC 9  |  ● 4:06 2ND  |  2nd & 24 at LAC 9  |  (Shotgun) K.Mitchell right end to LAC 23 for 5 yards…
```

## Features

- **Scrolling slate** in the status bar — live games first, then upcoming, then finals.
- **Colour-coded team tags** with automatic light/dark text, live dot, possession dot,
  red-zone highlight, `at` before kickoff and `Final` / `Final/OT` after.
- **Hover to pause**, a pause button to pin it, and a speed control.
- **Click any game** for the full board.
- **Follow one team** (or hide finals) — the ticker filters to what you care about.
- **`/nfl` scoreboard page** — logo cards with records, quarter, down & distance,
  "X ball", last play, venue and TV, plus an expandable **Details** panel that pulls
  ESPN leaders and scoring plays on demand. Sidebar nav row + command-palette entries.
- **Self-updating** — see [Updates](#updates).

## Install

Desktop plugins are plain JavaScript files the app loads at runtime from
`<HERMES_HOME>/desktop-plugins/`. Nothing to build, no restart.

### From GitHub (recommended)

In the Hermes desktop app: **Settings → Plugins → Install from GitHub**, and paste:

```
iowahawkeyedave/nfl-ticker
```

The app clones at a pinned commit, copies `plugin.js` into
`desktop-plugins/nfl-ticker/`, and hot-loads it.

### Manually

Copy `plugin.js` into:

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.hermes\desktop-plugins\nfl-ticker\plugin.js` |
| macOS / Linux | `~/.hermes/desktop-plugins/nfl-ticker/plugin.js` |

The folder name must be `nfl-ticker`. The app watches the directory and loads it
within a few seconds; if it doesn't show up, run **Reload desktop plugins** from the
command palette (`Ctrl/Cmd+K`).

## Usage

| Action | How |
|--------|-----|
| Open the scoreboard | Click any game in the ticker |
| Ticker settings | Gear at the right end of the ticker |
| Pause / resume | Hover the ticker, or the pause button next to the gear |
| Every command | `Ctrl/Cmd+K` → "NFL: …" |

Settings (follow team, hide finals, scroll on/off, speed) are stored per install.

## Updates

The plugin knows its own repo. Once an hour (and from
**NFL: Check the ticker for updates** in the palette) it fetches `plugin.js` from
`main` and compares the `VERSION` constant. When a newer version is published the
gear turns accent-coloured and the settings popover offers **Update to vX.Y.Z** —
that downloads the file, validates it, writes it over its own `plugin.js` (keeping
the previous copy as `plugin.js.previous`) and lets the app's file watcher reload it
in place. No restart.

If you installed through the app's GitHub door and prefer the pinned-commit route,
just run the install again instead; both work.

## Data

The unofficial-but-public ESPN site API:

- `site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
- `site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=<id>` (page details only)

No key, no account, no tracking. Polls every **20s while games are live**, every
**120s otherwise**, and only while the window is focused. Leaders/scoring are fetched
only when you expand a card.

## Notes & limits

- Needs the desktop app (it's a renderer plugin); the CLI/TUI doesn't load these.
- The ticker is tuned for the ~20px status bar — it's a ticker, not a scoreboard.
- ESPN's API is public but unofficial; if they change a field the plugin degrades to
  showing what it can rather than throwing (and the page tells you when it can't reach
  them).
- Built and verified against live in-season data; the offseason slate shows
  "No games on the slate" instead of an error.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the NFL or ESPN; team names and
logos belong to their owners.

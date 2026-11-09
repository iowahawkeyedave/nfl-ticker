# Score Ticker for Hermes Desktop

A live sports score ticker that lives in the Hermes desktop app's **bottom status bar**.
Team-coloured tags, scores, game clock, down & distance, possession marker and the last
play — scrolling past while you work, with a full scoreboard page one click away.

Started as a port of the idea behind [krypdoh/NFL-TCKR](https://github.com/krypdoh/NFL-TCKR)
(a Windows desktop-AppBar ticker) into a Hermes desktop plugin, so nothing has to reserve
screen space on your desktop — it rides the app's own status bar. As of **v1.1 it speaks
five leagues**, and the repo name stays `nfl-ticker` because that's the plugin id.

```
SCORES  NFL HOU 44 – LAC 22 | 2:20 4TH | K.Fairbairn 41 yard field goal is GOOD…  NBA LAL 61 – DET 48 | HALF  NHL TB 0 – WPG 1 | 10:19 P2
```

## Sports

| League | Status vocabulary |
|--------|-------------------|
| NFL | quarter + clock, down & distance, possession, red zone |
| College football | same as NFL (no possession marker from ESPN) |
| NBA | quarter + clock, `HALF`, `OT`/`OT2` |
| NHL | period + clock (`P1`…`P3`), `OT`, `SO` |
| MLB | half-inning (`Top 7th`, `Bot 7th`), `Final/10` |

Every league is one row in the `LEAGUES` table plus a branch in `liveStatus` — the ESPN
site API payload is identical across them, only the clock vocabulary differs. Adding a
league is ~3 lines (the paths for WNBA, MLS, EPL and F1 all answer the same way).

## Features

- **Scrolling slate** — live games first, then upcoming, then finals.
- **League-aware segments** — colour-coded team tags with automatic light/dark text, live
  dot, possession dot, red-zone highlight, `at` before kickoff, `Final` / `Final/OT`.
- **Auto-focus (`One league`)** — the ticker shows the league that matters: your team's game
  if it's live, else the live leagues on a **25s rotation**, else whatever is on next.
  Switch to **All** to scroll every enabled league in one crawl, with a league chip per game.
- **Pick your sports** — NFL / CFB / NBA / NHL / MLB toggle on and off; out-of-season
  leagues are simply quiet.
- **Follow one team** across leagues (`NFL · CHI Bears`, `MLB · CHC Cubs`, …).
- **Hover to pause**, a pause button to pin it, and a speed control.
- **Click any game** for the board.
- **`/nfl` scoreboard page** — grouped by league with an `ALL / NFL / CFB / NBA / NHL / MLB`
  filter, logo cards with records, status, down & distance / possession, last play, venue
  and TV, plus an expandable **Details** panel that pulls ESPN leaders and scoring plays on
  demand. Sidebar nav row + command-palette entries.
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

The folder name must be `nfl-ticker` (the plugin id). The app watches the directory and
loads it within a few seconds; if it doesn't show up, run **Reload desktop plugins** from
the command palette (`Ctrl/Cmd+K`).

## Usage

| Action | How |
|--------|-----|
| Open the scoreboard | Click any game in the ticker |
| Ticker settings | Gear at the right end of the ticker |
| Pause / resume | Hover the ticker, or the pause button next to the gear |
| Every command | `Ctrl/Cmd+K` → "Scores: …" |

Settings (sports, show mode, follow team, hide finals, scroll, speed) are stored per
install.

## Updates

The plugin knows its own repo. Once an hour (and from **Scores: Check the ticker for
updates** in the palette) it fetches `plugin.js` from `main` and compares the `VERSION`
constant. When a newer version is published the gear turns accent-coloured and the
settings popover offers **Update to vX.Y.Z** — that downloads the file, validates it,
writes it over its own `plugin.js` (keeping the previous copy as `plugin.js.previous`) and
lets the app's file watcher reload it in place. No restart.

## Data

The unofficial-but-public ESPN site API, one scoreboard call per enabled league:

- `site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard`
- `…/summary?event=<id>` (page details only)

No key, no account, no tracking. Polls every **20s while that league has live games**,
every **120s otherwise**, and only while the window is focused. Leaders/scoring are fetched
only when you expand a card.

## Notes & limits

- Needs the desktop app (it's a renderer plugin); the CLI/TUI doesn't load these.
- The ticker is tuned for the ~20px status bar — it's a ticker, not a scoreboard.
- ESPN only puts down & distance / possession in the **football** payloads; basketball,
  hockey and baseball get clock, period and last play there. Baseball's pitch count and
  base runners live deeper in the summary, so they're page-side (verify in season).
- ESPN's API is public but unofficial; if they change a field the plugin degrades to
  showing what it can rather than throwing.

## Roadmap

What's next — alerts, win probability, odds, hover cards, more leagues — lives in
[ROADMAP.md](ROADMAP.md).

## Version history

- **1.1.0** — five leagues (NFL, CFB, NBA, NHL, MLB), league-aware status lines, auto-focus
  with live-league rotation, `All` crawl mode, per-sport chips, league-grouped scoreboard
  page with a filter row.
- **1.0.0** — NFL only: scrolling slate, follow team, `/nfl` page, self-update.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with the NFL, ESPN or any league; team names
and logos belong to their owners.

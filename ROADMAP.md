# Roadmap

Deferred work, in rough order of value-per-line-of-code. Nothing here is committed to a
date — the user picks a bundle, it ships as the next minor version.

Renderer-only is a standing constraint: **no Python half, no `config.yaml` change.** Anything
that needs a backend (e.g. a Yahoo-fantasy score in the ticker) is explicitly out of scope
unless that decision is reopened.

## Shipped

- **1.3.0** — priority sort, score-change flash, quiet stand-down, multiple followed teams.
- **1.4.0** — win probability and hover cards.

Neither is on the list below any more.

## v1.4 candidates

### Cheap wins

- **Rotation polish** — per-league dwell time, and skip leagues whose games are all final
  when some other league is live (currently `liveSlates` already filters, but the "next up"
  fallback can land on a finished league).

### Live intelligence

- **Odds / spread** — `competitions[0].odds` carries `spread`, `overUnder`,
  `homeTeamOdds/awayTeamOdds`. Show "CHI -3.5 · 44" pregame and "covering" live. Offseason
  and some games have no odds; hide the chip rather than guessing.
- **Native toasts** — `ctx.os.notify` (throttled per plugin, and gated by Settings ▸
  Notifications ▸ Plugin notifications) when a followed team scores, takes the lead, a game
  goes final, or enters OT. Must dedupe per (gameId, event) — poll every 20s, so without a
  guard it will fire repeatedly. Also worth a global "alerts off" switch.

### Bigger lifts

- **More leagues** — WNBA (`basketball/wnba`), NCAAM (`basketball/mens-college-basketball`),
  MLS (`soccer/usa.1`), EPL (`soccer/eng.1`), F1 (`racing/f1`). Soccer needs a new status
  branch (minute + stoppage, `FT`, penalties) and a draw-aware winner (no `winner` flag);
  racing is a different shape entirely and would need its own segment renderer.
- **Per-league show mode** — in `All` mode, order leagues yourself and mute the ones you'd
  rather see on the page only.

## Known gaps to verify in season

- **MLB depth** — the scoreboard payload for a live game may carry `balls`, `strikes`,
  `outs`, `onFirst/Second/Third`; November has no live baseball to inspect. If present, add
  a count/bases chip; if not, pull it from `summary` for live games only. Same check for
  `R/H/E` on the page.
- **ESPN field drift** — `situation.down` disappearing or `status.period` semantics changing
  would degrade the football ticker quietly. Worth a tiny "shape sanity" test fixture in the
  repo (a saved payload per league) so a change is visible before users notice.

## Won't do (decided)

- A Python backend (`plugin.yaml` + `plugin_api.py` + `ctx.rest`) — the plugin stays one
  file, installed and updated by dropping it in `desktop-plugins/`.
- Yahoo fantasy score in the ticker — needs that backend.

## How to ship a version

1. Bump `export const VERSION` in `plugin.js`.
2. Update the README's version history and the features list.
3. Commit, tag `vX.Y.Z`, `gh release create`.
4. Installed copies offer "Update to vX.Y.Z" in the gear within the hour (it reads
   `VERSION` from the raw file on `main`).

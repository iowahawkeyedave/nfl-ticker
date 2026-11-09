# Roadmap

Deferred work, in rough order of value-per-line-of-code. Nothing here is committed to a
date — the user picks a bundle, it ships as the next minor version.

Renderer-only is a standing constraint: **no Python half, no `config.yaml` change.** Anything
that needs a backend (e.g. a Yahoo-fantasy score in the ticker) is explicitly out of scope
unless that decision is reopened.

## v1.3 candidates

(These were earmarked for 1.2; the layout pane took that slot.)

### Cheap wins (the "it feels smart now" bundle)

- **Priority sort** — order segments by what matters: red zone > 4th-quarter one-score >
  OT > live > upcoming > final, and demote blowouts (3+ score games in the last 10 min).
  All in `visibleGames`/the sort in `parseScoreboard`; no new data.
- **Score-change flash** — keep the previous poll's scores per game id and pulse the segment
  for ~2s when a score appears. Needs a `useRef` snapshot keyed by game id, plus one
  keyframe in `MARQUEE_CSS`. Do not flash on mount.
- **Quiet auto-hide** — when every enabled league has nothing live and nothing on today's
  slate, collapse the bar to a single muted chip (or drop it) instead of sitting on
  "No games on the slate" all week.
- **Rotation polish** — per-league dwell time, and skip leagues whose games are all final
  when some other league is live (currently `liveSlates` already filters, but the "next up"
  fallback can land on a finished league).

### Live intelligence

- **Win probability** — ESPN ships `competitions[0].situation.lastPlay.probability`
  (`homeWinPercentage` / `awayWinPercentage` / `tiePercentage`) for NFL and NBA. Ticker
  segment gets an optional "68%" chip; the page card gets a thin bar. Missing on some
  plays — treat as optional, never a placeholder.
- **Odds / spread** — `competitions[0].odds` carries `spread`, `overUnder`,
  `homeTeamOdds/awayTeamOdds`. Show "CHI -3.5 · 44" pregame and "covering" live. Offseason
  and some games have no odds; hide the chip rather than guessing.
- **Native toasts** — `ctx.os.notify` (throttled per plugin, and gated by Settings ▸
  Notifications ▸ Plugin notifications) when a followed team scores, takes the lead, a game
  goes final, or enters OT. Must dedupe per (gameId, event) — poll every 20s, so without a
  guard it will fire repeatedly. Also worth a global "alerts off" switch.

### Bigger lifts

- **Hover card** — hovering a segment opens a popover with per-period linescores, leaders
  and the last 3 plays, fetching `summary?event=` on hover (60s cache) instead of on click.
- **Multiple followed teams** — `follow` is a single `league:ABBR` string today; move to an
  array with a migration in `loadSettings` (keep reading the string form).
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

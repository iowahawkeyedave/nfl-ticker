/**
 * Score Ticker — live NFL, college football, NBA, NHL and MLB scores in the
 * Hermes status bar.
 * ------------------------------------------------------------------
 * Started as a port of github.com/krypdoh/NFL-TCKR (a Windows AppBar ticker):
 * instead of reserving a desktop strip, the ticker lives in the app's own
 * bottom status bar and scrolls the slate — team-coloured tags, scores, game
 * clock, down & distance, possession marker and the last play.
 *
 * 1.1 is league-aware: one status vocabulary per sport (quarters, periods,
 * half-innings, OT/SO), and the ticker auto-focuses the league that matters —
 * your team's game first, then the live leagues on a slow rotation.
 *
 * Data: ESPN public site API (site.api.espn.com), no key, no account.
 *
 * What it adds beyond the scroll:
 *   - click a game in the ticker  → the NFL scoreboard page
 *   - gear in the ticker          → follow one team, scroll speed, live only
 *   - ⌘K commands                 → open board, refresh, pause/resume scroll
 *   - /nfl page                   → full cards, on-demand leaders + scoring plays
 *
 * Contract: single plain-ESM file, imports only @hermes/plugin-sdk + react.
 * Styles are inline with theme tokens only — the app's Tailwind build does not
 * include classes invented here, and hardcoded colours break every skin.
 */

import {
  atom,
  Button,
  Codicon,
  host,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Switch,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

export const ID = 'nfl-ticker'
export const VERSION = '1.1.0'

// ---------------------------------------------------------------------------
// Leagues + settings
// ---------------------------------------------------------------------------

const SCOREBOARD_ROOT = 'https://site.api.espn.com/apis/site/v2/sports'
const scoreboardUrl = league => `${SCOREBOARD_ROOT}/${league.path}/scoreboard`
const summaryUrl = (league, id) => `${SCOREBOARD_ROOT}/${league.path}/summary?event=${id}`
const slateKey = league => ['nfl-ticker', 'slate', league.key]

/** One ESPN site-API path per league: the payload shape is identical, only the
 *  status vocabulary differs (quarters, periods, innings, halves), so a league
 *  is a row here plus a branch in `liveStatus`. */
const LEAGUES = [
  { key: 'nfl', label: 'NFL', sport: 'football', path: 'football/nfl', regulation: 4 },
  { key: 'cfb', label: 'CFB', sport: 'football', path: 'football/college-football', regulation: 4 },
  { key: 'nba', label: 'NBA', sport: 'basketball', path: 'basketball/nba', regulation: 4 },
  { key: 'nhl', label: 'NHL', sport: 'hockey', path: 'hockey/nhl', regulation: 3 },
  { key: 'mlb', label: 'MLB', sport: 'baseball', path: 'baseball/mlb', regulation: 9 }
]

const LEAGUE_BY_KEY = Object.fromEntries(LEAGUES.map(league => [league.key, league]))
const leagueLabel = key => LEAGUE_BY_KEY[key]?.label || ''

const DEFAULTS = {
  follow: '',
  speed: 70,
  liveOnly: false,
  scroll: true,
  leagues: LEAGUES.map(league => league.key),
  mode: 'auto'
}

/** Live store, seeded from plugin storage in register(). */
const $settings = atom({ ...DEFAULTS })

let storage = null
let openExternal = () => Promise.resolve(false)

function saveSettings(patch) {
  const next = { ...$settings.get(), ...patch }
  $settings.set(next)

  if (storage) {
    storage.set('settings', next)
  }

  return next
}

function loadSettings() {
  const saved = storage ? storage.get('settings', null) : null

  return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function getJSON(url, signal) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal })

  if (!response.ok) {
    throw new Error(`ESPN returned ${response.status}`)
  }

  return response.json()
}

const TEAM_FALLBACK = { abbr: '?', name: '', color: '#5b5b5b', logo: '', record: '', score: '' }

function parseCompetitor(c) {
  const team = c.team || {}

  return {
    id: String(c.id || team.id || ''),
    abbr: team.abbreviation || team.shortDisplayName || '?',
    name: team.shortDisplayName || team.displayName || team.name || '',
    location: team.location || '',
    color: team.color ? `#${team.color}` : TEAM_FALLBACK.color,
    altColor: team.alternateColor ? `#${team.alternateColor}` : team.color ? `#${team.color}` : TEAM_FALLBACK.color,
    logo: team.logo || team.logos?.[0]?.href || '',
    score: c.score !== undefined && c.score !== null && c.score !== '' ? String(c.score) : '',
    winner: c.winner === true,
    record: c.records?.[0]?.summary || ''
  }
}

function parseGame(event, league) {
  const competition = event.competitions?.[0] || {}
  const status = competition.status || event.status || {}
  const type = status.type || {}
  const situation = competition.situation || {}
  const bySide = {}

  for (const competitor of competition.competitors || []) {
    bySide[competitor.homeAway] = parseCompetitor(competitor)
  }

  const away = bySide.away || TEAM_FALLBACK
  const home = bySide.home || TEAM_FALLBACK
  const possessionId = situation.possession ? String(situation.possession) : ''
  const hasSituation = Boolean(situation.down)

  return {
    id: String(event.id || competition.id || ''),
    league: league.key,
    sport: league.sport,
    date: event.date || competition.date || '',
    state: type.state || 'pre',
    detail: type.detail || '',
    shortDetail: type.shortDetail || '',
    clock: status.displayClock || '',
    period: Number(status.period) || 0,
    away,
    home,
    possession: possessionId === away.id ? 'away' : possessionId === home.id ? 'home' : '',
    situation: hasSituation
      ? {
          down: situation.down,
          distance: situation.distance,
          text: situation.shortDownDistanceText || situation.downDistanceText || '',
          long: situation.downDistanceText || '',
          redZone: situation.isRedZone === true,
          possessionText: situation.possessionText || ''
        }
      : null,
    lastPlay: situation.lastPlay?.text || '',
    venue: competition.venue?.fullName || '',
    broadcast: (competition.broadcasts || [])
      .flatMap(b => b.names || [])
      .filter(Boolean)
      .join(', ')
  }
}

function liveCount(games) {
  return (games || []).filter(g => g.state === 'in').length
}

function intervalFor(data) {
  if (!data) {
    return 60_000
  }

  return liveCount(data.games) > 0 ? 20_000 : 120_000
}

function parseScoreboard(json, league) {
  const games = (json.events || []).map(event => parseGame(event, league))
  const rank = { in: 0, pre: 1, post: 2 }

  games.sort((a, b) => {
    const byState = (rank[a.state] ?? 3) - (rank[b.state] ?? 3)

    if (byState !== 0) {
      return byState
    }

    const byDate = new Date(a.date).getTime() - new Date(b.date).getTime()

    return Number.isNaN(byDate) ? 0 : byDate
  })

  return {
    league: league.key,
    games,
    week: json.week?.label || '',
    season: json.season?.year ? String(json.season.year) : '',
    updatedAt: Date.now()
  }
}

function useSlate(league, enabled) {
  return useQuery({
    queryKey: slateKey(league),
    queryFn: ({ signal }) => getJSON(scoreboardUrl(league), signal).then(json => parseScoreboard(json, league)),
    enabled,
    refetchInterval: query => intervalFor(query.state.data),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 1
  })
}

/** One hook per league — a FIXED-length list, so hook order is stable. Leagues
 *  the user turned off (and out-of-season ones, which answer with no events)
 *  cost nothing but stay in the list. */
function useSlates(enabledKeys) {
  const keys = new Set(enabledKeys)

  return LEAGUES.map((league, index) => {
    const query = useSlate(league, keys.has(league.key))

    return {
      league,
      index,
      enabled: keys.has(league.key),
      isPending: keys.has(league.key) && query.isPending,
      isError: query.isError,
      refetch: query.refetch,
      data: query.data
    }
  })
}

/** `follow` is `league:ABBR` (a bare abbr still matches any league, so settings
 *  written by v1.0 keep working). */
function followMatches(game, follow) {
  if (!follow) {
    return true
  }

  const [rawLeague, rawAbbr] = String(follow).includes(':') ? String(follow).split(':') : ['', String(follow)]
  const abbr = rawAbbr.trim().toUpperCase()

  if (rawLeague && game.league !== rawLeague) {
    return false
  }

  return game.away.abbr.toUpperCase() === abbr || game.home.abbr.toUpperCase() === abbr
}

function visibleGames(slate, settings) {
  const games = slate?.data?.games || []

  return games.filter(game => {
    if (settings.liveOnly && game.state === 'post') {
      return false
    }

    return followMatches(game, settings.follow)
  })
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function kickoffLabel(iso) {
  const when = new Date(iso)

  if (Number.isNaN(when.getTime())) {
    return 'TBD'
  }

  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s+/g, '')

  if (when.toDateString() === new Date().toDateString()) {
    return time
  }

  const day = when.toLocaleDateString([], { weekday: 'short' })

  return `${day} ${time}`
}

/** Overtime label for a period past regulation, per sport. Hockey names its
 *  shootout a period too (5), which is the only place the arithmetic breaks. */
function overtimeLabel(sport, period, regulation) {
  const extra = period - regulation

  if (extra <= 0) {
    return ''
  }

  if (sport === 'hockey' && extra === 2) {
    return 'SO'
  }

  return extra === 1 ? 'OT' : `OT${extra}`
}

function ordinalQuarter(period) {
  if (!period) {
    return ''
  }

  return `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : period === 3 ? 'rd' : 'th'}`
}

/** In-game status vocabulary: quarters for football/basketball, periods for
 *  hockey, half-innings for baseball, halves for college football. */
function liveStatus(game) {
  const league = LEAGUE_BY_KEY[game.league] || {}
  const period = game.period || 0
  const clock = game.clock || ''
  const overtime = overtimeLabel(game.sport, period, league.regulation ?? 4)

  if (/halftime/i.test(game.shortDetail || '')) {
    return 'HALF'
  }

  if (game.sport === 'baseball') {
    return game.shortDetail || (period ? `INN ${period}` : 'LIVE')
  }

  if (overtime) {
    return clock ? `${clock} ${overtime}` : overtime
  }

  if (!period) {
    return 'LIVE'
  }

  if (game.sport === 'hockey') {
    return clock ? `${clock} P${period}` : `P${period}`
  }

  if (game.sport === 'basketball') {
    return clock ? `${clock} Q${period}` : `Q${period}`
  }

  return `${clock} ${ordinalQuarter(period)}`.trim()
}

function statusLabel(game) {
  if (game.state === 'in') {
    return liveStatus(game)
  }

  if (game.state === 'post') {
    const detail = game.shortDetail || ''
    const overtime = overtimeLabel(game.sport, game.period, (LEAGUE_BY_KEY[game.league]?.regulation ?? 4))

    if (/^final/i.test(detail)) {
      return detail
    }

    return overtime ? `Final/${overtime}` : 'Final'
  }

  return kickoffLabel(game.date)
}

function readableOn(hex) {
  const clean = String(hex || '').replace('#', '')

  if (clean.length !== 6) {
    return '#ffffff'
  }

  const r = parseInt(clean.slice(0, 2), 16) || 0
  const g = parseInt(clean.slice(2, 4), 16) || 0
  const b = parseInt(clean.slice(4, 6), 16) || 0
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

  return luma > 0.62 ? 'rgba(0,0,0,0.86)' : '#ffffff'
}

const clip = (text, max) => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()

  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

const nowLabel = stamp => new Date(stamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

// ---------------------------------------------------------------------------
// Updates — the repo is the source of truth
// ---------------------------------------------------------------------------

const REPO = 'iowahawkeyedave/nfl-ticker'
const REPO_URL = `https://github.com/${REPO}`
const REPO_RAW = `https://raw.githubusercontent.com/${REPO}/main/plugin.js`
const UPDATE_KEY = ['nfl-ticker', 'update']
const openRepo = () => openExternal(REPO_URL)

function versionOf(text) {
  const match = /export const VERSION = '([0-9]+(?:\.[0-9]+)*)'/.exec(String(text || ''))

  return match ? match[1] : ''
}

function isNewer(candidate, current) {
  const a = String(candidate || '').split('.').map(Number)
  const b = String(current || '').split('.').map(Number)

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0
    const y = b[i] || 0

    if (x !== y) {
      return x > y
    }
  }

  return false
}

async function fetchLatestSource() {
  const response = await fetch(`${REPO_RAW}?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit' })

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`)
  }

  const text = await response.text()

  if (!versionOf(text) || !text.includes(`export const ID = '${ID}'`)) {
    throw new Error('The file at the update URL is not this plugin')
  }

  return { version: versionOf(text), text }
}

/** Hourly at most, and only while the window is focused. */
function useUpdateCheck() {
  return useQuery({
    queryKey: UPDATE_KEY,
    queryFn: fetchLatestSource,
    staleTime: 3_600_000,
    refetchInterval: 3_600_000,
    refetchIntervalInBackground: false,
    retry: 0
  })
}

/** Overwrite this install's own plugin.js. The Electron file watcher reloads it
 *  in place, so no restart. The previous file is kept beside it for a manual
 *  rollback. Refuses to write anything that is not this plugin. */
async function installUpdate(source) {
  const bridge = globalThis.window?.hermesDesktop

  if (!bridge?.desktopPluginsRoot || !bridge?.readFileText || !bridge?.writeTextFile) {
    throw new Error(`This build cannot self-update. Reinstall from ${REPO_URL}`)
  }

  const root = await bridge.desktopPluginsRoot()
  const dir = `${String(root).replace(/[\\/]+$/, '')}/${ID}`
  const target = `${dir}/plugin.js`
  const current = await bridge.readFileText(target)

  if (!current || typeof current.text !== 'string' || !current.text.includes(`export const ID = '${ID}'`)) {
    throw new Error(`Could not find this install at ${target}. Reinstall from GitHub.`)
  }

  if (!source.includes('export default {') || !source.includes(`export const ID = '${ID}'`)) {
    throw new Error('The downloaded file failed validation')
  }

  await bridge.writeTextFile(`${dir}/plugin.js.previous`, current.text)
  await bridge.writeTextFile(target, source)

  return dir
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const TICKER_HEIGHT = 20
/** How long each live league holds the ticker before the next one takes it. */
const ROTATE_MS = 25_000

const MONO = {
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: '0.01em'
}

function TeamTag({ team, possessive, small }) {
  return jsx('span', {
    title: `${team.name} (${team.record})`,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
      padding: small ? '0 3px' : '1px 5px',
      borderRadius: 3,
      background: team.color,
      color: readableOn(team.color),
      fontSize: small ? 9 : 10,
      fontWeight: 800,
      lineHeight: small ? '12px' : '14px',
      letterSpacing: '0.04em',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10)',
      flex: '0 0 auto',
      ...MONO
    },
    children: [
      possessive
        ? jsx('span', {
            key: 'p',
            style: {
              width: 4,
              height: 4,
              borderRadius: 2,
              background: 'currentColor',
              opacity: 0.95,
              flex: '0 0 auto'
            }
          })
        : null,
      team.abbr
    ].filter(Boolean)
  })
}

function Dot({ live }) {
  if (!live) {
    return null
  }

  return jsx('span', {
    'aria-hidden': true,
    style: {
      width: 5,
      height: 5,
      borderRadius: 3,
      background: 'var(--ui-green, #55a583)',
      boxShadow: '0 0 4px var(--ui-green, #55a583)',
      flex: '0 0 auto'
    }
  })
}

const SEP = () =>
  jsx('span', {
    'aria-hidden': true,
    style: {
      color: 'var(--ui-stroke-secondary)',
      fontSize: 9,
      flex: '0 0 auto',
      padding: '0 1px'
    },
    children: '|'
  })

// ---------------------------------------------------------------------------
// Ticker segment
// ---------------------------------------------------------------------------

function LeagueChip({ league }) {
  return jsx('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 3px',
      borderRadius: 2,
      border: '1px solid var(--ui-stroke-secondary)',
      color: 'var(--ui-text-quaternary)',
      fontSize: 8.5,
      fontWeight: 700,
      letterSpacing: '0.08em',
      flex: '0 0 auto'
    },
    children: leagueLabel(league)
  })
}

function Segment({ game, onOpen, showLeague }) {
  const live = game.state === 'in'
  const finished = game.state === 'post'
  const awayWon = finished && game.away.winner
  const homeWon = finished && game.home.winner

  const scoreStyle = won => ({
    fontWeight: won ? 800 : 700,
    color: won ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
    ...MONO
  })

  const situation = game.situation?.text || ''
  const play = game.lastPlay ? clip(game.lastPlay.replace(/^\s+/, ''), 88) : ''

  const title = [game.away.name, game.home.name, statusLabel(game), game.situation?.long, game.lastPlay]
    .filter(Boolean)
    .join(' · ')

  return jsxs('button', {
    type: 'button',
    onClick: onOpen,
    title,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: '100%',
      padding: '0 2px',
      background: 'transparent',
      border: 0,
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flex: '0 0 auto'
    },
    children: [
      showLeague ? jsx(LeagueChip, { key: 'league', league: game.league }) : null,
      jsxs('span', {
        key: 'teams',
        style: { display: 'inline-flex', alignItems: 'center', gap: 3 },
        children: [
          jsx(TeamTag, { key: 'a', team: game.away, possessive: game.possession === 'away' }),
          jsx('span', { key: 'as', style: scoreStyle(awayWon), children: game.away.score || '—' }),
          jsx('span', {
            key: 'at',
            style: { color: 'var(--ui-text-quaternary)', fontSize: 9 },
            children: game.state === 'pre' ? 'at' : '–'
          }),
          jsx(TeamTag, { key: 'h', team: game.home, possessive: game.possession === 'home' }),
          jsx('span', { key: 'hs', style: scoreStyle(homeWon), children: game.home.score || '—' })
        ]
      }),
      jsx(SEP, { key: 's1' }),
      jsxs('span', {
        key: 'status',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          color: live ? 'var(--ui-text-primary)' : finished ? 'var(--ui-text-tertiary)' : 'var(--ui-text-secondary)',
          fontWeight: live ? 700 : 600,
          fontSize: 9.5,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          ...MONO
        },
        children: [jsx(Dot, { key: 'd', live }), statusLabel(game)]
      }),
      situation ? jsx(SEP, { key: 's2' }) : null,
      situation
        ? jsx('span', {
            key: 'dd',
            style: {
              color: game.situation?.redZone ? 'var(--ui-red, #e75e78)' : 'var(--ui-text-secondary)',
              fontSize: 9.5,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              flex: '0 0 auto'
            },
            children: situation
          })
        : null,
      play ? jsx(SEP, { key: 's3' }) : null,
      play
        ? jsx('span', {
            key: 'play',
            style: {
              color: 'var(--ui-text-quaternary)',
              fontSize: 9.5,
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: '0 1 auto'
            },
            children: play
          })
        : null
    ].filter(Boolean)
  })
}

function Brand({ label }) {
  return jsxs('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      flex: '0 0 auto',
      color: 'var(--ui-accent)',
      fontWeight: 800,
      fontSize: 10,
      letterSpacing: '0.12em'
    },
    children: [
      jsx('span', {
        key: 'l',
        style: {
          width: 9,
          height: 5,
          borderRadius: 3,
          border: '1.5px solid currentColor',
          display: 'inline-block',
          transform: 'rotate(-20deg)'
        }
      }),
      label
    ]
  })
}

// ---------------------------------------------------------------------------
// Marquee
// ---------------------------------------------------------------------------

const MARQUEE_CSS = `
@keyframes nfltkr-scroll { from { transform: translate3d(0,0,0); } to { transform: translate3d(-50%,0,0); } }
@media (prefers-reduced-motion: reduce) { .nfltkr-track { animation: none !important; } }
`

function useStyles() {
  useEffect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = ID
    tag.textContent = MARQUEE_CSS
    document.head.appendChild(tag)

    return () => tag.remove()
  }, [])
}

function Marquee({ speed, paused, signature, children }) {
  const wrapRef = useRef(null)
  const rowRef = useRef(null)
  const [duration, setDuration] = useState(0)
  const [scrolls, setScrolls] = useState(false)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const row = rowRef.current

    if (!wrap || !row) {
      return undefined
    }

    const measure = () => {
      const rowWidth = row.scrollWidth
      const viewWidth = wrap.clientWidth
      const needs = rowWidth > viewWidth + 2
      const next = needs ? Math.max(8, rowWidth / Math.max(12, speed)) : 0

      setScrolls(needs)
      // A live poll rewrites the row every 20s; keeping a near-identical
      // duration avoids restarting the animation mid-scroll for no reason.
      setDuration(previous => (Math.abs(previous - next) < 1 ? previous : next))
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(wrap)
    observer.observe(row)

    return () => observer.disconnect()
  }, [speed, signature])

  const trackStyle = {
    display: 'flex',
    alignItems: 'center',
    width: 'max-content',
    height: '100%',
    willChange: scrolls ? 'transform' : undefined,
    animation: scrolls && duration ? `nfltkr-scroll ${duration.toFixed(2)}s linear infinite` : 'none',
    animationPlayState: paused ? 'paused' : 'running'
  }

  const row = key =>
    jsx(
      'div',
      {
        ref: key === 'a' ? rowRef : undefined,
        'aria-hidden': key === 'b' ? true : undefined,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingRight: 18,
          visibility: key === 'b' && !scrolls ? 'hidden' : 'visible'
        },
        children
      },
      key
    )

  return jsx('div', {
    ref: wrapRef,
    style: {
      overflow: 'hidden',
      flex: '1 1 auto',
      minWidth: 0,
      height: '100%',
      maskImage: 'linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 18px), transparent 100%)',
      WebkitMaskImage: 'linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 18px), transparent 100%)'
    },
    children: jsx('div', { className: 'nfltkr-track', style: trackStyle, children: [row('a'), row('b')] })
  })
}

// ---------------------------------------------------------------------------
// Settings popover (from the gear in the ticker)
// ---------------------------------------------------------------------------

function SettingsPanel({ slates, settings }) {
  const update = useUpdateCheck()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const available = update.data && isNewer(update.data.version, VERSION) ? update.data.version : ''

  const apply = async () => {
    setBusy(true)
    setNote('')

    try {
      await installUpdate(update.data.text)
      setNote(`Updated to v${update.data.version} — reloading`)
    } catch (error) {
      setNote(error?.message || 'Update failed')
    } finally {
      setBusy(false)
    }
  }

  const teams = useMemo(() => {
    const seen = new Map()

    for (const slate of slates || []) {
      for (const game of slate.data?.games || []) {
        for (const team of [game.away, game.home]) {
          if (team?.abbr) {
            seen.set(`${game.league}:${team.abbr}`, `${leagueLabel(game.league)} · ${team.abbr} ${team.name || ''}`.trim())
          }
        }
      }
    }

    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [slates])

  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '7px 0' }
  const label = { fontSize: 11.5, color: 'var(--ui-text-secondary)' }
  const pill = (active, onClick, text, key) =>
    jsx(
      'button',
      {
        type: 'button',
        onClick,
        style: {
          padding: '2px 6px',
          borderRadius: 4,
          border: `1px solid ${active ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
          background: active ? 'var(--ui-control-hover-background)' : 'transparent',
          color: active ? 'var(--ui-text-primary)' : 'var(--ui-text-quaternary)',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          cursor: 'pointer'
        },
        children: text
      },
      key
    )

  const toggleLeague = key => {
    const current = settings.leagues || []
    const next = current.includes(key) ? current.filter(item => item !== key) : [...current, key]

    saveSettings({ leagues: next.length ? next : current })
  }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, width: 248, fontSize: 12 },
    children: [
      jsx('div', {
        key: 'title',
        style: { fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--ui-text-quaternary)', paddingBottom: 4 },
        children: 'SCORE TICKER'
      }),
      jsxs('div', {
        key: 'leagues',
        style: { ...row, gap: 6, paddingBottom: 2, alignItems: 'center' },
        children: [
          jsx('span', { key: 'l', style: { ...label, flex: '0 0 auto' }, children: 'Sports' }),
          jsx('span', {
            key: 'chips',
            style: { display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'flex-end' },
            children: LEAGUES.map(league =>
              pill(
                (settings.leagues || []).includes(league.key),
                () => toggleLeague(league.key),
                league.label,
                league.key
              )
            )
          })
        ]
      }),
      jsxs('div', {
        key: 'mode',
        style: row,
        children: [
          jsx('span', { key: 'l', style: label, children: 'Show' }),
          jsx('span', {
            key: 'seg',
            style: { display: 'flex', gap: 3 },
            children: [
              pill(settings.mode === 'auto', () => saveSettings({ mode: 'auto' }), 'One league', 'auto'),
              pill(settings.mode === 'all', () => saveSettings({ mode: 'all' }), 'All', 'all')
            ]
          })
        ]
      }),
      jsxs('label', {
        key: 'follow',
        style: row,
        children: [
          jsx('span', { key: 'l', style: label, children: 'Follow' }),
          jsx('select', {
            key: 's',
            value: settings.follow,
            onChange: event => saveSettings({ follow: event.target.value }),
            style: {
              background: 'var(--ui-bg-input, var(--ui-bg-secondary))',
              color: 'var(--ui-text-primary)',
              border: '1px solid var(--ui-stroke-secondary)',
              borderRadius: 5,
              fontSize: 11.5,
              padding: '3px 4px',
              maxWidth: 132
            },
            children: [
              jsx('option', { key: '', value: '', children: 'Everything' }, ''),
              ...teams.map(([value, name]) => jsx('option', { key: value, value, children: name }, value))
            ]
          })
        ]
      }),
      jsxs('label', {
        key: 'live',
        style: row,
        children: [
          jsx('span', { key: 'l', style: label, children: 'Hide finals' }),
          jsx(Switch, {
            key: 's',
            checked: settings.liveOnly,
            onCheckedChange: checked => saveSettings({ liveOnly: checked })
          })
        ]
      }),
      jsxs('label', {
        key: 'scroll',
        style: row,
        children: [
          jsx('span', { key: 'l', style: label, children: 'Scroll' }),
          jsx(Switch, {
            key: 's',
            checked: settings.scroll,
            onCheckedChange: checked => saveSettings({ scroll: checked })
          })
        ]
      }),
      jsxs('label', {
        key: 'speed',
        style: { ...row, alignItems: 'center' },
        children: [
          jsx('span', { key: 'l', style: label, children: 'Speed' }),
          jsx('input', {
            key: 's',
            type: 'range',
            min: 20,
            max: 200,
            step: 5,
            value: settings.speed,
            onChange: event => saveSettings({ speed: Number(event.target.value) }),
            style: { width: 108, accentColor: 'var(--ui-accent)' }
          })
        ]
      }),
      jsx('div', {
        key: 'hint',
        style: { fontSize: 10.5, color: 'var(--ui-text-quaternary)', paddingTop: 6, lineHeight: 1.4 },
        children: 'Hover to pause · click a game for the board · auto rotates the live leagues.'
      }),
      jsxs('div', {
        key: 'version',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 8,
          marginTop: 6,
          borderTop: '1px solid var(--ui-stroke-tertiary)',
          fontSize: 10.5,
          color: 'var(--ui-text-quaternary)'
        },
        children: [
          jsx('span', { key: 'v', style: MONO, children: `v${VERSION}` }),
          jsx('span', { key: 'sp', style: { flex: '1 1 auto' } }),
          available
            ? jsx(Button, {
                key: 'update',
                size: 'xs',
                variant: 'secondary',
                disabled: busy,
                onClick: () => void apply(),
                children: busy ? 'Updating…' : `Update to v${available}`
              })
            : jsx('button', {
                key: 'repo',
                type: 'button',
                onClick: () => void openRepo(),
                style: {
                  background: 'transparent',
                  border: 0,
                  padding: 0,
                  color: 'var(--ui-text-quaternary)',
                  fontSize: 10.5,
                  cursor: 'pointer',
                  textDecoration: 'underline'
                },
                children: update.isError ? 'update check failed' : 'GitHub'
              })
        ]
      }),
      note
        ? jsx('div', {
            key: 'note',
            style: { fontSize: 10.5, color: 'var(--ui-text-tertiary)', paddingTop: 4, lineHeight: 1.4 },
            children: note
          })
        : null
    ]
  })
}

// ---------------------------------------------------------------------------
// Status bar contribution
// ---------------------------------------------------------------------------

function TickerBar() {
  useStyles()

  const settings = useValue($settings)
  const slates = useSlates(settings.leagues)
  const update = useUpdateCheck()
  const updateReady = Boolean(update.data && isNewer(update.data.version, VERSION))
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)

  const openBoard = () => host.navigate('/nfl')
  const withGames = slates.filter(slate => (slate.data?.games?.length || 0) > 0)
  const liveSlates = withGames.filter(slate => slate.data.games.some(game => game.state === 'in'))
  const live = slates.filter(slate => slate.enabled)
  const loading = live.some(slate => slate.isPending)
  const errored = live.length > 0 && live.every(slate => slate.isError)

  // Auto mode shows ONE league: the one your team is playing in, else the live
  // leagues on a slow rotation, else whatever is next on the calendar.
  const focusKey = useMemo(() => {
    const followedLive = liveSlates.find(slate =>
      slate.data.games.some(game => game.state === 'in' && followMatches(game, settings.follow))
    )

    if (followedLive) {
      return followedLive.league.key
    }

    if (liveSlates.length) {
      return liveSlates[tick % liveSlates.length].league.key
    }

    const upcoming = withGames.find(slate => slate.data.games.some(game => game.state === 'pre'))

    return (upcoming || withGames[0])?.league.key || ''
  }, [slates, settings.follow, tick])

  const rotating = settings.mode === 'auto' && liveSlates.length > 1

  useEffect(() => {
    if (!rotating) {
      return undefined
    }

    const timer = setInterval(() => setTick(value => value + 1), ROTATE_MS)

    return () => clearInterval(timer)
  }, [rotating])

  const shown = (settings.mode === 'all' ? withGames : withGames.filter(slate => slate.league.key === focusKey))
    .map(slate => ({ league: slate.league.key, games: visibleGames(slate, settings) }))
    .filter(entry => entry.games.length > 0)

  const content = []

  if (!shown.length && loading) {
    content.push(
      jsx(
        'span',
        { style: { color: 'var(--ui-text-quaternary)', fontSize: 9.5, letterSpacing: '0.06em' }, children: 'LOADING SLATES…' },
        'load'
      )
    )
  } else if (!shown.length && errored) {
    content.push(
      jsx(
        'button',
        {
          type: 'button',
          onClick: () => slates.forEach(slate => void slate.refetch()),
          style: {
            background: 'transparent',
            border: 0,
            color: 'var(--ui-text-tertiary)',
            fontSize: 9.5,
            cursor: 'pointer',
            padding: 0
          },
          children: 'Scores unavailable — retry'
        },
        'err'
      )
    )
  } else if (!shown.length) {
    content.push(
      jsx(
        'span',
        {
          style: { color: 'var(--ui-text-quaternary)', fontSize: 9.5, letterSpacing: '0.05em', textTransform: 'uppercase' },
          children: settings.follow ? `No game for ${settings.follow.replace(':', ' ')}` : 'No games on the slate'
        },
        'empty'
      )
    )
  } else {
    for (const entry of shown) {
      if (settings.mode === 'all') {
        content.push(jsx(LeagueChip, { league: entry.league }, `chip-${entry.league}`))
      }

      for (const game of entry.games) {
        content.push(jsx(Segment, { game, onOpen: openBoard }, game.id))
        content.push(jsx(SEP, {}, `sep-${game.id}`))
      }
    }
  }

  const bar = jsxs('div', {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: '100%',
      maxHeight: TICKER_HEIGHT,
      width: 'clamp(300px, 46vw, 760px)',
      minWidth: 0,
      flex: '0 0 auto',
      overflow: 'hidden'
    },
    children: [
      jsx(Brand, { label: settings.mode === 'all' ? 'SCORES' : leagueLabel(focusKey) || 'SCORES' }, 'brand'),
      content.length
        ? jsx(Marquee, {
            key: 'm',
            speed: settings.speed,
            signature: shown
              .map(entry => `${entry.league}:${entry.games.map(g => `${g.id}:${g.away.score}-${g.home.score}:${g.clock}:${g.state}`).join(',')}`)
              .join('|') || `${loading}|${errored}`,
            paused: hover || pinned || !settings.scroll,
            children: content
          })
        : null,
      jsx(Popover, {
        key: 'gear',
        open,
        onOpenChange: setOpen,
        children: [
          jsx(PopoverTrigger, {
            key: 'trigger',
            asChild: true,
            children: jsx('button', {
              type: 'button',
              title: updateReady ? `Score ticker settings — v${update.data.version} available` : 'Score ticker settings',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 16,
                height: 16,
                border: 0,
                borderRadius: 3,
                background: open ? 'var(--ui-control-hover-background)' : 'transparent',
                color: updateReady ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)',
                cursor: 'pointer',
                flex: '0 0 auto',
                padding: 0
              },
              children: jsx(Codicon, { name: 'settings-gear', size: 12 })
            })
          }),
          jsx(PopoverContent, {
            key: 'content',
            side: 'top',
            align: 'end',
            sideOffset: 8,
            collisionPadding: 10,
            children: jsx(SettingsPanel, { slates, settings })
          })
        ]
      }),
      jsx('button', {
        key: 'pin',
        type: 'button',
        onClick: () => setPinned(value => !value),
        title: pinned ? 'Resume scrolling' : 'Pause scrolling',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 16,
          height: 16,
          border: 0,
          borderRadius: 3,
          background: 'transparent',
          color: pinned ? 'var(--ui-accent)' : 'var(--ui-text-quaternary)',
          cursor: 'pointer',
          flex: '0 0 auto',
          padding: 0
        },
        children: jsx(Codicon, { name: pinned ? 'play' : 'debug-pause', size: 12 })
      })
    ]
  })

  return bar
}

// ---------------------------------------------------------------------------
// Scoreboard page
// ---------------------------------------------------------------------------

function TeamLogo({ team }) {
  const [failed, setFailed] = useState(false)

  if (!team.logo || failed) {
    return jsx('span', {
      style: {
        width: 22,
        height: 22,
        borderRadius: 5,
        background: team.color,
        color: readableOn(team.color),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 8,
        fontWeight: 800,
        letterSpacing: '0.03em',
        flex: '0 0 auto',
        ...MONO
      },
      children: team.abbr.slice(0, 3)
    })
  }

  return jsx('img', {
    src: team.logo,
    alt: team.abbr,
    width: 22,
    height: 22,
    loading: 'lazy',
    decoding: 'async',
    onError: () => setFailed(true),
    style: { width: 22, height: 22, objectFit: 'contain', flex: '0 0 auto' }
  })
}

function TeamRow({ team, score, winner, live, dim }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' },
    children: [
      jsx(TeamLogo, { key: 'logo', team }),
      jsxs('span', {
        key: 'name',
        style: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' },
        children: [
          jsx('span', {
            key: 'n',
            style: {
              fontSize: 12.5,
              fontWeight: winner ? 700 : 500,
              color: dim ? 'var(--ui-text-tertiary)' : 'var(--ui-text-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            },
            children: team.name || team.abbr
          }),
          jsx('span', {
            key: 'r',
            style: { fontSize: 10.5, color: 'var(--ui-text-quaternary)', ...MONO },
            children: team.record
          })
        ]
      }),
      jsx('span', {
        key: 'score',
        style: {
          fontSize: 19,
          fontWeight: winner ? 800 : 600,
          color: live ? 'var(--ui-text-primary)' : dim ? 'var(--ui-text-tertiary)' : 'var(--ui-text-secondary)',
          ...MONO
        },
        children: score || '—'
      })
    ]
  })
}

function LeadersPanel({ game }) {
  const summary = useQuery({
    queryKey: ['nfl-ticker', 'summary', game.league, game.id],
    queryFn: ({ signal }) => getJSON(summaryUrl(LEAGUE_BY_KEY[game.league] || LEAGUES[0], game.id), signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 0
  })

  if (summary.isPending) {
    return jsx('div', { style: { fontSize: 11, color: 'var(--ui-text-quaternary)', padding: '6px 0' }, children: 'Loading details…' })
  }

  if (summary.isError) {
    return jsx('div', { style: { fontSize: 11, color: 'var(--ui-text-quaternary)', padding: '6px 0' }, children: 'Details unavailable.' })
  }

  const data = summary.data || {}
  const scoring = (data.scoringPlays || []).slice(0, 8)
  const leaders = []

  for (const teamBlock of data.leaders || []) {
    const abbr = teamBlock.team?.abbreviation || ''

    for (const category of teamBlock.categories || []) {
      const top = (category.leaders || [])[0]

      if (!top) {
        continue
      }

      leaders.push({
        key: `${abbr}-${category.name}`,
        abbr,
        category: category.displayName || category.name,
        who: top.athlete?.shortName || top.displayName || '',
        stat: top.displayValue || String(top.value ?? '')
      })
    }
  }

  const sectionTitle = text =>
    jsx('div', {
      style: {
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.09em',
        color: 'var(--ui-text-quaternary)',
        padding: '8px 0 3px'
      },
      children: text
    })

  return jsxs('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      borderTop: '1px solid var(--ui-stroke-tertiary)',
      marginTop: 8,
      paddingTop: 4
    },
    children: [
      leaders.length ? sectionTitle('LEADERS') : null,
      ...leaders.map(entry =>
        jsxs(
          'div',
          {
            style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '1px 0', color: 'var(--ui-text-secondary)' },
            children: [
              jsx('span', { style: { width: 30, color: 'var(--ui-text-quaternary)', ...MONO }, children: entry.abbr }),
              jsx('span', { style: { width: 86, color: 'var(--ui-text-tertiary)' }, children: entry.category }),
              jsx('span', { style: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }, children: entry.who }),
              jsx('span', { style: { ...MONO, color: 'var(--ui-text-primary)' }, children: entry.stat })
            ]
          },
          entry.key
        )
      ),
      scoring.length ? sectionTitle('SCORING') : null,
      ...scoring.map((play, index) =>
        jsxs(
          'div',
          {
            style: { display: 'flex', gap: 8, fontSize: 11.5, padding: '1px 0', color: 'var(--ui-text-tertiary)' },
            children: [
              jsx('span', {
                style: { width: 30, color: 'var(--ui-text-quaternary)', ...MONO },
                children: play.period?.displayValue || ''
              }),
              jsx('span', { style: { flex: '1 1 auto', minWidth: 0 }, children: clip(play.text, 160) }),
              jsx('span', {
                style: { ...MONO, color: 'var(--ui-text-primary)' },
                children: `${play.awayScore ?? ''}-${play.homeScore ?? ''}`
              })
            ]
          },
          `sp-${index}`
        )
      )
    ]
  })
}

function GameCard({ game }) {
  const [expanded, setExpanded] = useState(false)
  const live = game.state === 'in'
  const finished = game.state === 'post'

  return jsxs('div', {
    style: {
      background: 'var(--ui-bg-card)',
      border: `1px solid ${live ? 'var(--ui-stroke-secondary)' : 'var(--ui-stroke-tertiary)'}`,
      borderRadius: 10,
      padding: '10px 12px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0
    },
    children: [
      jsxs('div', {
        key: 'head',
        style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase' },
        children: [
          jsx(Dot, { key: 'd', live }),
          jsx('span', {
            key: 'st',
            style: {
              color: live ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)',
              fontWeight: live ? 700 : 600,
              ...MONO
            },
            children: statusLabel(game)
          }),
          game.situation?.redZone ? jsx('span', { key: 'rz', style: { color: 'var(--ui-red, #e75e78)', fontWeight: 700 }, children: 'RED ZONE' }) : null,
          jsx('span', { key: 'sp', style: { flex: '1 1 auto' } }),
          game.broadcast
            ? jsx('span', { key: 'bc', style: { color: 'var(--ui-text-quaternary)' }, children: game.broadcast })
            : null
        ].filter(Boolean)
      }),
      jsx(TeamRow, {
        key: 'away',
        team: game.away,
        score: game.away.score,
        winner: finished && game.away.winner,
        live,
        dim: finished && game.home.winner
      }),
      jsx(TeamRow, {
        key: 'home',
        team: game.home,
        score: game.home.score,
        winner: finished && game.home.winner,
        live,
        dim: finished && game.away.winner
      }),
      game.situation?.long
        ? jsxs('div', {
            key: 'dd',
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: game.situation.redZone ? 'var(--ui-red, #e75e78)' : 'var(--ui-text-secondary)',
              paddingTop: 3
            },
            children: [
              jsx('span', { key: 't', style: { fontWeight: 600 }, children: game.situation.long }),
              game.possession
                ? jsx('span', { key: 'p', style: { color: 'var(--ui-text-quaternary)' }, children: `· ${game.possession === 'home' ? game.home.abbr : game.away.abbr} ball` })
                : null
            ]
          })
        : null,
      game.lastPlay
        ? jsx('div', {
            key: 'lp',
            style: { fontSize: 11, color: 'var(--ui-text-tertiary)', paddingTop: 3, lineHeight: 1.35 },
            children: clip(game.lastPlay, 180)
          })
        : null,
      game.venue
        ? jsx('div', { key: 'venue', style: { fontSize: 10, color: 'var(--ui-text-quaternary)', paddingTop: 4 }, children: game.venue })
        : null,
      jsx('button', {
        key: 'more',
        type: 'button',
        onClick: () => setExpanded(value => !value),
        style: {
          alignSelf: 'flex-start',
          marginTop: 6,
          background: 'transparent',
          border: 0,
          padding: 0,
          color: 'var(--ui-text-quaternary)',
          fontSize: 10.5,
          letterSpacing: '0.04em',
          cursor: 'pointer'
        },
        children: expanded ? 'Hide details' : 'Details'
      }),
      expanded ? jsx(LeadersPanel, { key: 'panel', game }) : null
    ].filter(Boolean)
  })
}

function LeagueSection({ league, games, week }) {
  return jsxs('section', {
    style: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 18 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', gap: 8, paddingBottom: 2, borderBottom: '1px solid var(--ui-stroke-tertiary)' },
        children: [
          jsx('span', { style: { fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--ui-text-secondary)' }, children: league.label }),
          week ? jsx('span', { style: { fontSize: 10.5, color: 'var(--ui-text-quaternary)' }, children: week }) : null,
          jsx('span', { style: { flex: '1 1 auto' } }),
          liveCount(games)
            ? jsxs('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--ui-text-tertiary)' },
                children: [jsx(Dot, { live: true }), `${liveCount(games)} live`]
              })
            : null
        ]
      }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))', gap: 12 },
        children: games.map(game => jsx(GameCard, { game }, game.id))
      })
    ]
  })
}

function NflPage() {
  const settings = useValue($settings)
  const slates = useSlates(settings.leagues)
  const [filter, setFilter] = useState('all')
  const groups = slates
    .map(slate => ({ league: slate.league, games: visibleGames(slate, settings), week: slate.data?.week || '' }))
    .filter(group => group.games.length > 0)
    .filter(group => filter === 'all' || group.league.key === filter)
  const live = groups.reduce((total, group) => total + liveCount(group.games), 0)
  const active = slates.filter(slate => slate.enabled)
  const loading = active.some(slate => slate.isPending)
  const errored = active.length > 0 && active.every(slate => slate.isError)
  const updated = Math.max(0, ...active.map(slate => slate.data?.updatedAt || 0))

  const chipRow = jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, flexWrap: 'wrap' },
    children: [
      jsx(
        'button',
        {
          type: 'button',
          onClick: () => setFilter('all'),
          style: {
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${filter === 'all' ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
            background: filter === 'all' ? 'var(--ui-control-hover-background)' : 'transparent',
            color: filter === 'all' ? 'var(--ui-text-primary)' : 'var(--ui-text-quaternary)',
            fontSize: 10.5,
            letterSpacing: '0.05em',
            cursor: 'pointer'
          },
          children: 'ALL'
        },
        'all'
      ),
      ...slates
        .filter(slate => slate.enabled)
        .map(slate =>
          jsx(
            'button',
            {
              type: 'button',
              onClick: () => setFilter(slate.league.key),
              style: {
                padding: '2px 8px',
                borderRadius: 999,
                border: `1px solid ${filter === slate.league.key ? 'var(--ui-accent)' : 'var(--ui-stroke-secondary)'}`,
                background: filter === slate.league.key ? 'var(--ui-control-hover-background)' : 'transparent',
                color: filter === slate.league.key ? 'var(--ui-text-primary)' : 'var(--ui-text-quaternary)',
                fontSize: 10.5,
                letterSpacing: '0.05em',
                cursor: 'pointer',
                opacity: (slate.data?.games?.length || 0) ? 1 : 0.45
              },
              children: slate.league.label
            },
            slate.league.key
          )
        )
    ]
  })

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
    children: [
      jsx('span', { style: { fontSize: 17, fontWeight: 700, letterSpacing: '0.02em' }, children: 'Scores' }),
      jsx('span', {
        style: { fontSize: 11, color: 'var(--ui-text-quaternary)', ...MONO },
        children: live ? `${live} live · updated ${updated ? nowLabel(updated) : '—'}` : `updated ${updated ? nowLabel(updated) : '—'}`
      }),
      jsx('span', { style: { flex: '1 1 auto' } }),
      jsx(Button, {
        size: 'sm',
        variant: 'secondary',
        onClick: () => slates.forEach(slate => void slate.refetch()),
        children: 'Refresh'
      })
    ]
  })

  let body

  if (loading && !groups.length) {
    body = jsx('div', { style: { fontSize: 12, color: 'var(--ui-text-tertiary)' }, children: 'Loading the slates…' })
  } else if (!groups.length && errored) {
    body = jsxs('div', {
      style: { fontSize: 12, color: 'var(--ui-text-secondary)', display: 'flex', flexDirection: 'column', gap: 8 },
      children: [
        jsx('span', { children: 'Could not reach ESPN for any league.' }),
        jsx(Button, {
          size: 'sm',
          variant: 'secondary',
          onClick: () => slates.forEach(slate => void slate.refetch()),
          children: 'Try again'
        })
      ]
    })
  } else if (!groups.length) {
    body = jsxs('div', {
      style: { fontSize: 12, color: 'var(--ui-text-tertiary)', display: 'flex', flexDirection: 'column', gap: 6 },
      children: [
        jsx('span', {
          children: settings.follow
            ? `No games for ${settings.follow.replace(':', ' ')} on these slates.`
            : 'No games on the selected slates.'
        }),
        jsx('span', {
          style: { fontSize: 11, color: 'var(--ui-text-quaternary)' },
          children: 'Season over or out of range — add a sport in the ticker settings.'
        })
      ]
    })
  } else {
    body = jsx('div', {
      style: { display: 'flex', flexDirection: 'column' },
      children: groups.map(group => jsx(LeagueSection, { league: group.league, games: group.games, week: group.week }, group.league.key))
    })
  }

  return jsxs('div', {
    style: {
      height: '100%',
      overflowY: 'auto',
      padding: '18px 20px 28px',
      display: 'flex',
      flexDirection: 'column',
      fontSize: 12
    },
    children: [header, chipRow, body]
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'Score Ticker',
  version: VERSION,

  register(ctx) {
    storage = ctx.storage
    openExternal = url => (ctx.os && ctx.os.openExternal ? ctx.os.openExternal(url) : Promise.resolve(false))
    $settings.set(loadSettings())

    ctx.registerMany([
      {
        id: 'ticker',
        area: STATUSBAR_AREAS.left,
        order: 120,
        render: () => jsx(TickerBar, {})
      },
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/nfl' },
        render: () => jsx(NflPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { path: '/nfl', label: 'Scores', codicon: 'broadcast' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.open',
          label: 'Scores: Open the scoreboard',
          keywords: ['scores', 'nfl', 'nba', 'nhl', 'mlb', 'college', 'sports', 'ticker'],
          run: () => host.navigate('/nfl')
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.refresh',
          label: 'Scores: Refresh every league',
          keywords: ['scores', 'sports', 'refresh', 'ticker'],
          run: () => {
            void queryClient.invalidateQueries({ queryKey: ['nfl-ticker', 'slate'] })
            host.notify({ kind: 'info', message: 'Scores refreshed' })
          }
        }
      },
      {
        id: 'check-updates',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.checkUpdates',
          label: 'Scores: Check the ticker for updates',
          keywords: ['ticker', 'update', 'upgrade'],
          run: () => {
            void queryClient.invalidateQueries({ queryKey: UPDATE_KEY }).then(async () => {
              const latest = queryClient.getQueryData(UPDATE_KEY)

              if (!latest) {
                host.notify({ kind: 'error', message: 'Could not reach GitHub for the update check' })
              } else if (isNewer(latest.version, VERSION)) {
                host.notify({ kind: 'info', message: `Score Ticker v${latest.version} is available — open the ticker settings gear` })
              } else {
                host.notify({ kind: 'info', message: `Score Ticker is up to date (v${VERSION})` })
              }
            })
          }
        }
      },
      {
        id: 'toggle-scroll',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.toggleScroll',
          label: 'Scores: Toggle ticker scrolling',
          keywords: ['ticker', 'scores', 'scroll', 'pause'],
          run: () => {
            const next = saveSettings({ scroll: !$settings.get().scroll })
            host.notify({ kind: 'info', message: next.scroll ? 'Ticker scrolling on' : 'Ticker paused' })
          }
        }
      }
    ])
  }
}

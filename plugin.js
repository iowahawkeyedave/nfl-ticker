/**
 * NFL Ticker — a live NFL score ticker in the Hermes status bar.
 * ------------------------------------------------------------------
 * Port of the idea behind github.com/krypdoh/NFL-TCKR (a Windows AppBar
 * ticker) to Hermes Desktop: instead of reserving a desktop strip, the
 * ticker lives in the app's own bottom status bar and scrolls the whole
 * week's slate — team-coloured tags, scores, game clock, down & distance,
 * possession marker and the last play.
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
export const VERSION = '1.0.0'

// ---------------------------------------------------------------------------
// Endpoints + settings
// ---------------------------------------------------------------------------

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
const summaryUrl = id => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${id}`
const QUERY_KEY = ['nfl-ticker', 'scoreboard']

const DEFAULTS = { follow: '', speed: 70, liveOnly: false, scroll: true }

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

function parseGame(event) {
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

function parseScoreboard(json) {
  const games = (json.events || []).map(parseGame)
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
    games,
    week: json.week?.label || '',
    season: json.season?.year ? String(json.season.year) : '',
    updatedAt: Date.now()
  }
}

function useScoreboard() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ signal }) => getJSON(SCOREBOARD_URL, signal).then(parseScoreboard),
    refetchInterval: query => intervalFor(query.state.data),
    refetchIntervalInBackground: false,
    staleTime: 10_000,
    retry: 1
  })
}

function useFollowed(games) {
  const settings = useValue($settings)
  const slate = games || []

  const visible = useMemo(() => {
    let list = slate

    if (settings.follow) {
      list = list.filter(g => g.away.abbr === settings.follow || g.home.abbr === settings.follow)
    }

    if (settings.liveOnly) {
      list = list.filter(g => g.state !== 'post')
    }

    return list
  }, [slate, settings.follow, settings.liveOnly])

  return { settings, games: visible }
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

function statusLabel(game) {
  if (game.state === 'in') {
    return `${game.clock} ${ordinalQuarter(game.period)}`.trim()
  }

  if (game.state === 'post') {
    return game.shortDetail || 'Final'
  }

  return kickoffLabel(game.date)
}

function ordinalQuarter(period) {
  if (!period) {
    return ''
  }

  if (period === 5) {
    return 'OT'
  }

  return `${period}${period === 1 ? 'st' : period === 2 ? 'nd' : period === 3 ? 'rd' : 'th'}`
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

function Segment({ game, onOpen }) {
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

function Brand() {
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
      'NFL'
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

function SettingsPanel({ games, settings }) {
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

    for (const game of games || []) {
      for (const team of [game.away, game.home]) {
        if (team?.abbr && !seen.has(team.abbr)) {
          seen.set(team.abbr, team.name || team.abbr)
        }
      }
    }

    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [games])

  const row = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '7px 0' }
  const label = { fontSize: 11.5, color: 'var(--ui-text-secondary)' }

  return jsxs('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, width: 248, fontSize: 12 },
    children: [
      jsx('div', {
        key: 'title',
        style: { fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--ui-text-quaternary)', paddingBottom: 4 },
        children: 'NFL TICKER'
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
              jsx('option', { key: '', value: '', children: 'Whole slate' }, ''),
              ...teams.map(([abbr, name]) => jsx('option', { key: abbr, value: abbr, children: `${abbr} — ${name}` }, abbr))
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
        children: 'Hover the ticker to pause. Click a game for the full board.'
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

  const query = useScoreboard()
  const update = useUpdateCheck()
  const updateReady = Boolean(update.data && isNewer(update.data.version, VERSION))
  const { settings, games } = useFollowed(query.data?.games)
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [open, setOpen] = useState(false)

  const openBoard = () => host.navigate('/nfl')

  const content = []

  if (query.isPending) {
    content.push(
      jsx(
        'span',
        { style: { color: 'var(--ui-text-quaternary)', fontSize: 9.5, letterSpacing: '0.06em' }, children: 'LOADING SLATE…' },
        'load'
      )
    )
  } else if (query.isError) {
    content.push(
      jsx(
        'button',
        {
          type: 'button',
          onClick: () => void query.refetch(),
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
  } else if (!games.length) {
    content.push(
      jsx(
        'span',
        {
          style: { color: 'var(--ui-text-quaternary)', fontSize: 9.5, letterSpacing: '0.05em', textTransform: 'uppercase' },
          children: settings.follow ? `No game for ${settings.follow}` : 'No games on the slate'
        },
        'empty'
      )
    )
  } else {
    games.forEach(game => {
      content.push(jsx(Segment, { game, onOpen: openBoard }, game.id))
      content.push(jsx(SEP, {}, `sep-${game.id}`))
    })
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
      jsx(Brand, {}, 'brand'),
      content.length
        ? jsx(Marquee, {
            key: 'm',
            speed: settings.speed,
            signature: `${games.map(g => `${g.id}:${g.away.score}-${g.home.score}:${g.clock}:${g.state}`).join('|')}|${settings.follow}|${query.isPending}`,
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
              title: updateReady ? `NFL ticker settings — v${update.data.version} available` : 'NFL ticker settings',
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
            children: jsx(SettingsPanel, { games: query.data?.games, settings })
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

function LeadersPanel({ gameId }) {
  const summary = useQuery({
    queryKey: ['nfl-ticker', 'summary', gameId],
    queryFn: ({ signal }) => getJSON(summaryUrl(gameId), signal),
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
      expanded ? jsx(LeadersPanel, { key: 'panel', gameId: game.id }) : null
    ].filter(Boolean)
  })
}

function NflPage() {
  const query = useScoreboard()
  const { settings, games } = useFollowed(query.data?.games)
  const all = query.data?.games || []

  const header = jsxs('div', {
    style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14, flexWrap: 'wrap' },
    children: [
      jsx('span', { style: { fontSize: 17, fontWeight: 700, letterSpacing: '0.02em' }, children: 'NFL' }),
      query.data?.week ? jsx('span', { style: { fontSize: 12, color: 'var(--ui-text-tertiary)' }, children: query.data.week }) : null,
      jsx('span', { style: { flex: '1 1 auto' } }),
      jsx('span', {
        style: { fontSize: 11, color: 'var(--ui-text-quaternary)', ...MONO },
        children: liveCount(all) ? `${liveCount(all)} live · updated ${nowLabel(query.data.updatedAt)}` : `updated ${nowLabel(query.data?.updatedAt || Date.now())}`
      }),
      jsx(Button, { size: 'sm', variant: 'secondary', onClick: () => void query.refetch(), children: 'Refresh' })
    ].filter(Boolean)
  })

  let body

  if (query.isPending) {
    body = jsx('div', { style: { fontSize: 12, color: 'var(--ui-text-tertiary)' }, children: 'Loading the slate…' })
  } else if (query.isError) {
    body = jsxs('div', {
      style: { fontSize: 12, color: 'var(--ui-text-secondary)', display: 'flex', flexDirection: 'column', gap: 8 },
      children: [
        jsx('span', { children: `Could not reach ESPN: ${query.error?.message || 'unknown error'}` }),
        jsx(Button, { size: 'sm', variant: 'secondary', onClick: () => void query.refetch(), children: 'Try again' })
      ]
    })
  } else if (!games.length) {
    body = jsx('div', {
      style: { fontSize: 12, color: 'var(--ui-text-tertiary)' },
      children: settings.follow ? `No games for ${settings.follow} on this slate.` : 'No games on the slate.'
    })
  } else {
    body = jsx('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))',
        gap: 12
      },
      children: games.map(game => jsx(GameCard, { game }, game.id))
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
    children: [header, body]
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'NFL Ticker',
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
        data: { path: '/nfl', label: 'NFL', codicon: 'broadcast' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.open',
          label: 'NFL: Open scoreboard',
          keywords: ['nfl', 'football', 'scores', 'ticker'],
          run: () => host.navigate('/nfl')
        }
      },
      {
        id: 'refresh',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.refresh',
          label: 'NFL: Refresh scores',
          keywords: ['nfl', 'scores', 'refresh'],
          run: () => {
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
            host.notify({ kind: 'info', message: 'NFL scores refreshed' })
          }
        }
      },
      {
        id: 'check-updates',
        area: PALETTE_AREA,
        data: {
          id: 'nfl.checkUpdates',
          label: 'NFL: Check the ticker for updates',
          keywords: ['nfl', 'ticker', 'update', 'upgrade'],
          run: () => {
            void queryClient.invalidateQueries({ queryKey: UPDATE_KEY }).then(async () => {
              const latest = queryClient.getQueryData(UPDATE_KEY)

              if (!latest) {
                host.notify({ kind: 'error', message: 'Could not reach GitHub for the update check' })
              } else if (isNewer(latest.version, VERSION)) {
                host.notify({ kind: 'info', message: `NFL Ticker v${latest.version} is available — open the ticker settings gear` })
              } else {
                host.notify({ kind: 'info', message: `NFL Ticker is up to date (v${VERSION})` })
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
          label: 'NFL: Toggle ticker scrolling',
          keywords: ['nfl', 'ticker', 'scroll', 'pause'],
          run: () => {
            const next = saveSettings({ scroll: !$settings.get().scroll })
            host.notify({ kind: 'info', message: next.scroll ? 'Ticker scrolling on' : 'Ticker paused' })
          }
        }
      }
    ])
  }
}

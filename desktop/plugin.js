/**
 * Hermes Eyes for Hermes Desktop.
 *
 * A pair of round googly eyes that live on the message box. They follow the
 * mouse, and when you stop moving it they react to the chat you are looking
 * at: they look up while the agent thinks, glance at each tool it runs, and
 * smile when it finishes. While a reply streams in, its letters fly out of
 * the eyes and land on the newest word; file names, commands, links and
 * numbers fly out whole and make that word glow.
 *
 * They also keep an eye on the chats you are NOT looking at:
 *
 * - A chat in another tab finishes, asks for an approval or a question, or
 *   seems stuck: the status-bar chip shows "N waiting". Click the chip or the
 *   eyes: one chat opens straight away; with more, a list shows each agent,
 *   what it is waiting for and what it last said.
 * - An approval or question in the chat in front of you: the eyes shoot a "!"
 *   at it and a ring pulses round it until it is answered.
 * - Something breaks (the turn errors, or a tool fails): worried eyes, and in
 *   another tab a red "N problem" chip.
 * - Step away and they doze off; come back and "While you were away" lists
 *   everything that finished or asked for you meanwhile.
 * - Hover them for a bubble: who, doing what, for how long.
 *
 * Also: a team chip while agents work, each agent's own eye colour, petting
 * (press and hold), sparks when a long task finishes, and a palette command
 * that copies the terminal command for the open chat. Scripts can open a chat
 * with hermes://open/hermes-eyes-open?session=ID&profile=NAME.
 *
 * Drag the eyes anywhere and they stay there; the list can put them back and
 * hide or show them. While they show, Hermes's own floating pet is hidden in
 * this window only.
 *
 * Plain ESM loaded uncompiled: jsx() calls, and only the three allowed imports.
 */
import {
  cn,
  haptic,
  host,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  profileColor,
  ROUTES_AREA,
  Tip
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'

const ID = 'hermes-eyes'
const AWAY_UNFOCUSED_MS = 60 * 1000 // another window in front this long
const AWAY_IDLE_MS = 3 * 60 * 1000 // or no mouse or keys this long

// --- what the eyes know -------------------------------------------------------------
//
// Gateway signals name chats by their live (runtime) id; opening one needs its
// saved id and profile. Desktop reports both for the chat in front of you, so
// every chat you have looked at gets its pair remembered here, together with
// the first line of the last thing it said.

const sessions = new Map() // runtime id -> { stored, profile, said, at }
const waiting = new Map() // runtime id -> { reason, at }
const awayLog = new Map() // runtime id -> { reason, at } gathered while you were away
let names = {} // profile slug -> display name
let previousBusy = {}
let store = null // ctx.storage, set in register()

let away = false
let lastActive = Date.now()
let blurredAt = 0

const ui = { open: false, mode: 'waiting', items: [] } // the list's state
const subscribers = new Set()
const notify = () => subscribers.forEach(fn => fn())

function focusedId() {
  return host.state.focusedSessionId?.get?.() ?? host.state.activeSessionId?.get?.() ?? null
}

function remember() {
  const sid = focusedId()
  const stored = host.state.focusedStoredSessionId?.get?.()
  if (!sid || !stored) return
  const known = sessions.get(sid) || {}
  sessions.set(sid, { ...known, stored, profile: host.state.focusedSessionProfile?.get?.() || known.profile })
}

function agentName(profile) {
  if (!profile) return 'An agent'
  const shown = names[profile]
  if (shown) return shown
  return profile.charAt(0).toUpperCase() + profile.slice(1)
}

function firstLine(text) {
  const line = String(text || '')
    .replace(/[`*_#>💬]/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(Boolean)
  if (!line) return ''
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

function flag(sid, reason) {
  const entry = { reason, at: Date.now() }
  if (sid !== focusedId()) waiting.set(sid, entry)
  if (away) awayLog.set(sid, entry)
  notify()
}

// Something broke: the gateway's own `error` event (a failed turn), or a
// tool.complete that carries an error -- the same two signals Hermes uses to
// make its own pet react. The focused chat already shows it, so it only
// worries the eyes for a moment; any other chat is flagged until you open it.
let worryUntil = 0
let glanceUntil = 0 // glance at the newest tool step until then

function problem(sid, detail) {
  worryUntil = performance.now() + 2600
  if (sid) {
    const entry = { reason: 'error', at: Date.now(), detail }
    if (sid !== focusedId()) waiting.set(sid, entry)
    if (away) awayLog.set(sid, entry)
  }
  notify()
}

const busySince = new Map() // runtime id -> when it started working

// --- what each agent is doing ----------------------------------------------------------
//
// The last sign of life from each chat -- a word, a tool step, anything -- and
// the tool it is running, so the eyes can say what it is up to and notice when
// a working chat has gone quiet for a long time.

const STUCK_MS = 3 * 60 * 1000
const activity = new Map() // runtime id -> { at, tool, wroteAt }

function touch(sid, patch) {
  if (!sid) return
  const a = activity.get(sid) || { at: 0, tool: null, wroteAt: 0 }
  Object.assign(a, { at: Date.now() }, patch)
  activity.set(sid, a)
  if (waiting.get(sid)?.reason === 'stuck') {
    waiting.delete(sid)
    notify()
  }
}

function quietFor(sid) {
  const a = activity.get(sid)
  return a ? Date.now() - a.at : 0
}

// Working, but no word and no step for a while -- and not because it is
// waiting on you for an approval or an answer.
function isStuck(sid) {
  if (!sid || !(host.state.busyBySession?.get?.() || {})[sid]) return false
  const w = waiting.get(sid)
  if (w && w.reason !== 'stuck') return false
  return quietFor(sid) > (store?.get?.('stuckMs', STUCK_MS) ?? STUCK_MS)
}

function checkStuck() {
  const busy = host.state.busyBySession?.get?.() || {}
  let changed = false
  for (const sid of Object.keys(busy)) {
    if (!busy[sid] || sid === focusedId() || waiting.has(sid) || !isStuck(sid)) continue
    waiting.set(sid, { reason: 'stuck', at: Date.now(), detail: `quiet for ${dur(quietFor(sid))}` })
    changed = true
  }
  if (changed) notify()
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 10) return `${m}m ${s % 60}s`
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// One line for the bubble over the eyes: who, doing what, for how long.
function peekText(attn) {
  const sid = focusedId()
  const profile = host.state.focusedSessionProfile?.get?.()
  const name = profile ? agentName(profile) : 'Hermes'
  const busy = !!(sid && (host.state.busyBySession?.get?.() || {})[sid]) || !!host.state.busy?.get?.()
  const a = sid && activity.get(sid)
  let doing
  if (attn) doing = 'needs your OK'
  else if (!busy) doing = 'all quiet'
  else if (a?.tool) doing = `running ${a.tool}`
  else if (a && Date.now() - a.wroteAt < 1500) doing = 'writing'
  else if (host.state.awaitingResponse?.get?.()) doing = 'thinking'
  else doing = 'working'
  const parts = [name, doing]
  const since = sid && busySince.get(sid)
  if (busy && since) parts.push(dur(Date.now() - since))
  if (waiting.size) parts.push(`${waiting.size} waiting`)
  return parts.join(' · ')
}

function onBusyChange(now) {
  now = now || {}
  for (const [sid, on] of Object.entries(now)) {
    if (on && !previousBusy[sid]) {
      busySince.set(sid, Date.now())
      touch(sid, { tool: null })
    }
  }
  for (const sid of [...busySince.keys()]) if (!now[sid]) busySince.delete(sid)
  for (const [sid, was] of Object.entries(previousBusy)) {
    if (was && !now[sid] && (sid !== focusedId() || away)) flag(sid, 'finished')
  }
  previousBusy = { ...now }
  notify()
}

function onFocusChange(sid) {
  remember()
  if (sid && waiting.delete(sid)) notify()
}

function onAnyEvent(event) {
  const type = String(event?.type || '')
  const sid = event?.session_id || event?.payload?.session_id || event?.payload?.sessionId
  if (sid) {
    if (type === 'tool.start') touch(sid, { tool: String(event?.payload?.name || 'a tool').replace(/_/g, ' ') })
    else if (type === 'tool.complete') touch(sid, { tool: null })
    else if (type === 'message.delta') touch(sid, { tool: null, wroteAt: Date.now() })
    else touch(sid)
  }
  if (type === 'error') {
    problem(sid, firstLine(event?.payload?.message) || 'Hermes reported an error')
    return
  }
  if (type === 'tool.complete' && event?.payload?.error) {
    const err = event.payload.error
    const text = firstLine(typeof err === 'string' ? err : err?.message || '')
    problem(sid, `${event.payload.name || 'a tool'} failed${text ? `: ${text}` : ''}`)
    return
  }
  if (type === 'tool.start' && (!sid || !focusedId() || sid === focusedId())) {
    glanceUntil = performance.now() + 1300
    return
  }
  if (type === 'message.complete' && (sid || 'focused') === replySid) resetReply(null)
  if (type === 'message.complete' && sid) {
    const said = firstLine(event?.payload?.text || event?.payload?.rendered)
    if (said) sessions.set(sid, { ...(sessions.get(sid) || {}), said, at: Date.now() })
    return
  }
  if (!/^(approval|clarify)/.test(type) || /respond|lock|timeout|mode|reload/.test(type)) return
  if (sid) flag(sid, type.startsWith('approval') ? 'approval' : 'question')
}

function useTicker() {
  const [, bump] = useState(0)
  useEffect(() => {
    const fn = () => bump(n => n + 1)
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }, [])
}

function itemsFrom(map) {
  return [...map.entries()]
    .map(([sid, w]) => {
      const s = sessions.get(sid) || {}
      return { sid, reason: w.reason, at: w.at, stored: s.stored, profile: s.profile, said: w.detail || s.said }
    })
    .sort((a, b) => b.at - a.at)
}

function openItem(item) {
  waiting.delete(item.sid)
  ui.open = false
  notify()
  if (!item.stored) {
    host.notify({ kind: 'info', message: 'That chat is in your sidebar — the eyes have not seen it open yet, so they cannot jump to it.' })
    return
  }
  haptic('tap')
  host.openSession(item.stored, item.profile ? { profile: item.profile } : undefined)
}

// Click on the chip or the eyes: one chat waiting opens straight away; more,
// or none, shows the list.
function summon() {
  const items = itemsFrom(waiting)
  if (items.length === 1 && items[0].stored) return openItem(items[0])
  ui.mode = 'waiting'
  ui.items = items
  ui.open = !ui.open
  notify()
}

// --- away and back ---------------------------------------------------------------------

function checkAway() {
  const now = Date.now()
  const unfocused = !document.hasFocus() && blurredAt && now - blurredAt > AWAY_UNFOCUSED_MS
  if (!away && (unfocused || now - lastActive > AWAY_IDLE_MS)) {
    away = true
    awayLog.clear()
    notify()
  }
}

function backFromAway() {
  if (!away) return
  away = false
  wokeAt = performance.now()
  const items = itemsFrom(awayLog)
  awayLog.clear()
  if (items.length) {
    ui.mode = 'away'
    ui.items = items
    ui.open = true
  }
  notify()
}

let wokeAt = -1e9

function onActivity() {
  lastActive = Date.now()
  if (document.hasFocus()) blurredAt = 0
  backFromAway()
}

// --- letters from the reply ------------------------------------------------------------
//
// message.delta carries the reply text as it streams, and Hermes draws it the
// moment it arrives -- so a letter that waits in a queue lands after its text.
// Each letter launches as soon as it arrives, flies for under half a second, and
// lands on the last character of the reply on screen. Only the newest few are
// kept: the eyes always shoot what is being written right now, never a backlog.

const SHOT_GAP = 110 // ms between letters: about nine a second, readable
const FLIGHT_MS = 420 // how long one letter is in the air
const KEEP = 3 // newest letters held; older ones are dropped to stay in sync

const letters = []
let eyesApi = null // set while the floating eyes are mounted

// 'perch': peeking over the top edge of the message box, following it.
// 'free': wherever you dragged them. The list can put them back.
let eyesMode = 'perch'
const PEEK = 14 // px of the eyes hidden behind the box's top edge

function onReplyDelta(event) {
  if (!eyesApi) return
  const sid = event?.session_id || event?.payload?.session_id
  const focused = focusedId()
  if (sid && focused && sid !== focused) {
    // A brand-new chat streams under an id the focus signal may not have
    // caught up with yet. Accept it when it is the only chat streaming.
    const busyNow = host.state.busyBySession?.get?.() || {}
    const streaming = Object.keys(busyNow).filter(k => busyNow[k])
    if (streaming.length > 1 || (streaming.length === 1 && streaming[0] !== sid)) return
  }
  const text = String(event?.payload?.text || '')
  for (const ch of text) if (ch.trim()) letters.push(ch)
  if (letters.length > KEEP) letters.splice(0, letters.length - KEEP)
  const key = sid || 'focused'
  if (key !== replySid) resetReply(key)
  replyText += text
  scanWords()
}

// Where the reply is being written: the last visible character of the reply
// text itself. Only the message body counts -- not the thinking block, tool
// steps, "working" status, buttons, timestamps or reactions, which all carry
// text of their own and used to pull the aim all over the screen.
const SKIP = [
  'button', '[aria-hidden="true"]', '[role="alert"]', '[data-slot="tool-row"]',
  '[data-slot="aui_turn-activity"]', '[data-slot="aui_thinking-disclosure"]',
  '[data-slot="aui_thinking-body"]', '[data-slot="aui_reasoning-text"]',
  '[data-slot="aui_response-loading"]', '[data-slot="aui_assistant-message-stopped"]',
  '[data-slot="tool-approval-stack"]', '[data-slot="tool-approval-card"]', '[data-slot="clarify-inline"]'
].join(',')
let lastAim = null // { x, y, at } -- the last good landing spot

// Hermes keeps chats from other tabs alive but invisible (visibility:hidden,
// inert), and a hidden one can be parked at the window's top-left corner. Only
// what you can actually see counts -- otherwise letters fly off to the corner.
function shown(el) {
  if (!el || !el.isConnected) return false
  if (el.closest('[inert], [aria-hidden="true"]')) return false
  if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function lastShown(selector, root = document) {
  const all = root.querySelectorAll(selector)
  for (let i = all.length - 1; i >= 0; i--) if (shown(all[i])) return all[i]
  return null
}

// Looked up a few times a frame; the answer holds for a moment.
const memo = new Map()
function cached(key, fn) {
  const now = performance.now()
  const m = memo.get(key)
  if (m && now - m.at < 60 && (!m.v || m.v.isConnected)) return m.v
  const v = fn()
  memo.set(key, { v, at: now })
  return v
}

function replyBody() {
  return cached('reply', findReplyBody)
}

function findReplyBody() {
  // The reply being written, if one is streaming in a chat you can see.
  const marks = document.querySelectorAll('[data-slot="aui_message-streaming-marker"][data-message-streaming="true"]')
  for (let i = marks.length - 1; i >= 0; i--) {
    const body = marks[i].closest('[data-role="assistant"]')?.querySelector('[data-slot="aui_assistant-message-content"]')
    if (shown(body)) return body
  }
  return lastShown('[data-slot="aui_assistant-message-content"]')
}

function composerBox() {
  return cached('composer', () => lastShown('[data-slot="composer-surface"]'))
}

function floorY() {
  // Text scrolled under the message box can't be seen; land just above it.
  const box = composerBox()
  return box ? box.getBoundingClientRect().top - 12 : window.innerHeight - 90
}

// Never aim outside the window or under the message box.
function onScreen(t) {
  if (!t) return t
  return { ...t, x: Math.min(window.innerWidth - 12, Math.max(12, t.x)), y: Math.min(floorY(), Math.max(12, t.y)) }
}

function caretTarget() {
  const body = replyBody()
  if (!body) return null
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n =>
      n.nodeType === 1
        ? n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
        : n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
  })
  // Walk backwards from the end: the newest text is last.
  walker.currentNode = body
  let n = null
  while (walker.lastChild()) n = walker.currentNode
  const floor = floorY()
  const range = document.createRange()
  for (let i = 0; n && i < 40; n = walker.previousNode(), i++) {
    const text = n.nodeValue
    let end = text.length
    while (end > 0 && !text[end - 1].trim()) end--
    range.setStart(n, Math.max(0, end - 1))
    range.setEnd(n, end)
    const rects = range.getClientRects()
    const r = rects[rects.length - 1]
    if (!r || !r.width || !r.height) continue
    if (r.bottom < 0) return null // the reply's end is scrolled above the view
    return onScreen({ x: r.right, y: Math.min(r.top + r.height / 2, floor) })
  }
  return null
}

function replyTarget() {
  // No visible text yet (the reply is just starting): aim at the start of the
  // reply, or at the spot the last letter landed -- never somewhere random.
  if (lastAim && performance.now() - lastAim.at < 3000) return lastAim
  const body = replyBody()
  const floor = floorY()
  if (!body) return { x: window.innerWidth * 0.45, y: floor }
  const r = body.getBoundingClientRect()
  return onScreen({ x: r.left + 24, y: Math.max(60, Math.min(r.bottom - 12, floor)) })
}

function aimAt() {
  const t = caretTarget()
  if (t) lastAim = { ...t, at: performance.now() }
  return t || replyTarget()
}

// Letters in the air. Each one homes in on the end of the reply every frame
// rather than on where it was at launch: the chat scrolls and more text lands
// while a letter flies, and a fixed target leaves it short or off to the side.
const flights = [] // { el, from, start, lift, duration, target?, onLand? }

const LETTER_STYLE = {
  font: "700 20px 'JetBrains Mono', ui-monospace, monospace",
  color: '#fff',
  textShadow: '0 0 6px #b69cff, 0 0 14px #8b6cf0'
}

// opts.target: a function giving the landing spot, asked every frame (falls
// back to the end of the reply); opts.onLand: called when it arrives.
function fire(ch, from, to, opts = {}) {
  const el = document.createElement('span')
  el.textContent = ch
  Object.assign(el.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    zIndex: '2147483001',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    willChange: 'transform, opacity'
  }, opts.style || LETTER_STYLE)
  document.body.appendChild(el)
  const flight = {
    el,
    from,
    start: performance.now(),
    lift: -Math.max(18, Math.abs(to.x - from.x) * 0.08),
    duration: opts.duration || FLIGHT_MS,
    target: opts.target,
    onLand: opts.onLand
  }
  flights.push(flight)
  moveFlight(flight, flight.start, to)
}

const ease = t => 1 - Math.pow(1 - t, 3)

// Returns false once the letter has landed.
function moveFlight(f, now, to) {
  to = (f.target && f.target()) || to
  const p = Math.max(0, Math.min(1, (now - f.start) / f.duration))
  const e = ease(p)
  const x = f.from.x + (to.x - f.from.x) * e
  const y = f.from.y + (to.y - f.from.y) * e + f.lift * Math.sin(Math.PI * p)
  const scale = p < 0.5 ? 0.5 + 1.3 * p : 1.15 - 0.7 * (p - 0.5)
  f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale})`
  f.el.style.opacity = String(p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25)
  if (p < 1) return true
  f.el.remove()
  f.onLand?.()
  return false
}

function stepFlights(now, to) {
  for (let i = flights.length - 1; i >= 0; i--) if (!moveFlight(flights[i], now, to)) flights.splice(i, 1)
}

function dropFlights() {
  for (const f of flights) f.el.remove()
  flights.length = 0
}

// --- important words -------------------------------------------------------------------
//
// Most of a reply is ordinary prose. A file name, a command, a link or a number
// is what you look for when you skim, so the eyes shoot those whole: the word
// flies out as a little tag, lands on itself in the reply, and glows there for
// a moment.

const WORD_GAP = 700 // ms between word shots
const WORD_FLIGHT_MS = 560
const words = [] // words waiting to be shot, oldest first
let replyText = '' // the raw text of the reply streaming in front of you
let replySid = null
let scanned = 0 // replyText before this index has been looked at
const shotWords = new Set() // already shot in this reply

const FILE_EXT = 'js|mjs|cjs|ts|tsx|jsx|py|md|json|ya?ml|sh|bash|css|html|toml|txt|go|rs|lua|conf|ini|lock|sql|env'
const WORD_RE = new RegExp(
  [
    '`([^`\\n]{2,48})`', // `code`
    '(https?:\\/\\/[^\\s)>\\]"\'`]+)', // links
    `(?<![\\w/~.-])((?:~|\\.{1,2})?\\/?[\\w@.-]+(?:\\/[\\w@.-]+)+\\/?|[\\w-]+\\.(?:${FILE_EXT}))(?![\\w/-])`, // paths, files
    '(?<![\\w.$/-])(\\d+(?:[.,]\\d+)*(?:%|ms|MB|GB|KB|px|[smhk])?)(?!\\w|[.,]\\d)' // numbers
  ].join('|'),
  'g'
)

function resetReply(sid) {
  replySid = sid
  replyText = ''
  scanned = 0
  shotWords.clear()
  words.length = 0
}

function insideFence(i) {
  return ((replyText.slice(0, i).match(/```/g) || []).length & 1) === 1
}

function wordFrom(m) {
  if (m[1]) return m[1].trim()
  if (m[2]) return m[2].replace(/[.,;:!?]+$/, '')
  if (m[3]) {
    const t = m[3].replace(/[.,]+$/, '')
    if (!/[a-z]/i.test(t)) return null // 10/09/2026
    // "and/or", "w/o": a path needs a ~ . or / start, an extension, or depth.
    if (t.includes('/') && !/^[~./]/.test(t) && !/\.\w{1,5}$/.test(t) && (t.match(/\//g) || []).length < 2) return null
    return t
  }
  if (m[4]) return m[4].replace(/\D/g, '').length >= 2 || /\D$/.test(m[4]) ? m[4] : null
  return null
}

function scanWords() {
  WORD_RE.lastIndex = scanned
  let m
  while ((m = WORD_RE.exec(replyText))) {
    const end = m.index + m[0].length
    // The word may still be growing: "87" + "." may yet become "87.5%".
    if (!m[1] && (end >= replyText.length || (/[.,]/.test(replyText[end]) && end + 1 >= replyText.length))) break
    scanned = end
    if (insideFence(m.index)) continue
    const w = wordFrom(m)
    if (!w || w.length > 64 || shotWords.has(w)) continue
    shotWords.add(w)
    words.push({ text: w, range: null, missedAt: 0 })
    if (words.length > 2) words.shift() // only the newest: stay in step with the reply
  }
}

function tagText(w) {
  let t = w.replace(/^https?:\/\//, '')
  if (t.length > 34) t = `${t.slice(0, 16)}…${t.slice(-16)}`
  return t
}

// The word's place in the reply. Markdown is gone by then (`code` shows as
// code), so search the rendered text, newest first.
function findWord(text) {
  const body = replyBody()
  if (!body) return null
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n =>
      n.nodeType === 1
        ? n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT
  })
  walker.currentNode = body
  let n = null
  while (walker.lastChild()) n = walker.currentNode
  for (let i = 0; n && i < 400; n = walker.previousNode(), i++) {
    const at = n.nodeValue.lastIndexOf(text)
    if (at < 0) continue
    const range = document.createRange()
    range.setStart(n, at)
    range.setEnd(n, at + text.length)
    return range
  }
  return null
}

function wordRects(w, now) {
  // Hermes redraws the reply as it streams, which can swap the text out from
  // under a saved range: look again at once. Only a failed search waits.
  if (!w.range || !w.range.startContainer.isConnected || w.range.toString() !== w.text) {
    w.range = null
    if (now - w.missedAt < 90) return null
    w.range = findWord(w.text)
    if (!w.range) {
      w.missedAt = now
      return null
    }
  }
  const rects = [...w.range.getClientRects()].filter(r => r.width && r.height)
  return rects.length ? rects : null
}

function wordPoint(w) {
  const rects = wordRects(w, performance.now())
  if (!rects) return null
  const r = rects[rects.length - 1]
  return onScreen({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
}

const glows = [] // { w, els, start }
const GLOW_MS = 1600

function glow(w) {
  glows.push({ w, els: [], start: performance.now() })
}

function stepGlows(now) {
  for (let i = glows.length - 1; i >= 0; i--) {
    const g = glows[i]
    const p = (now - g.start) / GLOW_MS
    const rects = p < 1 ? wordRects(g.w, now) : null
    if (!rects) {
      g.els.forEach(e => e.remove())
      g.els = []
      if (p >= 1) glows.splice(i, 1)
      continue
    }
    while (g.els.length < rects.length) {
      const e = document.createElement('div')
      Object.assign(e.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147482998',
        borderRadius: '5px',
        background: 'rgba(182,156,255,.26)',
        boxShadow: '0 0 0 1px rgba(182,156,255,.55), 0 0 14px rgba(139,108,240,.55)'
      })
      document.body.appendChild(e)
      g.els.push(e)
    }
    const fade = p < 0.15 ? p / 0.15 : p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1
    g.els.forEach((e, k) => {
      const r = rects[k]
      if (!r) return void (e.style.opacity = '0')
      Object.assign(e.style, {
        left: `${r.left - 3}px`,
        top: `${r.top - 1}px`,
        width: `${r.width + 6}px`,
        height: `${r.height + 2}px`,
        opacity: String(fade)
      })
    })
  }
}

function dropGlows() {
  for (const g of glows) g.els.forEach(e => e.remove())
  glows.length = 0
}

const WORD_STYLE = {
  font: "600 13px 'JetBrains Mono', ui-monospace, monospace",
  color: '#fff',
  background: 'rgba(48,24,72,.92)',
  border: '1px solid rgba(182,156,255,.7)',
  borderRadius: '6px',
  padding: '1px 7px',
  boxShadow: '0 0 12px rgba(139,108,240,.6)'
}

function shootWord(w, from, fallback) {
  fire(tagText(w.text), from, fallback, {
    style: WORD_STYLE,
    duration: WORD_FLIGHT_MS,
    target: () => wordPoint(w),
    onLand: () => glow(w)
  })
}

// --- something needs you, right here -------------------------------------------------
//
// When the chat in front of you stops for an approval or a question, the eyes
// fire a "!" at it, keep looking at it, and a ring pulses round it until it is
// answered.

const ATTN_SEL = '[data-slot="tool-approval-card"]:not([aria-hidden="true"]), [data-slot="clarify-inline"]'
let attention = null // { el, ring }
const attnSeen = new WeakSet()

function findAttention() {
  return lastShown(ATTN_SEL)
}

// Where to point: the Approve button end of an approval, else the box itself.
function attnPoint(el) {
  if (!shown(el)) return null
  const actions = el.querySelector('[data-slot="tool-approval-actions"]')
  const r = (actions || el).getBoundingClientRect()
  if (!r.width) return null
  return onScreen(actions ? { x: r.right - 48, y: r.top + r.height / 2 } : { x: r.left + Math.min(r.width, 320) / 2, y: r.top + 18 })
}

const BANG_STYLE = {
  font: "800 26px 'JetBrains Mono', ui-monospace, monospace",
  color: '#FFBF00',
  textShadow: '0 0 8px rgba(255,191,0,.9), 0 0 18px rgba(233,84,32,.7)'
}

function clearAttention() {
  attention?.ring.remove()
  attention = null
}

// Returns the element to look at, if any.
function updateAttention(from) {
  const el = findAttention()
  if (!el) return void clearAttention()
  if (attention?.el !== el) {
    clearAttention()
    const ring = document.createElement('div')
    Object.assign(ring.style, {
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: '2147482999',
      borderRadius: '12px',
      boxSizing: 'border-box',
      border: '2px solid rgba(255,191,0,.85)'
    })
    document.body.appendChild(ring)
    ring.animate(
      [
        { boxShadow: '0 0 0 0 rgba(255,191,0,.55)', opacity: 1 },
        { boxShadow: '0 0 0 12px rgba(255,191,0,0)', opacity: 0.55 }
      ],
      { duration: 1300, iterations: Infinity, easing: 'ease-out' }
    )
    attention = { el, ring }
    if (!attnSeen.has(el) && from) {
      attnSeen.add(el)
      const to = attnPoint(el)
      if (to) fire('!', from, to, { style: BANG_STYLE, duration: 520, target: () => attnPoint(el) })
    }
  }
  const r = el.getBoundingClientRect()
  Object.assign(attention.ring.style, {
    left: `${r.left - 4}px`,
    top: `${r.top - 4}px`,
    width: `${r.width + 8}px`,
    height: `${r.height + 8}px`
  })
  return el
}

// --- the eyes --------------------------------------------------------------------------

const W = 96
const H = 52
const EYES = [
  { cx: 26, cy: 26 },
  { cx: 70, cy: 26 }
]
const RX = 20
const RY = 22
const PUPIL = 15

function svg() {
  const clip = (e, i) => `<clipPath id="oe-clip-${i}"><ellipse cx="${e.cx}" cy="${e.cy}" rx="${RX}" ry="${RY}"/></clipPath>`
  const ball = (e, i) => `
    <g class="oe-open" data-eye="${i}">
      <ellipse cx="${e.cx}" cy="${e.cy}" rx="${RX}" ry="${RY}" fill="url(#oe-sclera)"/>
      <g clip-path="url(#oe-clip-${i})">
        <g class="oe-pupil" data-eye="${i}">
          <circle cx="${e.cx}" cy="${e.cy}" r="${PUPIL}" fill="url(#oe-iris)"/>
          <circle cx="${e.cx}" cy="${e.cy}" r="6.4" fill="#060208"/>
          <ellipse cx="${e.cx - 5.2}" cy="${e.cy - 6}" rx="4.2" ry="3.3" fill="#fff"/>
          <circle cx="${e.cx + 5}" cy="${e.cy + 5.6}" r="1.6" fill="#fff" opacity=".85"/>
        </g>
        <rect class="oe-lid" data-eye="${i}" x="${e.cx - RX}" y="${e.cy - RY}" width="${RX * 2}" height="0" fill="var(--oe-lid)"/>
      </g>
      <ellipse cx="${e.cx}" cy="${e.cy}" rx="${RX}" ry="${RY}" fill="none" stroke="rgba(30,10,40,.25)" stroke-width="1"/>
    </g>
    <g class="oe-happy" data-eye="${i}" style="display:none">
      <path d="M ${e.cx - 13} ${e.cy + 4} Q ${e.cx} ${e.cy - 14} ${e.cx + 13} ${e.cy + 4}" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
    </g>`
  return `
  <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <defs>
      <radialGradient id="oe-sclera" cx="38%" cy="32%" r="75%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="70%" stop-color="#f6f2ff"/><stop offset="100%" stop-color="#cdbfe8"/>
      </radialGradient>
      <radialGradient id="oe-iris" cx="50%" cy="72%" r="65%">
        <stop offset="0%" style="stop-color: var(--oe-iris, #7a5fd0)"/><stop offset="55%" style="stop-color: color-mix(in srgb, var(--oe-iris, #7a5fd0) 30%, #1a0c28)"/><stop offset="100%" stop-color="#0e0612"/>
      </radialGradient>
      ${EYES.map(clip).join('')}
    </defs>
    ${EYES.map(ball).join('')}
    <path class="oe-sweat" d="M ${W - 7} 3 q 4.5 6.5 0 9.5 q -4.5 -3 0 -9.5 z" fill="#9fd3ff" stroke="#eaf7ff" stroke-width=".8" style="display:none"/>
    <text class="oe-z" x="${W - 6}" y="2" fill="#cdbfe8" font-size="13" font-weight="700" font-family="ui-monospace, monospace" style="display:none">z</text>
  </svg>`
}

function lerp(a, b, k) {
  return a + (b - a) * k
}

// Mounts the floating eyes and runs them until unmount (plugin reload, disable,
// or hidden from the list), when everything it added is taken down again.
// --- the agent's own colour ------------------------------------------------------------
//
// Hermes gives every agent a colour (the sidebar's profile rail), and you can
// pick your own there. The eyes' irises take the colour of the agent in front
// of you, so you can tell at a glance who you are talking to.

let colorPicks = {}
let colorPicksAt = 0

function agentColor(profile) {
  if (!profile || profile === 'default') return '#7a5fd0'
  const now = Date.now()
  if (now - colorPicksAt > 2000) {
    colorPicksAt = now
    try {
      colorPicks = JSON.parse(window.localStorage.getItem('hermes.desktop.profileColors') || '{}') || {}
    } catch {
      colorPicks = {}
    }
  }
  return colorPicks[profile] || (typeof profileColor === 'function' && profileColor(profile)) || '#7a5fd0'
}

// --- little bursts: hearts when petted, sparks for a big finish ------------------------

function burst(from, { glyphs, colors, count, spread, rise, duration, size }) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('span')
    el.textContent = glyphs[i % glyphs.length]
    Object.assign(el.style, {
      position: 'fixed',
      left: `${from.x}px`,
      top: `${from.y}px`,
      zIndex: '2147483002',
      pointerEvents: 'none',
      font: `700 ${size}px system-ui, sans-serif`,
      color: colors[i % colors.length],
      textShadow: `0 0 8px ${colors[i % colors.length]}`
    })
    document.body.appendChild(el)
    const angle = spread >= Math.PI * 2 ? (i / count) * Math.PI * 2 + Math.random() * 0.4 : -Math.PI / 2 + (Math.random() - 0.5) * spread
    const dist = rise * (0.6 + Math.random() * 0.6)
    const dx = Math.cos(angle) * dist
    const dy = Math.sin(angle) * dist
    el.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.4)', opacity: 0 },
        { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55}px)) scale(1.1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 10}px)) scale(.7)`, opacity: 0 }
      ],
      { duration: duration * (0.85 + Math.random() * 0.3), easing: 'cubic-bezier(.2,.7,.3,1)' }
    ).onfinish = () => el.remove()
  }
}

const HEARTS = { glyphs: ['♥'], colors: ['#ff7eb6', '#ff9ccb', '#ffb3d6'], count: 1, spread: 1.1, rise: 46, duration: 950, size: 15 }
const SPARKS = {
  glyphs: ['✦', '✧', '•', '✦', '★'],
  colors: ['#FFBF00', '#B69CFF', '#E95420', '#8AE234', '#ffffff'],
  count: 16,
  spread: Math.PI * 2,
  rise: 70,
  duration: 1000,
  size: 14
}
const BIG_FINISH_MS = 60 * 1000 // a task this long earns the sparks

function mountEyes() {
  eyesMode = store ? store.get('mode', 'perch') : 'perch'
  const saved = store ? store.get('spot', null) : null
  const el = document.createElement('div')
  el.setAttribute('data-hermes-eyes', '')
  el.innerHTML = svg()
  Object.assign(el.style, {
    position: 'fixed',
    left: `${Math.min(window.innerWidth - W, Math.max(0, saved?.left ?? window.innerWidth - W - 28))}px`,
    top: `${Math.min(window.innerHeight - H, Math.max(0, saved?.top ?? window.innerHeight - H - 138))}px`,
    width: `${W}px`,
    height: `${H}px`,
    zIndex: '2147483000',
    cursor: 'grab',
    filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.35))',
    transition: 'transform 180ms ease',
    userSelect: 'none'
  })
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim() || '#8b6cf0'
  el.style.setProperty('--oe-lid', accent)
  document.body.appendChild(el)

  // Hermes's own floating pet would make a second pair of eyes. Hide it here,
  // only while these are showing; the terminal chats are untouched. If a Hermes
  // update changes the pet's markup this simply stops matching and it returns.
  const hidePet = document.createElement('style')
  hidePet.textContent =
    'body div[style*="position: fixed"][style*="touch-action: none"][style*="z-index: 60"][style*="cursor: grab"]{display:none!important}'
  document.head.appendChild(hidePet)

  const pupils = [...el.querySelectorAll('.oe-pupil')]
  const lids = [...el.querySelectorAll('.oe-lid')]
  const opens = [...el.querySelectorAll('.oe-open')]
  const happies = [...el.querySelectorAll('.oe-happy')]
  const zee = el.querySelector('.oe-z')
  const sweat = el.querySelector('.oe-sweat')
  const look = EYES.map(() => ({ x: 0, y: 0 }))

  let mouse = null
  let movedAt = 0
  let nextBlink = performance.now() + 2500 + Math.random() * 3500
  let blinkAt = -1e9
  let happyUntil = 0
  let wasBusy = !!host.state.busy?.get?.()
  let frame = 0
  let aim = null
  let aimUntil = 0
  let lastShot = 0
  let typedAt = -1e9
  let petting = false
  let lastHeart = 0
  let busyStart = 0
  let shownProfile = undefined
  let lastWord = 0
  let quietUntil = 0
  let lastAttn = 0
  let attnEl = null
  let shotEye = 0
  eyesApi = {
    pupil(i) {
      const r = el.getBoundingClientRect()
      const e = EYES[i]
      return {
        x: r.left + ((e.cx + look[i].x * (RX - PUPIL * 0.75)) / W) * r.width,
        y: r.top + ((e.cy + look[i].y * (RY - PUPIL * 0.75)) / H) * r.height
      }
    }
  }

  // A speech bubble over the eyes: what the agent is doing while you hover,
  // and on its own when the chat in front of you seems stuck.
  const bubble = document.createElement('div')
  Object.assign(bubble.style, {
    position: 'fixed',
    zIndex: '2147483002',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    font: "500 11.5px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif",
    color: '#EEEEEC',
    background: 'rgba(22,16,34,.94)',
    border: '1px solid rgba(182,156,255,.5)',
    borderRadius: '8px',
    padding: '4px 9px',
    boxShadow: '0 4px 14px rgba(0,0,0,.35)',
    opacity: '0',
    transition: 'opacity 160ms ease',
    transform: 'translate(-50%, -100%)'
  })
  document.body.appendChild(bubble)
  let hovering = false
  el.addEventListener('pointerenter', () => (hovering = true))
  el.addEventListener('pointerleave', () => (hovering = false))

  const onMove = e => {
    mouse = { x: e.clientX, y: e.clientY }
    movedAt = performance.now()
  }
  window.addEventListener('mousemove', onMove, { passive: true })

  // Typing in the message box: the eyes watch you write.
  const onKey = e => {
    const box = composerBox()
    if (box && e.target instanceof Node && box.contains(e.target)) typedAt = performance.now()
  }
  window.addEventListener('keydown', onKey, true)

  // Drag to move; a press that does not move is a click, which summons.
  let drag = null
  const onDown = e => {
    if (e.button !== 0) return
    const r = el.getBoundingClientRect()
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false, at: performance.now() }
    el.style.cursor = 'grabbing'
    el.setPointerCapture(e.pointerId)
    e.preventDefault()
  }
  const onDrag = e => {
    if (!drag) return
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true
    if (!drag.moved) return
    eyesMode = 'free'
    el.style.clipPath = ''
    const left = Math.max(0, Math.min(window.innerWidth - W, e.clientX - drag.dx))
    const top = Math.max(0, Math.min(window.innerHeight - H, e.clientY - drag.dy))
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }
  const onUp = () => {
    if (!drag) return
    const moved = drag.moved
    drag = null
    el.style.cursor = 'grab'
    if (petting) {
      // A press and hold is a pat, not a click.
      petting = false
      happyUntil = performance.now() + 900
      return
    }
    if (moved) {
      store?.set?.('mode', 'free')
      store?.set?.('spot', { left: parseFloat(el.style.left), top: parseFloat(el.style.top) })
      notify()
    } else summon()
  }
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onDrag)
  el.addEventListener('pointerup', onUp)

  // Sit on the message box's top edge at its right end, with the bottom of the
  // eyes clipped where the box would hide them, so they peek over it. With no
  // message box on screen (settings, a full page) they wait in the corner.
  const perch = () => {
    if (eyesMode !== 'perch' || drag) return
    const box = composerBox()
    const r = box && box.getBoundingClientRect()
    if (r && r.width > W * 2 && r.height > 0) {
      el.style.left = `${Math.round(r.right - W - 64)}px`
      el.style.top = `${Math.round(r.top - H + PEEK)}px`
      el.style.clipPath = `inset(-24px -24px ${PEEK}px -24px)`
    } else {
      el.style.left = `${window.innerWidth - W - 28}px`
      el.style.top = `${window.innerHeight - H - 138}px`
      el.style.clipPath = ''
    }
  }

  const tick = now => {
    perch()
    const busy = !!host.state.busy?.get?.()
    const thinking = !!host.state.awaitingResponse?.get?.()

    const profile = host.state.focusedSessionProfile?.get?.() || null
    if (profile !== shownProfile) {
      shownProfile = profile
      el.style.setProperty('--oe-iris', agentColor(profile))
    }

    if (!wasBusy && busy) busyStart = now
    if (wasBusy && !busy && busyStart && now - busyStart > BIG_FINISH_MS && now >= worryUntil) {
      const a = eyesApi.pupil(0)
      const b = eyesApi.pupil(1)
      burst({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, SPARKS)
    }
    if (wasBusy && !busy) happyUntil = now + 1500

    // Press and hold the eyes: they close happily and hearts float up.
    if (drag && !drag.moved && now - drag.at > 450) petting = true
    if (petting) {
      happyUntil = Math.max(happyUntil, now + 200)
      if (now - lastHeart > 260) {
        lastHeart = now
        const er = el.getBoundingClientRect()
        burst({ x: er.left + er.width * (0.25 + Math.random() * 0.5), y: er.top + 6 }, HEARTS)
      }
    }
    const typing = now - typedAt < 1400
    if (now - wokeAt < 1400) happyUntil = Math.max(happyUntil, wokeAt + 1400)
    wasBusy = busy
    const idle = now - movedAt > 1800
    const needsYou = waiting.size > 0
    const hasProblem = [...waiting.values()].some(w => w.reason === 'error')
    const shaking = now < worryUntil
    const worried = shaking || (idle && hasProblem)

    // Shoot the next letter of the reply, alternating eyes.
    // While letters fly, the target is measured again every frame.
    if (flights.length || letters.length) aim = aimAt()
    // An important word goes out whole, from between the eyes, and the letters
    // hold fire while it flies so it stands out.
    if (words.length && now - lastWord > WORD_GAP) {
      lastWord = now
      quietUntil = now + WORD_FLIGHT_MS * 0.7
      aimUntil = now + WORD_FLIGHT_MS + 200
      const a = eyesApi.pupil(0)
      const b = eyesApi.pupil(1)
      shootWord(words.shift(), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, aim || aimAt())
    }
    if (letters.length && now - lastShot > SHOT_GAP && now > quietUntil) {
      lastShot = now
      aimUntil = now + FLIGHT_MS + 200
      fire(letters.shift(), eyesApi.pupil(shotEye), aim)
      shotEye = 1 - shotEye
    }
    if (flights.length) stepFlights(now, aim)
    if (glows.length) stepGlows(now)
    const aiming = aim && now < aimUntil

    // An approval or a question in this chat: shoot a "!" at it and watch it.
    if (now - lastAttn > 250 || attention) {
      if (now - lastAttn > 250) lastAttn = now
      attnEl = updateAttention(eyesApi.pupil(shotEye)) || null
    }
    const attnAt = attnEl && attnPoint(attnEl)

    const here = focusedId()
    const stuckHere = !attnEl && isStuck(here)
    const peek = hovering && !drag
    if (peek || stuckHere) {
      const profile = host.state.focusedSessionProfile?.get?.()
      const text = peek
        ? peekText(attnEl)
        : `${profile ? agentName(profile) : 'The agent'} might be stuck · quiet ${dur(quietFor(here))}`
      if (bubble.textContent !== text) bubble.textContent = text
      bubble.style.color = !peek && stuckHere ? '#FFBF00' : '#EEEEEC'
      bubble.style.borderColor = !peek && stuckHere ? 'rgba(255,191,0,.6)' : 'rgba(182,156,255,.5)'
      const er = el.getBoundingClientRect()
      const half = bubble.offsetWidth / 2
      const below = er.top < 44
      bubble.style.left = `${Math.min(window.innerWidth - half - 8, Math.max(half + 8, er.left + er.width / 2))}px`
      bubble.style.top = below ? `${er.bottom + 8}px` : `${er.top - 6}px`
      bubble.style.transform = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)'
      bubble.style.opacity = '1'
    } else bubble.style.opacity = '0'

    const r = el.getBoundingClientRect()
    // The newest tool step the agent is running, to glance at.
    let glanceAt = null
    if (now < glanceUntil) {
      const row = lastShown('[data-slot="tool-row"]')
      const b = row && row.getBoundingClientRect()
      if (b && b.width) glanceAt = { x: b.left + Math.min(b.width, 260) / 2, y: b.top + b.height / 2 }
    }
    EYES.forEach((e, i) => {
      let tx = 0
      let ty = 0
      if (aiming) {
        const ex = r.left + (e.cx / W) * r.width
        const ey = r.top + (e.cy / H) * r.height
        const d = Math.hypot(aim.x - ex, aim.y - ey) || 1
        tx = (aim.x - ex) / d
        ty = (aim.y - ey) / d
      } else if (now < glanceUntil && glanceAt) {
        const ex = r.left + (e.cx / W) * r.width
        const ey = r.top + (e.cy / H) * r.height
        const d = Math.hypot(glanceAt.x - ex, glanceAt.y - ey) || 1
        tx = (glanceAt.x - ex) / d
        ty = (glanceAt.y - ey) / d
      } else if (attnAt) {
        const ex = r.left + (e.cx / W) * r.width
        const ey = r.top + (e.cy / H) * r.height
        const d = Math.hypot(attnAt.x - ex, attnAt.y - ey) || 1
        tx = (attnAt.x - ex) / d
        ty = (attnAt.y - ey) / d
      } else if (typing) {
        // Watching you write: down toward the caret in the message box.
        const sel = window.getSelection?.()
        let c = null
        if (sel && sel.rangeCount) {
          const rr = sel.getRangeAt(0).getBoundingClientRect()
          if (rr.width || rr.height) c = { x: rr.left, y: rr.top + rr.height / 2 }
        }
        if (!c) {
          const b = composerBox()?.getBoundingClientRect()
          c = b ? { x: b.left + Math.min(b.width * 0.35, 260), y: b.top + 28 } : null
        }
        if (c) {
          const ex = r.left + (e.cx / W) * r.width
          const ey = r.top + (e.cy / H) * r.height
          const d = Math.hypot(c.x - ex, c.y - ey) || 1
          tx = (c.x - ex) / d
          ty = (c.y - ey) / d
        }
      } else if (away) {
        tx = 0
        ty = 0.6 // dozing, looking down
      } else if (worried) {
        tx = i === 0 ? 0.35 : -0.35 // anxious, looking down and inward
        ty = 0.4
      } else if (stuckHere && idle) {
        tx = Math.sin(now / 1600) * 0.6 // puzzled, looking about
        ty = 0.15
      } else if (needsYou && idle) {
        tx = 0
        ty = 0 // face you
      } else if (thinking && idle) {
        tx = Math.sin(now / 900) * 0.35
        ty = -0.9
      } else if (busy && idle) {
        tx = Math.sin(now / 420) > 0 ? 0.8 : -0.8
        ty = -0.15
      } else if (mouse) {
        const ex = r.left + (e.cx / W) * r.width
        const ey = r.top + (e.cy / H) * r.height
        const vx = mouse.x - ex
        const vy = mouse.y - ey
        const d = Math.hypot(vx, vy) || 1
        const pull = Math.min(1, d / 240)
        tx = (vx / d) * pull
        ty = (vy / d) * pull
      }
      look[i].x = lerp(look[i].x, tx, away ? 0.05 : 0.22)
      look[i].y = lerp(look[i].y, ty, away ? 0.05 : 0.22)
      pupils[i].setAttribute('transform', `translate(${(look[i].x * (RX - PUPIL * 0.75)).toFixed(2)} ${(look[i].y * (RY - PUPIL * 0.75)).toFixed(2)})`)
    })

    // Blink: down in 70 ms, held 40, up in 90. Two quick ones on waking.
    if (now >= nextBlink) {
      blinkAt = now
      nextBlink = now + 3500 + Math.random() * 3500
    }
    if (now - wokeAt > 0 && now - wokeAt < 30) blinkAt = now
    if (now - wokeAt > 260 && now - wokeAt < 290) blinkAt = now
    const t = (now - blinkAt) / 1000
    let lid = 0
    if (t < 0.07) lid = t / 0.07
    else if (t < 0.11) lid = 1
    else if (t < 0.2) lid = 1 - (t - 0.11) / 0.09
    if (away) lid = Math.max(lid, 0.72 + Math.sin(now / 700) * 0.06) // heavy, drowsy lids
    else if (worried) lid = Math.max(lid, 0.34)
    else if (stuckHere) lid = Math.max(lid, 0.45) // squinting
    else if (thinking && idle) lid = Math.max(lid, 0.22)
    lids.forEach(l => l.setAttribute('height', String(lid * RY * 2)))

    // A sleepy "z" drifting up while away.
    if (zee) {
      zee.style.display = away ? '' : 'none'
      if (away) {
        const k = (now % 2400) / 2400
        zee.setAttribute('y', String(10 - k * 16))
        zee.setAttribute('opacity', String(k < 0.8 ? 1 : (1 - k) / 0.2))
      }
    }

    if (sweat) sweat.style.display = worried && !away ? '' : 'none'

    const happy = now < happyUntil && !worried
    opens.forEach(o => (o.style.display = happy ? 'none' : ''))
    happies.forEach(h => (h.style.display = happy ? '' : 'none'))

    // A little hop every two seconds while chats are waiting on you.
    el.style.transform = shaking && !away
      ? `translateX(${(Math.sin(now / 38) * 1.6).toFixed(2)}px)`
      : !away && needsYou && idle && Math.floor(now / 2000) % 2 === 0 && now % 2000 < 260
        ? 'translateY(-5px)'
        : ''

    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('keydown', onKey, true)
    eyesApi = null
    letters.length = 0
    words.length = 0
    dropFlights()
    dropGlows()
    clearAttention()
    bubble.remove()
    hidePet.remove()
    el.remove()
  }
}

// --- the chip and the list -------------------------------------------------------------

function TinyEyes({ alert, problem }) {
  const pupil = problem ? 'var(--ui-red)' : alert ? 'var(--ui-accent)' : 'currentColor'
  return jsxs('svg', {
    width: 18,
    height: 10,
    viewBox: '0 0 18 10',
    'aria-hidden': true,
    children: [
      jsx('ellipse', { cx: 4.5, cy: 5, rx: 4, ry: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      jsx('ellipse', { cx: 13.5, cy: 5, rx: 4, ry: 4.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
      jsx('circle', { cx: 5, cy: 5.4, r: 1.9, fill: pupil }),
      jsx('circle', { cx: 14, cy: 5.4, r: 1.9, fill: pupil })
    ]
  })
}

const REASON = {
  finished: 'finished',
  approval: 'needs your approval',
  question: 'has a question',
  error: 'ran into a problem',
  stuck: 'might be stuck'
}

function ago(at) {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function Row({ item }) {
  return jsxs('button', {
    type: 'button',
    className: cn(
      'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
      'hover:bg-(--ui-control-hover-background) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none'
    ),
    onClick: () => openItem(item),
    children: [
      jsxs('div', {
        className: 'flex w-full items-baseline gap-1.5 text-[0.8125rem]',
        children: [
          jsx('span', { className: 'font-medium text-foreground', children: agentName(item.profile) }),
          jsx('span', {
            className:
              item.reason === 'error'
                ? 'text-(--ui-red) font-medium'
                : item.reason === 'finished'
                  ? 'text-(--ui-text-tertiary)'
                  : 'text-(--ui-accent) font-medium',
            children: REASON[item.reason] || item.reason
          }),
          jsx('span', { className: 'ml-auto text-[0.6875rem] text-(--ui-text-quaternary)', children: ago(item.at) })
        ]
      }),
      item.said
        ? jsx('div', { className: 'w-full truncate text-[0.75rem] text-(--ui-text-secondary)', children: item.said })
        : null
    ]
  })
}

function EyesChip() {
  useTicker()
  const [visible, setVisible] = useState(() => (store ? store.get('visible', true) : true))

  useEffect(() => (visible ? mountEyes() : undefined), [visible])

  const count = waiting.size
  const problems = [...waiting.values()].filter(w => w.reason === 'error').length
  const items = ui.open ? (ui.mode === 'waiting' ? itemsFrom(waiting) : ui.items) : []
  const heading = ui.mode === 'away' ? 'While you were away' : problems ? 'Needs a look' : count ? 'Waiting on you' : 'All clear'

  const trigger = jsxs('button', {
    type: 'button',
    className: cn(
      'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
      problems
        ? 'text-(--ui-red) font-medium'
        : count
          ? 'text-(--ui-accent) font-medium'
          : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
    ),
    // The popover opens and closes itself on click. Only when exactly one chat
    // is waiting does this step in, cancel the toggle and jump straight there.
    onClick: e => {
      haptic('tap')
      const only = itemsFrom(waiting)
      if (only.length === 1 && only[0].stored) {
        e.preventDefault()
        openItem(only[0])
      }
    },
    children: [
      jsx(TinyEyes, { alert: count > 0, problem: problems > 0 }),
      problems ? `${problems} problem${problems === 1 ? '' : 's'}` : count ? `${count} waiting` : null
    ]
  })

  return jsxs(Popover, {
    open: ui.open,
    onOpenChange: open => {
      ui.open = open
      if (!open) ui.mode = 'waiting'
      notify()
    },
    children: [
      jsx(Tip, {
        label: problems
          ? `${problems} chat${problems === 1 ? '' : 's'} ran into a problem`
          : count
            ? `${count} chat${count === 1 ? '' : 's'} waiting on you`
            : 'Hermes Eyes',
        children: jsx(PopoverTrigger, { asChild: true, children: trigger })
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'top',
        variant: 'menu',
        className: 'w-80 p-1.5',
        children: jsxs('div', {
          className: 'flex flex-col gap-0.5',
          children: [
            jsx('div', {
              className: 'px-2.5 pt-1.5 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)',
              children: heading
            }),
            ...(items.length
              ? items.map(item => jsx(Row, { item }, item.sid))
              : [
                  jsx('div', {
                    className: 'px-2.5 py-2 text-[0.8125rem] text-(--ui-text-secondary)',
                    children: 'Nothing is waiting on you.'
                  })
                ]),
            jsx('div', { className: 'my-1 h-px bg-(--ui-stroke-secondary)' }),
            visible && eyesMode === 'free'
              ? jsx('button', {
                  type: 'button',
                  className:
                    'rounded-md px-2.5 py-1.5 text-left text-[0.75rem] text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background)',
                  onClick: () => {
                    eyesMode = 'perch'
                    store?.set?.('mode', 'perch')
                    notify()
                  },
                  children: 'Put the eyes back on the message box'
                })
              : null,
            jsx('button', {
              type: 'button',
              className:
                'rounded-md px-2.5 py-1.5 text-left text-[0.75rem] text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background)',
              onClick: () => {
                const next = !visible
                store?.set?.('visible', next)
                setVisible(next)
              },
              children: visible ? 'Hide the eyes' : 'Show the eyes'
            })
          ]
        })
      })
    ]
  })
}

// --- the team chip ---------------------------------------------------------------------

function TeamChip() {
  useTicker()
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 15000) // keep "3m" fresh
    return () => clearInterval(t)
  }, [])
  const working = [...busySince.entries()].sort((a, b) => a[1] - b[1])
  if (!working.length) return null
  const who = working.map(([sid, since]) => {
    const s = sessions.get(sid) || {}
    return { sid, since, name: s.profile ? agentName(s.profile) : 'a chat', stored: s.stored, profile: s.profile }
  })
  const label = who.length <= 2 ? `${who.map(w => w.name).join(' · ')} working` : `${who.length} working`
  const tip = who.map(w => `${w.name} — working ${ago(w.since).replace(' ago', '').replace('just now', 'a few seconds')}`).join('\n')
  return jsx(Tip, {
    label: tip,
    children: jsxs('button', {
      type: 'button',
      className: cn(
        'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] text-(--ui-text-secondary) transition-colors',
        'hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        if (who.length === 1 && who[0].stored) {
          haptic('tap')
          host.openSession(who[0].stored, who[0].profile ? { profile: who[0].profile } : undefined)
        }
      },
      children: [
        jsx('span', {
          className: 'inline-block size-1.5 rounded-full bg-(--ui-accent) animate-pulse',
          'aria-hidden': true
        }),
        label
      ]
    })
  })
}

// --- open a chat from outside ----------------------------------------------------------
//
// hermes://open/hermes-eyes-open?session=ID&profile=NAME lands on this page,
// which opens that chat in place, so a terminal script can hand a chat over
// to Desktop.

function OpenPage() {
  useEffect(() => {
    const go = () => {
      const q = new URLSearchParams(window.location.hash.split('?')[1] || '')
      const session = q.get('session')
      if (!session) return
      const profile = q.get('profile') || undefined
      host.openSession(session, profile ? { profile } : undefined)
    }
    go()
    window.addEventListener('hashchange', go)
    return () => window.removeEventListener('hashchange', go)
  }, [])
  return jsx('div', { className: 'p-6 text-sm text-(--ui-text-secondary)', children: 'Opening the chat…' })
}

function resumeCommand() {
  const stored = host.state.focusedStoredSessionId?.get?.()
  if (!stored) return null
  const profile = host.state.focusedSessionProfile?.get?.() || 'default'
  return `hermes -p ${profile} --resume ${stored} chat`
}

export default {
  id: ID,
  name: 'Hermes Eyes',
  register(ctx) {
    store = ctx.storage

    // Store subscriptions go through onDispose and events through ctx.onEvent,
    // so a reload or disable takes every one of them down.
    const watch = [
      [host.state.busyBySession, onBusyChange],
      [host.state.focusedSessionId, onFocusChange],
      [host.state.focusedStoredSessionId, remember],
      [host.state.focusedSessionProfile, remember]
    ]
    for (const [atomRef, fn] of watch) {
      const off = atomRef?.listen?.(fn)
      if (typeof off === 'function') ctx.onDispose(off)
    }
    ctx.onEvent('*', onAnyEvent)
    ctx.onEvent('message.delta', onReplyDelta)

    for (const type of ['mousemove', 'keydown', 'pointerdown', 'focus']) ctx.addEventListener(window, type, onActivity, { passive: true })
    ctx.addEventListener(window, 'blur', () => {
      blurredAt = Date.now()
    })
    ctx.setInterval(checkAway, 5000)
    ctx.setInterval(checkStuck, 5000)

    // Agents' display names ("Ada — Research" -> "Ada") for the list.
    host
      .request('profiles.list', { include_sessions: false })
      .then(result => {
        const rows = Array.isArray(result) ? result : result?.profiles || []
        const next = {}
        for (const p of rows) {
          const shown = String(p.display_name || p.name || '').split(/\s+[—-]\s+/)[0].trim()
          if (p.name && shown) next[p.name] = shown
        }
        names = next
        notify()
      })
      .catch(() => {})

    ctx.onDispose(() => {
      waiting.clear()
      awayLog.clear()
      sessions.clear()
      previousBusy = {}
      ui.open = false
    })
    remember()
    onBusyChange(host.state.busyBySession?.get?.())

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 120,
      render: () => jsx(EyesChip, {})
    })
    ctx.register({ id: 'team', area: 'statusBar.right', order: 119, render: () => jsx(TeamChip, {}) })
    ctx.register({ id: 'open', area: ROUTES_AREA, data: { path: '/hermes-eyes-open' }, render: () => jsx(OpenPage, {}) })
    ctx.register({
      id: 'copy-resume',
      area: PALETTE_AREA,
      data: {
        id: 'hermes-eyes.copy-resume',
        label: 'Copy the terminal command for this chat',
        keywords: ['terminal', 'resume', 'continue', 'cli'],
        run: async () => {
          const cmd = resumeCommand()
          if (!cmd) return host.notify({ kind: 'info', message: 'Open a chat first.' })
          const ok = await ctx.os.writeClipboard(cmd)
          host.notify({ kind: ok ? 'success' : 'info', message: ok ? `Copied: ${cmd}` : cmd })
        }
      }
    })
  }
}

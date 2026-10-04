import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { DraftSize, LastMessage, Plan, Ttl, TtlMode } from '../types'

const lastAt = atom({ plugin: 'cache-warm', key: 'lastAt' } as const, null)
const tokens = atom({ plugin: 'cache-warm', key: 'tokens' } as const, 0)
const autoTtl = atom({ plugin: 'cache-warm', key: 'autoTtl' } as const, '5m')
const mode = atom({ plugin: 'cache-warm', key: 'mode' } as const, 'auto')
const isHidden = atom({ plugin: 'cache-warm', key: 'isHidden' } as const, false)
const model = atom({ plugin: 'cache-warm', key: 'model' } as const, null)
const effort = atom({ plugin: 'cache-warm', key: 'effort' } as const, null)
const draft = atom({ plugin: 'cache-warm', key: 'draft' } as const, 'none')
const hasLimits = atom({ plugin: 'cache-warm', key: 'hasLimits' } as const, false)
const lastMessage = atom({ plugin: 'cache-warm', key: 'lastMessage' } as const, null)
const weekStart = atom({ plugin: 'cache-warm', key: 'weekStart' } as const, null)
const weekNow = atom({ plugin: 'cache-warm', key: 'weekNow' } as const, null)
const plan = atom({ plugin: 'cache-warm', key: 'plan' } as const, 'auto')

const MINUTE = 60_000
const TTL_MS: Record<Ttl, number> = { '5m': 5 * MINUTE, '1h': 60 * MINUTE }
// The band turns amber and a toast shows when this much time is left
const WARN_MS = 5 * MINUTE
// Below this many tokens a cold send is cheap, so the tips stay quiet
const BIG_CONTEXT = 20_000

type Price = { input: number; read: number }
// Dollars per million tokens at standard speed: input, and a cache read (Anthropic
// list prices, 25 Sep 2026). Checked in order, so the longer ids come first
const PRICES: Array<[string, Price]> = [
  ['fable-5-1', { input: 10, read: 0.25 }],
  ['mythos-5-1', { input: 10, read: 0.25 }],
  ['fable-5', { input: 10, read: 1 }],
  ['opus-5-5', { input: 4, read: 0.2 }],
  ['opus', { input: 5, read: 0.5 }],
  ['sonnet-5', { input: 2, read: 0.2 }],
  ['sonnet-4-6', { input: 3, read: 0.3 }],
  ['haiku-4-5', { input: 1, read: 0.1 }],
]
// A cache write costs this many times the input price
const WRITE: Record<Ttl, number> = { '5m': 1.25, '1h': 2 }
// Models where /effort keeps the cache, on an API key or a Claude subscription
const EFFORT_KEEPS_CACHE = ['opus-5-5', 'sonnet-5-5', 'fable-5-1']
const PLANS: Record<'pro' | 'max5' | 'max20', { label: string; usd: number }> = {
  pro: { label: 'Pro', usd: 20 },
  max5: { label: 'Max 5x', usd: 100 },
  max20: { label: 'Max 20x', usd: 200 },
}
const PLAN_CHOICES = ['auto', 'pro', 'max5', 'max20', 'api']

// Everything the band draws from, read once per drawing
type Snapshot = {
  at: number | null
  tokens: number
  ttl: Ttl
  now: number
  isWorking: boolean
  model: string | null
  effort: string | number | null
  draft: DraftSize
  isSubscription: boolean
  last: LastMessage | null
  plan: Plan
  weekShare: number | null
}

type Line = { text: string; color?: string; isDim?: boolean }

function priceOf(id: string | null): Price | null {
  if (id === null) return null
  const hit = PRICES.find(([key]) => id.includes(key))
  return hit ? hit[1] : null
}

// How many warm sends one cold send costs: the write rate over the read rate
function coldMultiple(id: string | null, ttl: Ttl): string {
  const price = priceOf(id)
  const x = price ? (price.input * WRITE[ttl]) / price.read : WRITE[ttl] / 0.1
  return (Number.isInteger(x) ? String(x) : x.toFixed(1)) + 'x'
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'k'
  return String(n)
}

function formatLeft(ms: number): string {
  if (ms >= 2 * MINUTE) return Math.ceil(ms / MINUTE) + ' min'
  const seconds = Math.ceil(ms / 1000)
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

function money(usd: number): string {
  if (usd < 0.01) return 'under $0.01'
  return '$' + (usd < 100 ? usd.toFixed(2) : String(Math.round(usd)))
}

function percent(points: number): string {
  return points < 0.1 ? 'under 0.1%' : points.toFixed(1) + '%'
}

function draftSize(length: number): DraftSize {
  if (length === 0) return 'none'
  if (length < 25) return 'short'
  return length < 400 ? 'normal' : 'long'
}

function msLeft(s: Snapshot): number | null {
  return s.at === null ? null : TTL_MS[s.ttl] - (s.now - s.at)
}

// What re-sending the chat costs at API prices, warm and cold; null for an unknown model
function sendCost(s: Snapshot): { warm: number; cold: number } | null {
  const price = priceOf(s.model)
  if (price === null || s.tokens === 0) return null
  return {
    warm: (s.tokens * price.read) / 1_000_000,
    cold: (s.tokens * price.input * WRITE[s.ttl]) / 1_000_000,
  }
}

// Line 1: is the cache warm, and for how long
function cacheLine(s: Snapshot): Line {
  const size = s.tokens > 0 ? formatTokens(s.tokens) + ' tokens' : 'no context yet'
  const multiple = coldMultiple(s.model, s.ttl)
  if (s.isWorking) return { text: '● cache warm · Claude is working · ' + size, color: 'success' }
  const left = msLeft(s)
  if (left === null) return { text: '○ cache: no reading yet · it starts with Claude’s first reply', isDim: true }
  if (left > WARN_MS) {
    return {
      text: '● cache warm · ' + formatLeft(left) + ' left of ' + TTL_MS[s.ttl] / MINUTE + ' · ' + size + ' · going cold costs ' + multiple,
      color: 'success',
    }
  }
  if (left > 0) {
    return { text: '◐ cache cools in ' + formatLeft(left) + ' · reply now, or /compact at a break · ' + size, color: 'warning' }
  }
  return { text: '○ cache cold · your next message re-sends ' + size + ' at ' + multiple + ' the warm cost', color: 'error' }
}

// Line 2: what the next send costs, and what the last one did
function moneyLine(s: Snapshot): Line | null {
  const parts: string[] = []
  const cost = sendCost(s)
  if (cost) {
    parts.push('next send ≈ ' + money(cost.warm) + (s.isSubscription ? ' at API prices' : '') + ', ' + money(cost.cold) + ' if cold')
  }
  if (s.last) {
    if (s.isSubscription && s.last.fivePct !== null) parts.push('last message used ' + percent(s.last.fivePct) + ' of your 5-hour limit')
    else if (s.last.usd !== null) parts.push('last message ' + money(s.last.usd))
  }
  if (s.plan !== 'auto' && s.plan !== 'api' && s.weekShare !== null && s.weekShare > 0) {
    const { label, usd } = PLANS[s.plan]
    // The plan's price for one week, times the share of the weekly limit this chat used
    parts.push('this chat ≈ ' + money((s.weekShare / 100) * ((usd * 12) / 52)) + ' of your ' + label + ' plan')
  }
  return parts.length > 0 ? { text: parts.join(' · '), isDim: true } : null
}

// Line 3: one habit that saves usage, when it applies right now
function tipLine(s: Snapshot): Line | null {
  const size = formatTokens(s.tokens) + ' tokens'
  const isBig = s.tokens >= BIG_CONTEXT
  if (s.isWorking) {
    return { text: 'Let Claude think. Stopping it to ask again re-sends all ' + size + '.', color: 'warning' }
  }
  if (s.draft === 'short' && isBig) {
    return { text: 'Short follow-up? One full message beats three short ones: each send re-reads all ' + size + '.', color: 'warning' }
  }
  const isLowEffort = s.effort === 'low' || s.effort === 'medium'
  const keepsCache = s.model !== null && EFFORT_KEEPS_CACHE.some(key => s.model.includes(key))
  if (s.draft === 'long' && isLowEffort && keepsCache) {
    return { text: 'Big ask at ' + s.effort + ' effort? /effort high lets Claude think longer, and on this model it keeps your cache.', color: 'warning' }
  }
  const left = msLeft(s)
  if (left !== null && left <= 0 && isBig) {
    const cost = sendCost(s)
    const rewrite = cost ? 'the ' + money(cost.cold) + ' rewrite' : 'rewriting ' + size
    return { text: 'Starting something new? /clear first, so the next send skips ' + rewrite + '.', color: 'warning' }
  }
  return null
}

// The lifetime in use: the person's choice, or the one the plan gives
async function currentTtl($): Promise<Ttl> {
  const chosen = await read($, mode)
  return chosen === 'auto' ? await read($, autoTtl) : chosen
}

async function snapshot($, isWorking: boolean): Promise<Snapshot> {
  const chosenPlan = await read($, plan)
  const start = await read($, weekStart)
  const now = await read($, weekNow)
  return {
    at: await read($, lastAt),
    tokens: await read($, tokens),
    ttl: await currentTtl($),
    now: await $.clock.now(),
    isWorking,
    model: await read($, model),
    effort: await read($, effort),
    draft: await read($, draft),
    isSubscription: chosenPlan === 'api' ? false : chosenPlan !== 'auto' || (await read($, hasLimits)),
    last: await read($, lastMessage),
    plan: chosenPlan,
    weekShare: start !== null && now !== null ? Math.max(0, now - start) : null,
  }
}

// Copy the saved choices from $.store into $.state
async function loadChoices($) {
  const savedMode = await $.store.get('mode')
  if (savedMode === 'auto' || savedMode === '5m' || savedMode === '1h') await update($, mode, () => savedMode)
  const savedPlan = await $.store.get('plan')
  if (typeof savedPlan === 'string' && PLAN_CHOICES.includes(savedPlan)) {
    const value = savedPlan as Plan
    await update($, plan, () => value)
  }
}

// The percent used of one rate-limit window, or null when the reading has none
function windowPct(usage, kind: string): number | null {
  const found = usage.rateLimits.find(l => l.kind === kind)
  return found ? found.percentUsed : null
}

export const register: Register = on => {
  // The lastAt the amber toast last fired for, so it fires once per cool-down
  let warnedFor: number | null = null
  // The session's cost and 5-hour percent when the current turn started
  let costAtStart: number | null = null
  let fiveAtStart: number | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-warm',
      description: 'Cache band: show, hide, set the cache lifetime (ttl) or your Claude plan (plan)',
      argumentHint: '[show | hide | ttl auto|5m|1h | plan auto|pro|max5|max20|api]',
      immediate: true,
    })
    await loadChoices($)

    // Redraw once a second so the countdown moves, and warn once when it gets short
    $.clock.every(1000, async () => {
      const at = await read($, lastAt)
      if (at !== null && at !== warnedFor) {
        const left = TTL_MS[await currentTtl($)] - ((await $.clock.now()) - at)
        if (left > 0 && left <= WARN_MS) {
          warnedFor = at
          $.ui.toast('Cache cools in 5 min. Reply now, or /compact at a break.')
        }
      }
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  // /clear, /resume and /branch reset $.state, so load the saved choices again
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadChoices($)
    return next(e)
  })

  // Track how much is typed, so the tips can tell a quick "ok" from a big ask
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    const size = draftSize(box.text.length)
    if (size !== (await read($, draft))) await update($, draft, () => size)
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, draft, () => 'none')
    return next(e)
  })

  // A main-conversation turn starts: note the cost so far, to price this message
  on('turn.start', async ($, e, next) => {
    const usage = await $.session.usage()
    costAtStart = usage.cost ? usage.cost.usd : null
    fiveAtStart = windowPct(usage, 'five_hour')
    return next(e)
  })

  // Each request in the main conversation reads or writes the cache, which restarts its clock
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      const named = e.model
      const level = e.effort ?? null
      await update($, lastAt, () => at)
      await update($, model, () => named)
      await update($, effort, () => level)
    }
    return yield* next(e)
  })

  // After a main-conversation turn, read the context size, the plan's lifetime and what the turn cost
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const usage = await $.session.usage()
    const n = usage.context.tokens
    if (n !== undefined) await update($, tokens, () => n)
    if (e.usage) {
      const answered = e.usage.model
      await update($, model, () => answered)
    }

    // A subscription reports its 5-hour and weekly windows. Within them Claude Code
    // asks for the 1-hour cache; past them it draws on usage credits at 5 minutes
    const five = windowPct(usage, 'five_hour')
    const week = windowPct(usage, 'seven_day')
    const isLimited = five !== null || week !== null
    const isOverLimit = (five !== null && five >= 100) || (week !== null && week >= 100)
    const ttl: Ttl = isLimited && !isOverLimit ? '1h' : '5m'
    await update($, hasLimits, () => isLimited)
    await update($, autoTtl, () => ttl)

    // A window that reset during the turn reads lower than at the start: count from zero
    const cost = usage.cost ? usage.cost.usd : null
    const spent: LastMessage = {
      usd: cost !== null && costAtStart !== null ? Math.max(0, cost - costAtStart) : null,
      fivePct: five !== null && fiveAtStart !== null ? (five >= fiveAtStart ? five - fiveAtStart : five) : null,
    }
    await update($, lastMessage, () => spent)

    if (week !== null) {
      const first = await read($, weekStart)
      // The weekly window reset since the first reading: count from this one
      if (first === null || week < first) await update($, weekStart, () => week)
      await update($, weekNow, () => week)
    }

    return result
  })

  // Each model has its own cache, so a switch starts cold
  on('classic.PostModelSwitch', async ($, e, next) => {
    const switched = e.to_model
    await update($, lastAt, () => 0)
    await update($, model, () => switched)
    return next(e)
  })

  on('command.run', { command: 'cache-warm' }, async ($, e) => {
    const words = (e.args ?? '').trim().split(/\s+/).filter(Boolean)

    if (words[0] === 'hide') {
      await update($, isHidden, () => true)
      return { text: 'Cache band hidden. /cache-warm show brings it back.' }
    }

    if (words[0] === 'ttl') {
      const choice = words[1]
      if (choice !== 'auto' && choice !== '5m' && choice !== '1h') {
        return { text: 'Use /cache-warm ttl auto, 5m or 1h. auto reads it from your plan.' }
      }
      const value: TtlMode = choice
      await update($, mode, () => value)
      await $.store.set('mode', value)
      return { text: 'Cache lifetime set to ' + value + '.' }
    }

    if (words[0] === 'plan') {
      const choice = words[1] ?? ''
      if (!PLAN_CHOICES.includes(choice)) {
        return { text: 'Use /cache-warm plan pro, max5, max20, api or auto. It prices your chat as a share of your plan.' }
      }
      const value = choice as Plan
      await update($, plan, () => value)
      await $.store.set('plan', value)
      const named = value === 'pro' || value === 'max5' || value === 'max20' ? PLANS[value].label + ' ($' + PLANS[value].usd + '/month)' : value
      return { text: 'Plan set to ' + named + '.' }
    }

    if (words.length > 0 && words[0] !== 'show') {
      return { text: 'Use /cache-warm show, hide, ttl auto|5m|1h, or plan auto|pro|max5|max20|api.' }
    }

    await update($, isHidden, () => false)
    const s = await snapshot($, false)
    const lines = [cacheLine(s), moneyLine(s)].filter((line): line is Line => line !== null).map(line => line.text)
    // Before the first reply there is no rate-limit reading to tell the plan by
    if (s.at !== null) {
      const chosen = await read($, mode)
      lines.push('Cache lifetime ' + s.ttl + (chosen === 'auto' ? ', from your plan.' : ', set by you.'))
    }
    return { text: lines.join('\n') }
  })

  // The hint line under the prompt (terminal): what this send costs, while you type
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!e.props.isDraft || (await read($, isHidden))) return next(e)
    const cost = sendCost(await snapshot($, e.props.isWorking))
    if (cost === null) return next(e)
    const tail = (e.props.tail ?? '') + ' · this send ≈ ' + money(cost.warm)
    return next({ ...e, props: { ...e.props, tail } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const s = await snapshot($, e.props.isWorking)
    const cache = cacheLine(s)
    const cost = moneyLine(s)
    const tip = tipLine(s)
    const { Box, Text } = $.ui.resolve(e)
    // Keep whatever other mods draw in the band, under these lines
    const theirs = await next(e)

    return (
      <Box flexDirection="column">
        <Text color={cache.color} dimColor={cache.isDim} wrap="truncate-end">
          {cache.text}
        </Text>
        {cost && (
          <Text dimColor wrap="truncate-end">
            {cost.text}
          </Text>
        )}
        {tip && (
          <Text color={tip.color} wrap="truncate-end">
            {tip.text}
          </Text>
        )}
        {theirs}
      </Box>
    )
  })
}

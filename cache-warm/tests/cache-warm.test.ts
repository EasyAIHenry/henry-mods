import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 }
const HINT = { isDraft: true, isWorking: false, hint: '? for shortcuts' }
const MINUTE = 60_000

// A Max plan mid-week, 446k tokens in context, before and after one message
function planUsage(cost: number, five: number, week: number) {
  return {
    startedAt: 0,
    context: { tokens: 446_000, window: 1_000_000, percent: 45 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: five },
      { kind: 'seven_day', percentUsed: week },
    ],
    cost: { usd: cost },
  }
}

// An API key: no rate-limit windows, only the dollar ledger
function apiUsage(cost: number) {
  return { startedAt: 0, context: { tokens: 400_000, window: 1_000_000, percent: 40 }, rateLimits: [], cost: { usd: cost } }
}

// Stand in for the engine beneath the mod; `world.usage` is what $.session.usage answers
function engine(on, world) {
  on('session.usage', () => ({ value: world.usage }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.edit', (_$, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  // The band is empty until a mod fills it; the hint line records the tail it was handed
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    world.tail = e.props.tail
    return $.ui.resolve(e).Text({ children: [e.props.hint] })
  })
}

// One message: the turn starts, one request goes out at `effort`, the turn ends with `after`
async function oneTurn($, world, after, model = 'claude-opus-5-5', effort = 'medium') {
  await $.turn.start({ text: 'go', turnId: 't1' })
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 3 })) {
    // Nothing streams from the stand-in
  }
  world.usage = after
  const usage = { model, input_tokens: 10, output_tokens: 500, cache_read_input_tokens: 446_000, cache_creation_input_tokens: 0 }
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 1_000, isAborted: false, reason: 'answer', usage })
}

async function bandLines(ui, props = BAND) {
  await ui.redraw(props)
  return (await ui.findAll({ type: 'Text' })).map(found => found.text)
}

for (const surface of SURFACES) {
  test(`on a Max plan with Opus 5.5: hour countdown, 40x cold cost, price per message (${surface})`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    mock.store(on)
    const world = { usage: planUsage(4, 10, 60) }
    engine(on, world)

    const ui = await $.ui.mount({ plugin: 'cache-warm', surface, component: 'AbovePrompt', props: BAND })
    expect(await bandLines(ui)).toEqual(['○ cache: no reading yet · it starts with Claude’s first reply'])

    await oneTurn($, world, planUsage(4.31, 10.6, 60.2))
    expect(await bandLines(ui)).toEqual([
      '● cache warm · 60 min left of 60 · 446k tokens · going cold costs 40x',
      'next send ≈ $0.09 at API prices, $3.57 if cold · last message used 0.6% of your 5-hour limit',
    ])

    // Told the plan, a second message prices the chat as a share of the week
    await $.command.run({ command: 'cache-warm', args: 'plan max5' })
    await oneTurn($, world, planUsage(4.62, 11.2, 61))
    expect((await bandLines(ui))[1]).toBe(
      'next send ≈ $0.09 at API prices, $3.57 if cold · last message used 0.6% of your 5-hour limit · this chat ≈ $0.18 of your Max 5x plan',
    )

    // While Claude works, the band says to let it think
    expect((await bandLines(ui, { ...BAND, isWorking: true }))[2]).toBe(
      'Let Claude think. Stopping it to ask again re-sends all 446k tokens.',
    )

    await clock.advance(56 * MINUTE)
    expect((await bandLines(ui))[0]).toBe('◐ cache cools in 4 min · reply now, or /compact at a break · 446k tokens')

    await clock.advance(5 * MINUTE)
    const cold = await bandLines(ui)
    expect(cold[0]).toBe('○ cache cold · your next message re-sends 446k tokens at 40x the warm cost')
    expect(cold[2]).toBe('Starting something new? /clear first, so the next send skips the $3.57 rewrite.')
  })
}

test('on an API key with Sonnet 5.5: 5-minute cache, dollars per message', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const world = { usage: apiUsage(1) }
  engine(on, world)

  const ui = await $.ui.mount({ plugin: 'cache-warm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await oneTurn($, world, apiUsage(1.31), 'claude-sonnet-5-5', 'high')
  expect(await bandLines(ui)).toEqual([
    '◐ cache cools in 5 min · reply now, or /compact at a break · 400k tokens',
    'next send ≈ $0.08, $1.00 if cold · last message $0.31',
  ])
})

test('typing: a short follow-up and a big ask each get a tip, and the hint line prices the send', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const world = { usage: planUsage(4, 10, 60), tail: undefined }
  engine(on, world)

  const ui = await $.ui.mount({ plugin: 'cache-warm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await oneTurn($, world, planUsage(4.31, 10.6, 60.2))

  const edit = (text, inputText) =>
    $.prompt.edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })

  await edit('', 'ok')
  expect((await bandLines(ui))[2]).toBe(
    'Short follow-up? One full message beats three short ones: each send re-reads all 446k tokens.',
  )

  await edit('ok', ' '.repeat(10) + 'rebuild the pricing page '.repeat(20))
  expect((await bandLines(ui))[2]).toBe(
    'Big ask at medium effort? /effort high lets Claude think longer, and on this model it keeps your cache.',
  )

  await $.ui.mount({ plugin: 'cache-warm', surface: 'terminal', component: 'PromptHint', props: HINT })
  expect(world.tail).toBe(' · this send ≈ $0.09')

  await $.prompt.submit({ text: 'rebuild the pricing page' })
  expect(await bandLines(ui)).toHaveLength(2)
})

test('/cache-warm sets the lifetime and the plan, hides and shows the band', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  engine(on, { usage: planUsage(4, 10, 60) })

  expect((await $.command.run({ command: 'cache-warm', args: 'ttl 5m' })).text).toBe('Cache lifetime set to 5m.')
  expect((await $.command.run({ command: 'cache-warm', args: 'ttl 2h' })).text).toContain('Use /cache-warm ttl auto, 5m or 1h')
  expect((await $.command.run({ command: 'cache-warm', args: 'plan max20' })).text).toBe('Plan set to Max 20x ($200/month).')
  expect((await $.command.run({ command: 'cache-warm', args: 'plan team' })).text).toContain('Use /cache-warm plan pro, max5')

  await $.command.run({ command: 'cache-warm', args: 'hide' })
  const ui = await $.ui.mount({ plugin: 'cache-warm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text' })).toBeUndefined()

  const shown = await $.command.run({ command: 'cache-warm', args: '' })
  expect(shown.text).toContain('no reading yet')
})

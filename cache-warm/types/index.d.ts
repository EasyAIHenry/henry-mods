// How long a cache entry lives after the last request reads or writes it
export type Ttl = '5m' | '1h'

// 'auto' reads it from the plan; '5m' or '1h' is the person's own choice
export type TtlMode = 'auto' | Ttl

// Which Claude plan pays for the session; 'auto' only tells a subscription from an API key
export type Plan = 'auto' | 'pro' | 'max5' | 'max20' | 'api'

// How much is typed in the prompt box: nothing, a few words, a normal ask, a big one
export type DraftSize = 'none' | 'short' | 'normal' | 'long'

// What the last message cost: dollars at API prices, and points of the 5-hour limit
export type LastMessage = { usd: number | null; fivePct: number | null }

declare module 'claude-code' {
  interface PluginState {
    'cache-warm': {
      // When the last main-conversation request went out, in ms; 0 after a model switch
      lastAt: number | null
      // Prompt tokens the next request re-sends
      tokens: number
      autoTtl: Ttl
      mode: TtlMode
      isHidden: boolean
      // The model the last main-conversation request named, and its effort
      model: string | null
      effort: string | number | null
      draft: DraftSize
      // Whether the last reading had a subscription's 5-hour and weekly windows
      hasLimits: boolean
      lastMessage: LastMessage | null
      // The weekly window's percent at the first reading of the session, and now
      weekStart: number | null
      weekNow: number | null
      plan: Plan
    }
  }
}

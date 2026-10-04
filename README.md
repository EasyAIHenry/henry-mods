# henry-mods

Claude Code mods by Henry Chua. A mod is a small add-on that runs inside Claude Code and draws on the screen.

## cache-warm

Stop wasting Claude credits. Claude keeps your chat warm for an hour on a Pro or Max plan (5 minutes on the API). Let it go cold and your next message re-sends the whole chat at up to 40x the warm price. This mod shows you, above where you type:

1. **Time left** before your chat goes cold (it turns amber with a pop-up at 5 minutes, red at zero)
2. **The price** of your next message, warm and cold
3. **One tip** for what you're doing right now: let Claude think, send one full message instead of "ok", or `/clear` when you start something new on a cold chat

### Install (Terminal)

Needs Claude Code 2.1.287 or newer.

```bash
claude update
claude plugin marketplace add EasyAIHenry/henry-mods
claude plugin install cache-warm@henry-mods
```

Then start `claude`. The lines show after Claude's first reply. They also show in the Code tab of the Claude desktop app.

### Commands

| Command | What it does |
|---|---|
| `/cache-warm` | Show the band and the current reading |
| `/cache-warm hide` | Hide the band |
| `/cache-warm plan pro` (or `max5`, `max20`, `api`, `auto`) | Adds what each chat costs as a share of your plan |
| `/cache-warm ttl 5m` (or `1h`, `auto`) | Set the cache lifetime yourself |

To remove it: `claude plugin uninstall cache-warm@henry-mods`.

### What it can touch

A mod runs with your permissions, so check any mod before you install it. You can list what this one does without running it:

```bash
git clone https://github.com/EasyAIHenry/henry-mods
claude plugin validate henry-mods/cache-warm
```

It reads the clock and the session's token usage, saves two settings (your plan and the cache lifetime), and draws. It makes no network requests and reads no files.

### Notes

- Prices are Anthropic's API list prices (Opus 5.5: $4 per million input tokens, $0.20 for a cache read, $8 to rewrite the 1-hour cache). On a Pro or Max plan you don't pay dollars per message; it comes out of your usage limit.
- The plan share is an estimate: your plan's monthly price, turned into a weekly price, times the share of your weekly limit the chat used.
- Tested on Claude Code 2.1.289, 4 October 2026.

MIT licence.

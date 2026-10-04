# jev-effort

A Claude Code mod that sets the main conversation's reasoning effort for each prompt, using [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's decision model, reached through OpenRouter.

On each prompt it reads recent context and asks Jev one question: how much reasoning does this work need? It maps the score (0–3) to `low` / `medium` / `high` / `xhigh` and applies it at the turn's first request. The turn keeps that effort through all its tool calls. Subagents are never touched, and the mod never sets `max`.

**Shadow mode is on by default.** It classifies and logs what it *would* set, without changing anything. Turn it off once the logs show that Jev's calls match yours.

## Install

Requires Claude Code ≥ 2.1.259 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/jev-effort
```

Put your OpenRouter key in the `OPENROUTER_API_KEY` environment variable, or under `pluginConfigs` → `jev-effort` → `options` → `apiKey` in settings (it's a secret, so `/config` doesn't show it). Change the other options, such as `shadow`, through `/config`.

## Options

| Option | Default | |
|---|---|---|
| `apiKey` | `""` | OpenRouter key. If empty, the `OPENROUTER_API_KEY` environment variable is used; if that's unset too, the mod does nothing. |
| `shadow` | `true` | Log only; never change a request. |
| `sendContext` | `true` | Send the last reply, earlier prompts and the last turn's tool names. Off: the prompt alone. |
| `minUpgradeConfidence` | `0.3` | How sure Jev must be to raise effort above your `/effort`. |
| `minDowngradeConfidence` | `0.6` | How sure Jev must be to lower it. |
| `timeoutMs` | `800` | The longest each prompt waits for Jev (100–5000). |
| `logDecisions` | `true` | One transcript line per turn. |
| `model` | `~typesafe/jev-latest` | Pin a version (e.g. `typesafe/jev-1.13`) while evaluating. |
| `endpoint` | `https://openrouter.ai/api/v1/systemone` | For TypeSafe-direct: `https://api.typesafe.ai/v1/systemone`, with model `jev-latest`. |

Your `/effort` is the baseline the mod moves from: neither a floor nor a ceiling. With `/effort max`, a numeric budget, or a model without effort, the mod leaves the turn alone.

**What gets skipped.** Bare slash commands (`/simplify`), prompts typed while a turn is running, empty prompts, and anything that isn't from you (notifications, peers, schedules) are not classified.

**Failures.** On a timeout, an HTTP error or a bad answer, the turn repeats the previous turn's effort (as long as your `/effort` hasn't changed). That keeps the effort steady instead of snapping back.

## Reading the output

- **Transcript:** one line per turn, e.g. `[jev-effort] shadow · jev 0.42 → low (conf 0.71, 212ms) · high → low`.
- **Status line:** `jev·s ● ▁▃█▂▁ medium → low 0.71 · 340ms`. `jev·s` means shadow mode, `jev` means routing. The glyph is the request state: `◌` asking, `●` answered, `✕` failed (timeout or HTTP error), `–` nothing sent (skipped). The bars are the last 8 Jev scores, low to high; if every bar is the same height, Jev isn't telling your prompts apart.

In shadow mode, compare those lines with your own sense of each task. Once Jev's calls look right, set `shadow: false`. If its confident downgrades are often wrong, raise `minDowngradeConfidence`. Running a while with `sendContext: false` shows what the context adds.

## Prompt cache

On models with per-turn effort (Opus 5.5, Sonnet 5.5, Opus 5, Fable 5.1, Mythos 5.1), Claude Code sends an effort change as an in-conversation message, so the prompt cache survives. Measured on 2.1.289 with a subscription (2026-10-04): when a `turn.step` hook changed the effort, the next request still read the whole ~82k-token prefix from cache. On older models, an effort change re-caches the conversation.

## Privacy

With a key set, each classified prompt sends the following to `endpoint` (OpenRouter, which forwards it to TypeSafe):
- your prompt (up to 2000 characters)
- Claude's last reply (up to 1500)
- up to 3 earlier prompts (300 characters each)
- the last turn's tool names, with counts and failure counts

Never sent: tool inputs or outputs, file contents, the system prompt, CLAUDE.md or memory, images, session ids or paths. Whatever you or Claude wrote into those texts goes with them.

## License

MIT. Forked from claude-code-templates' `jev-model-router` v0.4.2 (github.com/davila7/claude-code-templates), reduced to effort routing with conversation context, shadow mode and OpenRouter.

Copyright (c) 2025 Daniel (San) Ávila. Modifications copyright (c) 2026 gebeer.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

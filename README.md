# jev-effort

A Claude Code mod. It sets the reasoning effort for each prompt.

The mod sends your prompt to [Jev](https://openrouter.ai/docs/guides/community/jev) through OpenRouter. Jev gives a score from 0 to 3. The mod changes the score to an effort level:

| Score | Effort |
|---|---|
| 0 | `low` |
| 1 | `medium` |
| 2 | `high` |
| 3 | `xhigh` |

- The effort stays the same for all tool calls in the turn.
- The mod does not change subagents.
- The mod does not set `max`.

> **Shadow mode is on by default.** The mod only writes what it *would* set. It does not change the effort.

## Requirements

- Claude Code 2.1.259 or later
- An [OpenRouter](https://openrouter.ai/keys) API key

## Install

1. Clone the repository:

   ```bash
   git clone https://github.com/gebeer/jev-effort.git
   ```

2. Start Claude Code with the mod:

   ```bash
   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir ./jev-effort
   ```

## Set the OpenRouter key

Use one of these two methods.

**Method A: environment variable**

```bash
export OPENROUTER_API_KEY=sk-or-...
```

**Method B: settings file**

Add the key to `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "jev-effort": {
      "options": {
        "apiKey": "sk-or-..."
      }
    }
  }
}
```

Note:
- If you set both, the mod uses the settings file.
- If you set no key, the mod does nothing.
- `/config` does not show the key, because the key is secret.

## Options

Change the options in `/config`, or in `pluginConfigs` → `jev-effort` → `options`.

| Option | Default | Function |
|---|---|---|
| `apiKey` | `""` | The OpenRouter key. |
| `shadow` | `true` | Write the decision only. Do not change the effort. |
| `sendContext` | `true` | Send recent conversation context. If `false`, send the prompt only. |
| `minUpgradeConfidence` | `0.3` | The minimum confidence to increase the effort. |
| `minDowngradeConfidence` | `0.6` | The minimum confidence to decrease the effort. |
| `timeoutMs` | `800` | The maximum wait time for Jev, in ms (100–5000). |
| `logDecisions` | `true` | Write one line per turn in the transcript. |
| `model` | `~typesafe/jev-latest` | The Jev model. Example: `typesafe/jev-1.13`. |
| `endpoint` | `https://openrouter.ai/api/v1/systemone` | The API URL. For TypeSafe direct, use `https://api.typesafe.ai/v1/systemone` with model `jev-latest`. |

## How it works

- Your `/effort` is the start point. The mod increases or decreases from it.
- With `/effort max`, a numeric budget, or a model without effort, the mod does nothing.
- If Jev fails (timeout, HTTP error, bad answer), the mod uses the effort of the previous turn.

The mod does not classify these prompts:
- Slash commands without text (for example `/simplify`)
- Prompts that you type while a turn runs
- Empty prompts
- Messages that do not come from you (notifications, peers, schedules)

## Read the output

**Transcript line:**

```
[jev-effort] shadow · jev 0.42 → low (conf 0.71, 212ms) · high → low
```

**Status line:**

```
jev-effort: ● ▁▃█▂▁ medium → low 0.71 · 340ms
```

| Symbol | Meaning |
|---|---|
| `◌` | Request in progress |
| `●` | Jev answered |
| `✕` | Request failed |
| `–` | Prompt skipped |
| `▁▃█` | The last 8 Jev scores. If all bars have the same height, Jev does not see a difference between your prompts. |

## Tune the mod

1. Use shadow mode for some time.
2. Compare each decision with your own opinion.
3. When the decisions are correct, set `shadow` to `false`.
4. If Jev decreases the effort incorrectly too often, increase `minDowngradeConfidence`.

## Prompt cache

On newer models (Opus 5.5, Sonnet 5.5, Opus 5, Fable 5.1, Mythos 5.1), an effort change does not break the prompt cache.

On older models, an effort change creates a new cache for the conversation.

Tested on Claude Code 2.1.289, 2026-10-04.

## Privacy

The mod sends this data to the endpoint (OpenRouter sends it to TypeSafe):
- Your prompt (maximum 2000 characters)
- Claude's last reply (maximum 1500 characters)
- Maximum 3 earlier prompts (300 characters each)
- The tool names of the last turn, with counts and failure counts

The mod does **not** send:
- Tool inputs or outputs
- File contents
- The system prompt, CLAUDE.md, or memory
- Images, session IDs, or paths

Note: Text that you or Claude write in the prompts and replies goes with them.

## License

MIT. See [LICENSE](LICENSE).

Forked from `jev-model-router` v0.4.2 in [claude-code-templates](https://github.com/davila7/claude-code-templates).

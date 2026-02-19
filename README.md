# pi-context-pruner

`pi-context-pruner` reduces token/context growth in Pi by shrinking heavy `toolResult` payloads (large `read`/`bash` output), while staying friendly to prompt caching economics.

It does **not** modify session history files. Transformations happen only in model-facing flow (`tool_result` and optional `context` hook).

## Prompt cache economics (important)

Naive per-turn history rewriting can destroy prompt-prefix cache hit rates.

This extension avoids that with a Codex-inspired strategy:

1. **Stable ingest-time truncation (default ON)**
   - Large tool outputs are canonicalized once when `tool_result` arrives.
2. **Context pruning optional (default OFF)**
   - `/context-pruner context-on` enables context-hook pruning.
3. **Hysteresis thresholds**
   - Separate activate/deactivate ratios reduce prune/unprune flapping.
4. **Safety rails**
   - Keep recent tool results, keep errors, keep `edit`/`write` full.

## Install

### Local path

```bash
pi install /absolute/path/to/pi-context-pruner
/reload
```

### npm (after publish)

```bash
pi install npm:pi-context-pruner
/reload
```

## Commands

```text
/context-pruner status
/context-pruner settings
/context-pruner on
/context-pruner off
/context-pruner balanced
/context-pruner aggressive
/context-pruner context-on
/context-pruner context-off
/context-pruner observe-on
/context-pruner observe-off
/context-pruner set activate <0-1>
/context-pruner set deactivate <0-1>
/context-pruner set keep-recent <int>
/context-pruner set keep-recent-heavy <int>
/context-pruner set heavy-chars <int>
/context-pruner set max-old-chars <int>
/context-pruner set tool-max-chars <int>
/context-pruner reset
/context-pruner help
```

## Settings UI

Use `/context-pruner settings` for interactive config (toggle modes, select profile, adjust numeric thresholds) without manually typing keys.

## Persistence scope

Settings are persisted globally across sessions/restarts in:

- `~/.pi/agent/state/pi-context-pruner.json`

For tests/automation you can override path via env var:

- `PI_CONTEXT_PRUNER_CONFIG_PATH`

## Observability

When observability is enabled (default), the extension emits action visibility for:

- tool-result truncation events
- context pruning activation/deactivation
- context prune passes (number of messages shrunk)
- settings/profile changes

In interactive mode this appears via notifications + a widget (`context-pruner recent actions`).

## Defaults

### Stable tool-result truncation (default ON)

- `tool-max-chars`: 10000

### Context pruning (default OFF)

When enabled:

#### balanced

- activate at **80%** context usage
- deactivate at **70%**
- keep recent tool results: 10
- keep recent heavy tool results: 6
- old heavy prune threshold: 2500 chars

#### aggressive

- activate at **70%**
- deactivate at **55%**
- keep recent tool results: 6
- keep recent heavy tool results: 3
- old heavy prune threshold: 1500 chars

## Development

```bash
pnpm install
pnpm run check
```

## Project structure

- `src/index.ts` – extension wiring, command handling, observability
- `src/pruner.ts` – pure context-pruning logic
- `src/persistence.ts` – global settings persistence
- `src/constants.ts` – default profiles and constants
- `src/commands.ts` – command parsing/help
- `test/*.test.ts` – unit tests

## Publish

```bash
pnpm publish --access public
```

## License

MIT

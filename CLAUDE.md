# CLAUDE.md — Jira CLI Agent Rules

This file defines conventions, architecture decisions, and rules for maintaining and extending this codebase.
Any AI agent (Claude, Copilot, etc.) working on this project must follow these rules.

---

## Project Overview

This is a **Node.js CommonJS CLI tool** named `jira` that interacts with the **Atlassian Jira REST API v3**.
It is designed for personal developer use and works with **any Jira Cloud workspace**.

Published to npm as `@g-abhishek/jira-cli` — installable globally via `npm install -g @g-abhishek/jira-cli`.

---

## Critical Architecture Rules

### 1. CommonJS ONLY — No ESM
All files must use `require()` / `module.exports`. Never use `import` / `export`.
This is required for:
- npm package compatibility (consumers install via `npm install -g`, no transpilation step)
- The specific library versions chosen (chalk v4, ora v5, inquirer v8)

```js
// ✅ Correct
const chalk = require('chalk');
module.exports = { ... };

// ❌ Never do this
import chalk from 'chalk';
export default { ... };
```

### 2. Library Version Constraints
These specific versions are pinned because newer versions dropped CommonJS support:

| Library | Version | Reason |
|---|---|---|
| `chalk` | `^4.x` | v5+ is ESM-only |
| `ora` | `^5.x` | v6+ is ESM-only |
| `inquirer` | `^8.x` | v9+ is ESM-only |

**Never upgrade these without verifying CommonJS compatibility.**

### 3. Jira API Version
Always use **REST API v3** (`/rest/api/3/`). Never use v2 or latest.
Exception: Agile endpoints use `/rest/agile/1.0/`.

### 4. Auth Method
Always use **Basic Auth** with `email:api_token` base64 encoding.
Never use OAuth, session tokens, or other auth methods.

```js
auth: {
  username: email,
  password: token,
}
```

---

## File Structure Rules

```
jira-cli/
├── commands/       One file per CLI command (list, create, update, etc.)
├── services/       API communication only (jiraService.js)
├── utils/          Shared utilities (no API calls)
├── validators/     Zod schemas only
├── index.js        Entry point + yargs config
└── package.json
```

**Rules:**
- `commands/` files contain only CLI logic (prompts, formatting, orchestration)
- `services/jiraService.js` contains ALL Jira API calls — no API calls in commands
- `utils/` files must not make direct API calls
- Each command file exports exactly: `{ command, desc, builder, handler }`

---

## Custom Fields — Dynamic Discovery (No Hardcoding)

Custom dropdown fields (option fields) are **fully dynamic**. The CLI works with any Jira project's custom fields without any hardcoded field IDs.

### How it works

`jira sync` calls the Jira `createMeta` API and discovers **all** custom fields that have `allowedValues`. It stores two objects in the cache:

| Cache Key | Content |
|---|---|
| `customFields` | `{ "Field Label": ["option1", "option2", ...], ... }` |
| `customFieldIds` | `{ "Field Label": "customfield_XXXXX", ... }` |

`jira create` and `jira update --fields` read these objects and generate prompts dynamically — one prompt per discovered custom field.

### Writing to custom fields in payloads

Always use:
- **Option fields**: `{ value: "option name" }`
- **User fields**: `{ accountId: "..." }`
- **Array fields**: `[{ name: "..." }]`
- **Number fields**: raw number (e.g. story points `customfield_10026`)

### The only hardcoded field

Story Points (`customfield_10026`) is the one universal field hardcoded because it is standard across all Jira instances.

---

## Sync Cache — What Gets Stored

Cache lives in `~/.jira-cli/cache.json`. Default TTL: 24 hours.
Cache keys follow the pattern: `{PROJECT_KEY}:{data_type}`

| Cache key | Populated by | Used by |
|---|---|---|
| `{KEY}:fields` → `issueTypes` | project info API | `create` |
| `{KEY}:fields` → `fixVersions` | project versions API | `create` |
| `{KEY}:fields` → `components` | project components API | `create` |
| `{KEY}:fields` → `priorities` | priorities API | `create`, `update` |
| `{KEY}:fields` → `customFields` | createMeta API — all custom option fields | `create`, `update --fields` |
| `{KEY}:fields` → `customFieldIds` | createMeta API — maps label → fieldId | `create`, `update --fields` |
| `{KEY}:fields` → `statuses` | createMeta API | `search --interactive` |
| `{KEY}:fields` → `activeSprints` | Agile boards API | `dashboard` |
| `{KEY}:sync_meta` | set by sync itself | staleness check |

**Rules:**
- Transitions are **not** cached — always fetch live (depend on current ticket state)
- User search results are **not** cached (users change too frequently)
- Always check `cache.isSyncStale(projectKey)` and warn user if stale

---

## Sync Enforcement

Commands that need dropdown values (`create`, `update --fields`, `search --interactive`) call
`requireSyncedData()` from `utils/requireSync.js`. If sync has never been run, the command
throws a clear error:

```
✖ Error: No sync data found for project MYPROJ.
  Run jira sync --project MYPROJ first, then retry.
```

`requireSyncedField()` is used only for fields that **must** be present (e.g. `issueTypes`).
Optional fields (fixVersions, components, customFields) use soft checks: `synced.X || []`.

---

## Description Formats

Jira uses **Atlassian Document Format (ADF)** for rich text fields.
When writing descriptions/comments via API, always convert plain text to ADF:

```js
// Minimum valid ADF structure
{
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'Your text here' }]
    }
  ]
}
```

Use `utils/aiHelper.js → extractPlainText()` for reading ADF back as plain text.

**Issue-type specific description templates** are in `utils/aiHelper.js → DESCRIPTION_TEMPLATES`.
Always select the correct template based on issue type (Bug, Story, Task, Epic).

---

## AI Providers

Exactly two supported providers — no others:

| Provider | Config key | Model |
|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` (upgrade to `claude-sonnet-4-6` for quality) |
| OpenAI (Codex) | `OPENAI_API_KEY` | `gpt-4o-mini` (upgrade to `gpt-4o` for quality) |

Provider selection order: `AI_PROVIDER` config → Claude (if key present) → OpenAI (if key present) → `null` (AI disabled).

**AI failures must never break the workflow.** All AI functions in `utils/aiHelper.js` return a graceful fallback result when `getProvider()` returns null.

---

## Error Handling Rules

1. **Always use `utils/errorParser.js → printError()`** for user-facing errors. Never `console.error(err)`.
2. **Always use `logger.error()` for structured logging** so errors appear in `jira logs`.
3. **Never let the CLI crash with a stack trace** to the user. Catch all errors in command handlers.
4. **AI failures must never break the workflow.** All AI functions return a fallback result on failure.
5. **Network errors must be handled** — check for ECONNREFUSED, ENOTFOUND, ETIMEDOUT explicitly.

```js
// ✅ Correct pattern in every command handler
handler: async (argv) => {
  try {
    // ... command logic
  } catch (err) {
    printError(err);              // User-friendly message
    logger.error(`cmd failed: ${err.message}`);  // Structured log
    process.exit(1);
  }
}
```

---

## UX Rules

1. **Always use `ora` spinners** for any operation > ~300ms (API calls, AI calls, file I/O)
2. **Always use `chalk`** for colored output — follow this convention:
   - `chalk.cyan` — issue keys (e.g. PROJ-1234)
   - `chalk.green` — success messages
   - `chalk.red` — errors and blockers
   - `chalk.yellow` — warnings
   - `chalk.blue` — in-progress statuses
   - `chalk.dim` — secondary/metadata information
   - `chalk.bold` — headers and key info
3. **Never dump raw JSON** to the console unless `--json` flag is explicitly set
4. **Interactive prompts use `inquirer`** — prefer `list` type (arrow keys) over `input` for known options
5. **Stale sync warning** — always check `cache.isSyncStale(projectKey)` and warn if stale

---

## Adding New Commands

1. Create `commands/newcommand.js`
2. Export `{ command, desc, builder, handler }`
3. Register in `index.js` with `.command(require('./commands/newcommand'))`
4. Add new Jira API methods to `services/jiraService.js`
5. Add Zod schema to `validators/schema.js`
6. Add usage examples to `SETUP.md`

---

## Testing Checklist (Before Any Release)

Run through these manually:

- [ ] `jira doctor` — all checks pass
- [ ] `jira config show` — credentials display correctly (masked)
- [ ] `jira sync` — completes without errors, lists discovered custom fields
- [ ] `jira list` — shows your tickets
- [ ] `jira list --filter "bugs"` — AI filter works (or falls back gracefully)
- [ ] `jira view PROJ-XXXX` — shows full ticket details
- [ ] `jira create --dry-run` — payload preview shows custom fields dynamically
- [ ] `jira update PROJ-XXXX` — transitions list correctly
- [ ] `jira comment PROJ-XXXX -m "test"` — comment appears in Jira
- [ ] `jira dashboard` — renders and exits cleanly
- [ ] Disconnect network → commands fail with clean error messages (no stack traces)
- [ ] Remove both API keys → `create` still works (AI features skipped gracefully)

---

## Dependency Policy

- **Never add dependencies without documenting why** in this file
- **Prefer zero-dependency approaches** for simple utilities
- **Always check CommonJS compatibility** before adding new packages
- **npm compatibility** — any new native modules must work with a plain `npm install -g` (no native compile steps)

Current dependencies and why they exist:

| Package | Why |
|---|---|
| `@anthropic-ai/sdk` | Anthropic Claude API client — one of two supported AI providers |
| `axios` | HTTP client with interceptors for retry/logging |
| `axios-retry` | Automatic retry on 429/5xx responses |
| ~~`better-sqlite3`~~ | Replaced with JSON file cache (zero deps, no native compile) |
| `chalk@4` | Terminal color output (CommonJS, not v5) |
| `dotenv` | Load .env files |
| `inquirer@8` | Interactive prompts with arrow keys (CommonJS, not v9) |
| `openai` | OpenAI (Codex) API client — one of two supported AI providers |
| `ora@5` | Spinner during API calls (CommonJS, not v6) |
| `winston` | Structured logging with file rotation |
| `yargs` | CLI framework with command/option parsing |
| `zod` | Runtime input validation with type inference |

---

## Known Limitations

- Jira transitions are workflow-specific and vary per project board. Always fetch live.
- JSON file cache has no locking — concurrent CLI runs on the same machine could cause a race condition on writes (extremely unlikely in normal use).
- OpenAI uses `gpt-4o-mini` for cost efficiency — upgrade to `gpt-4o` in `aiHelper.js` for higher quality.
- Anthropic Claude uses `claude-haiku-4-5-20251001` for cost efficiency — upgrade to `claude-sonnet-4-6` in `aiProviders.js` for higher quality.
- Dashboard auto-refresh uses `setInterval` — very high refresh rates (< 5s) may hit Jira rate limits.
- `createMeta` API may return different field sets for different issue types. The sync deduplicates by taking the first issue type that exposes each field.

---

## Security Reminders

- `~/.jira-cli/config.json` must always be written with `mode: 0o600`
- Never log API tokens, even at debug level
- Never include credentials in error messages
- The `.gitignore` must always exclude `.env` and `*.json` credential files

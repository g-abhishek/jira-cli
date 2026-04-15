# CLAUDE.md — Jira CLI Agent Rules

This file defines conventions, architecture decisions, and rules for maintaining and extending this codebase.
Any AI agent (Claude, Copilot, etc.) working on this project must follow these rules.

---

## Project Overview

This is a **Node.js CommonJS CLI tool** named `jira` that interacts with the **Atlassian Jira REST API v3**.
It is designed for personal developer use, scoped to the **JCP (Jio Commerce Platform)** Atlassian workspace.

**Primary user**: Abhishek Gupta (`abhishek35.gupta@ril.com`)
**Jira workspace**: `gofynd.atlassian.net`
**Default project**: `JCP`

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

## JCP Project — Known Custom Fields

These are the Jira custom field IDs for the JCP project. Use these exact IDs when reading/writing fields:

| Field Name | Custom Field ID | Type |
|---|---|---|
| Story Points | `customfield_10026` | number |
| QA Story Points | `customfield_10075` | number |
| Total Story Points | `customfield_10096` | number |
| JCP Work Type | `customfield_17322` | option |
| JCP Planning Type | `customfield_17321` | option |
| JCP Delivery State | `customfield_17320` | option |
| JCP Cluster | `customfield_11371` | option |
| JCP Channel | `customfield_10455` | option |
| JCP Estimate | `customfield_17356` | option |
| JCP Planned Month | `customfield_17389` | option |
| JCP Planned Quarter | `customfield_17390` | option |
| Sprint | `customfield_10020` | array |
| Epic Link | `customfield_10014` | string |
| Assigned Developer | `customfield_10091` | user |
| Assigned QA | `customfield_10054` | user |
| Engineering Lead | `customfield_10055` | user |
| Product Manager | `customfield_10261` | user |
| Environment (dropdown) | `customfield_10030` | option |
| Severity | `customfield_10033` | option |
| Ticket Category | `customfield_10441` | option |
| Requesting Team | `customfield_10381` | option |
| SIT Due Date | `customfield_12790` | date |
| QA Due Date | `customfield_10417` | date |
| QA Start Date | `customfield_10416` | date |
| Affected Systems | `customfield_10056` | array |
| ADO Link | `customfield_10361` | string |
| BUG Description | `customfield_10272` | doc |
| STORY Description | `customfield_10273` | doc |
| EPIC Description | `customfield_10275` | doc |

**When writing to option fields**, always use `{ value: "option name" }` format.
**When writing to user fields**, always use `{ accountId: "..." }` format.
**When writing to array fields**, always use `[{ name: "..." }]` format.

---

## JCP Dropdown Values — Sync Required

**All dropdown field values MUST come from the sync cache. No hardcoded fallbacks.**

Commands that need dropdown values (`create`, `update --fields`, `search --interactive`) call
`requireSyncedField()` from `utils/requireSync.js`. If sync has not been run, the command
throws a clear error and tells the user to run `jira sync` first.

```
✖ Error: No sync data found for project JCP.
  Run jira sync --project JCP first, then retry.
```

**The only hardcoded values allowed** are calendar constants that never change:
```js
// JCP Planned Month — calendar constant, not project-specific
['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// JCP Planned Quarter — calendar constant, not project-specific
['JFM', 'AMJ', 'JAS', 'OND']
```

**Everything else must come from `cache.get(`${projectKey}:fields`)`:**

| Cache Key | Field | Populated By |
|---|---|---|
| `clusters` | JCP Cluster | `jira sync` → createmeta |
| `channels` | JCP Channel | `jira sync` → createmeta |
| `workTypes` | JCP Work Type | `jira sync` → createmeta |
| `planningTypes` | JCP Planning Type | `jira sync` → createmeta |
| `estimates` | JCP Estimate | `jira sync` → createmeta |
| `issueTypes` | Issue Types | `jira sync` → project info |
| `fixVersions` | Fix Versions | `jira sync` → project versions |
| `components` | Components | `jira sync` → project components |
| `priorities` | Priorities | `jira sync` → priorities API |
| `statuses` | Statuses | `jira sync` → createmeta |
| `environments` | Environment dropdown | `jira sync` → createmeta |
| `severities` | Severity | `jira sync` → createmeta |

**Never add hardcoded option arrays** to any command file. If a new field is needed,
add it to `commands/sync.js` → fetch from Jira → store in cache → use via `requireSyncedField()`.

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

## Cache Rules

- Cache lives in `~/.jira-cli/cache.json` (pure JS JSON file — no native deps)
- Default TTL: 24 hours (configurable via `CACHE_TTL` env var)
- Cache keys follow the pattern: `{PROJECT_KEY}:{data_type}`
  - `JCP:fields` — all field metadata and dropdown options
  - `JCP:sync_meta` — sync timestamp
- Always check cache before making API calls for metadata (versions, components, etc.)
- Transitions are NOT cached — always fetch live (they depend on current ticket state)
- User search results are NOT cached (users change too frequently)

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
   - `chalk.cyan` — issue keys (JCP-1234)
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
- [ ] `jira sync` — completes without errors
- [ ] `jira list` — shows your tickets
- [ ] `jira list --filter "bugs"` — AI filter works (or falls back gracefully)
- [ ] `jira view JCP-XXXX` — shows full ticket details
- [ ] `jira create --dry-run` — payload preview correct
- [ ] `jira update JCP-XXXX` — transitions list correctly
- [ ] `jira comment JCP-XXXX -m "test"` — comment appears in Jira
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

---

## Security Reminders

- `~/.jira-cli/config.json` must always be written with `mode: 0o600`
- Never log API tokens, even at debug level
- Never include credentials in error messages
- The `.gitignore` must always exclude `.env` and `*.json` credential files

# Jira CLI — Setup Guide

A production-ready terminal tool for managing Jira tickets. Works with any Jira Cloud workspace.

---

## Prerequisites

- Node.js >= 16 ([download](https://nodejs.org))
- npm >= 8
- A Jira Cloud account with API token access
- Git (for branch integration features)

---

## Installation

There are three ways to install depending on your situation.

---

### Option A — Install from npm (recommended)

Published to the public npm registry. One command, works anywhere Node is installed.

```bash
npm install -g @g-abhishek/jira-cli
```

To update to the latest version:

```bash
npm install -g @g-abhishek/jira-cli@latest
```

---

### Option B — Install directly from GitHub (no registry needed)

No npm registry authentication required. Installs straight from the source repo.

```bash
npm install -g github:g-abhishek/jira-cli
```

To update: just re-run the same command.

---

### Option C — Local development (clone + link)

For contributors or if you want to modify the tool.

```bash
git clone https://github.com/g-abhishek/jira-cli.git
cd jira-cli
npm install
npm link
```

`npm link` registers the `jira` command globally pointing at your local copy.
Any changes you make take effect immediately — no reinstall needed.

---

### Step 2 — Run the setup wizard

Same for all three install options:

```bash
jira config
```

This launches an interactive wizard that:
- Asks for your Jira base URL, email, and API token
- Asks for your AI provider key (Anthropic Claude or OpenAI — optional)
- Sets your default project key
- Tests the connection to Jira immediately
- Saves credentials to `~/.jira-cli/config.json` with owner-only permissions (chmod 600)

---

## Getting Your Jira API Token

1. Go to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Name it (e.g. `jira-cli`) and copy the token
4. Paste it when prompted by `jira config`

---

## Getting an AI Provider (Optional)

AI powers:
- AI-enhanced ticket descriptions
- Plain-English → JQL conversion (`--filter "bugs this week"`)
- Ticket generation from git commits (`--from-git`)
- Issue TL;DR summaries (`--summarize`)
- CLI help assistant (`jira ask "..."`)

The CLI works without any AI provider — AI features are gracefully skipped.

Providers are checked in this priority order: Claude Code CLI → Anthropic API → OpenAI → none.

### Option 0 — Claude Code CLI (recommended — no API key needed)

If your organisation blocks external AI API endpoints (e.g. `api.anthropic.com`, `api.openai.com`), this is the best option. Claude Code runs locally using your existing Claude authentication — no separate API key required.

```bash
npm install -g @anthropic-ai/claude-code
jira config set AI_PROVIDER claude-code
jira doctor   # confirm it's detected
```

The CLI will auto-detect Claude Code without needing `AI_PROVIDER` set, but setting it explicitly ensures it's always preferred.

### Option 1 — Anthropic Claude API

1. Go to [https://console.anthropic.com/](https://console.anthropic.com/)
2. Create an API key
3. Paste it when prompted by `jira config` (or run `jira config set ANTHROPIC_API_KEY sk-ant-...`)

### Option 2 — OpenAI (Codex)

1. Go to [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Create a new key
3. Paste it when prompted by `jira config` (or run `jira config set OPENAI_API_KEY sk-...`)

---

## First Run

After `jira config` succeeds, sync your project metadata:

```bash
jira sync
```

This fetches and caches:
- Fix versions, components, issue types
- Custom dropdown fields (dynamically discovered — Cluster, Channel, Work Type, or whatever your project has)
- Active sprint information
- Available transitions

Sync runs once and caches for 24 hours. Re-run any time with `--force`.

---

## Configuration File

Credentials are stored at `~/.jira-cli/config.json` (not in your project directory).

```json
{
  "JIRA_BASE_URL": "https://your-domain.atlassian.net",
  "JIRA_EMAIL": "you@company.com",
  "JIRA_API_TOKEN": "your-token",
  "DEFAULT_PROJECT": "JCP",
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "OPENAI_API_KEY": "sk-...",
  "AI_PROVIDER": "claude-code"
}
```

`AI_PROVIDER` values: `claude-code` (local Claude Code CLI, no API key), `claude` (Anthropic API), `openai`, or omit for auto-detect.

You can also edit values directly:

```bash
jira config set DEFAULT_PROJECT JCP
jira config set JIRA_BASE_URL https://newdomain.atlassian.net
jira config show
```

---

## Project Auto-Detection

The CLI automatically detects which Jira project you are working on using this priority chain:

| Priority | Source | Example |
|---|---|---|
| 1 | Git branch name | `feature/JCP-1234-fix` → project `JCP` |
| 2 | `.jira` file in repo root | `PROJECT=JCP` |
| 3 | `~/.jira-cli/config.json` | `DEFAULT_PROJECT: "JCP"` |
| 4 | `DEFAULT_PROJECT` env var | `export DEFAULT_PROJECT=JCP` |
| 5 | Prompt (saves if confirmed) | Interactive fallback |

**To set up per-repo project detection**, add a `.jira` file to your repo root:

```bash
echo "PROJECT=JCP" > .jira
echo ".jira" >> .gitignore   # optional: keep it local
# Or commit it so the whole team shares the config
```

---

## Command Reference

### `jira list`
List your assigned tickets in the current project.

```bash
jira list
jira list --status "In Progress"
jira list --type Bug
jira list --filter "high priority bugs this sprint"   # AI-powered
jira list --limit 50 --page 1                 # Paginate (0-indexed pages; higher pages may be slower)
jira list --json | jq '.[].key'                       # Pipe to jq
```

### `jira search`
Search all tickets in the project (not just yours).

```bash
jira search --status "SIT" --type Bug
jira search --assignee "John"
jira search --filter "unassigned tasks due this week"
jira search --interactive                              # Arrow-key filter builder
jira search --limit 50 --page 1                        # Paginate (0-indexed pages; higher pages may be slower)
```

### `jira create`
Create a ticket interactively with AI enhancement.

```bash
jira create
jira create --type Bug
jira create --from-git           # Generate from recent git commits
jira create --dry-run            # Preview without creating
```

### `jira update <KEY>`
Transition a ticket. Shows only valid next states (workflow-aware).

```bash
jira update JCP-1234
jira update JCP-1234 --status "In Progress"
jira update JCP-1234 --fields   # Also update priority, story points, etc.
```

### `jira delete <KEY>`
Delete a ticket. Requires typing the key to confirm.

```bash
jira delete JCP-1234
jira delete JCP-1234 --force    # Skip confirmation
```

### `jira view <KEY>`
View full ticket details including JCP-specific fields.

```bash
jira view JCP-1234
jira view JCP-1234 --summarize  # Add AI TL;DR
jira view JCP-1234 --open       # Open in browser after viewing
jira view JCP-1234 --json       # Raw JSON output
```

### `jira comment <KEY>`
Add or view comments.

```bash
jira comment JCP-1234                       # Opens editor
jira comment JCP-1234 -m "Deployed to SIT"  # Inline message
jira comment JCP-1234 --list                # List comments
```

### `jira start <KEY>`
Start working: transition to In Progress AND create a git branch.

```bash
jira start JCP-1234
jira start JCP-1234 --no-branch      # Only transition, no git
jira start JCP-1234 --no-transition  # Only branch, no transition
```

Creates branch: `feature/JCP-1234-short-summary`

### `jira dashboard`
Terminal sprint board — Kanban view of your tickets.

```bash
jira dashboard
jira dashboard --all             # Show all team members
jira dashboard --refresh 30     # Auto-refresh every 30 seconds
```

Controls: `Enter` to refresh, `q` to quit.

### `jira sync`
Sync project metadata to local cache.

```bash
jira sync
jira sync --project JCP
jira sync --force    # Re-sync even if cache is fresh
```

### `jira config`
Setup wizard and credential management.

```bash
jira config               # Run setup wizard
jira config show          # View current config (tokens masked)
jira config set KEY VAL   # Update a single value
jira config reset         # Delete all saved credentials
```

### `jira doctor`
Run a full health check on your setup.

```bash
jira doctor
```

Checks: Node version, credentials, Jira connectivity, project access, AI provider keys, git integration, cache freshness.

### `jira ask`
AI-powered help assistant scoped to this CLI. Ask anything about commands, configuration, troubleshooting, or JQL.

```bash
jira ask "how do I set up AI?"
jira ask "what does jira sync do?"
jira ask "how to filter tickets by assignee"
jira ask "is my Anthropic key configured?"    # reads your live config and answers directly
jira ask "why is my sync stale?"
```

Requires an AI provider. If none is configured, the command will tell you how to set one up.

### `jira logs`
View CLI activity logs.

```bash
jira logs
jira logs --lines 100
jira logs --level error
jira logs --clear
```

---

## Security Notes

- API tokens are stored in `~/.jira-cli/config.json` with `chmod 600` (owner-read only)
- Never commit `.env` files or tokens to git
- The `.gitignore` in this project excludes `.env` and `config.json`
- Tokens are never logged (the logger masks sensitive fields)

---

## Publishing a New Version

When you make changes and want to push an update to GitHub Packages:

```bash
# 1. Bump the version in package.json
npm version patch   # 1.0.0 → 1.0.1  (bug fixes)
npm version minor   # 1.0.0 → 1.1.0  (new features)
npm version major   # 1.0.0 → 2.0.0  (breaking changes)

# 2. Publish to GitHub Packages
npm publish
```

The `prepublishOnly` script runs a basic sanity check before every publish to make sure the package is not broken.

Anyone who installed via Option A can then run:

```bash
npm install -g @g-abhishek/jira-cli@latest
```

to get the new version.

---

## Troubleshooting

**`jira: command not found`**
- Run `npm link` from the `jira-cli` directory
- Or add the bin path manually: `export PATH="$PATH:$(npm root -g)/.bin"`

**`Authentication failed`**
- Run `jira doctor` to diagnose
- Regenerate your API token at `https://id.atlassian.com/manage-profile/security/api-tokens`
- Run `jira config` to update it

**`Cannot connect to Jira`**
- Check `JIRA_BASE_URL` format: must be `https://yourcompany.atlassian.net`
- Check VPN/network access to Atlassian

**`Dropdown options show wrong/no values`**
- Run `jira sync --force` to refresh the metadata cache

**`AI features not working`**
- Run `jira doctor` to check your AI provider configuration
- Run `jira config show` to see which providers are detected as active
- The CLI works without any AI provider — features fall back gracefully

**`AI filter shows [smart-fallback] instead of [AI]`**
- Your AI provider may be configured but blocked by a corporate VPN or firewall
- Run `jira logs` to see the exact error (look for `JQL conversion failed`)
- If the error says `Connection error` or `ECONNREFUSED`, your network is blocking `api.openai.com` or `api.anthropic.com`
- Switch to Claude Code CLI which runs locally and needs no outbound API call:
  ```bash
  npm install -g @anthropic-ai/claude-code
  jira config set AI_PROVIDER claude-code
  ```

---

## File Locations

| File | Purpose |
|---|---|
| `~/.jira-cli/config.json` | Your credentials and settings |
| `~/.jira-cli/cache.json` | Local cache (versions, components, field options) |
| `~/.jira-cli/logs/jira-cli.log` | Activity log (view with `jira logs`) |
| `./.jira` | Per-repo project key (optional) |

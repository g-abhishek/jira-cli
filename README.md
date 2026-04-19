# @g-abhishek/jira-cli

A terminal tool for managing Jira tickets without leaving your editor. List, create, update, search, and transition issues from the command line — with optional AI assistance.

Works with **any Jira Cloud workspace**.

---

## Install

```bash
npm install -g @g-abhishek/jira-cli
```

---

## First-time Setup

Run the setup wizard once:

```bash
jira config
```

You'll be asked for:

| Setting | Where to get it |
|---|---|
| Jira URL | e.g. `https://yourcompany.atlassian.net` |
| Email | Your Atlassian account email |
| API Token | [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Default project | e.g. `MYPROJ` |
| AI key (optional) | Anthropic or OpenAI key — CLI works without it |

Then sync your project metadata (required before first use):

```bash
jira sync
```

This fetches your project's issue types, fix versions, components, and all custom dropdown fields. Cached for 24 hours.

Verify everything is working:

```bash
jira doctor
```

---

## Commands

### `jira list`
List tickets assigned to you.

```bash
jira list                          # Your open tickets
jira list --filter "bugs this week"  # AI-powered plain English filter
jira list --status "In Progress"   # Filter by status
jira list --limit 20               # Show more results
jira list --page 2                 # Paginate (0-indexed pages; higher pages may be slower)
```

---

### `jira view <KEY>`
See full details of a ticket.

```bash
jira view PROJ-1234
jira view PROJ-1234 --summarize    # Add AI-generated TL;DR
jira view PROJ-1234 --comments     # Include comments
```

---

### `jira create`
Create a ticket interactively with prompts.

```bash
jira create                        # Step-by-step prompts
jira create --type Bug             # Skip the issue type prompt
jira create --from-git             # AI generates ticket from recent git commits
jira create --dry-run              # Preview the payload without creating
```

The prompts cover: issue type, summary, description, priority, story points, due date, fix versions, components, and any custom dropdown fields synced from your project.

---

### `jira update <KEY>`
Transition a ticket to a new status.

```bash
jira update PROJ-1234              # Pick the next status from a list
jira update PROJ-1234 --status "In Review"  # Skip the prompt
jira update PROJ-1234 --fields     # Also update priority, custom fields, add a comment
```

Only valid next states are shown (workflow-aware — no invalid jumps).

---

### `jira start <KEY>`
Transition a ticket to In Progress and create a matching git branch.

```bash
jira start PROJ-1234
```

Automatically creates a branch like `feature/PROJ-1234-ticket-summary` and checks it out.

---

### `jira comment <KEY>`
Add or read comments.

```bash
jira comment PROJ-1234 -m "Fixed in latest build"   # Add inline
jira comment PROJ-1234                               # Open editor
jira comment PROJ-1234 --list                        # Read existing comments
```

---

### `jira search`
Search all tickets in the project (not just yours).

```bash
jira search --filter "open bugs assigned to me"    # AI → JQL
jira search --interactive                          # Arrow-key filter builder
jira search --jql "project = PROJ AND priority = High"  # Raw JQL
jira search --limit 50 --page 1                    # Paginate (0-indexed pages; higher pages may be slower)
```

---

### `jira delete <KEY>`
Delete a ticket (asks for confirmation).

```bash
jira delete PROJ-1234
jira delete PROJ-1234 --force      # Skip confirmation
```

---

### `jira dashboard`
Terminal sprint board — tickets grouped by status, auto-refreshes.

```bash
jira dashboard
jira dashboard --all               # Show entire team's tickets (not just yours)
jira dashboard --refresh 30        # Refresh every 30 seconds
```

---

### `jira sync`
Fetch and cache project metadata. Run this once before first use, and any time your project's fields change.

```bash
jira sync
jira sync --project OTHERPROJ     # Sync a different project
jira sync --force                 # Force refresh even if cache is fresh
```

What it fetches:
- Issue types
- Fix versions
- Components
- Priorities
- All custom dropdown fields (Cluster, Channel, Work Type, or whatever your project has)
- Active sprint info

---

### `jira config`
Manage credentials and settings.

```bash
jira config                        # Run setup wizard
jira config show                   # Show current config (tokens masked)
jira config set DEFAULT_PROJECT MYPROJ   # Update a single value
jira config reset                  # Wipe everything and start fresh
```

---

### `jira doctor`
Health check — verifies credentials, connectivity, sync freshness, git setup, and AI provider status.

```bash
jira doctor
```

Run this any time something isn't working.

---

### `jira ask`
AI-powered help assistant scoped to this CLI. Ask anything about commands, config, troubleshooting, or JQL.

```bash
jira ask "how do I set up an AI provider?"
jira ask "what does jira sync do?"
jira ask "how to filter tickets by status"
jira ask "is my OpenAI key configured?"   # Reads your live config and answers directly
```

Requires an AI provider to be configured (see AI Features below).

---

### `jira logs`
View recent activity and errors.

```bash
jira logs
jira logs --tail 50                # Show last 50 lines
jira logs --level error            # Errors only
```

---

## AI Features (Optional)

If an AI provider is configured, these features unlock:

| Feature | Command |
|---|---|
| Plain English ticket filter | `jira list --filter "my bugs this sprint"` |
| Generate ticket from git commits | `jira create --from-git` |
| Enhance summary + description | Auto-runs during `jira create` |
| TL;DR summary | `jira view PROJ-1234 --summarize` |
| CLI help assistant | `jira ask "how do I..."` |

**The CLI works fully without any AI provider** — AI steps are silently skipped.

**Supported providers (checked in this order):**

| Priority | Provider | How to enable |
|---|---|---|
| 1 | Claude Code CLI (local) | Install Claude Code — no API key needed |
| 2 | Anthropic Claude API | Set `ANTHROPIC_API_KEY` |
| 3 | OpenAI (Codex) | Set `OPENAI_API_KEY` |

**Recommended — Claude Code (no API key required):**
```bash
npm install -g @anthropic-ai/claude-code   # install once
jira config set AI_PROVIDER claude-code    # tell jira to use it
```

To force a specific provider:
```bash
jira config set AI_PROVIDER claude-code   # use local Claude Code CLI
jira config set AI_PROVIDER openai        # force OpenAI
```

---

## Project Auto-detection

You don't need to pass `--project` every time. The CLI finds your project key in this order:

1. Git branch name (e.g. `feature/PROJ-123-...` → `PROJ`)
2. `.jira` file in the current directory
3. `DEFAULT_PROJECT` in your config
4. Prompts you if none of the above match

---

## Custom Fields

`jira sync` automatically discovers all dropdown fields in your project (e.g. Cluster, Channel, Work Type, Environment, Severity — whatever your project has). These appear as prompts during `jira create` and `jira update --fields` with no configuration needed.

---

## Config File

Credentials are stored at `~/.jira-cli/config.json` (not in your project directory, never committed to git).

```json
{
  "JIRA_BASE_URL": "https://yourcompany.atlassian.net",
  "JIRA_EMAIL": "you@company.com",
  "JIRA_API_TOKEN": "your-token",
  "DEFAULT_PROJECT": "MYPROJ",
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "OPENAI_API_KEY": "sk-...",
  "AI_PROVIDER": "claude-code"
}
```

`AI_PROVIDER` can be `claude-code` (local, no API key), `claude` (Anthropic API), `openai`, or omitted for auto-detect.

---

## Troubleshooting

**`No Jira credentials found`**
Run `jira config` to set up your credentials.

**`No sync data found for project XYZ`**
Run `jira sync --project XYZ` first, then retry.

**`AI features not working`**
Run `jira doctor` to check which AI provider is detected. Run `jira config show` to verify your key is set.

**`Transitions not showing`**
Transitions are fetched live from Jira per ticket. Check your API token has the right permissions.

**Network errors**
Run `jira doctor` — it tests connectivity to your Jira instance directly.

---

## Links

- [npm package](https://www.npmjs.com/package/@g-abhishek/jira-cli)
- [GitHub](https://github.com/g-abhishek/jira-cli)
- [Jira API Token](https://id.atlassian.com/manage-profile/security/api-tokens)
- [Anthropic API Key](https://console.anthropic.com/)
- [OpenAI API Key](https://platform.openai.com/api-keys)

---

## License

MIT

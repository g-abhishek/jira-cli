'use strict';

/**
 * ask.js
 * `jira ask "<question>"` — AI-powered help assistant for the Jira CLI.
 *
 * Answers any question about using this CLI: commands, config, AI setup,
 * troubleshooting, JQL, workflows — with concrete examples and commands to run.
 *
 * Uses the same AI provider as other commands (Claude Code local, Anthropic, OpenAI).
 * If no AI is available, points the user to relevant docs.
 *
 * Usage:
 *   jira ask "how do I set up AI?"
 *   jira ask "how to filter tickets by status"
 *   jira ask "what does jira sync do?"
 *   jira ask "how to create a bug ticket"
 */

const chalk = require('chalk');
const ora = require('ora');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getProvider, detectProviders } = require('../utils/aiProviders');
const { printError } = require('../utils/errorParser');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

// README.md and SETUP.md are the single source of truth for CLI knowledge.
// Always keep them up to date when adding new commands or features.
// This function throws if neither file can be read — that's intentional,
// because stale hardcoded knowledge is worse than no knowledge.
function loadCliKnowledge() {
  const root = path.join(__dirname, '..');
  const sources = ['README.md', 'SETUP.md'];
  const parts = [];

  for (const file of sources) {
    const filePath = path.join(root, file);
    try {
      if (fs.existsSync(filePath)) {
        parts.push(`\n\n=== ${file} ===\n\n` + fs.readFileSync(filePath, 'utf8'));
      }
    } catch {
      // skip unreadable file, try the next one
    }
  }

  if (parts.length === 0) {
    throw new Error('Could not read README.md or SETUP.md from the package. Try reinstalling: npm install -g @g-abhishek/jira-cli@latest');
  }

  return parts.join('\n');
}

// ── Live context — reads actual config + state from disk ──────────────────────
// This lets the AI answer factual questions about the user's setup directly
// (e.g. "is OpenAI key set?", "what project am I on?", "is sync fresh?")
// without redirecting them to run another command first.

function maskToken(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '****' + val.slice(-4);
}

function loadLiveContext() {
  const configPath = path.join(os.homedir(), '.jira-cli', 'config.json');
  let config = {};
  try {
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}

  const providers = detectProviders();

  // Sync freshness for default project
  const projectKey = config.DEFAULT_PROJECT || process.env.DEFAULT_PROJECT || null;
  let syncStatus = 'unknown (no default project set)';
  if (projectKey) {
    const meta = cache.getMeta(projectKey);
    if (!meta) syncStatus = `never synced — run: jira sync --project ${projectKey}`;
    else if (meta.isStale) syncStatus = `stale (last synced: ${meta.lastSynced}) — run: jira sync`;
    else syncStatus = `fresh (last synced: ${meta.lastSynced})`;
  }

  return `
══ USER'S CURRENT CONFIG (live, read from ~/.jira-cli/config.json) ══
  JIRA_BASE_URL    : ${config.JIRA_BASE_URL || '(not set)'}
  JIRA_EMAIL       : ${config.JIRA_EMAIL || '(not set)'}
  JIRA_API_TOKEN   : ${maskToken(config.JIRA_API_TOKEN)}
  DEFAULT_PROJECT  : ${config.DEFAULT_PROJECT || '(not set)'}
  ANTHROPIC_API_KEY: ${config.ANTHROPIC_API_KEY ? maskToken(config.ANTHROPIC_API_KEY) : '(not set)'}
  OPENAI_API_KEY   : ${config.OPENAI_API_KEY ? maskToken(config.OPENAI_API_KEY) : '(not set)'}
  AI_PROVIDER      : ${config.AI_PROVIDER || '(auto-detect)'}

══ ACTIVE AI PROVIDERS (detected right now) ══
${providers.length > 0
  ? providers.map((p, i) => `  ${i + 1}. ${p.name} [${p.local ? 'local' : 'cloud'}]  model: ${p.model}${i === 0 ? '  ← active' : ''}`).join('\n')
  : '  None detected — AI features disabled'}

══ SYNC STATUS ══
  Project ${projectKey || 'N/A'}: ${syncStatus}
`;
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  command: 'ask <question>',
  desc: 'Ask the AI assistant anything about this CLI',
  builder: (yargs) =>
    yargs
      .positional('question', {
        type: 'string',
        desc: 'Your question, e.g. "how do I set up AI?"',
      }),

  handler: async (argv) => {
    const question = argv.question?.trim();
    if (!question) {
      console.log(chalk.yellow('\n  Usage: jira ask "your question here"\n'));
      console.log(chalk.dim('  Examples:'));
      console.log(chalk.dim('    jira ask "how to set up AI provider"'));
      console.log(chalk.dim('    jira ask "how to filter tickets by status"'));
      console.log(chalk.dim('    jira ask "what does jira sync do?"'));
      console.log();
      return;
    }

    const spinner = ora('Thinking...').start();

    try {
      const provider = await getProvider();

      if (!provider) {
        spinner.stop();
        console.log(chalk.yellow('\n  No AI provider configured.\n'));
        console.log('  ' + chalk.bold('jira ask') + ' requires an AI provider to answer questions.\n');
        console.log('  Recommended — Claude Code (local, no API key needed):');
        console.log(chalk.cyan('    $ jira config set AI_PROVIDER claude-code'));
        console.log(chalk.dim('    Requires: npm install -g @anthropic-ai/claude-code\n'));
        console.log('  Or set an API key:');
        console.log(chalk.cyan('    $ jira config set ANTHROPIC_API_KEY sk-ant-YOUR-KEY'));
        console.log(chalk.cyan('    $ jira config set OPENAI_API_KEY sk-YOUR-KEY'));
        console.log(chalk.dim('\n  Then retry: jira ask "' + question + '"\n'));
        return;
      }

      const cliKnowledge = loadCliKnowledge();
      const liveContext  = loadLiveContext();

      const systemPrompt = `You are a helpful assistant for a Node.js CLI tool called "jira" (@g-abhishek/jira-cli).
Answer the user's question clearly, concisely, and practically.
Always show the actual commands to run. Prefix runnable commands with $ like: $ jira config show
Be friendly and direct. No fluff.

IMPORTANT: You have access to the user's LIVE config and state below. Use it to give specific,
accurate answers. If the user asks whether a key is set, check the live context and answer
directly — do NOT tell them to run a command to find out themselves.

${liveContext}

Here is the full CLI documentation for reference:
${cliKnowledge}

Format your response for a terminal — use plain text, not markdown headers.
Use indentation for structure. Keep it concise but complete.
If showing commands, put them on their own line prefixed with $ like:
  $ jira config set AI_PROVIDER claude-code
Always end with a practical next step the user can take immediately.`;

      const userPrompt = `Question: ${question}`;

      const answer = await provider.chat(systemPrompt, userPrompt, {
        temperature: 0.3,
        maxTokens: 600,
      });

      spinner.stop();

      console.log(chalk.bold(`\n  💬 ${question}\n`));
      console.log(chalk.dim('  ─'.repeat(40)));
      console.log();

      // Indent and format the answer for terminal display
      const formatted = answer
        .split('\n')
        .map((line) => {
          // Highlight inline $ commands
          if (/^\s*\$\s+/.test(line)) {
            return '  ' + chalk.cyan(line.trim());
          }
          return '  ' + line;
        })
        .join('\n');

      console.log(formatted);
      console.log();

      logger.info(`ask: answered "${question}" using ${provider.name}`);

    } catch (err) {
      spinner.stop();
      printError(err);
      logger.error(`ask failed: ${err.message}`);
      process.exit(1);
    }
  },
};

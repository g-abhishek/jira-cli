'use strict';

/**
 * config.js
 * `jira config` — Interactive setup wizard.
 *
 * Writes to ~/.jira-cli/config.json (not .env in project directory).
 * Safer than .env files which can be accidentally committed.
 *
 * Subcommands:
 *   jira config          — Run setup wizard
 *   jira config show     — Show current config (masked tokens)
 *   jira config set KEY VALUE — Set a single value
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { testConnection } = require('../services/jiraService');
const { detectProviders } = require('../utils/aiProviders');
const { printError } = require('../utils/errorParser');
const logger = require('../utils/logger');

const CONFIG_DIR = path.join(os.homedir(), '.jira-cli');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function writeConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 }); // Owner-read-only
}

function maskToken(token) {
  if (!token) return chalk.dim('(not set)');
  return token.slice(0, 4) + '****' + token.slice(-4);
}

module.exports = {
  command: 'config [action] [key] [value]',
  desc: 'Configure Jira CLI credentials and settings',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['show', 'set', 'reset'],
        desc: 'Action: show | set | reset',
      })
      .positional('key', { type: 'string', desc: 'Config key (for `set` action)' })
      .positional('value', { type: 'string', desc: 'Config value (for `set` action)' }),

  handler: async (argv) => {
    try {
      // ── jira config show ─────────────────────────────────────────────────
      if (argv.action === 'show') {
        const config = readConfig();
        console.log(chalk.bold('\n  Current Configuration\n'));
        console.log(`  ${chalk.dim('Config file')}     ${CONFIG_PATH}`);
        console.log(`  ${chalk.dim('JIRA_BASE_URL')}   ${config.JIRA_BASE_URL || chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('JIRA_EMAIL')}      ${config.JIRA_EMAIL || chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('JIRA_API_TOKEN')}  ${maskToken(config.JIRA_API_TOKEN)}`);
        console.log(`  ${chalk.dim('DEFAULT_PROJECT')} ${config.DEFAULT_PROJECT || chalk.dim('(not set)')}`);

        // AI provider section
        console.log(chalk.bold('\n  AI Configuration\n'));
        const spinner = ora('  Detecting AI providers...').start();
        const providers = await detectProviders();
        spinner.stop();

        if (providers.length === 0) {
          console.log(`  ${chalk.dim('AI Provider')}     ${chalk.dim('None detected')}`);
          console.log(chalk.dim('  Install Ollama locally or set OPENAI_API_KEY / ANTHROPIC_API_KEY\n'));
        } else {
          const preferred = config.AI_PROVIDER;
          providers.forEach((p, i) => {
            const active = (!preferred && i === 0) || preferred === p.type;
            const tag = active ? chalk.green(' ← active') : '';
            const local = p.local ? chalk.cyan(' [local]') : chalk.dim(' [cloud]');
            console.log(`  ${chalk.dim((i + 1) + '.')} ${p.name}${local}  model: ${chalk.white(p.model)}${tag}`);
          });
          console.log();
        }
        return;
      }

      // ── jira config set KEY VALUE ─────────────────────────────────────────
      if (argv.action === 'set') {
        if (!argv.key || !argv.value) {
          console.log(chalk.red('  Usage: jira config set <KEY> <VALUE>'));
          console.log(chalk.dim('  Keys: JIRA_BASE_URL | JIRA_EMAIL | JIRA_API_TOKEN | OPENAI_API_KEY | DEFAULT_PROJECT'));
          process.exit(1);
        }
        const config = readConfig();
        config[argv.key] = argv.value;
        writeConfig(config);
        console.log(chalk.green(`\n  ✔ ${argv.key} updated\n`));
        return;
      }

      // ── jira config reset ─────────────────────────────────────────────────
      if (argv.action === 'reset') {
        const { confirmed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmed',
            message: 'Reset all config? This will delete your stored credentials.',
            default: false,
          },
        ]);
        if (confirmed) {
          if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
          console.log(chalk.green('\n  ✔ Config reset. Run `jira config` to set up again.\n'));
        }
        return;
      }

      // ── jira config (wizard) ───────────────────────────────────────────────
      const existing = readConfig();

      console.log(chalk.bold('\n🔧 Jira CLI Setup Wizard\n'));
      console.log(chalk.dim('  Credentials are stored in: ' + CONFIG_PATH));
      console.log(chalk.dim('  File is readable only by you (chmod 600)\n'));

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'JIRA_BASE_URL',
          message: 'Jira base URL:',
          default: existing.JIRA_BASE_URL || '',
          validate: (v) => {
            try { new URL(v); return true; } catch { return 'Must be a valid URL (e.g. https://yourcompany.atlassian.net)'; }
          },
          filter: (v) => v.trim().replace(/\/$/, ''),
        },
        {
          type: 'input',
          name: 'JIRA_EMAIL',
          message: 'Your Atlassian email:',
          default: existing.JIRA_EMAIL || '',
          validate: (v) => v.includes('@') || 'Must be a valid email',
          filter: (v) => v.trim().toLowerCase(),
        },
        {
          type: 'password',
          name: 'JIRA_API_TOKEN',
          message: 'Jira API Token (hidden):',
          mask: '•',
          default: existing.JIRA_API_TOKEN || '',
          validate: (v) => v.trim().length > 5 || 'API token appears too short',
          when: () => true,
        },
        {
          type: 'input',
          name: 'DEFAULT_PROJECT',
          message: 'Default project key:',
          default: existing.DEFAULT_PROJECT || 'JCP',
          filter: (v) => v.trim().toUpperCase(),
        },
      ]);

      // ── AI Provider Setup ──────────────────────────────────────────────────
      console.log(chalk.bold('\n  AI Setup (powers ticket enhancement, JQL filter, TL;DR)\n'));

      // Show what's already detected
      const detectedProviders = detectProviders();
      if (detectedProviders.length > 0) {
        console.log(chalk.green(`  Already configured: ${detectedProviders.map((p) => p.name).join(', ')}\n`));
      }

      const aiAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'AI_PROVIDER',
          message: 'AI provider:',
          choices: [
            { name: 'Auto-detect (Claude if available, else OpenAI)', value: 'auto' },
            { name: 'Anthropic Claude', value: 'claude' },
            { name: 'OpenAI (Codex)', value: 'openai' },
            { name: 'None (disable AI features)', value: 'none' },
          ],
          default: existing.AI_PROVIDER || 'auto',
        },
        {
          type: 'password',
          name: 'ANTHROPIC_API_KEY',
          message: 'Anthropic API Key:',
          mask: '•',
          when: (a) => a.AI_PROVIDER === 'claude' || a.AI_PROVIDER === 'auto',
          filter: (v) => v.trim() || existing.ANTHROPIC_API_KEY || '',
        },
        {
          type: 'password',
          name: 'OPENAI_API_KEY',
          message: 'OpenAI API Key:',
          mask: '•',
          when: (a) => a.AI_PROVIDER === 'openai' || a.AI_PROVIDER === 'auto',
          filter: (v) => v.trim() || existing.OPENAI_API_KEY || '',
        },
      ]);

      const aiConfig = {};
      if (aiAnswers.AI_PROVIDER !== 'none' && aiAnswers.AI_PROVIDER !== 'auto') {
        aiConfig.AI_PROVIDER = aiAnswers.AI_PROVIDER;
      }
      if (aiAnswers.ANTHROPIC_API_KEY) aiConfig.ANTHROPIC_API_KEY = aiAnswers.ANTHROPIC_API_KEY;
      if (aiAnswers.OPENAI_API_KEY) aiConfig.OPENAI_API_KEY = aiAnswers.OPENAI_API_KEY;

      // Merge with existing config
      const newConfig = { ...existing, ...answers, ...aiConfig };
      if (!newConfig.OPENAI_API_KEY) delete newConfig.OPENAI_API_KEY;
      if (!newConfig.ANTHROPIC_API_KEY) delete newConfig.ANTHROPIC_API_KEY;
      if (!newConfig.AI_PROVIDER) delete newConfig.AI_PROVIDER;

      // Write config
      writeConfig(newConfig);

      // Test connection
      console.log('');
      const testSpinner = ora('Testing connection to Jira...').start();

      // Load env from new config before testing
      process.env.JIRA_BASE_URL = newConfig.JIRA_BASE_URL;
      process.env.JIRA_EMAIL = newConfig.JIRA_EMAIL;
      process.env.JIRA_API_TOKEN = newConfig.JIRA_API_TOKEN;

      const result = await testConnection();
      testSpinner.stop();

      if (result.ok) {
        console.log(chalk.green(`\n  ✔ Connected! Logged in as: ${chalk.bold(result.user)} (${result.email})`));
        console.log(chalk.dim(`\n  Run ${chalk.white('jira sync')} to sync project metadata.`));
        console.log(chalk.dim(`  Run ${chalk.white('jira list')} to see your tickets.\n`));
      } else {
        console.log(chalk.red(`\n  ✖ Connection failed: ${result.error}`));
        console.log(chalk.dim('  Config saved — run `jira config` again to fix credentials.\n'));
      }

      logger.info(`config: setup wizard completed (${result.ok ? 'connected' : 'failed'})`);
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  },
};

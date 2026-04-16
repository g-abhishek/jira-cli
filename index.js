#!/usr/bin/env node
'use strict';

/**
 * index.js — Jira CLI Entry Point
 *
 * A production-ready Jira CLI tool for developers.
 * Works with any Jira Cloud workspace.
 *
 * Usage:
 *   jira list                        List your tickets
 *   jira list --filter "bugs today"  AI-powered filter
 *   jira create                      Create a ticket interactively
 *   jira create --from-git           Generate from git history
 *   jira update PROJ-1234            Transition a ticket
 *   jira delete PROJ-1234            Delete a ticket
 *   jira view PROJ-1234              View ticket details
 *   jira comment PROJ-1234           Add a comment
 *   jira start PROJ-1234             Transition + git branch
 *   jira search --filter "..."       Search all org tickets
 *   jira dashboard                   Terminal sprint board
 *   jira sync                        Sync project metadata
 *   jira config                      Setup credentials
 *   jira doctor                      Health check
 *   jira logs                        View activity logs
 */

// ── Load .env if present (project root or ~/.jira-cli/.env) ──────────────────
const path = require('path');
const fs = require('fs');
const os = require('os');

// Load from multiple locations in priority order
const envLocations = [
  path.join(os.homedir(), '.jira-cli', '.env'),
  path.join(process.cwd(), '.env'),
];

for (const envPath of envLocations) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    break;
  }
}

// Also load from config.json into process.env for backwards compatibility
const configPath = path.join(os.homedir(), '.jira-cli', 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // Only set env vars if not already set (env takes priority)
    Object.entries(config).forEach(([key, val]) => {
      if (!process.env[key] && val) process.env[key] = val;
    });
  } catch {}
}

// ── Yargs CLI Definition ──────────────────────────────────────────────────────
const yargs = require('yargs');
const chalk = require('chalk');

yargs
  .scriptName('jira')
  .usage('$0 <command> [options]')

  // ── Commands ────────────────────────────────────────────────────────────────
  .command(require('./commands/list'))
  .command(require('./commands/search'))
  .command(require('./commands/create'))
  .command(require('./commands/update'))
  .command(require('./commands/delete'))
  .command(require('./commands/view'))
  .command(require('./commands/comment'))
  .command(require('./commands/start'))
  .command(require('./commands/dashboard'))
  .command(require('./commands/sync'))
  .command(require('./commands/config'))
  .command(require('./commands/doctor'))
  .command(require('./commands/logs'))

  // ── Global Options ───────────────────────────────────────────────────────────
  .option('verbose', {
    alias: 'v',
    type: 'boolean',
    global: true,
    desc: 'Enable verbose/debug output',
  })

  // ── Examples ─────────────────────────────────────────────────────────────────
  .example('$0 list', 'List your assigned tickets')
  .example('$0 list --filter "bugs this week"', 'AI-powered filter')
  .example('$0 create', 'Create a ticket interactively')
  .example('$0 create --from-git', 'Generate ticket from git history')
  .example('$0 update PROJ-1234', 'Transition a ticket')
  .example('$0 view PROJ-1234 --summarize', 'View ticket with AI TL;DR')
  .example('$0 start PROJ-1234', 'Transition + create git branch')
  .example('$0 dashboard', 'Open sprint board')
  .example('$0 sync', 'Sync project metadata')
  .example('$0 doctor', 'Check setup health')

  // ── Middleware ────────────────────────────────────────────────────────────────
  .middleware((argv) => {
    if (argv.verbose) {
      process.env.LOG_LEVEL = 'debug';
    }

    // Warn if no config found and command is not config/doctor
    const skipConfigCheck = ['config', 'doctor', 'logs', 'help', '--help', '-h', '--version'];
    const cmd = argv._[0];
    if (cmd && !skipConfigCheck.includes(cmd)) {
      const hasConfig =
        fs.existsSync(configPath) ||
        (process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);

      if (!hasConfig) {
        console.log(chalk.yellow('\n⚠  No Jira credentials found.'));
        console.log(chalk.dim('  Run `jira config` to set up your credentials first.\n'));
        process.exit(1);
      }
    }
  })

  // ── Help formatting ───────────────────────────────────────────────────────────
  .wrap(Math.min(100, yargs.terminalWidth()))
  .epilog(chalk.dim('Tip: Run `jira doctor` to check your setup, `jira sync` before first use.'))

  // ── Error handling ─────────────────────────────────────────────────────────────
  .fail((msg, err, yargs) => {
    if (err) {
      console.error(chalk.red('\n✖ Unexpected error:'), err.message);
      if (process.env.LOG_LEVEL === 'debug') console.error(err.stack);
    } else if (msg) {
      console.error(chalk.red('\n✖ ' + msg));
      console.error(chalk.dim('  Run `jira --help` for usage.\n'));
    }
    process.exit(1);
  })

  .demandCommand(1, chalk.yellow('\n  Please specify a command. Run `jira --help` for available commands.\n'))
  .strict()
  .help('help')
  .alias('help', 'h')
  .version()
  .alias('version', 'V')
  .parse();

'use strict';

/**
 * logs.js
 * `jira logs` — Tail the CLI log file.
 *
 * Logs are written to ~/.jira-cli/logs/jira-cli.log
 * Each line is a JSON record with timestamp, level, and message.
 *
 * Flags:
 *   --lines   Number of lines to show (default: 50)
 *   --level   Filter by level: error | warn | info | debug
 *   --clear   Clear all log files
 */

const chalk = require('chalk');
const os = require('os');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const LOG_DIR = path.join(os.homedir(), '.jira-cli', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'jira-cli.log');

const LEVEL_COLORS = {
  error: chalk.red,
  warn: chalk.yellow,
  info: chalk.cyan,
  debug: chalk.dim,
};

module.exports = {
  command: 'logs',
  desc: 'View Jira CLI activity logs',
  builder: (yargs) =>
    yargs
      .option('lines', { alias: 'n', type: 'number', default: 50, desc: 'Number of lines to show' })
      .option('level', { alias: 'l', type: 'string', desc: 'Filter by level (error|warn|info|debug)' })
      .option('clear', { type: 'boolean', default: false, desc: 'Clear all log files' }),

  handler: async (argv) => {
    // ── Clear ──────────────────────────────────────────────────────────────
    if (argv.clear) {
      try {
        if (fs.existsSync(LOG_FILE)) {
          fs.writeFileSync(LOG_FILE, '');
          console.log(chalk.green('\n  ✔ Logs cleared.\n'));
        } else {
          console.log(chalk.dim('\n  No log file found.\n'));
        }
      } catch (e) {
        console.log(chalk.red(`  Failed to clear logs: ${e.message}`));
      }
      return;
    }

    // ── Read ───────────────────────────────────────────────────────────────
    if (!fs.existsSync(LOG_FILE)) {
      console.log(chalk.dim('\n  No logs yet. Run some commands first.\n'));
      return;
    }

    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);

    if (lines.length === 0) {
      console.log(chalk.dim('\n  Log file is empty.\n'));
      return;
    }

    // Filter by level if specified
    const filtered = argv.level
      ? lines.filter((line) => {
          try {
            const parsed = JSON.parse(line);
            return parsed.level === argv.level.toLowerCase();
          } catch {
            return true;
          }
        })
      : lines;

    const shown = filtered.slice(-argv.lines);

    console.log(chalk.bold(`\n  Jira CLI Logs`) + chalk.dim(` — last ${shown.length} of ${filtered.length} entries\n`));

    shown.forEach((line) => {
      try {
        const entry = JSON.parse(line);
        const ts = new Date(entry.timestamp).toLocaleTimeString();
        const level = entry.level || 'info';
        const colorFn = LEVEL_COLORS[level] || chalk.white;
        const tag = colorFn(`[${level.toUpperCase().padEnd(5)}]`);
        console.log(`  ${chalk.dim(ts)} ${tag} ${entry.message}`);
      } catch {
        // Not valid JSON — print raw
        console.log(chalk.dim(`  ${line}`));
      }
    });

    console.log(chalk.dim(`\n  Log file: ${LOG_FILE}\n`));
  },
};

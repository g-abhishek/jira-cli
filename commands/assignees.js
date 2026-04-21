'use strict';

/**
 * assignees.js
 * `jira assignees` — Manage local assignee memory.
 *
 * Subcommands:
 *   jira assignees list
 *   jira assignees remove "Name"
 *   jira assignees clear
 */

const chalk = require('chalk');
const { listEntries, removeEntryByName, clearEntries } = require('../utils/assigneeMemory');
const { printError } = require('../utils/errorParser');
const logger = require('../utils/logger');

module.exports = {
  command: 'assignees [action] [name]',
  desc: 'Manage local assignee memory',
  builder: (yargs) =>
    yargs
      .positional('action', {
        type: 'string',
        choices: ['list', 'remove', 'clear'],
        desc: 'Action: list | remove | clear',
      })
      .positional('name', { type: 'string', desc: 'Name to remove (for remove)' }),

  handler: async (argv) => {
    try {
      const action = argv.action || 'list';

      if (action === 'list') {
        const entries = listEntries();
        if (entries.length === 0) {
          console.log(chalk.dim('\n  No assignees in memory yet.\n'));
          return;
        }
        console.log(chalk.bold('\n  Assignee Memory\n'));
        entries.forEach((e, i) => {
          const email = e.email ? ` <${e.email}>` : '';
          const aliases = e.aliases && e.aliases.length > 0 ? `  aliases: ${e.aliases.join(', ')}` : '';
          console.log(`  ${chalk.dim(String(i + 1).padStart(2))}. ${chalk.white(e.displayName)}${email}${aliases ? chalk.dim(`\n      ${aliases}`) : ''}`);
        });
        console.log();
        return;
      }

      if (action === 'remove') {
        if (!argv.name) {
          console.log(chalk.red('  Usage: jira assignees remove "Name"'));
          process.exit(1);
        }
        const removed = removeEntryByName(argv.name);
        if (removed === 0) {
          console.log(chalk.yellow('\n  No matching assignee found.\n'));
        } else {
          console.log(chalk.green(`\n  ✔ Removed ${removed} entr${removed === 1 ? 'y' : 'ies'}.\n`));
        }
        return;
      }

      if (action === 'clear') {
        clearEntries();
        console.log(chalk.green('\n  ✔ Assignee memory cleared.\n'));
        return;
      }
    } catch (err) {
      printError(err);
      logger.error(`assignees failed: ${err.message}`);
      process.exit(1);
    }
  },
};

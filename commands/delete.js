'use strict';

/**
 * delete.js
 * `jira delete <KEY>` — Delete a Jira issue with confirmation.
 *
 * Requires typing the issue key to confirm (prevents accidental deletion).
 * Flags:
 *   --force    Skip confirmation (use with caution)
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { getIssue, deleteIssue } = require('../services/jiraService');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema } = require('../validators/schema');
const logger = require('../utils/logger');

module.exports = {
  command: 'delete <key>',
  desc: 'Delete a Jira issue (requires confirmation)',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', desc: 'Issue key (e.g. JCP-1234)' })
      .option('force', { alias: 'f', type: 'boolean', default: false, desc: 'Skip confirmation' }),

  handler: async (argv) => {
    try {
      const key = validate(IssueKeySchema, argv.key);

      // Fetch the issue first so we can show what's being deleted
      const spinner = ora(`Fetching ${key}...`).start();
      const issue = await getIssue(key);
      spinner.stop();

      const f = issue.fields;

      // Show what will be deleted
      console.log(chalk.bold.red('\n⚠  You are about to permanently delete:'));
      console.log(`  ${chalk.bold.cyan(key)} — ${f.summary?.slice(0, 70)}`);
      console.log(`  Status: ${f.status?.name}  |  Type: ${f.issuetype?.name}  |  Priority: ${f.priority?.name}`);
      console.log(chalk.red('\n  This action CANNOT be undone.\n'));

      if (!argv.force) {
        // Require user to type the issue key to confirm
        const { typedKey } = await inquirer.prompt([
          {
            type: 'input',
            name: 'typedKey',
            message: `Type "${key}" to confirm deletion:`,
            validate: (v) => v.trim().toUpperCase() === key.toUpperCase() || `Must type exactly "${key}" to confirm`,
          },
        ]);

        if (typedKey.trim().toUpperCase() !== key.toUpperCase()) {
          console.log(chalk.yellow('\nCancelled.\n'));
          return;
        }
      }

      const deleteSpinner = ora(`Deleting ${key}...`).start();
      await deleteIssue(key);
      deleteSpinner.stop();

      console.log(chalk.green(`\n✔ ${key} has been permanently deleted.\n`));
      logger.info(`delete: ${key} (${f.issuetype?.name}) "${f.summary?.slice(0, 50)}"`);
    } catch (err) {
      printError(err);
      logger.error(`delete failed: ${err.message}`);
      process.exit(1);
    }
  },
};

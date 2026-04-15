'use strict';

/**
 * comment.js
 * `jira comment <KEY>` — Add a comment to a Jira issue from the terminal.
 *
 * Flags:
 *   --message   Inline comment text (skip editor prompt)
 *   --list      List existing comments instead of adding
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { addComment, getComments, getIssue } = require('../services/jiraService');
const { extractPlainText } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema, CommentSchema } = require('../validators/schema');
const logger = require('../utils/logger');

module.exports = {
  command: 'comment <key>',
  desc: 'Add or view comments on a Jira issue',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', desc: 'Issue key (e.g. JCP-1234)' })
      .option('message', { alias: 'm', type: 'string', desc: 'Comment text (skip editor)' })
      .option('list', { alias: 'l', type: 'boolean', default: false, desc: 'List comments instead of adding' }),

  handler: async (argv) => {
    try {
      const key = validate(IssueKeySchema, argv.key);

      // ── List mode ──────────────────────────────────────────────────────────
      if (argv.list) {
        const spinner = ora(`Loading comments for ${key}...`).start();
        const [issue, comments] = await Promise.all([getIssue(key), getComments(key)]);
        spinner.stop();

        const f = issue.fields;
        console.log(`\n  ${chalk.bold.cyan(key)} — ${f.summary?.slice(0, 60)}\n`);
        console.log(chalk.bold.dim(`  Comments (${comments.length}):\n`));

        if (comments.length === 0) {
          console.log(chalk.dim('  No comments yet.\n'));
          return;
        }

        comments.forEach((c, i) => {
          const author = chalk.cyan(c.author?.displayName || 'Unknown');
          const date = new Date(c.created).toLocaleString();
          const text = extractPlainText(c.body) || '';
          console.log(`  ${chalk.dim(`${i + 1}.`)} ${author} ${chalk.dim(date)}`);
          console.log(`     ${text.slice(0, 300)}\n`);
        });
        return;
      }

      // ── Add comment mode ──────────────────────────────────────────────────
      let text = argv.message;

      if (!text) {
        // Show ticket context first
        const ctxSpinner = ora(`Loading ${key}...`).start();
        const issue = await getIssue(key);
        ctxSpinner.stop();
        const f = issue.fields;

        console.log(`\n  ${chalk.bold.cyan(key)} — ${f.summary?.slice(0, 60)}`);
        console.log(`  Status: ${chalk.yellow(f.status?.name)}\n`);

        const ans = await inquirer.prompt([
          {
            type: 'editor',
            name: 'comment',
            message: 'Write your comment:',
          },
        ]);
        text = ans.comment;
      }

      // Validate
      validate(CommentSchema, { key, text });

      const spinner = ora('Posting comment...').start();
      await addComment(key, text);
      spinner.stop();

      console.log(chalk.green(`\n✔ Comment added to ${key}\n`));
      logger.info(`comment: added to ${key}`);
    } catch (err) {
      printError(err);
      logger.error(`comment failed: ${err.message}`);
      process.exit(1);
    }
  },
};

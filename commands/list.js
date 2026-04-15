'use strict';

/**
 * list.js
 * `jira list` — List YOUR assigned tickets in the current project.
 * Uses JQL: assignee = currentUser() AND project = <resolved>
 *
 * Flags:
 *   --status    Filter by status (e.g. "In Progress")
 *   --type      Filter by issue type (Bug, Task, Story...)
 *   --limit     Number of results (default 25)
 *   --page      Pagination (0-indexed)
 *   --filter    Plain-English filter (AI converts to JQL)
 *   --json      Output raw JSON (for piping)
 */

const chalk = require('chalk');
const ora = require('ora');
const { searchIssues } = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { convertToJQL } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
const { isSyncStale } = require('../utils/cache');
const logger = require('../utils/logger');

// Status → colored badge
const STATUS_COLORS = {
  'To Do': chalk.gray,
  'In Progress': chalk.blue,
  'Code Review': chalk.cyan,
  'SIT': chalk.magenta,
  'UAT': chalk.yellow,
  Done: chalk.green,
  Closed: chalk.green,
  Blocked: chalk.red,
  'Waiting for Dev/Requestor': chalk.yellow,
};

function colorStatus(status) {
  const fn = STATUS_COLORS[status] || chalk.white;
  return fn(`[${status}]`);
}

// Priority → colored symbol
const PRIORITY_SYMBOLS = {
  Blocker: chalk.red('🔴'),
  High: chalk.red('↑'),
  Medium: chalk.yellow('→'),
  Low: chalk.green('↓'),
  Minor: chalk.dim('↓'),
};

function priorityIcon(priority) {
  return PRIORITY_SYMBOLS[priority] || chalk.dim('·');
}

module.exports = {
  command: 'list',
  desc: 'List your assigned Jira tickets',
  builder: (yargs) =>
    yargs
      .option('status', { alias: 's', type: 'string', desc: 'Filter by status (e.g. "In Progress")' })
      .option('type', { alias: 't', type: 'string', desc: 'Filter by issue type (Bug, Task, Story...)' })
      .option('limit', { alias: 'l', type: 'number', default: 25, desc: 'Number of results' })
      .option('page', { alias: 'p', type: 'number', default: 0, desc: 'Page number (0-indexed)' })
      .option('filter', { alias: 'f', type: 'string', desc: 'Plain-English filter (AI-powered)' })
      .option('json', { type: 'boolean', default: false, desc: 'Output raw JSON' }),

  handler: async (argv) => {
    try {
      const projectKey = await resolveProjectKeyInteractive();

      // Stale sync warning
      if (isSyncStale(projectKey) && !argv.json) {
        console.log(chalk.yellow(`⚠  Sync data is stale. Run ${chalk.bold('jira sync')} to refresh field options.\n`));
      }

      let jql;

      if (argv.filter) {
        // AI-powered plain English → JQL
        const spinner = ora('Converting filter to JQL...').start();
        const result = await convertToJQL(argv.filter, projectKey);
        spinner.stop();

        jql = result.jql;
        if (!argv.json) {
          const tag = result.aiUsed ? chalk.cyan('[AI]') : chalk.dim('[fallback]');
          console.log(`${tag} JQL: ${chalk.dim(jql)}\n`);
        }
      } else {
        // Manual JQL construction
        const conditions = [
          `project = ${projectKey}`,
          'assignee = currentUser()',
        ];

        if (argv.status) conditions.push(`status = "${argv.status}"`);
        if (argv.type) conditions.push(`issuetype = "${argv.type}"`);

        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';
      }

      const spinner = ora('Fetching your tickets...').start();

      const result = await searchIssues(jql, {
        startAt: argv.page * argv.limit,
        maxResults: argv.limit,
      });

      spinner.stop();

      logger.info(`jira list: fetched ${result.issues?.length} issues`);

      if (argv.json) {
        console.log(JSON.stringify(result.issues, null, 2));
        return;
      }

      const issues = result.issues || [];
      const total = result.total || 0;

      if (issues.length === 0) {
        console.log(chalk.dim('No tickets found matching your criteria.'));
        return;
      }

      // Header
      console.log(
        chalk.bold(`\n📋 Your tickets in ${chalk.cyan(projectKey)} `) +
          chalk.dim(`(${issues.length} of ${total})\n`)
      );

      // Print each issue
      issues.forEach((issue) => {
        const f = issue.fields;
        const key = chalk.bold.cyan(issue.key.padEnd(12));
        const status = colorStatus(f.status?.name || 'Unknown');
        const priority = priorityIcon(f.priority?.name);
        const points = f.customfield_10026 ? chalk.dim(` [${f.customfield_10026}sp]`) : '';
        const summary = f.summary?.slice(0, 65) || '(no summary)';
        const cluster = f.customfield_11371?.value ? chalk.dim(` · ${f.customfield_11371.value}`) : '';

        console.log(`${priority} ${key} ${status}${points} ${summary}${cluster}`);
      });

      // Pagination hint
      if (total > argv.limit) {
        const nextPage = argv.page + 1;
        const remaining = total - (argv.page + 1) * argv.limit;
        if (remaining > 0) {
          console.log(
            chalk.dim(
              `\n  ${remaining} more tickets. Use --page ${nextPage} to see next page.`
            )
          );
        }
      }

      console.log();
    } catch (err) {
      printError(err);
      logger.error(`list command failed: ${err.message}`);
      process.exit(1);
    }
  },
};

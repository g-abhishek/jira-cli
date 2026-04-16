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
const { printTable } = require('../utils/table');
const logger = require('../utils/logger');

// ── Status coloring ────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  'To Do':                    chalk.gray,
  'In Progress':              chalk.blue,
  'Code Review':              chalk.cyan,
  'LEAD REVIEW':              chalk.cyan,
  'SIT':                      chalk.magenta,
  'UAT':                      chalk.yellow,
  'UAT Verification':         chalk.yellow,
  'On Hold':                  chalk.yellow,
  Done:                       chalk.green,
  Closed:                     chalk.green,
  Blocked:                    chalk.red,
  Duplicate:                  chalk.dim,
  'Waiting for Dev/Requestor': chalk.yellow,
};

function colorStatus(status) {
  const fn = STATUS_COLORS[status] || chalk.white;
  return fn(status);
}

// ── Priority icon ──────────────────────────────────────────────────────────────

const PRIORITY_SYMBOLS = {
  Blocker: chalk.red('●'),
  High:    chalk.red('↑'),
  Medium:  chalk.yellow('→'),
  Low:     chalk.green('↓'),
  Minor:   chalk.dim('↓'),
};

function priorityIcon(priority) {
  return PRIORITY_SYMBOLS[priority] || chalk.dim('·');
}

// ── Issue type short label ─────────────────────────────────────────────────────

const TYPE_COLORS = {
  Bug:      chalk.red,
  Story:    chalk.blue,
  Task:     chalk.cyan,
  Epic:     chalk.magenta,
  'Sub-task': chalk.dim,
};

function colorType(type) {
  const fn = TYPE_COLORS[type] || chalk.white;
  return fn(type);
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  command: 'list',
  desc: 'List your assigned Jira tickets',
  builder: (yargs) =>
    yargs
      .option('status',  { alias: 's', type: 'string',  desc: 'Filter by status (e.g. "In Progress")' })
      .option('type',    { alias: 't', type: 'string',  desc: 'Filter by issue type (Bug, Task, Story...)' })
      .option('limit',   { alias: 'l', type: 'number',  default: 25,   desc: 'Number of results' })
      .option('page',    { alias: 'p', type: 'number',  default: 0,    desc: 'Page number (0-indexed)' })
      .option('filter',  { alias: 'f', type: 'string',  desc: 'Plain-English filter (AI-powered)' })
      .option('json',    {             type: 'boolean', default: false, desc: 'Output raw JSON' }),

  handler: async (argv) => {
    try {
      const projectKey = await resolveProjectKeyInteractive();

      // Stale sync warning
      if (isSyncStale(projectKey) && !argv.json) {
        console.log(chalk.yellow(`⚠  Sync data is stale. Run ${chalk.bold('jira sync')} to refresh.\n`));
      }

      let jql;

      if (argv.filter) {
        const spinner = ora('Converting filter to JQL...').start();
        const result = await convertToJQL(argv.filter, projectKey);
        spinner.stop();

        jql = result.jql;
        // If the AI extracted a count (e.g. "show 100 tickets"), use it as maxResults
        if (result.suggestedLimit) argv.limit = result.suggestedLimit;
        if (!argv.json) {
          if (result.aiUsed) {
            console.log(`${chalk.cyan('[AI]')} JQL: ${chalk.dim(jql)}\n`);
          } else if (result.reason === 'api_error') {
            console.log(`${chalk.yellow('[smart-fallback]')} JQL: ${chalk.dim(jql)}`);
            console.log(chalk.red(`  ✖ AI error: ${result.errorMsg}`));
            console.log(chalk.dim('  Run `jira logs` to see full error details.\n'));
          } else {
            console.log(`${chalk.yellow('[smart-fallback]')} JQL: ${chalk.dim(jql)}`);
            console.log(chalk.dim('  Tip: Add an AI key for smarter filtering → jira config set ANTHROPIC_API_KEY sk-ant-...\n'));
          }
        }
      } else {
        const conditions = [
          `project = ${projectKey}`,
          'assignee = currentUser()',
        ];
        if (argv.status) conditions.push(`status = "${argv.status}"`);
        if (argv.type)   conditions.push(`issuetype = "${argv.type}"`);
        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';
      }

      const spinner = ora('Fetching your tickets...').start();
      const result = await searchIssues(jql, {
        maxResults: argv.limit,
        nextPageToken: argv.page > 0 ? String(argv.page * argv.limit) : undefined,
      });
      spinner.stop();

      logger.info(`jira list: fetched ${result.issues?.length} issues`);

      if (argv.json) {
        console.log(JSON.stringify(result.issues, null, 2));
        return;
      }

      const issues = result.issues || [];
      const total  = result.total  || 0;

      if (issues.length === 0) {
        console.log(chalk.dim('\nNo tickets found matching your criteria.\n'));
        return;
      }

      // ── Header ──────────────────────────────────────────────────────────────
      console.log(
        chalk.bold(`\n📋 Your tickets in ${chalk.cyan(projectKey)}`) +
        chalk.dim(`  (${issues.length} of ${total})\n`)
      );

      // ── Table ───────────────────────────────────────────────────────────────
      printTable({
        columns: [
          {
            key: 'priority', header: ' ', width: 1,
            render: (v) => v,  // already an icon
          },
          {
            key: 'key', header: 'Key', width: 11,
            render: (v) => chalk.bold.cyan(v),
          },
          {
            key: 'type', header: 'Type', width: 9,
            render: (v) => colorType(v),
          },
          {
            key: 'status', header: 'Status', width: 18,
            render: (v) => colorStatus(v),
          },
          {
            key: 'sp', header: 'SP', width: 3, align: 'right',
            render: (v) => v ? chalk.dim(v) : chalk.dim('-'),
          },
          {
            key: 'summary', header: 'Summary', width: 'fill',
            render: (v) => chalk.white(v),
          },
        ],
        rows: issues.map((issue) => ({
          priority: priorityIcon(issue.fields.priority?.name),
          key:      issue.key,
          type:     issue.fields.issuetype?.name || '?',
          status:   issue.fields.status?.name    || 'Unknown',
          sp:       issue.fields.customfield_10026 != null
                      ? String(issue.fields.customfield_10026)
                      : '',
          summary:  issue.fields.summary || '(no summary)',
        })),
      });

      // ── Pagination ───────────────────────────────────────────────────────────
      if (result.nextPageToken) {
        console.log(chalk.dim(`\n  More results — use --page ${argv.page + 1} to continue.\n`));
      } else {
        console.log();
      }

    } catch (err) {
      printError(err);
      logger.error(`list command failed: ${err.message}`);
      process.exit(1);
    }
  },
};

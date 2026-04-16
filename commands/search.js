'use strict';

/**
 * search.js
 * `jira search` — Search ALL tickets in the org/project (not just yours).
 *
 * Flags:
 *   --project    Project key (auto-resolved if omitted)
 *   --assignee   Filter by assignee display name or "me"
 *   --status     Filter by status
 *   --type       Filter by issue type
 *   --priority   Filter by priority
 *   --filter     Plain-English query (AI → JQL)
 *   --limit      Results per page
 *   --page       Page number
 *   --json       Output raw JSON
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { searchIssues } = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { convertToJQL } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
const { printTable } = require('../utils/table');
const cache = require('../utils/cache');
const { requireSyncedData, requireSyncedField } = require('../utils/requireSync');
const logger = require('../utils/logger');

// ── Status coloring ────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  'To Do':                     chalk.gray,
  'In Progress':               chalk.blue,
  'Code Review':               chalk.cyan,
  'LEAD REVIEW':               chalk.cyan,
  'SIT':                       chalk.magenta,
  'UAT':                       chalk.yellow,
  'UAT Verification':          chalk.yellow,
  'On Hold':                   chalk.yellow,
  Done:                        chalk.green,
  Closed:                      chalk.green,
  Blocked:                     chalk.red,
  Duplicate:                   chalk.dim,
  'Waiting for Dev/Requestor': chalk.yellow,
};

function colorStatus(status) {
  const fn = STATUS_COLORS[status] || chalk.white;
  return fn(status);
}

// ── Issue type coloring ────────────────────────────────────────────────────────

const TYPE_COLORS = {
  Bug:        chalk.red,
  Story:      chalk.blue,
  Task:       chalk.cyan,
  Epic:       chalk.magenta,
  'Sub-task': chalk.dim,
};

function colorType(type) {
  const fn = TYPE_COLORS[type] || chalk.white;
  return fn(type);
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

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  command: 'search',
  desc: 'Search all tickets in the project (not just yours)',
  builder: (yargs) =>
    yargs
      .option('project',     { alias: 'P',  type: 'string',  desc: 'Project key' })
      .option('assignee',    { alias: 'a',  type: 'string',  desc: 'Assignee name or "me"' })
      .option('status',      { alias: 's',  type: 'string',  desc: 'Status filter' })
      .option('type',        { alias: 't',  type: 'string',  desc: 'Issue type filter' })
      .option('priority',    { alias: 'pr', type: 'string',  desc: 'Priority filter' })
      .option('filter',      { alias: 'f',  type: 'string',  desc: 'Plain-English filter (AI-powered)' })
      .option('limit',       { alias: 'l',  type: 'number',  default: 25,   desc: 'Results per page' })
      .option('page',        { alias: 'p',  type: 'number',  default: 0,    desc: 'Page number (0-indexed)' })
      .option('json',        {              type: 'boolean', default: false, desc: 'Output raw JSON' })
      .option('interactive', { alias: 'i',  type: 'boolean', default: false, desc: 'Interactive filter builder' }),

  handler: async (argv) => {
    try {
      const projectKey = argv.project || (await resolveProjectKeyInteractive());
      let jql;

      // ── Interactive mode ───────────────────────────────────────────────────
      if (argv.interactive) {
        const syncedData = cache.get(`${projectKey}:fields`);
        requireSyncedData(syncedData, projectKey);
        const statuses   = requireSyncedField(syncedData, 'statuses',   projectKey, 'Statuses');
        const issueTypes = requireSyncedField(syncedData, 'issueTypes', projectKey, 'Issue Types');

        const answers = await inquirer.prompt([
          {
            type: 'list',
            name: 'assigneeMode',
            message: 'Assignee:',
            choices: ['Anyone', 'Me (currentUser)', 'Specific person'],
          },
          {
            type: 'input',
            name: 'assigneeName',
            message: 'Enter assignee name:',
            when: (a) => a.assigneeMode === 'Specific person',
          },
          {
            type: 'checkbox',
            name: 'statuses',
            message: 'Filter by status (space to select, Enter to continue):',
            choices: statuses,
          },
          {
            type: 'checkbox',
            name: 'types',
            message: 'Filter by issue type:',
            choices: issueTypes,
          },
        ]);

        const conditions = [`project = ${projectKey}`];
        if (answers.assigneeMode === 'Me (currentUser)') conditions.push('assignee = currentUser()');
        if (answers.assigneeMode === 'Specific person' && answers.assigneeName) {
          conditions.push(`assignee = "${answers.assigneeName}"`);
        }
        if (answers.statuses.length > 0)
          conditions.push(`status in (${answers.statuses.map((s) => `"${s}"`).join(', ')})`);
        if (answers.types.length > 0)
          conditions.push(`issuetype in (${answers.types.map((t) => `"${t}"`).join(', ')})`);

        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';

      // ── AI / plain-English filter ──────────────────────────────────────────
      } else if (argv.filter) {
        const spinner = ora('Converting filter to JQL...').start();
        const result = await convertToJQL(argv.filter, projectKey);
        spinner.stop();
        jql = result.jql;
        if (!argv.json) {
          if (result.aiUsed) {
            console.log(`${chalk.cyan('[AI]')} JQL: ${chalk.dim(jql)}\n`);
          } else if (result.reason === 'api_error') {
            console.log(`${chalk.yellow('[smart-fallback]')} JQL: ${chalk.dim(jql)}`);
            console.log(chalk.red(`  ✖ AI error: ${result.errorMsg}`));
            console.log(chalk.dim('  Run `jira logs` to see full error details.\n'));
          } else {
            console.log(`${chalk.yellow('[smart-fallback]')} JQL: ${chalk.dim(jql)}`);
            console.log(chalk.dim('  Tip: Add an AI key → jira config set ANTHROPIC_API_KEY sk-ant-...\n'));
          }
        }

      // ── Manual flag-based JQL ──────────────────────────────────────────────
      } else {
        const conditions = [`project = ${projectKey}`];
        if (argv.assignee) {
          conditions.push(
            argv.assignee === 'me'
              ? 'assignee = currentUser()'
              : `assignee = "${argv.assignee}"`
          );
        }
        if (argv.status)   conditions.push(`status = "${argv.status}"`);
        if (argv.type)     conditions.push(`issuetype = "${argv.type}"`);
        if (argv.priority) conditions.push(`priority = "${argv.priority}"`);
        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';
      }

      const spinner = ora(`Searching ${projectKey}...`).start();
      const result = await searchIssues(jql, {
        maxResults: argv.limit,
        nextPageToken: argv.page > 0 ? String(argv.page * argv.limit) : undefined,
      });
      spinner.stop();

      if (argv.json) {
        console.log(JSON.stringify(result.issues, null, 2));
        return;
      }

      const issues = result.issues || [];
      const total  = result.total  || 0;

      if (issues.length === 0) {
        console.log(chalk.dim('\nNo tickets found.\n'));
        return;
      }

      // ── Header ──────────────────────────────────────────────────────────────
      console.log(
        chalk.bold(`\n🔍 Search results in ${chalk.cyan(projectKey)}`) +
        chalk.dim(`  (${issues.length} of ${total})\n`)
      );

      // ── Table ───────────────────────────────────────────────────────────────
      printTable({
        columns: [
          {
            key: 'priority', header: ' ', width: 1,
            render: (v) => v,
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
            key: 'summary', header: 'Summary', width: 'fill',
            render: (v) => chalk.white(v),
          },
          {
            key: 'assignee', header: 'Assignee', width: 14,
            render: (v) => chalk.dim(v),
          },
        ],
        rows: issues.map((issue) => ({
          priority: priorityIcon(issue.fields.priority?.name),
          key:      issue.key,
          type:     issue.fields.issuetype?.name || '?',
          status:   issue.fields.status?.name    || 'Unknown',
          summary:  issue.fields.summary         || '(no summary)',
          assignee: issue.fields.assignee
            ? issue.fields.assignee.displayName.split(' ').map((w) => w[0]).join('') +
              ' ' + (issue.fields.assignee.displayName.split(' ').slice(-1)[0] || '')
            : 'Unassigned',
        })),
      });

      // ── Pagination ───────────────────────────────────────────────────────────
      if (total > argv.limit) {
        const remaining = total - (argv.page + 1) * argv.limit;
        if (remaining > 0) {
          console.log(chalk.dim(`\n  ${remaining} more — use --page ${argv.page + 1} for next page.\n`));
        }
      } else {
        console.log();
      }

      logger.info(`search: found ${total} issues for JQL: ${jql}`);
    } catch (err) {
      printError(err);
      logger.error(`search failed: ${err.message}`);
      process.exit(1);
    }
  },
};

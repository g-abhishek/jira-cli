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
const cache = require('../utils/cache');
const { requireSyncedData, requireSyncedField } = require('../utils/requireSync');
const logger = require('../utils/logger');

module.exports = {
  command: 'search',
  desc: 'Search all tickets in the project (not just yours)',
  builder: (yargs) =>
    yargs
      .option('project', { alias: 'P', type: 'string', desc: 'Project key' })
      .option('assignee', { alias: 'a', type: 'string', desc: 'Assignee name or "me"' })
      .option('status', { alias: 's', type: 'string', desc: 'Status filter' })
      .option('type', { alias: 't', type: 'string', desc: 'Issue type filter' })
      .option('priority', { alias: 'pr', type: 'string', desc: 'Priority filter' })
      .option('filter', { alias: 'f', type: 'string', desc: 'Plain-English filter (AI-powered)' })
      .option('limit', { alias: 'l', type: 'number', default: 25, desc: 'Results per page' })
      .option('page', { alias: 'p', type: 'number', default: 0, desc: 'Page number (0-indexed)' })
      .option('json', { type: 'boolean', default: false, desc: 'Output raw JSON' })
      .option('interactive', { alias: 'i', type: 'boolean', default: false, desc: 'Interactive filter builder' }),

  handler: async (argv) => {
    try {
      const projectKey = argv.project || (await resolveProjectKeyInteractive());
      let jql;

      // Interactive mode: build filters with prompts
      if (argv.interactive) {
        const syncedData = cache.get(`${projectKey}:fields`);
        requireSyncedData(syncedData, projectKey);
        const statuses   = requireSyncedField(syncedData, 'statuses',    projectKey, 'Statuses');
        const issueTypes = requireSyncedField(syncedData, 'issueTypes',  projectKey, 'Issue Types');

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
        if (answers.statuses.length > 0) {
          conditions.push(`status in (${answers.statuses.map((s) => `"${s}"`).join(', ')})`);
        }
        if (answers.types.length > 0) {
          conditions.push(`issuetype in (${answers.types.map((t) => `"${t}"`).join(', ')})`);
        }

        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';

      } else if (argv.filter) {
        const spinner = ora('Converting filter to JQL...').start();
        const result = await convertToJQL(argv.filter, projectKey);
        spinner.stop();
        jql = result.jql;
        if (!argv.json) {
          const tag = result.aiUsed ? chalk.cyan('[AI]') : chalk.dim('[fallback]');
          console.log(`${tag} JQL: ${chalk.dim(jql)}\n`);
        }
      } else {
        // Manual flag-based JQL
        const conditions = [`project = ${projectKey}`];
        if (argv.assignee) {
          conditions.push(
            argv.assignee === 'me'
              ? 'assignee = currentUser()'
              : `assignee = "${argv.assignee}"`
          );
        }
        if (argv.status) conditions.push(`status = "${argv.status}"`);
        if (argv.type) conditions.push(`issuetype = "${argv.type}"`);
        if (argv.priority) conditions.push(`priority = "${argv.priority}"`);
        jql = conditions.join(' AND ') + ' ORDER BY updated DESC';
      }

      const spinner = ora(`Searching ${projectKey}...`).start();

      const result = await searchIssues(jql, {
        startAt: argv.page * argv.limit,
        maxResults: argv.limit,
      });

      spinner.stop();

      if (argv.json) {
        console.log(JSON.stringify(result.issues, null, 2));
        return;
      }

      const issues = result.issues || [];
      const total = result.total || 0;

      if (issues.length === 0) {
        console.log(chalk.dim('\nNo tickets found.'));
        return;
      }

      console.log(chalk.bold(`\n🔍 Search results in ${chalk.cyan(projectKey)} `) + chalk.dim(`(${issues.length} of ${total})\n`));

      issues.forEach((issue) => {
        const f = issue.fields;
        const key = chalk.bold.cyan(issue.key.padEnd(12));
        const status = chalk.dim(`[${f.status?.name || '?'}]`);
        const assignee = f.assignee ? chalk.dim(` @${f.assignee.displayName.split(' ')[0]}`) : chalk.dim(' unassigned');
        const type = chalk.dim(`${f.issuetype?.name || ''}`);
        const summary = f.summary?.slice(0, 60) || '(no summary)';

        console.log(`  ${key} ${status} ${type} ${summary}${assignee}`);
      });

      if (total > argv.limit) {
        const remaining = total - (argv.page + 1) * argv.limit;
        if (remaining > 0) {
          console.log(chalk.dim(`\n  ${remaining} more. Use --page ${argv.page + 1} for next page.`));
        }
      }

      console.log();
      logger.info(`search: found ${total} issues for JQL: ${jql}`);
    } catch (err) {
      printError(err);
      logger.error(`search failed: ${err.message}`);
      process.exit(1);
    }
  },
};

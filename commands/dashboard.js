'use strict';

/**
 * dashboard.js
 * `jira dashboard` — Terminal sprint board view.
 *
 * Shows a Kanban-style board with columns:
 *   To Do | In Progress | Code Review | SIT | UAT | Done
 *
 * Each column shows tickets assigned to current user in the active sprint.
 * Refreshes on Enter key, exits on 'q'.
 *
 * Flags:
 *   --project  Project key
 *   --all      Show all team members (not just yours)
 *   --refresh  Auto-refresh interval in seconds (default: off)
 */

const chalk = require('chalk');
const ora = require('ora');
const readline = require('readline');
const { searchIssues } = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { printError } = require('../utils/errorParser');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

// Status columns for the board (in display order)
const BOARD_COLUMNS = [
  { name: 'To Do', color: chalk.gray, width: 22 },
  { name: 'In Progress', color: chalk.blue, width: 22 },
  { name: 'Code Review', color: chalk.cyan, width: 22 },
  { name: 'SIT', color: chalk.magenta, width: 22 },
  { name: 'Done', color: chalk.green, width: 22 },
];

module.exports = {
  command: 'dashboard',
  desc: 'Terminal sprint board — your tickets at a glance',
  builder: (yargs) =>
    yargs
      .option('project', { alias: 'p', type: 'string', desc: 'Project key' })
      .option('all', { alias: 'a', type: 'boolean', default: false, desc: 'Show all assignees' })
      .option('refresh', { alias: 'r', type: 'number', desc: 'Auto-refresh interval (seconds)' }),

  handler: async (argv) => {
    try {
      const projectKey = argv.project || (await resolveProjectKeyInteractive());

      // Get active sprint name from cache
      const synced = cache.get(`${projectKey}:fields`) || {};
      const activeSprint = synced.activeSprints?.[0]?.name || null;

      let refreshTimer = null;

      const renderBoard = async () => {
        const spinner = ora('Loading dashboard...').start();

        try {
          // Build JQL: current sprint, current user (unless --all)
          const sprintClause = activeSprint ? `sprint = "${activeSprint}"` : `sprint in openSprints()`;
          const assigneeClause = argv.all ? '' : ' AND assignee = currentUser()';
          const jql = `project = ${projectKey} AND ${sprintClause}${assigneeClause} ORDER BY status ASC, priority DESC`;

          const result = await searchIssues(jql, {
            maxResults: 100,
            fields: [
              'summary', 'status', 'priority', 'assignee', 'issuetype',
              'customfield_10026', // Story Points — universal field
            ],
          });

          spinner.stop();

          const issues = result.issues || [];

          // Group by status
          const grouped = {};
          BOARD_COLUMNS.forEach((col) => { grouped[col.name] = []; });
          grouped['Other'] = [];

          issues.forEach((issue) => {
            const status = issue.fields?.status?.name;
            if (grouped[status]) {
              grouped[status].push(issue);
            } else {
              // Map to closest column
              const statusLower = (status || '').toLowerCase();
              if (statusLower.includes('progress') || statusLower.includes('dev')) {
                grouped['In Progress'].push(issue);
              } else if (statusLower.includes('review') || statusLower.includes('pr')) {
                grouped['Code Review'].push(issue);
              } else if (statusLower.includes('sit') || statusLower.includes('test')) {
                grouped['SIT'].push(issue);
              } else if (statusLower.includes('done') || statusLower.includes('clos')) {
                grouped['Done'].push(issue);
              } else {
                grouped['To Do'].push(issue);
              }
            }
          });

          // Clear terminal
          process.stdout.write('\x1Bc');

          // ── Header ──────────────────────────────────────────────────────────
          const now = new Date().toLocaleTimeString();
          const scope = argv.all ? 'all team' : 'your tickets';
          console.log(chalk.bold(`\n  📊 ${projectKey} Sprint Board`) + chalk.dim(` · ${scope} · ${now}`));
          if (activeSprint) console.log(chalk.dim(`  Sprint: ${activeSprint}`));
          console.log(chalk.dim(`  Total: ${issues.length} tickets\n`));

          // ── Column Headers ───────────────────────────────────────────────────
          const colWidth = 24;
          let headerRow = '  ';
          BOARD_COLUMNS.forEach((col) => {
            const count = grouped[col.name]?.length || 0;
            const title = `${col.name} (${count})`;
            headerRow += col.color(title.padEnd(colWidth));
          });
          console.log(headerRow);
          console.log('  ' + chalk.dim('─'.repeat(colWidth * BOARD_COLUMNS.length)));

          // ── Rows ──────────────────────────────────────────────────────────────
          const maxRows = Math.max(...BOARD_COLUMNS.map((c) => grouped[c.name]?.length || 0));

          for (let i = 0; i < Math.min(maxRows, 12); i++) {
            let row = '  ';
            BOARD_COLUMNS.forEach((col) => {
              const issue = grouped[col.name]?.[i];
              if (issue) {
                const f = issue.fields;
                const key = issue.key;
                const summary = (f.summary || '').slice(0, colWidth - key.length - 2);
                const pts = f.customfield_10026 ? chalk.dim(`[${f.customfield_10026}]`) : '';
                const cell = `${chalk.cyan(key)} ${summary} ${pts}`;
                row += cell.slice(0, colWidth).padEnd(colWidth);
              } else {
                row += ' '.repeat(colWidth);
              }
            });
            console.log(row);
          }

          if (maxRows > 12) {
            console.log(chalk.dim(`\n  ... and ${maxRows - 12} more tickets`));
          }

          // ── Footer ───────────────────────────────────────────────────────────
          console.log();
          console.log(chalk.dim('  [Enter] Refresh   [q] Quit' + (argv.refresh ? `   [auto: ${argv.refresh}s]` : '')));

          logger.info(`dashboard: rendered ${issues.length} tickets for ${projectKey}`);
        } catch (e) {
          spinner.stop();
          printError(e);
        }
      };

      // Initial render
      await renderBoard();

      // ── Keyboard input ──────────────────────────────────────────────────────
      readline.emitKeypressEvents(process.stdin);
      if (process.stdin.isTTY) process.stdin.setRawMode(true);

      // Auto-refresh timer
      if (argv.refresh) {
        refreshTimer = setInterval(renderBoard, argv.refresh * 1000);
      }

      process.stdin.on('keypress', async (str, key) => {
        if (key.name === 'return' || key.name === 'enter') {
          await renderBoard();
        }
        if (str === 'q' || (key.ctrl && key.name === 'c')) {
          if (refreshTimer) clearInterval(refreshTimer);
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          console.log(chalk.dim('\n  Exited dashboard.\n'));
          process.exit(0);
        }
      });

      process.stdin.resume();
    } catch (err) {
      printError(err);
      logger.error(`dashboard failed: ${err.message}`);
      process.exit(1);
    }
  },
};

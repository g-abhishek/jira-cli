'use strict';

/**
 * view.js
 * `jira view <KEY>` — Show full details of a single ticket.
 *
 * Displays: summary, status, priority, assignees, description,
 * JCP-specific fields, comments, and a link to open in browser.
 *
 * Flags:
 *   --summarize  AI TL;DR of the ticket
 *   --open       Open ticket in browser after viewing
 *   --json       Raw JSON output
 */

const chalk = require('chalk');
const ora = require('ora');
const { execSync } = require('child_process');
const { getIssue, getComments } = require('../services/jiraService');
const { summarizeIssue, extractPlainText } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema } = require('../validators/schema');
const logger = require('../utils/logger');

// Open URL in default browser cross-platform
function openInBrowser(url) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${cmd} "${url}"`, { stdio: 'ignore' });
  } catch {}
}

module.exports = {
  command: 'view <key>',
  desc: 'View full details of a Jira ticket',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', desc: 'Issue key (e.g. JCP-1234)' })
      .option('summarize', { alias: 'S', type: 'boolean', default: false, desc: 'Show AI TL;DR' })
      .option('open', { alias: 'o', type: 'boolean', default: false, desc: 'Open in browser' })
      .option('json', { type: 'boolean', default: false, desc: 'Raw JSON output' }),

  handler: async (argv) => {
    try {
      const key = validate(IssueKeySchema, argv.key);

      const spinner = ora(`Fetching ${key}...`).start();
      const [issue, comments] = await Promise.all([
        getIssue(key),
        getComments(key),
      ]);
      spinner.stop();

      if (argv.json) {
        console.log(JSON.stringify(issue, null, 2));
        return;
      }

      const f = issue.fields;

      // ── Header ──────────────────────────────────────────────────────────────
      console.log('\n' + chalk.bold('─'.repeat(60)));
      console.log(chalk.bold.cyan(`  ${issue.key}`) + '  ' + chalk.bold(f.summary));
      console.log(chalk.bold('─'.repeat(60)));

      // ── Core Fields ──────────────────────────────────────────────────────────
      const row = (label, value) => {
        if (!value) return;
        console.log(`  ${chalk.dim(label.padEnd(22))} ${value}`);
      };

      row('Status', colorStatus(f.status?.name));
      row('Type', f.issuetype?.name);
      row('Priority', f.priority?.name);
      row('Assignee', f.assignee?.displayName || chalk.dim('Unassigned'));
      row('Reporter', f.reporter?.displayName);
      row('Assigned Developer', f.customfield_10091?.displayName);
      row('Assigned QA', f.customfield_10054?.displayName);
      row('Engineering Lead', f.customfield_10055?.displayName);
      row('Product Manager', f.customfield_10261?.displayName);
      row('Story Points', f.customfield_10026?.toString());
      row('QA Story Points', f.customfield_10075?.toString());
      row('Sprint', f.customfield_10020?.[0]?.name);
      row('Epic', f.customfield_10014);
      row('Due Date', f.duedate);
      row('Labels', f.labels?.join(', ') || null);
      row('Components', f.components?.map((c) => c.name).join(', ') || null);
      row('Fix Versions', f.fixVersions?.map((v) => v.name).join(', ') || null);

      // ── JCP-Specific Fields ───────────────────────────────────────────────────
      const jcpFields = [
        ['JCP Work Type', f.customfield_17322?.value],
        ['JCP Planning Type', f.customfield_17321?.value],
        ['JCP Delivery State', f.customfield_17320?.value],
        ['JCP Cluster', f.customfield_11371?.value],
        ['JCP Channel', f.customfield_10455?.value],
        ['JCP Estimate', f.customfield_17356?.value],
        ['JCP Planned Month', f.customfield_17389?.value],
        ['JCP Planned Quarter', f.customfield_17390?.value],
        ['Environment', f.customfield_10030?.value],
        ['Severity', f.customfield_10033?.value],
        ['Ticket Category', f.customfield_10441?.value],
        ['SIT Due Date', f.customfield_12790],
        ['QA Due Date', f.customfield_10417],
      ];

      const hasJcp = jcpFields.some(([, v]) => v);
      if (hasJcp) {
        console.log('\n' + chalk.bold.dim('  ── JCP Fields ──────────────────────────'));
        jcpFields.forEach(([label, value]) => row(label, value));
      }

      // ── Description ──────────────────────────────────────────────────────────
      console.log('\n' + chalk.bold.dim('  ── Description ─────────────────────────'));
      const desc = extractPlainText(f.description);
      if (desc) {
        const lines = desc.split('\n').map((l) => '  ' + l);
        console.log(chalk.white(lines.join('\n')));
      } else {
        console.log(chalk.dim('  (no description)'));
      }

      // ── AI Summary ──────────────────────────────────────────────────────────
      if (argv.summarize) {
        const aiSpinner = ora('Generating AI summary...').start();
        const ai = await summarizeIssue(issue, comments);
        aiSpinner.stop();
        console.log('\n' + chalk.bold.cyan('  ── AI TL;DR ─────────────────────────────'));
        console.log(chalk.white(ai.summary.split('\n').map((l) => '  ' + l).join('\n')));
        if (!ai.aiUsed) console.log(chalk.dim('  (AI not available — showing basic summary)'));
      }

      // ── Comments ─────────────────────────────────────────────────────────────
      if (comments.length > 0) {
        console.log('\n' + chalk.bold.dim(`  ── Comments (${comments.length}) ───────────────────`));
        comments.slice(0, 5).forEach((c) => {
          const author = chalk.cyan(c.author?.displayName || 'Unknown');
          const date = new Date(c.created).toLocaleDateString();
          const text = extractPlainText(c.body)?.slice(0, 200) || '';
          console.log(`\n  ${author} ${chalk.dim(date)}`);
          console.log(`  ${text}`);
        });
        if (comments.length > 5) {
          console.log(chalk.dim(`\n  ... and ${comments.length - 5} more comments`));
        }
      }

      // ── Link ─────────────────────────────────────────────────────────────────
      const { baseUrl } = getBaseUrl();
      const ticketUrl = `${baseUrl}/browse/${issue.key}`;
      console.log('\n  ' + chalk.dim('🔗 ') + chalk.underline.blue(ticketUrl));
      console.log();

      // ── Open in browser ───────────────────────────────────────────────────────
      if (argv.open) {
        openInBrowser(ticketUrl);
        console.log(chalk.green('  ✔ Opened in browser\n'));
      }

      logger.info(`view: ${key}`);
    } catch (err) {
      printError(err);
      logger.error(`view failed: ${err.message}`);
      process.exit(1);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorStatus(status) {
  const map = {
    'To Do': chalk.gray,
    'In Progress': chalk.blue,
    'Code Review': chalk.cyan,
    SIT: chalk.magenta,
    UAT: chalk.yellow,
    Done: chalk.green,
    Closed: chalk.green,
    Blocked: chalk.red,
  };
  const fn = map[status] || chalk.white;
  return fn(status);
}

function getBaseUrl() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const configPath = path.join(os.homedir(), '.jira-cli', 'config.json');
  let fileConfig = {};
  try {
    if (fs.existsSync(configPath)) fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {}
  return { baseUrl: (fileConfig.JIRA_BASE_URL || process.env.JIRA_BASE_URL || '').replace(/\/$/, '') };
}

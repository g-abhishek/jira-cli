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

      // ── Custom Fields (dynamic — from sync cache, works for any project) ────────
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const _cfg = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.jira-cli', 'cache.json'), 'utf8')); }
        catch { return {}; }
      })();
      const _synced = _cfg[`${issue.fields?.project?.key}:fields`]?.value;
      const _cfIds = _synced?.customFieldIds || {}; // { "Field Label": "customfield_XXXXX" }

      // Build a reverse map: customfield_XXXXX → "Field Label"
      const fieldIdToLabel = Object.fromEntries(
        Object.entries(_cfIds).map(([label, id]) => [id, label])
      );

      // Collect any custom field with a value from the issue response
      const customFieldRows = Object.entries(f)
        .filter(([key, val]) => key.startsWith('customfield_') && val !== null && val !== undefined)
        .map(([key, val]) => {
          const label = fieldIdToLabel[key] || null;
          if (!label) return null; // skip unknown fields not in sync
          const display = typeof val === 'object' ? (val.value || val.name || val.displayName || JSON.stringify(val)) : String(val);
          return [label, display];
        })
        .filter(Boolean);

      if (customFieldRows.length > 0) {
        console.log('\n' + chalk.bold.dim('  ── Custom Fields ────────────────────────'));
        customFieldRows.forEach(([label, value]) => row(label, value));
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

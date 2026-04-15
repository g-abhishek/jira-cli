'use strict';

/**
 * create.js
 * `jira create` — Interactively create a Jira issue.
 *
 * Flow:
 *  1. Select issue type
 *  2. Input summary + description
 *  3. Select JCP-specific fields (cluster, work type, etc.)
 *  4. Select priority, fix version, component, story points
 *  5. AI enhances summary + description
 *  6. Confirm → create → print key
 *
 * Flags:
 *   --from-git   Generate ticket from recent git commits (AI)
 *   --type       Pre-select issue type (skip prompt)
 *   --dry-run    Show payload without creating
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { createIssue, getIssueTypes } = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { enhanceTicket, generateFromGit, getDescriptionTemplate } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
const { validate, CreateIssueSchema } = require('../validators/schema');
const cache = require('../utils/cache');
const { requireSyncedData, requireSyncedField } = require('../utils/requireSync');
const gitHelper = require('../utils/gitHelper');
const logger = require('../utils/logger');

module.exports = {
  command: 'create',
  desc: 'Create a new Jira issue interactively',
  builder: (yargs) =>
    yargs
      .option('from-git', { type: 'boolean', default: false, desc: 'Generate from recent git commits' })
      .option('type', { alias: 't', type: 'string', desc: 'Pre-select issue type' })
      .option('dry-run', { type: 'boolean', default: false, desc: 'Show payload without creating' }),

  handler: async (argv) => {
    try {
      const projectKey = await resolveProjectKeyInteractive();

      // Load synced data — throws with clear message if jira sync has not been run
      const synced = cache.get(`${projectKey}:fields`);
      requireSyncedData(synced, projectKey);

      const fixVersions  = requireSyncedField(synced, 'fixVersions',  projectKey, 'Fix Versions');
      const components   = requireSyncedField(synced, 'components',   projectKey, 'Components');
      const issueTypes   = requireSyncedField(synced, 'issueTypes',   projectKey, 'Issue Types');
      const clusters     = requireSyncedField(synced, 'clusters',     projectKey, 'JCP Cluster');
      const channels     = requireSyncedField(synced, 'channels',     projectKey, 'JCP Channel');
      const workTypes    = requireSyncedField(synced, 'workTypes',    projectKey, 'JCP Work Type');
      const planningTypes = requireSyncedField(synced, 'planningTypes', projectKey, 'JCP Planning Type');
      const estimates    = requireSyncedField(synced, 'estimates',    projectKey, 'JCP Estimate');
      // Months and quarters are calendar constants — not project-specific
      const months   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const quarters = ['JFM', 'AMJ', 'JAS', 'OND'];

      console.log(chalk.bold(`\n✨ Create a new ticket in ${chalk.cyan(projectKey)}\n`));

      // ── Step 1: Issue Type ───────────────────────────────────────────────────
      let issueType = argv.type;
      if (!issueType) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'issueType',
            message: 'Issue type:',
            choices: issueTypes,
          },
        ]);
        issueType = ans.issueType;
      }

      // ── Step 2: From Git (AI mode) ───────────────────────────────────────────
      let summary = '';
      let description = '';

      if (argv['from-git']) {
        if (!gitHelper.isGitRepo()) {
          console.log(chalk.yellow('Not in a git repository. Switching to manual input.\n'));
        } else {
          const gitSpinner = ora('Reading git history...').start();
          const commits = gitHelper.getRecentCommits(5);
          const diff = gitHelper.getLastCommitDiff();
          gitSpinner.stop();

          console.log(chalk.dim('\nRecent commits:\n') + chalk.white(commits || '(none)') + '\n');

          const aiSpinner = ora('Generating ticket from git history...').start();
          const ai = await generateFromGit({ commits, diff, issueType });
          aiSpinner.stop();

          if (ai.aiUsed) {
            console.log(chalk.cyan('✨ AI generated:\n'));
          }

          summary = ai.summary;
          description = ai.description;

          // Allow user to review and edit
          const confirm = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'useAI',
              message: `Use AI-generated summary: "${summary.slice(0, 80)}"?`,
              default: true,
            },
          ]);

          if (!confirm.useAI) {
            summary = '';
            description = '';
          }
        }
      }

      // ── Step 3: Manual summary/description input ──────────────────────────────
      if (!summary) {
        const ans = await inquirer.prompt([
          {
            type: 'input',
            name: 'summary',
            message: 'Summary:',
            validate: (v) => v.trim().length > 0 || 'Summary cannot be empty',
          },
        ]);
        summary = ans.summary;
      }

      if (!description) {
        const template = getDescriptionTemplate(issueType);
        const ans = await inquirer.prompt([
          {
            type: 'editor',
            name: 'description',
            message: 'Description (editor will open):',
            default: template,
          },
        ]);
        description = ans.description;
      }

      // ── Step 4: Core Fields ──────────────────────────────────────────────────
      const coreAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'priority',
          message: 'Priority:',
          choices: ['Blocker', 'High', 'Medium', 'Low', 'Minor'],
          default: 'Medium',
        },
        {
          type: 'number',
          name: 'storyPoints',
          message: 'Story Points (0 to skip):',
          default: 0,
          validate: (v) => (Number.isInteger(v) && v >= 0) || 'Must be a non-negative integer',
        },
        {
          type: 'input',
          name: 'dueDate',
          message: 'Due date (YYYY-MM-DD, or blank to skip):',
          validate: (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v) || 'Invalid date format',
        },
      ]);

      // ── Step 5: JCP Fields ───────────────────────────────────────────────────
      const jcpAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'jcpWorkType',
          message: 'JCP Work Type:',
          choices: ['(skip)', ...workTypes],
        },
        {
          type: 'list',
          name: 'jcpPlanningType',
          message: 'JCP Planning Type:',
          choices: ['(skip)', ...planningTypes],
        },
        {
          type: 'list',
          name: 'jcpCluster',
          message: 'JCP Cluster:',
          choices: ['(skip)', ...clusters],
        },
        {
          type: 'list',
          name: 'jcpChannel',
          message: 'JCP Channel:',
          choices: ['(skip)', ...channels],
        },
        {
          type: 'list',
          name: 'jcpEstimate',
          message: 'JCP Estimate:',
          choices: ['(skip)', ...estimates],
        },
        {
          type: 'list',
          name: 'jcpPlannedMonth',
          message: 'JCP Planned Month:',
          choices: ['(skip)', ...months],
        },
        {
          type: 'list',
          name: 'jcpPlannedQuarter',
          message: 'JCP Planned Quarter:',
          choices: ['(skip)', ...quarters],
        },
      ]);

      // ── Step 6: Versions + Components ────────────────────────────────────────
      let selectedVersions = [];
      let selectedComponents = [];

      if (fixVersions.length > 0) {
        const verAns = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'fixVersions',
            message: 'Fix Versions (space to select):',
            choices: fixVersions.slice(0, 30), // cap for UX
            pageSize: 10,
          },
        ]);
        selectedVersions = verAns.fixVersions;
      }

      if (components.length > 0) {
        const compAns = await inquirer.prompt([
          {
            type: 'checkbox',
            name: 'components',
            message: 'Components:',
            choices: components,
            pageSize: 10,
          },
        ]);
        selectedComponents = compAns.components;
      }

      // ── Step 7: AI Enhancement ────────────────────────────────────────────────
      const aiSpinner = ora('Enhancing with AI...').start();
      const enhanced = await enhanceTicket({ summary, description, issueType });
      aiSpinner.stop();

      if (enhanced.aiUsed) {
        console.log(chalk.cyan('\n✨ AI enhanced your ticket:'));
        console.log(`  Summary: ${chalk.white(enhanced.summary)}`);
      } else {
        console.log(chalk.dim('\n  (AI not available — using your input as-is)'));
      }

      // ── Step 8: Confirm ───────────────────────────────────────────────────────
      console.log(chalk.bold('\n── Preview ──────────────────────────────────────'));
      console.log(`  ${chalk.dim('Type')}     ${issueType}`);
      console.log(`  ${chalk.dim('Summary')}  ${enhanced.summary.slice(0, 80)}`);
      console.log(`  ${chalk.dim('Priority')} ${coreAnswers.priority}`);
      if (jcpAnswers.jcpCluster !== '(skip)') console.log(`  ${chalk.dim('Cluster')}  ${jcpAnswers.jcpCluster}`);
      if (jcpAnswers.jcpWorkType !== '(skip)') console.log(`  ${chalk.dim('Work Type')} ${jcpAnswers.jcpWorkType}`);
      console.log(chalk.bold('─────────────────────────────────────────────────\n'));

      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: 'Create this ticket?',
          default: true,
        },
      ]);

      if (!confirmed) {
        console.log(chalk.yellow('\nCancelled.\n'));
        return;
      }

      // ── Step 9: Build payload ─────────────────────────────────────────────────
      const fields = {
        project: { key: projectKey },
        summary: enhanced.summary,
        description: buildADF(enhanced.description),
        issuetype: { name: issueType },
        priority: { name: coreAnswers.priority },
      };

      if (coreAnswers.storyPoints > 0) fields.customfield_10026 = coreAnswers.storyPoints;
      if (coreAnswers.dueDate) fields.duedate = coreAnswers.dueDate;
      if (jcpAnswers.jcpWorkType !== '(skip)') fields.customfield_17322 = { value: jcpAnswers.jcpWorkType };
      if (jcpAnswers.jcpPlanningType !== '(skip)') fields.customfield_17321 = { value: jcpAnswers.jcpPlanningType };
      if (jcpAnswers.jcpCluster !== '(skip)') fields.customfield_11371 = { value: jcpAnswers.jcpCluster };
      if (jcpAnswers.jcpChannel !== '(skip)') fields.customfield_10455 = { value: jcpAnswers.jcpChannel };
      if (jcpAnswers.jcpEstimate !== '(skip)') fields.customfield_17356 = { value: jcpAnswers.jcpEstimate };
      if (jcpAnswers.jcpPlannedMonth !== '(skip)') fields.customfield_17389 = { value: jcpAnswers.jcpPlannedMonth };
      if (jcpAnswers.jcpPlannedQuarter !== '(skip)') fields.customfield_17390 = { value: jcpAnswers.jcpPlannedQuarter };
      if (selectedVersions.length > 0) fields.fixVersions = selectedVersions.map((v) => ({ name: v }));
      if (selectedComponents.length > 0) fields.components = selectedComponents.map((c) => ({ name: c }));

      // Dry run
      if (argv['dry-run']) {
        console.log(chalk.cyan('\n── Dry Run Payload ───────────────────────────────'));
        console.log(JSON.stringify({ fields }, null, 2));
        console.log(chalk.dim('\nNo ticket was created (--dry-run mode).\n'));
        return;
      }

      // ── Step 10: Create ───────────────────────────────────────────────────────
      const createSpinner = ora('Creating ticket...').start();
      const created = await createIssue(fields);
      createSpinner.stop();

      const { baseUrl } = getBaseUrl();
      const url = `${baseUrl}/browse/${created.key}`;

      console.log(chalk.green(`\n✔ Created ${chalk.bold(created.key)}`));
      console.log(chalk.dim(`  ${url}\n`));
      logger.info(`create: ${created.key} (${issueType}) in ${projectKey}`);
    } catch (err) {
      printError(err);
      logger.error(`create failed: ${err.message}`);
      process.exit(1);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert plain text to Atlassian Document Format (ADF).
 * Preserves line breaks as paragraphs.
 */
function buildADF(text) {
  if (!text) return null;
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line.trim()
      ? [{ type: 'text', text: line }]
      : [],
  }));

  return {
    type: 'doc',
    version: 1,
    content: paragraphs.filter((p) => p.content.length > 0 || true),
  };
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

'use strict';

/**
 * create.js
 * `jira create` — Interactively create a Jira issue.
 *
 * Flow:
 *  1. Select issue type
 *  2. Input summary + description
 *  3. Select core fields (priority, story points, due date)
 *  4. Select custom dropdown fields (dynamically built from `jira sync` cache)
 *  5. Select fix versions + components
 *  6. AI enhances summary + description
 *  7. Confirm → create → print key
 *
 * Flags:
 *   --from-git   Generate ticket from recent git commits (AI)
 *   --type       Pre-select issue type (skip prompt)
 *   --dry-run    Show payload without creating
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { autoList } = require('../utils/prompts');
const { createIssue } = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { enhanceTicket, generateFromGit, extractPlainText } = require('../utils/aiHelper');
const { printError } = require('../utils/errorParser');
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
      .option('dry-run', { type: 'boolean', default: false, desc: 'Show payload without creating' })
      .option('all-fields', { type: 'boolean', default: false, desc: 'Prompt for all optional custom fields' }),

  handler: async (argv) => {
    try {
      const projectKey = await resolveProjectKeyInteractive();

      // Load synced data — throws with clear message if jira sync has not been run
      const synced = cache.get(`${projectKey}:fields`);
      requireSyncedData(synced, projectKey);

      // These core fields must always be synced
      const issueTypes = requireSyncedField(synced, 'issueTypes', projectKey, 'Issue Types');

      // Optional fields — silently skip if not present in this project
      const fixVersions   = synced.fixVersions  || [];
      const components    = synced.components   || [];
      const priorities    = synced.priorities   || ['Blocker', 'High', 'Medium', 'Low', 'Minor'];

      // Custom dropdown fields discovered dynamically during `jira sync`
      // Works for any Jira project — no hardcoded field IDs
      const customFields    = synced.customFields    || {};  // { fieldLabel: [values] }
      const customFieldIds  = synced.customFieldIds  || {};  // { fieldLabel: "customfield_XXXXX" }
      const customFieldMeta = synced.customFieldMeta || {};  // { fieldLabel: { type, items, custom } }
      const requiredFields  = synced.requiredFields || {};  // { fieldLabel: { id, type, items, required } }

      console.log(chalk.bold(`\n✨ Create a new ticket in ${chalk.cyan(projectKey)}\n`));

      // ── Step 1: Issue Type ───────────────────────────────────────────────────
      let issueType = argv.type;
      if (!issueType) {
        const ans = await inquirer.prompt([
          autoList('issueType', 'Issue type:', issueTypes),
        ]);
        issueType = ans.issueType;
      }

      // ── Step 2: From Git (AI mode) ───────────────────────────────────────────
      let summary = '';
      let description = '';
      let descriptionProvided = false;

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
        const ans = await inquirer.prompt([
          {
            type: 'editor',
            name: 'description',
            message: 'Description (optional, editor will open):',
            default: '',
          },
        ]);
        description = ans.description;
        descriptionProvided = !!description && description.trim().length > 0;
      }

      // ── Step 4: Core Fields ──────────────────────────────────────────────────
      const coreAnswers = await inquirer.prompt([
        autoList('priority', 'Priority:', priorities),
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

      // ── Step 5: Custom Fields (dynamic — built from jira sync) ───────────────
      // Shows whatever dropdown fields exist in this specific project. Works for
      // any Jira workspace — no hardcoded field IDs.
      const customFieldAnswers = {};  // fieldId → { value: "..." }

      const customFieldEntries = Object.entries(customFields);
      const fieldsToPrompt = argv['all-fields']
        ? customFieldEntries
        : customFieldEntries.filter(([label]) => requiredFields[label]);

      if (fieldsToPrompt.length > 0) {
        const rawCustomAnswers = {};
        const nonArrayPrompts = [];

        for (const [label, values] of fieldsToPrompt) {
          const meta = customFieldMeta[label] || {};
          const isRequired = !!requiredFields[label];
          const isArray = meta.type === 'array';

          if (isArray) {
            const selected = await promptMultiSelectWithFilter(label, values, { required: isRequired });
            if (selected.length > 0) rawCustomAnswers[label] = selected;
          } else {
            nonArrayPrompts.push(
              autoList(
                label,
                `${label}${isRequired ? ' (required)' : ''}:`,
                isRequired ? values : ['(skip)', ...values]
              )
            );
          }
        }

        if (nonArrayPrompts.length > 0) {
          const answers = await inquirer.prompt(nonArrayPrompts);
          Object.assign(rawCustomAnswers, answers);
        }

        // Map label answers back to their Jira field IDs for payload
        Object.entries(rawCustomAnswers).forEach(([label, value]) => {
          const fieldId = customFieldIds[label];
          if (!fieldId) return;

          const meta = customFieldMeta[label] || {};
          const isArray = meta.type === 'array';

          if (isArray) {
            if (Array.isArray(value) && value.length > 0) {
              customFieldAnswers[fieldId] = value.map((v) => ({ value: v }));
            }
            return;
          }

          if (value !== '(skip)') {
            customFieldAnswers[fieldId] = { value };
          }
        });
      }

      // ── Step 5b: Required custom text fields (e.g., Steps to Reproduce) ─────
      const requiredTextFields = Object.entries(requiredFields)
        .filter(([label, meta]) => meta?.id?.startsWith('customfield_'))
        .filter(([label, meta]) => !customFields[label]); // not an option field

      if (requiredTextFields.length > 0) {
        const textPrompts = requiredTextFields.map(([label, meta]) => ({
          type: meta.type === 'string' ? 'input' : 'editor',
          name: label,
          message: `${label} (required):`,
          validate: (v) => (v && v.trim().length > 0) || 'This field is required',
        }));

        const textAnswers = await inquirer.prompt(textPrompts);
        Object.entries(textAnswers).forEach(([label, value]) => {
          const id = requiredFields[label]?.id;
          if (!id || !value || !value.trim()) return;

          const meta = requiredFields[label] || {};
          const needsADF = typeof meta.custom === 'string' && meta.custom.includes('textarea');
          customFieldAnswers[id] = needsADF ? buildADF(value.trim()) : value.trim();
        });
      }

      // ── Step 6: Versions + Components ────────────────────────────────────────
      let selectedVersions = [];
      let selectedComponents = [];

      const fixVersionsRequired =
        !!requiredFields['Fix Versions'] || !!requiredFields['Fix versions'] || !!requiredFields['fixVersions'];

      if (fixVersions.length > 0) {
        selectedVersions = await promptMultiSelectWithFilter('Fix Versions', fixVersions, { required: fixVersionsRequired });
        if (fixVersionsRequired && selectedVersions.length === 0) {
          throw new Error('Fix Versions is required but none were selected. Please choose at least one.');
        }
      }

      const componentsRequired = !!requiredFields.Components;
      if (components.length > 0) {
        selectedComponents = await promptMultiSelectWithFilter('Components', components, { required: componentsRequired });
      } else if (componentsRequired) {
        throw new Error('Components is required but no components are available in sync data. Run `jira sync --force`.');
      }

      // ── Step 7: AI Enhancement ────────────────────────────────────────────────
      const aiSpinner = ora('Enhancing with AI...').start();
      const enhanced = await enhanceTicket({ summary, description, issueType });
      aiSpinner.stop();

      // If user left description blank, keep it blank (don't inject templates)
      if (!descriptionProvided) {
        enhanced.description = '';
      }

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
      // Show any custom fields that were set
      Object.entries(customFieldAnswers).forEach(([fieldId, val]) => {
        // Look up the label for display
        const label = Object.keys(customFieldIds).find((l) => customFieldIds[l] === fieldId) || fieldId;
        const display =
          Array.isArray(val)
            ? val.map((v) => v.value || v.name || v).join(', ')
            : (val && typeof val === 'object' && val.type === 'doc')
              ? extractPlainText(val).slice(0, 80)
              : (val && typeof val === 'object' && val.value) ? val.value : String(val);
        console.log(`  ${chalk.dim(label.slice(0, 10).padEnd(10))} ${display}`);
      });
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
      // Dynamic custom fields from sync — field IDs are project-specific
      Object.assign(fields, customFieldAnswers);
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
    content: paragraphs,
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

/**
 * Multi-select with filter + repeat.
 * Returns array of selected values.
 */
async function promptMultiSelectWithFilter(label, choices, { required = false } = {}) {
  const selected = new Set();
  let addMore = true;

  while (addMore) {
    const { filter } = await inquirer.prompt([
      {
        type: 'input',
        name: 'filter',
        message: `Filter ${label} (type to narrow, blank for all):`,
        default: '',
      },
    ]);

    const query = (filter || '').toLowerCase().trim();
    const filtered = query
      ? choices.filter((v) => v.toLowerCase().includes(query))
      : choices;

    if (filtered.length === 0) {
      console.log(chalk.yellow(`\n  No ${label.toLowerCase()} matched that filter.\n`));
    } else {
      const { picks } = await inquirer.prompt([
        {
          type: 'checkbox',
          name: 'picks',
          message: `${label} (space to select):`,
          choices: filtered.slice(0, 30), // cap for UX
          pageSize: 10,
        },
      ]);
      picks.forEach((v) => selected.add(v));
    }

    const { more } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'more',
        message: `Add more ${label.toLowerCase()}?`,
        default: false,
      },
    ]);
    addMore = more;
  }

  const result = Array.from(selected);
  if (required && result.length === 0) {
    console.log(chalk.yellow(`\n  ${label} is required. Please select at least one.\n`));
    return promptMultiSelectWithFilter(label, choices, { required });
  }
  return result;
}

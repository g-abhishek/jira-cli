'use strict';

/**
 * update.js
 * `jira update <KEY>` — Transition a ticket to a new status.
 *
 * Flow:
 *  1. Fetch current status
 *  2. Fetch available transitions dynamically (only valid next states)
 *  3. Arrow-key select target status
 *  4. Optionally update other fields (priority, story points, assignee)
 *  5. Confirm → transition → show new status
 *
 * Note: Jira transitions are workflow-aware — only valid next states are shown.
 * This prevents invalid status jumps (e.g. To Do → Done skipping In Progress).
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { autoList } = require('../utils/prompts');
const { getIssue, getTransitions, transitionIssue, updateIssue } = require('../services/jiraService');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema } = require('../validators/schema');
const cache = require('../utils/cache');
// requireSyncedField no longer needed — custom fields are now loaded directly from cache
const logger = require('../utils/logger');

module.exports = {
  command: 'update <key>',
  desc: 'Update or transition a Jira ticket',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', desc: 'Issue key (e.g. JCP-1234)' })
      .option('status', { alias: 's', type: 'string', desc: 'Target status (skip prompt)' })
      .option('fields', { type: 'boolean', default: false, desc: 'Also update other fields' }),

  handler: async (argv) => {
    try {
      const key = validate(IssueKeySchema, argv.key);

      // ── Fetch current state + transitions in parallel ──────────────────────
      const spinner = ora(`Loading ${key}...`).start();
      const [issue, transitions] = await Promise.all([
        getIssue(key),
        getTransitions(key),
      ]);
      spinner.stop();

      const f = issue.fields;
      const currentStatus = f.status?.name || 'Unknown';

      // Show current state
      console.log(`\n  ${chalk.bold.cyan(key)} — ${chalk.bold(f.summary?.slice(0, 60))}`);
      console.log(`  Current status: ${chalk.yellow(currentStatus)}\n`);

      if (transitions.length === 0) {
        console.log(chalk.red('  No transitions available for this ticket in its current state.'));
        console.log(chalk.dim('  It may be closed or locked by the workflow.\n'));
        return;
      }

      // ── Select transition ──────────────────────────────────────────────────
      let selectedTransition;

      if (argv.status) {
        // Find transition by name (case-insensitive)
        selectedTransition = transitions.find(
          (t) => t.name.toLowerCase() === argv.status.toLowerCase() ||
                 t.to?.name?.toLowerCase() === argv.status.toLowerCase()
        );
        if (!selectedTransition) {
          console.log(chalk.red(`  Status "${argv.status}" is not a valid transition from "${currentStatus}"`));
          console.log(chalk.dim(`  Available: ${transitions.map((t) => t.to?.name || t.name).join(', ')}`));
          process.exit(1);
        }
      } else {
        // Build transition choices with category color coding
        const choices = transitions.map((t) => {
          const toName = t.to?.name || t.name;
          const category = t.to?.statusCategory?.name || '';
          const color = category === 'Done' ? chalk.green : category === 'In Progress' ? chalk.blue : chalk.gray;
          return {
            name: `${color(toName)}  ${chalk.dim(`(${t.name})`)}`,
            value: t,
            short: toName,
          };
        });

        const ans = await inquirer.prompt([
          autoList('transition', 'Move to:', choices),
        ]);
        selectedTransition = ans.transition;
      }

      // ── Optional field updates ─────────────────────────────────────────────
      const fieldUpdates = {};

      if (argv.fields) {
        const projectKey = f.project?.key;
        const synced = projectKey ? cache.get(`${projectKey}:fields`) : null;
        const customFields    = synced?.customFields   || {};  // fieldLabel → [values]
        const customFieldIds  = synced?.customFieldIds || {};  // fieldLabel → fieldId
        const customFieldMeta = synced?.customFieldMeta || {}; // fieldLabel → { type, items, custom }
        const priorities     = synced?.priorities || ['Blocker', 'High', 'Medium', 'Low', 'Minor'];

        // Core field prompts
        const corePrompts = [
          autoList('_priority', 'Update priority? (current: ' + (f.priority?.name || 'none') + ')', ['(keep)', ...priorities]),
          {
            type: 'number',
            name: '_storyPoints',
            message: `Update story points? (current: ${f.customfield_10026 || 0}, 0 = keep):`,
            default: 0,
          },
        ];

        const arrayFields = [];
        const nonArrayPrompts = [...corePrompts];

        // Append one prompt per synced custom dropdown field
        Object.entries(customFields).forEach(([label, values]) => {
          const meta = customFieldMeta[label] || {};
          const isArray = meta.type === 'array';

          if (isArray) {
            arrayFields.push({ label, values });
            return;
          }

          nonArrayPrompts.push(autoList(`_cf_${label}`, `Update ${label}?`, ['(keep)', ...values]));
        });

        // Comment always last
        const commentPrompt = [{
          type: 'input',
          name: '_comment',
          message: 'Add a comment with this transition? (blank to skip):',
        }];

        const fieldAnswers = await inquirer.prompt([...nonArrayPrompts, ...commentPrompt]);

        // Handle multi-select custom fields with filter + loop
        for (const { label, values } of arrayFields) {
          const selected = await promptMultiSelectWithFilter(`Update ${label}`, values, { allowEmpty: true });
          if (Array.isArray(selected) && selected.length > 0) {
            fieldAnswers[`_cf_${label}`] = selected;
          }
        }

        if (fieldAnswers._priority !== '(keep)') fieldUpdates.priority = { name: fieldAnswers._priority };
        if (fieldAnswers._storyPoints > 0) fieldUpdates.customfield_10026 = fieldAnswers._storyPoints;

        // Apply any custom field updates using their real Jira field IDs
        Object.entries(fieldAnswers).forEach(([key, value]) => {
          if (key.startsWith('_cf_')) {
            const label = key.slice(4); // strip '_cf_'
            const fieldId = customFieldIds[label];
            if (!fieldId) return;

            const meta = customFieldMeta[label] || {};
            const isArray = meta.type === 'array';

            if (isArray) {
              if (Array.isArray(value) && value.length > 0) {
                fieldUpdates[fieldId] = value.map((v) => ({ value: v }));
              }
            } else if (value !== '(keep)') {
              fieldUpdates[fieldId] = { value };
            }
          }
        });

        // Store comment to add after transition
        if (fieldAnswers._comment) fieldUpdates._comment = fieldAnswers._comment;
      }

      // ── Confirm ────────────────────────────────────────────────────────────
      const toStatus = selectedTransition.to?.name || selectedTransition.name;
      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Transition ${chalk.cyan(key)} → ${chalk.bold(toStatus)}?`,
          default: true,
        },
      ]);

      if (!confirmed) {
        console.log(chalk.yellow('\nCancelled.\n'));
        return;
      }

      // ── Execute transition ─────────────────────────────────────────────────
      const execSpinner = ora('Applying transition...').start();

      // Run transition + field updates in parallel where possible
      await transitionIssue(key, selectedTransition.id);

      // Field updates after transition (Jira requires transition first)
      const updateKeys = Object.keys(fieldUpdates).filter((k) => !k.startsWith('_'));
      if (updateKeys.length > 0) {
        const updateFields = {};
        updateKeys.forEach((k) => { updateFields[k] = fieldUpdates[k]; });
        await updateIssue(key, updateFields);
      }

      // Add comment if provided
      if (fieldUpdates._comment) {
        const { addComment } = require('../services/jiraService');
        await addComment(key, fieldUpdates._comment);
      }

      execSpinner.stop();

      console.log(chalk.green(`\n✔ ${key} → ${chalk.bold(toStatus)}\n`));
      logger.info(`update: ${key} transitioned to "${toStatus}"`);
    } catch (err) {
      printError(err);
      logger.error(`update failed: ${err.message}`);
      process.exit(1);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Multi-select with filter + repeat.
 * Returns array of selected values, or [] if user keeps existing.
 */
async function promptMultiSelectWithFilter(label, choices, { allowEmpty = true } = {}) {
  const { shouldUpdate } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'shouldUpdate',
      message: `${label}?`,
      default: false,
    },
  ]);

  if (!shouldUpdate) return [];

  const selected = new Set();
  let addMore = true;

  while (addMore) {
    const { filter } = await inquirer.prompt([
      {
        type: 'input',
        name: 'filter',
        message: `Filter ${label.toLowerCase()} (type to narrow, blank for all):`,
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
  if (!allowEmpty && result.length === 0) {
    console.log(chalk.yellow(`\n  Please select at least one.\n`));
    return promptMultiSelectWithFilter(label, choices, { allowEmpty });
  }
  return result;
}

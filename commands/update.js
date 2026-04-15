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
const { getIssue, getTransitions, transitionIssue, updateIssue } = require('../services/jiraService');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema } = require('../validators/schema');
const cache = require('../utils/cache');
const { requireSyncedField } = require('../utils/requireSync');
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
          {
            type: 'list',
            name: 'transition',
            message: 'Move to:',
            choices,
            pageSize: 15,
          },
        ]);
        selectedTransition = ans.transition;
      }

      // ── Optional field updates ─────────────────────────────────────────────
      const fieldUpdates = {};

      if (argv.fields) {
        const projectKey = f.project?.key;
        const synced = projectKey ? cache.get(`${projectKey}:fields`) : null;
        // Clusters required from sync — if missing, skip that prompt
        const clusters = synced ? requireSyncedField(synced, 'clusters', projectKey, 'JCP Cluster') : null;

        const fieldAnswers = await inquirer.prompt([
          {
            type: 'list',
            name: 'priority',
            message: 'Update priority? (current: ' + (f.priority?.name || 'none') + ')',
            choices: ['(keep)', 'Blocker', 'High', 'Medium', 'Low', 'Minor'],
          },
          {
            type: 'number',
            name: 'storyPoints',
            message: `Update story points? (current: ${f.customfield_10026 || 0}, 0 = keep):`,
            default: 0,
          },
          {
            type: 'list',
            name: 'jcpCluster',
            message: 'Update JCP Cluster?',
            choices: clusters ? ['(keep)', ...clusters] : ['(keep)'],
            when: () => !!clusters,
          },
          {
            type: 'input',
            name: 'comment',
            message: 'Add a comment with this transition? (blank to skip):',
          },
        ]);

        if (fieldAnswers.priority !== '(keep)') fieldUpdates.priority = { name: fieldAnswers.priority };
        if (fieldAnswers.storyPoints > 0) fieldUpdates.customfield_10026 = fieldAnswers.storyPoints;
        if (fieldAnswers.jcpCluster !== '(keep)') fieldUpdates.customfield_11371 = { value: fieldAnswers.jcpCluster };

        // Store comment to add after transition
        if (fieldAnswers.comment) fieldUpdates._comment = fieldAnswers.comment;
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

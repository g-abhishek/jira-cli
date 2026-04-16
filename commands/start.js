'use strict';

/**
 * start.js
 * `jira start <KEY>` — Start working on a ticket.
 *
 * Does two things in one command:
 *  1. Transitions the ticket to "In Progress" (or whichever transition contains "progress")
 *  2. Creates + checks out a git branch: feature/JCP-1234-short-summary
 *
 * This is the "I'm starting this ticket" command for developers.
 */

const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { autoList } = require('../utils/prompts');
const { getIssue, getTransitions, transitionIssue } = require('../services/jiraService');
const { createBranchForIssue, isGitRepo } = require('../utils/gitHelper');
const { printError } = require('../utils/errorParser');
const { validate, IssueKeySchema } = require('../validators/schema');
const logger = require('../utils/logger');

module.exports = {
  command: 'start <key>',
  desc: 'Start a ticket: transition to In Progress + create git branch',
  builder: (yargs) =>
    yargs
      .positional('key', { type: 'string', desc: 'Issue key (e.g. JCP-1234)' })
      .option('no-branch', { type: 'boolean', default: false, desc: 'Skip git branch creation' })
      .option('no-transition', { type: 'boolean', default: false, desc: 'Skip Jira transition' }),

  handler: async (argv) => {
    try {
      const key = validate(IssueKeySchema, argv.key);

      // ── Fetch issue + transitions in parallel ──────────────────────────────
      const spinner = ora(`Loading ${key}...`).start();
      const [issue, transitions] = await Promise.all([
        getIssue(key),
        getTransitions(key),
      ]);
      spinner.stop();

      const f = issue.fields;
      const currentStatus = f.status?.name;
      const summary = f.summary || '';

      console.log(`\n  ${chalk.bold.cyan(key)} — ${summary.slice(0, 60)}`);
      console.log(`  Current status: ${chalk.yellow(currentStatus)}\n`);

      // ── Find "In Progress" transition ──────────────────────────────────────
      let inProgressTransition = null;

      if (!argv['no-transition']) {
        // Look for a transition that leads to an "in progress" state
        inProgressTransition = transitions.find(
          (t) =>
            t.to?.name?.toLowerCase().includes('progress') ||
            t.name?.toLowerCase().includes('progress') ||
            t.to?.name?.toLowerCase().includes('in dev') ||
            t.name?.toLowerCase().includes('start')
        );

        if (!inProgressTransition && transitions.length > 0) {
          // Let user pick from available transitions
          console.log(chalk.yellow('  Could not auto-detect "In Progress" transition.'));
          const ans = await inquirer.prompt([
            autoList('transition', 'Which transition should "start" use?',
              transitions.map((t) => ({
                name: `${t.to?.name || t.name}  ${chalk.dim(`(${t.name})`)}`,
                value: t,
                short: t.to?.name || t.name,
              }))
            ),
          ]);
          inProgressTransition = ans.transition;
        }

        if (!inProgressTransition) {
          console.log(chalk.dim('  No transitions available — skipping Jira status update.'));
        }
      }

      // ── Git branch ────────────────────────────────────────────────────────
      let branchResult = null;
      if (!argv['no-branch']) {
        if (!isGitRepo()) {
          console.log(chalk.dim('  Not in a git repository — skipping branch creation.'));
        } else {
          branchResult = createBranchForIssue(key, summary);
        }
      }

      // ── Confirm ───────────────────────────────────────────────────────────
      console.log(chalk.bold('  What will happen:'));
      if (inProgressTransition) {
        console.log(`  ✓ Transition ${key} → ${chalk.blue(inProgressTransition.to?.name || 'In Progress')}`);
      }
      if (branchResult !== null || (!argv['no-branch'] && isGitRepo())) {
        const branch = branchResult?.branch || `feature/${key}-${summary.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`;
        console.log(`  ✓ Git branch: ${chalk.cyan(branch)}`);
      }

      const { confirmed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmed',
          message: `Start ${key}?`,
          default: true,
        },
      ]);

      if (!confirmed) {
        console.log(chalk.yellow('\nCancelled.\n'));
        return;
      }

      // ── Execute ────────────────────────────────────────────────────────────
      const execSpinner = ora('Starting ticket...').start();

      // 1. Transition Jira ticket
      if (inProgressTransition && !argv['no-transition']) {
        await transitionIssue(key, inProgressTransition.id);
      }

      execSpinner.stop();

      // 2. Create + checkout git branch
      if (!argv['no-branch'] && isGitRepo()) {
        const result = createBranchForIssue(key, summary);
        if (result.success) {
          const existed = result.existed ? chalk.dim(' (already existed, checked out)') : '';
          console.log(chalk.green(`\n  ✔ Switched to branch ${chalk.cyan(result.branch)}${existed}`));
        } else {
          console.log(chalk.yellow(`\n  ⚠  Could not create branch: ${result.error}`));
        }
      }

      if (inProgressTransition && !argv['no-transition']) {
        const toStatus = inProgressTransition.to?.name || 'In Progress';
        console.log(chalk.green(`  ✔ ${key} → ${chalk.bold(toStatus)}`));
      }

      console.log();
      logger.info(`start: ${key} — branch created, transitioned to In Progress`);
    } catch (err) {
      printError(err);
      logger.error(`start failed: ${err.message}`);
      process.exit(1);
    }
  },
};

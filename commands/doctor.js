'use strict';

/**
 * doctor.js
 * `jira doctor` — Health check for the entire CLI setup.
 *
 * Checks:
 *  ✔ Config file exists + credentials present
 *  ✔ JIRA_BASE_URL is a valid URL
 *  ✔ Jira API connectivity + authentication
 *  ✔ Project key exists and is accessible
 *  ✔ OpenAI key validity (if configured)
 *  ✔ Cache status
 *  ✔ Git integration
 *  ✔ Node.js version
 *  ✔ Sync freshness
 */

const chalk = require('chalk');
const ora = require('ora');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { testConnection, getProject } = require('../services/jiraService');
const { detectProviders } = require('../utils/aiProviders');
const { resolveProjectKey } = require('../utils/projectResolver');
const { isGitRepo, getCurrentBranch, getProjectKeyFromBranch } = require('../utils/gitHelper');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const CONFIG_PATH = path.join(os.homedir(), '.jira-cli', 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {};
}

function check(label, passed, detail = '') {
  const icon = passed ? chalk.green('✔') : chalk.red('✖');
  const text = passed ? chalk.white(label) : chalk.red(label);
  const info = detail ? chalk.dim(` — ${detail}`) : '';
  console.log(`  ${icon} ${text}${info}`);
  return passed;
}

function warn(label, detail = '') {
  console.log(`  ${chalk.yellow('⚠')} ${chalk.yellow(label)}${detail ? chalk.dim(` — ${detail}`) : ''}`);
}

module.exports = {
  command: 'doctor',
  desc: 'Run a health check on your Jira CLI setup',
  handler: async () => {
    console.log(chalk.bold('\n🏥 Jira CLI — Health Check\n'));

    let allGood = true;

    // ── 1. Node.js version ────────────────────────────────────────────────────
    const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
    const nodeOk = nodeVersion >= 16;
    check(`Node.js v${process.versions.node}`, nodeOk, nodeOk ? '' : 'Requires Node.js >= 16');
    if (!nodeOk) allGood = false;

    // ── 2. Config file ────────────────────────────────────────────────────────
    const configExists = fs.existsSync(CONFIG_PATH);
    check('Config file', configExists, configExists ? CONFIG_PATH : 'Run `jira config` to create');
    if (!configExists) allGood = false;

    const config = readConfig();

    // ── 3. Required credentials ────────────────────────────────────────────────
    const hasUrl = !!config.JIRA_BASE_URL || !!process.env.JIRA_BASE_URL;
    const hasEmail = !!config.JIRA_EMAIL || !!process.env.JIRA_EMAIL;
    const hasToken = !!config.JIRA_API_TOKEN || !!process.env.JIRA_API_TOKEN;

    check('JIRA_BASE_URL set', hasUrl);
    check('JIRA_EMAIL set', hasEmail);
    check('JIRA_API_TOKEN set', hasToken);

    if (!hasUrl || !hasEmail || !hasToken) allGood = false;

    // ── 4. URL format ─────────────────────────────────────────────────────────
    const url = config.JIRA_BASE_URL || process.env.JIRA_BASE_URL || '';
    if (url) {
      try {
        new URL(url);
        check('JIRA_BASE_URL format', true, url);
      } catch {
        check('JIRA_BASE_URL format', false, 'Invalid URL format');
        allGood = false;
      }
    }

    // ── 5. Jira API connectivity ──────────────────────────────────────────────
    if (hasUrl && hasEmail && hasToken) {
      const connSpinner = ora('  Connecting to Jira...').start();
      const result = await testConnection();
      connSpinner.stop();

      // Overwrite the spinner line
      if (result.ok) {
        check(`Jira API connection`, true, `Logged in as ${result.user}`);
      } else {
        check(`Jira API connection`, false, result.error);
        allGood = false;
      }
    }

    // ── 6. Default project ────────────────────────────────────────────────────
    const projectKey = resolveProjectKey();
    if (projectKey) {
      check('Default project detected', true, projectKey);

      // Verify project is accessible
      const projSpinner = ora(`  Verifying project ${projectKey}...`).start();
      try {
        const project = await getProject(projectKey);
        projSpinner.stop();
        check(`Project ${projectKey} accessible`, true, project.name);
      } catch (e) {
        projSpinner.stop();
        check(`Project ${projectKey} accessible`, false, 'Cannot access project');
        allGood = false;
      }
    } else {
      warn('Default project', 'Not detected. Add a .jira file in your repo root (PROJECT=JCP) or run `jira config`');
    }

    // ── 7. Sync status ────────────────────────────────────────────────────────
    if (projectKey) {
      const meta = cache.getMeta(projectKey);
      if (meta && !meta.isStale) {
        check('Project sync', true, `Last synced: ${meta.lastSynced}`);
      } else if (meta && meta.isStale) {
        warn('Project sync', `Stale (last: ${meta.lastSynced}). Run \`jira sync\``);
      } else {
        warn('Project sync', `Never synced. Run \`jira sync --project ${projectKey}\``);
      }
    }

    // ── 8. AI providers (optional) ────────────────────────────────────────────
    const providers = detectProviders();
    if (providers.length > 0) {
      providers.forEach((p) => {
        const local = p.local ? ' [local]' : ' [cloud]';
        check(`AI provider: ${p.name}${local}`, true, `model: ${p.model}`);
      });
    } else {
      warn('AI providers', 'Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set — AI features disabled (optional)');
    }

    // ── 9. Git integration ────────────────────────────────────────────────────
    const inGit = isGitRepo();
    if (inGit) {
      const branch = getCurrentBranch();
      const detectedProject = getProjectKeyFromBranch();
      check('Git repository', true, `Branch: ${branch}`);
      if (detectedProject) {
        check('Project from branch', true, `Detected project: ${detectedProject}`);
      } else {
        warn('Project from branch', 'No Jira key in branch name');
      }
    } else {
      warn('Git repository', 'Not inside a git repo (some features limited)');
    }

    // ── 10. Log file ──────────────────────────────────────────────────────────
    const logDir = path.join(os.homedir(), '.jira-cli', 'logs');
    const logExists = fs.existsSync(logDir);
    check('Log directory', logExists, logExists ? logDir : 'Will be created on first use');

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + chalk.bold('─'.repeat(45)));
    if (allGood) {
      console.log(chalk.green.bold('  ✔ Everything looks good! Your CLI is ready.\n'));
    } else {
      console.log(chalk.yellow.bold('  ⚠  Some checks failed. See details above.\n'));
      console.log(chalk.dim('  Quick fix: run `jira config` to set up credentials.\n'));
    }

    logger.info(`doctor: ran health check (${allGood ? 'all passed' : 'some failures'})`);
  },
};

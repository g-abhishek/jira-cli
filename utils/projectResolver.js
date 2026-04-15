'use strict';

/**
 * projectResolver.js
 * Resolves the current Jira project key using a priority chain:
 *   1. Git branch name (e.g. feature/JCP-1234 → JCP)
 *   2. .jira file in current or parent directory
 *   3. ~/.jira-cli/config.json DEFAULT_PROJECT
 *   4. JIRA_DEFAULT_PROJECT env var
 *   5. Prompt user if none found, offer to save
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { getProjectKeyFromBranch } = require('./gitHelper');

const CONFIG_PATH = path.join(os.homedir(), '.jira-cli', 'config.json');

/**
 * Walk up directory tree to find a .jira file.
 * .jira file format: PROJECT=JCP
 */
function findJiraFileProject() {
  let dir = process.cwd();
  const root = path.parse(dir).root;

  while (dir !== root) {
    const jiraFile = path.join(dir, '.jira');
    if (fs.existsSync(jiraFile)) {
      try {
        const content = fs.readFileSync(jiraFile, 'utf8');
        const match = content.match(/PROJECT\s*=\s*([A-Z0-9]+)/i);
        if (match) return match[1].toUpperCase();
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read default project from ~/.jira-cli/config.json
 */
function getConfigProject() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return config.DEFAULT_PROJECT || null;
    }
  } catch {}
  return null;
}

/**
 * Resolve project key using the priority chain (non-interactive).
 * Returns null if not found.
 */
function resolveProjectKey() {
  // 1. Git branch
  const branchKey = getProjectKeyFromBranch();
  if (branchKey) return branchKey;

  // 2. .jira file
  const fileKey = findJiraFileProject();
  if (fileKey) return fileKey;

  // 3. ~/.jira-cli/config.json
  const configKey = getConfigProject();
  if (configKey) return configKey;

  // 4. Env var
  const envKey = process.env.DEFAULT_PROJECT;
  if (envKey) return envKey;

  return null;
}

/**
 * Resolve project key interactively.
 * Prompts user if nothing found, offers to save for future.
 * @returns {Promise<string>}
 */
async function resolveProjectKeyInteractive() {
  const key = resolveProjectKey();
  if (key) return key;

  const inquirer = require('inquirer');
  const chalk = require('chalk');

  console.log(chalk.yellow('\n⚠  Could not auto-detect your Jira project key.'));
  console.log(chalk.dim('  Tip: Add a .jira file in your repo root with PROJECT=JCP\n'));

  const { projectKey } = await inquirer.prompt([
    {
      type: 'input',
      name: 'projectKey',
      message: 'Enter your Jira project key (e.g. JCP):',
      validate: (v) => /^[A-Z0-9]+$/i.test(v.trim()) || 'Invalid project key format',
      filter: (v) => v.trim().toUpperCase(),
    },
  ]);

  const { saveIt } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'saveIt',
      message: `Save "${projectKey}" as your default project?`,
      default: true,
    },
  ]);

  if (saveIt) {
    try {
      const configDir = path.join(os.homedir(), '.jira-cli');
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

      let config = {};
      if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      }
      config.DEFAULT_PROJECT = projectKey;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log(chalk.green(`✔ Saved to ~/.jira-cli/config.json`));
    } catch {
      console.log(chalk.yellow('Could not save config, but continuing.'));
    }
  }

  return projectKey;
}

module.exports = { resolveProjectKey, resolveProjectKeyInteractive };

'use strict';

/**
 * gitHelper.js
 * Git integration utilities:
 * - Extract Jira project key from current branch name
 * - Extract issue key from branch (e.g. feature/JCP-1234-fix → JCP-1234)
 * - Get recent commit messages for AI ticket generation
 * - Create and checkout a new branch from an issue key
 */

const { execSync } = require('child_process');

/**
 * Run a git command safely. Returns output or null on failure.
 */
function git(cmd) {
  try {
    return execSync(`git ${cmd}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if we're inside a git repository.
 */
function isGitRepo() {
  return git('rev-parse --is-inside-work-tree') === 'true';
}

/**
 * Get current branch name.
 */
function getCurrentBranch() {
  return git('rev-parse --abbrev-ref HEAD');
}

/**
 * Extract Jira project key from branch name.
 * Handles patterns: JCP-1234, feature/JCP-1234, feat/JCP-1234-description
 * Returns project key like "JCP" or null.
 */
function getProjectKeyFromBranch() {
  const branch = getCurrentBranch();
  if (!branch) return null;

  // Match PROJECT-NUMBER pattern (e.g. JCP-1234)
  const match = branch.match(/([A-Z][A-Z0-9]+)-\d+/i);
  if (match) return match[1].toUpperCase();
  return null;
}

/**
 * Extract full issue key from branch name.
 * e.g. feature/JCP-1234-fix-login → JCP-1234
 */
function getIssueKeyFromBranch() {
  const branch = getCurrentBranch();
  if (!branch) return null;

  const match = branch.match(/([A-Z][A-Z0-9]+-\d+)/i);
  if (match) return match[1].toUpperCase();
  return null;
}

/**
 * Get the last N commit messages (for AI ticket generation).
 * @param {number} count - Number of commits to fetch
 * @returns {string|null}
 */
function getRecentCommits(count = 5) {
  return git(`log --oneline -${count}`);
}

/**
 * Get the diff of the last commit (for AI ticket generation from code change).
 * @returns {string|null}
 */
function getLastCommitDiff() {
  return git('diff HEAD~1 HEAD --stat');
}

/**
 * Create and checkout a new branch for a Jira issue.
 * Branch name format: feature/JCP-1234-short-summary
 * @param {string} issueKey - e.g. JCP-1234
 * @param {string} summary - Issue summary (will be slugified)
 * @returns {{ success: boolean, branch: string, error: string }}
 */
function createBranchForIssue(issueKey, summary) {
  if (!isGitRepo()) {
    return { success: false, error: 'Not inside a git repository.' };
  }

  // Slugify summary: lowercase, replace spaces/special chars with dashes, limit length
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '');

  const branchName = `feature/${issueKey}-${slug}`;

  try {
    execSync(`git checkout -b ${branchName}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { success: true, branch: branchName };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message;

    // Branch might already exist
    if (stderr.includes('already exists')) {
      try {
        execSync(`git checkout ${branchName}`, { stdio: 'pipe' });
        return { success: true, branch: branchName, existed: true };
      } catch {
        return { success: false, error: `Branch ${branchName} exists but could not be checked out.` };
      }
    }
    return { success: false, error: stderr };
  }
}

module.exports = {
  isGitRepo,
  getCurrentBranch,
  getProjectKeyFromBranch,
  getIssueKeyFromBranch,
  getRecentCommits,
  getLastCommitDiff,
  createBranchForIssue,
};

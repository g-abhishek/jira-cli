'use strict';

/**
 * requireSync.js
 * Enforces that `jira sync` has been run before any command
 * that depends on project metadata (dropdown values, versions, etc.)
 *
 * If sync data is missing → throw a clear, actionable error.
 * If sync data is stale   → warn but continue (data may still be valid).
 *
 * Usage:
 *   const { requireSyncedField, requireSyncedData } = require('../utils/requireSync');
 *   const clusters = requireSyncedField(synced, 'clusters', projectKey);
 */

const chalk = require('chalk');

/**
 * Assert that sync data exists at all.
 * Throws if `jira sync` has never been run for this project.
 *
 * @param {object|null} synced - Result of cache.get(`${projectKey}:fields`)
 * @param {string} projectKey
 */
function requireSyncedData(synced, projectKey) {
  if (!synced || Object.keys(synced).length === 0) {
    throw new Error(
      `No sync data found for project ${chalk.cyan(projectKey)}.\n` +
      `  Run ${chalk.bold(`jira sync --project ${projectKey}`)} first, then retry.\n` +
      `  Sync fetches all dropdown options, versions, and components from Jira.`
    );
  }
}

/**
 * Get a specific field from synced cache data.
 * Throws with a clear message if the field is missing or empty.
 *
 * @param {object} synced   - Synced cache object
 * @param {string} field    - Field name (e.g. 'clusters', 'fixVersions')
 * @param {string} projectKey
 * @param {string} [label]  - Human-readable label for the error message
 * @returns {Array} The field values
 */
function requireSyncedField(synced, field, projectKey, label) {
  requireSyncedData(synced, projectKey);

  const value = synced[field];
  const displayLabel = label || field;

  if (!value || (Array.isArray(value) && value.length === 0)) {
    throw new Error(
      `Sync data for "${chalk.yellow(displayLabel)}" is missing or empty in project ${chalk.cyan(projectKey)}.\n` +
      `  Run ${chalk.bold(`jira sync --force --project ${projectKey}`)} to refresh all field options.\n` +
      `  If this keeps failing, the field may not exist in this project.`
    );
  }

  return value;
}

/**
 * Warn (not throw) if sync data is stale.
 * Used for non-critical fields where showing potentially outdated data
 * is better than blocking the user entirely.
 *
 * @param {object} synced
 * @param {string} field
 * @param {string} projectKey
 * @param {string} [label]
 * @returns {Array|null} The field values or null if missing
 */
function warnIfStaleSyncedField(synced, field, projectKey, label) {
  const displayLabel = label || field;
  const value = synced?.[field];

  if (!value || (Array.isArray(value) && value.length === 0)) {
    console.log(
      chalk.yellow(`  ⚠  "${displayLabel}" not in sync cache.`) +
      chalk.dim(` Run jira sync --force to refresh.`)
    );
    return null;
  }

  return value;
}

module.exports = { requireSyncedData, requireSyncedField, warnIfStaleSyncedField };

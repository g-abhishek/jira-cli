'use strict';

/**
 * errorParser.js
 * Converts Jira API error envelopes and axios errors into clean human-readable messages.
 * Jira errors look like: { errorMessages: [], errors: { field: "message" } }
 */

const chalk = require('chalk');

/**
 * Parse a Jira/axios error into a user-friendly string.
 * @param {Error} err - Axios error or generic error
 * @returns {string} Clean error message
 */
function parseError(err) {
  // Network / timeout errors
  if (!err.response) {
    if (err.code === 'ECONNREFUSED') return 'Cannot connect to Jira. Check your JIRA_BASE_URL.';
    if (err.code === 'ENOTFOUND') return 'DNS lookup failed. Check your JIRA_BASE_URL or internet connection.';
    if (err.code === 'ETIMEDOUT') return 'Request timed out. Jira might be slow or unreachable.';
    return `Network error: ${err.message}`;
  }

  const status = err.response.status;
  const data = err.response.data;

  // Auth errors
  if (status === 401) return 'Authentication failed. Check your JIRA_EMAIL and JIRA_API_TOKEN.';
  if (status === 403) return 'Permission denied. Your account lacks access to this resource.';
  if (status === 404) return 'Not found. The issue key, project, or endpoint does not exist.';
  if (status === 429) return 'Rate limited by Jira. Please wait a moment and try again.';

  // Jira validation errors
  if (data && data.errors && Object.keys(data.errors).length > 0) {
    const fieldErrors = Object.entries(data.errors)
      .map(([field, msg]) => `  → ${chalk.yellow(field)}: ${msg}`)
      .join('\n');
    return `Jira rejected the request:\n${fieldErrors}`;
  }

  // Jira message errors
  if (data && data.errorMessages && data.errorMessages.length > 0) {
    return data.errorMessages.join('\n');
  }

  // Generic HTTP error
  if (data && data.message) return data.message;

  return `Jira API error (HTTP ${status})`;
}

/**
 * Log a clean error to console (with emoji prefix).
 */
function printError(err) {
  const msg = parseError(err);
  console.error(chalk.red('✖ Error:'), msg);
}

module.exports = { parseError, printError };

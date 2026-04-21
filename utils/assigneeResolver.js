'use strict';

/**
 * assigneeResolver.js
 * Resolve assignee input via local memory + Jira user search.
 */

const inquirer = require('inquirer');
const { searchUsers } = require('../services/jiraService');
const { findMatches, upsertEntry } = require('./assigneeMemory');

async function resolveAssignee(input, projectKey) {
  const query = String(input || '').trim();
  if (!query) return null;

  // 1) Local memory
  const matches = findMatches(query);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const ans = await inquirer.prompt([
      {
        type: 'list',
        name: 'pick',
        message: 'Multiple matches found in memory. Which one?',
        choices: matches.map((m) => ({
          name: `${m.displayName}${m.email ? ' <' + m.email + '>' : ''}`,
          value: m,
        })),
      },
    ]);
    return ans.pick;
  }

  // 2) Jira search by query/email
  const results = await searchUsers(query, projectKey);
  let picked = null;

  if (results.length === 1) {
    picked = results[0];
  } else if (results.length > 1) {
    const ans = await inquirer.prompt([
      {
        type: 'list',
        name: 'pick',
        message: 'Multiple Jira users found. Which one?',
        choices: results.map((u) => ({
          name: `${u.displayName}${u.emailAddress ? ' <' + u.emailAddress + '>' : ''}`,
          value: u,
        })),
      },
    ]);
    picked = ans.pick;
  } else {
    const { email } = await inquirer.prompt([
      {
        type: 'input',
        name: 'email',
        message: `No user found for "${query}". Enter email to search:`,
      },
    ]);
    if (email && email.trim()) {
      const emailResults = await searchUsers(email.trim(), projectKey);
      if (emailResults.length === 1) {
        picked = emailResults[0];
      } else if (emailResults.length > 1) {
        const ans = await inquirer.prompt([
          {
            type: 'list',
            name: 'pick',
            message: 'Multiple Jira users found for that email. Which one?',
            choices: emailResults.map((u) => ({
              name: `${u.displayName}${u.emailAddress ? ' <' + u.emailAddress + '>' : ''}`,
              value: u,
            })),
          },
        ]);
        picked = ans.pick;
      }
    }
  }

  if (!picked) return null;

  const entry = {
    displayName: picked.displayName,
    accountId: picked.accountId,
    email: picked.emailAddress || null,
  };
  upsertEntry({ ...entry, alias: query });
  return entry;
}

/**
 * Replace assignee = "Name" or assignee = name in JQL with accountId if resolvable.
 * Only handles simple equality to avoid breaking complex JQL.
 */
async function replaceAssigneeInJql(jql, projectKey) {
  if (!jql || typeof jql !== 'string') return jql;

  const quoted = jql.match(/assignee\s*=\s*"([^"]+)"/i);
  const unquoted = jql.match(/assignee\s*=\s*([A-Za-z0-9._-]+)/i);
  const match = quoted || unquoted;
  if (!match) return jql;

  const name = quoted ? quoted[1] : unquoted[1];
  if (!name || /currentUser\(\)/i.test(name)) return jql;

  const resolved = await resolveAssignee(name, projectKey);
  if (!resolved?.accountId) return jql;

  return jql.replace(match[0], `assignee = "${resolved.accountId}"`);
}

module.exports = { resolveAssignee, replaceAssigneeInJql };

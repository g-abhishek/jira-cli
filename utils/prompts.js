'use strict';

/**
 * prompts.js
 * Shared prompt helpers for consistent UX across all commands.
 *
 * autoList() — drop-in replacement for inquirer `type: 'list'` that adds
 * live search/filtering via inquirer-autocomplete-prompt.
 *
 * Usage:
 *   const { autoList } = require('../utils/prompts');
 *   const ans = await inquirer.prompt([ autoList('name', 'Priority:', priorities) ]);
 *
 * Features:
 *   - Type to filter instantly — no mode-switching needed
 *   - Arrow keys still work as normal
 *   - Special items like (keep) and (skip) are always pinned at the top
 *     regardless of what the user types, so they can always skip a field
 *   - Works with plain string arrays and { name, value, short } objects
 */

const inquirer = require('inquirer');
const autocompletePrompt = require('inquirer-autocomplete-prompt');

// Register once — safe to call multiple times (inquirer ignores re-registration)
inquirer.registerPrompt('autocomplete', autocompletePrompt);

/**
 * Build an autocomplete prompt config.
 *
 * @param {string} name       - inquirer answer key
 * @param {string} message    - prompt label shown to user
 * @param {Array}  choices    - string[] or { name, value, short }[]
 * @param {Object} [opts]
 * @param {number} [opts.pageSize=15]  - visible rows
 * @returns {Object} inquirer prompt config
 */
function autoList(name, message, choices, opts = {}) {
  // Normalise to { name, value, short } objects for consistent handling
  const normalised = choices.map((c) =>
    typeof c === 'string'
      ? { name: c, value: c, short: c }
      : { name: c.name, value: c.value, short: c.short || c.name }
  );

  // Items whose display name starts with '(' are pinned — e.g. (keep), (skip)
  const pinned = normalised.filter((c) => /^\(/.test(c.short || c.name || ''));
  const rest   = normalised.filter((c) => !/^\(/.test(c.short || c.name || ''));

  return {
    type: 'autocomplete',
    name,
    message,
    pageSize: opts.pageSize || 15,
    source: (_, input) => {
      const q = (input || '').toLowerCase().trim();
      if (!q) return Promise.resolve(normalised);

      const filtered = rest.filter((c) => {
        const plain = (c.short || c.name || '').toLowerCase();
        return plain.includes(q);
      });

      // Always show pinned items first so user can always skip a field
      return Promise.resolve([...pinned, ...filtered]);
    },
  };
}

module.exports = { autoList };

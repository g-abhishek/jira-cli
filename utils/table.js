'use strict';

/**
 * table.js
 * Reusable terminal table renderer with ANSI-safe column alignment.
 *
 * Handles chalk colors correctly: strips ANSI escape codes when
 * calculating visible width so padding/truncation stays accurate.
 *
 * Usage:
 *   const { printTable } = require('./table');
 *   printTable({ columns, rows, indent });
 *
 * Column definition:
 *   { key, header, width, align, render }
 *   - width: number of chars, or 'fill' to consume remaining terminal width
 *   - align: 'left' (default) | 'right'
 *   - render: optional fn(plainValue) → colored string, applied after truncation
 */

const chalk = require('chalk');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip ANSI escape codes to get visible character count. */
function visibleLen(str) {
  return String(str).replace(/\u001b\[[0-9;]*m/g, '').replace(/[^\x00-\x7E]/g, '  ').length;
}

/** Pad a string (may contain ANSI) to a given visible width. */
function padEnd(str, width) {
  const pad = Math.max(0, width - visibleLen(str));
  return str + ' '.repeat(pad);
}

/** Truncate plain text to width, appending ellipsis if cut. */
function truncate(str, width) {
  if (!str) return '';
  str = String(str);
  if (str.length <= width) return str;
  return str.slice(0, width - 1) + '…';
}

/** Right-pad a number/string to given width, right-aligned. */
function padStart(str, width) {
  str = String(str);
  const pad = Math.max(0, width - visibleLen(str));
  return ' '.repeat(pad) + str;
}

// ── Main renderer ─────────────────────────────────────────────────────────────

/**
 * Print a table to stdout.
 *
 * @param {object} opts
 * @param {Array}  opts.columns  Column definitions
 * @param {Array}  opts.rows     Data rows (plain objects)
 * @param {string} [opts.indent] Left indent string (default: '  ')
 */
function printTable({ columns, rows, indent = '  ' }) {
  const termWidth = process.stdout.columns || 120;

  // Resolve 'fill' column width — takes all space not used by fixed columns
  const fixedTotal = columns
    .filter((c) => c.width !== 'fill')
    .reduce((sum, c) => sum + (c.width || 10) + 2, 0); // +2 gap between columns
  const fillWidth = Math.max(20, termWidth - fixedTotal - indent.length - 2);

  const resolved = columns.map((c) => ({
    ...c,
    w: c.width === 'fill' ? fillWidth : (c.width || 10),
  }));

  // ── Header ──────────────────────────────────────────────────────────────────
  const headerLine = resolved
    .map((c) => {
      const h = c.align === 'right'
        ? padStart(c.header.toUpperCase(), c.w)
        : padEnd(c.header.toUpperCase(), c.w);
      return chalk.bold.white(h);
    })
    .join(chalk.dim('  '));
  console.log(indent + headerLine);

  // ── Separator ────────────────────────────────────────────────────────────────
  const sepLine = resolved
    .map((c) => chalk.dim('─'.repeat(c.w)))
    .join(chalk.dim('  '));
  console.log(indent + sepLine);

  // ── Data rows ────────────────────────────────────────────────────────────────
  rows.forEach((row) => {
    const cells = resolved.map((c) => {
      // 1. Get raw value
      let val = row[c.key] != null ? String(row[c.key]) : '';

      // 2. Truncate based on plain-text length
      val = truncate(val, c.w);

      // 3. Apply color/render function
      if (c.render) val = c.render(val, row);

      // 4. Pad to column width (ANSI-safe)
      if (c.align === 'right') {
        val = padStart(val, c.w);
      } else {
        val = padEnd(val, c.w);
      }

      return val;
    });

    console.log(indent + cells.join('  '));
  });
}

module.exports = { printTable, truncate, padEnd, padStart, visibleLen };

'use strict';

/**
 * terminalLink.js
 * OSC-8 hyperlinks for terminals that support them.
 *
 * Falls back to plain text when unsupported to avoid showing escape codes.
 */

function supportsHyperlinks() {
  if (process.env.FORCE_HYPERLINK === '1') return true;
  if (process.env.NO_HYPERLINK === '1') return false;
  if (!process.stdout.isTTY) return false;

  // Conservative allowlist of terminals known to support OSC-8 links.
  return Boolean(
    process.env.TERM_PROGRAM || // iTerm2, Apple Terminal, VS Code, etc.
    process.env.VTE_VERSION ||  // GNOME Terminal, etc.
    process.env.WT_SESSION ||   // Windows Terminal
    process.env.KONSOLE_VERSION ||
    process.env.LC_TERMINAL
  );
}

function osc8(url, text) {
  const safeUrl = String(url || '').replace(/\u001b/g, '');
  // Allow ANSI styling codes in visible text (chalk), but never in the URL.
  const visibleText = String(text || '');
  // Prefer ST (ESC \) as terminator; some terminals ignore BEL-terminated OSC-8.
  const ST = '\u001b\\';
  return `\u001b]8;;${safeUrl}${ST}${visibleText}\u001b]8;;${ST}`;
}

/**
 * Build a clickable link if supported.
 * @param {string} text - Visible link text
 * @param {string} url  - Target URL
 */
function terminalLink(text, url) {
  const t = String(text || '');
  if (!url) return t;
  if (!supportsHyperlinks()) return t || String(url);
  return osc8(url, t || url);
}

module.exports = { terminalLink, supportsHyperlinks };

'use strict';

/**
 * logger.js
 * Winston-based structured logger.
 * Writes human-readable logs to console and rotating files under ~/.jira-cli/logs/
 */

const winston = require('winston');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Ensure log directory exists
const LOG_DIR = path.join(os.homedir(), '.jira-cli', 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_FILE = path.join(LOG_DIR, 'jira-cli.log');
const level = process.env.LOG_LEVEL || 'info';

// Custom format for console: only show message, no timestamps/levels
const consoleFormat = winston.format.printf(({ message }) => message);

const logger = winston.createLogger({
  level,
  transports: [
    // File transport: structured JSON for debugging
    new winston.transports.File({
      filename: LOG_FILE,
      maxsize: 1024 * 1024 * 5, // 5MB
      maxFiles: 3,
      tailable: true,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
    }),
  ],
});

// Silent console unless LOG_LEVEL=debug explicitly set
if (level === 'debug') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        consoleFormat
      ),
    })
  );
}

/**
 * Tail the last N lines of the log file
 * Used by `jira logs` command
 */
logger.tail = function (lines = 50) {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const allLines = content.trim().split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return 'No log file found. Run a command first.';
  }
};

module.exports = logger;

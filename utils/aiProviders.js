'use strict';

/**
 * aiProviders.js
 * Manages three supported AI providers.
 *
 * Auto-detection priority:
 *   1. User's preferred provider in config (AI_PROVIDER = 'claude-code' | 'claude' | 'openai')
 *   2. Claude Code CLI — if `claude` binary is in PATH (no API key needed)
 *   3. Anthropic Claude — if ANTHROPIC_API_KEY is set
 *   4. OpenAI — if OPENAI_API_KEY is set
 *   5. None — AI features disabled, CLI still fully works
 *
 * Unified interface: provider.chat(systemPrompt, userPrompt, options) → string
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const logger = require('./logger');

const CONFIG_PATH = path.join(os.homedir(), '.jira-cli', 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {};
}

// ── Provider: Claude Code CLI (local, no API key) ─────────────────────────────

/**
 * Check whether the `claude` CLI binary is available in PATH.
 */
function isClaudeCodeAvailable() {
  try {
    const result = spawnSync('claude', ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Create a provider that delegates to the local `claude` CLI.
 * Uses `claude -p "<prompt>"` (print / non-interactive mode).
 * No API key required — uses Claude Code's own auth.
 */
function createClaudeCodeProvider() {
  return {
    name: 'Claude Code (local)',
    type: 'claude-code',
    model: 'claude (local CLI)',
    local: true,

    async chat(systemPrompt, userPrompt /*, options */) {
      // Combine system + user prompts into one message for the CLI
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const result = spawnSync('claude', ['-p', fullPrompt], {
        timeout: 60000,       // 60s — model can take a moment
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: 'pipe',
      });

      if (result.error) {
        throw new Error(`claude CLI error: ${result.error.message}`);
      }
      if (result.status !== 0) {
        const stderr = (result.stderr || '').trim();
        throw new Error(`claude CLI exited with code ${result.status}${stderr ? ': ' + stderr : ''}`);
      }

      const output = (result.stdout || '').trim();
      if (!output) throw new Error('claude CLI returned empty response');
      return output;
    },
  };
}

// ── Provider: Anthropic Claude API ────────────────────────────────────────────

function createClaudeProvider(apiKey, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });
  const resolvedModel = model || 'claude-haiku-4-5-20251001';

  return {
    name: 'Anthropic Claude',
    type: 'claude',
    model: resolvedModel,
    local: false,

    async chat(systemPrompt, userPrompt, options = {}) {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: options.maxTokens ?? 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      return response.content[0]?.text?.trim() || '';
    },
  };
}

// ── Provider: OpenAI / Codex ──────────────────────────────────────────────────

function createOpenAIProvider(apiKey, model) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey });
  const resolvedModel = model || 'gpt-4o-mini';

  return {
    name: 'OpenAI (Codex)',
    type: 'openai',
    model: resolvedModel,
    local: false,

    async chat(systemPrompt, userPrompt, options = {}) {
      const response = await client.chat.completions.create({
        model: resolvedModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 800,
        ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      });
      return response.choices[0]?.message?.content?.trim() || '';
    },
  };
}

// ── Detect available providers ─────────────────────────────────────────────────

/**
 * Detect which providers are available on this machine.
 * Returns an array ordered by auto-detection priority.
 */
function detectProviders() {
  const config = readConfig();
  const available = [];

  // 1. Claude Code CLI (local — no API key needed)
  if (isClaudeCodeAvailable()) {
    available.push({
      name: 'Claude Code (local)',
      type: 'claude-code',
      model: 'claude (local CLI)',
      local: true,
      available: true,
    });
  }

  // 2. Anthropic Claude API
  const anthropicKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      available.push({
        name: 'Anthropic Claude',
        type: 'claude',
        model: config.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        local: false,
        available: true,
      });
    } catch {
      // SDK not installed — skip
    }
  }

  // 3. OpenAI / Codex
  const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    available.push({
      name: 'OpenAI (Codex)',
      type: 'openai',
      model: config.OPENAI_MODEL || 'gpt-4o-mini',
      local: false,
      available: true,
    });
  }

  return available;
}

// ── Get active provider ────────────────────────────────────────────────────────

/**
 * Get the active AI provider based on config + availability.
 * Priority: preferred config → Claude Code CLI → Anthropic → OpenAI → null
 */
function getProvider() {
  const config = readConfig();
  const preferred = config.AI_PROVIDER; // 'claude-code' | 'claude' | 'openai'

  const anthropicKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const openaiKey    = config.OPENAI_API_KEY    || process.env.OPENAI_API_KEY;

  // ── Honour explicit preference ─────────────────────────────────────────────
  if (preferred === 'claude-code') {
    if (isClaudeCodeAvailable()) {
      logger.debug('AI provider: Claude Code CLI (preferred)');
      return createClaudeCodeProvider();
    }
    logger.warn('AI_PROVIDER=claude-code but `claude` binary not found in PATH');
  }

  if (preferred === 'claude' && anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      logger.debug('AI provider: Anthropic Claude (preferred)');
      return createClaudeProvider(anthropicKey, config.ANTHROPIC_MODEL);
    } catch {
      logger.warn('ANTHROPIC_API_KEY set but @anthropic-ai/sdk not installed');
    }
  }

  if (preferred === 'openai' && openaiKey) {
    logger.debug('AI provider: OpenAI (preferred)');
    return createOpenAIProvider(openaiKey, config.OPENAI_MODEL);
  }

  // ── Auto-detect ────────────────────────────────────────────────────────────
  // Claude Code first — no API key needed, works out of the box
  if (isClaudeCodeAvailable()) {
    logger.debug('AI provider: Claude Code CLI (auto-detected)');
    return createClaudeCodeProvider();
  }

  if (anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      logger.debug('AI provider: Anthropic Claude (auto-detected)');
      return createClaudeProvider(anthropicKey, config.ANTHROPIC_MODEL);
    } catch {
      // SDK not installed, fall through
    }
  }

  if (openaiKey) {
    logger.debug('AI provider: OpenAI (auto-detected)');
    return createOpenAIProvider(openaiKey, config.OPENAI_MODEL);
  }

  logger.debug('No AI provider available');
  return null;
}

module.exports = { getProvider, detectProviders, isClaudeCodeAvailable };

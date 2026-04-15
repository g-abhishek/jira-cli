'use strict';

/**
 * aiProviders.js
 * Manages two supported AI providers: Anthropic Claude and OpenAI (Codex).
 *
 * Auto-detection priority:
 *   1. User's preferred provider in config (AI_PROVIDER = 'claude' | 'openai')
 *   2. Claude  — if ANTHROPIC_API_KEY is set
 *   3. OpenAI  — if OPENAI_API_KEY is set
 *   4. None    — AI features disabled, CLI still fully works
 *
 * Unified interface: provider.chat(systemPrompt, userPrompt, options) → string
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const CONFIG_PATH = path.join(os.homedir(), '.jira-cli', 'config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  return {};
}

// ── Provider: Anthropic Claude ────────────────────────────────────────────────

function createClaudeProvider(apiKey, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });
  const resolvedModel = model || 'claude-haiku-4-5-20251001';

  return {
    name: 'Anthropic Claude',
    type: 'claude',
    model: resolvedModel,

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

// ── Detect available providers ────────────────────────────────────────────────

/**
 * Detect which providers are configured on this machine.
 * Returns an array ordered by preference.
 *
 * @returns {Array<{ name, type, model, available }>}
 */
function detectProviders() {
  const config = readConfig();
  const available = [];

  // Check Claude
  const anthropicKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      available.push({
        name: 'Anthropic Claude',
        type: 'claude',
        model: config.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
        available: true,
      });
    } catch {
      // SDK not installed — silently skip
    }
  }

  // Check OpenAI / Codex
  const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    available.push({
      name: 'OpenAI (Codex)',
      type: 'openai',
      model: config.OPENAI_MODEL || 'gpt-4o-mini',
      available: true,
    });
  }

  return available;
}

// ── Get active provider ────────────────────────────────────────────────────────

/**
 * Get the active AI provider client based on config + availability.
 * Returns null if neither is configured.
 *
 * @returns {object|null}
 */
function getProvider() {
  const config = readConfig();
  const preferred = config.AI_PROVIDER; // 'claude' | 'openai'

  const anthropicKey = config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  // If user has set a preferred provider, try that first
  if (preferred === 'claude' && anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      logger.debug('AI provider: Anthropic Claude');
      return createClaudeProvider(anthropicKey, config.ANTHROPIC_MODEL);
    } catch {
      logger.warn('ANTHROPIC_API_KEY set but @anthropic-ai/sdk not installed. Run: npm install -g @anthropic-ai/sdk');
    }
  }

  if (preferred === 'openai' && openaiKey) {
    logger.debug('AI provider: OpenAI (Codex)');
    return createOpenAIProvider(openaiKey, config.OPENAI_MODEL);
  }

  // Auto-detect: Claude first, then OpenAI
  if (anthropicKey) {
    try {
      require('@anthropic-ai/sdk');
      logger.debug('AI provider: Anthropic Claude (auto-detected)');
      return createClaudeProvider(anthropicKey, config.ANTHROPIC_MODEL);
    } catch {
      // SDK not installed, fall through to OpenAI
    }
  }

  if (openaiKey) {
    logger.debug('AI provider: OpenAI (auto-detected)');
    return createOpenAIProvider(openaiKey, config.OPENAI_MODEL);
  }

  logger.debug('No AI provider configured');
  return null;
}

module.exports = { getProvider, detectProviders };

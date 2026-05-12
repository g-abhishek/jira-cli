'use strict';

/**
 * aiHelper.js
 * AI-powered enhancements for the Jira CLI.
 *
 * Uses aiProviders.js to auto-detect the best available provider:
 *   Ollama (local) → LM Studio (local) → Anthropic Claude → OpenAI → None
 *
 * All functions degrade gracefully if no provider is available.
 *
 * Capabilities:
 *  1. enhanceTicket()    — Convert raw input into structured Jira ticket
 *  2. convertToJQL()     — Convert plain English to JQL query
 *  3. generateFromGit()  — Generate ticket from git commits/diff
 *  4. summarizeIssue()   — TL;DR of a ticket + its comments
 */

const logger = require('./logger');
const { getProvider } = require('./aiProviders');
const { AIEnhancedTicketSchema, validate } = require('../validators/schema');

// ── Issue-Type Specific Description Templates ─────────────────────────────────

const DESCRIPTION_TEMPLATES = {
  Bug: `Steps to Reproduce:
1.
2.

Expected Result:


Actual Result:


Environment:

Additional Context / Screenshots:`,

  Story: `As a [user/persona], I want to [action] so that [benefit].

Acceptance Criteria:
- [ ]
- [ ]

User Flow / Wireframe Link:

Notes:`,

  Task: `Objective:


Technical Details:


Definition of Done:
- [ ]
- [ ]`,

  Epic: `Problem Statement:


Hypothesis:


Business Value:


Scope / Out of Scope:`,

  'Sub-task': `Parent Task:

Description:

Acceptance Criteria:
- [ ]`,
};

function getDescriptionTemplate(issueType) {
  return DESCRIPTION_TEMPLATES[issueType] || DESCRIPTION_TEMPLATES.Task;
}

// ── 1. Enhance Ticket ─────────────────────────────────────────────────────────

async function enhanceTicket(rawInput) {
  const provider = await getProvider();

  if (!provider) {
    logger.debug('No AI provider available — skipping enhancement');
    return { ...rawInput, aiUsed: false, provider: null };
  }

  const template = getDescriptionTemplate(rawInput.issueType || 'Task');

  const systemPrompt = `You are a senior software engineer writing Jira tickets.
Always return ONLY valid JSON with keys "summary" and "description". No extra text.`;

  const userPrompt = `Convert this raw input into a well-structured Jira ticket.

Issue Type: ${rawInput.issueType || 'Task'}
Raw Summary: ${rawInput.summary}
Raw Description: ${rawInput.description || '(none provided)'}

Return ONLY this JSON structure:
{
  "summary": "Clear, concise one-line summary under 100 chars",
  "description": "Properly formatted description using this template:\\n${template.replace(/\n/g, '\\n')}"
}

Rules:
- summary must be actionable and specific
- description must fill in the template sections with content inferred from the input
- If information is missing, write sensible placeholder text in brackets`;

  try {
    const content = await provider.chat(systemPrompt, userPrompt, {
      temperature: 0.3,
      maxTokens: 800,
      jsonMode: true,
    });
    const parsed = JSON.parse(content);
    const validated = validate(AIEnhancedTicketSchema, parsed);
    return { ...validated, aiUsed: true, provider: provider.name };
  } catch (err) {
    logger.warn(`AI enhancement failed (${provider.name}): ${err.message} — using raw input`);
    return { summary: rawInput.summary, description: rawInput.description || '', aiUsed: false, provider: null };
  }
}

// ── Smart Fallback JQL Parser ─────────────────────────────────────────────────

/**
 * Parse common natural-language patterns into JQL without AI.
 * Handles: date ranges, assignee, status, issue type, priority.
 */
function buildFallbackJQL(naturalQuery, projectKey) {
  const q = naturalQuery.toLowerCase();
  const conditions = [`project = ${projectKey}`];
  const useCreated = /\bcreated\b/.test(q);
  const dateField = useCreated ? 'created' : 'updated';

  // ── Date ranges ─────────────────────────────────────────────────────────────
  const lastNMonths = q.match(/last\s+(\d+)\s+months?/);
  const lastNWeeks  = q.match(/last\s+(\d+)\s+weeks?/);
  const lastNDays   = q.match(/last\s+(\d+)\s+days?/);
  const thisWeek    = /this\s+week/.test(q);
  const thisMonth   = /this\s+month/.test(q);
  const today       = /\btoday\b/.test(q);

  if (lastNMonths) {
    const n = parseInt(lastNMonths[1], 10);
    conditions.push(`${dateField} >= -${n * 30}d`);
  } else if (lastNWeeks) {
    const n = parseInt(lastNWeeks[1], 10);
    conditions.push(`${dateField} >= -${n * 7}d`);
  } else if (lastNDays) {
    const n = parseInt(lastNDays[1], 10);
    conditions.push(`${dateField} >= -${n}d`);
  } else if (thisWeek) {
    conditions.push(`${dateField} >= startOfWeek()`);
  } else if (thisMonth) {
    conditions.push(`${dateField} >= startOfMonth()`);
  } else if (today) {
    conditions.push(`${dateField} >= startOfDay()`);
  }

  // ── Assignee ────────────────────────────────────────────────────────────────
  if (/\bmine\b|\bmy\b|\bassigned to me\b/.test(q)) {
    conditions.push('assignee = currentUser()');
  }

  // ── Status ──────────────────────────────────────────────────────────────────
  if (/\bin progress\b/.test(q))   conditions.push('status = "In Progress"');
  else if (/\bopen\b/.test(q))     conditions.push('status = "Open"');
  else if (/\bdone\b|\bclosed\b|\bcompleted\b/.test(q)) conditions.push('status = Done');
  else if (/\bto do\b|\btodo\b/.test(q)) conditions.push('status = "To Do"');
  else if (/\bin review\b/.test(q)) conditions.push('status = "In Review"');

  // ── Issue type ───────────────────────────────────────────────────────────────
  if (/\bbug[s]?\b/.test(q))       conditions.push('issuetype = Bug');
  else if (/\bstory|stories\b/.test(q)) conditions.push('issuetype = Story');
  else if (/\btask[s]?\b/.test(q)) conditions.push('issuetype = Task');
  else if (/\bepic[s]?\b/.test(q)) conditions.push('issuetype = Epic');

  // ── Priority ─────────────────────────────────────────────────────────────────
  if (/\bhigh priority\b|\burgent\b|\bblocker\b/.test(q)) {
    conditions.push('priority in (High, Highest, Blocker)');
  } else if (/\blow priority\b/.test(q)) {
    conditions.push('priority in (Low, Lowest)');
  }

  return conditions.join(' AND ') + ' ORDER BY updated DESC';
}

// ── 2. Convert Plain English to JQL ──────────────────────────────────────────

async function convertToJQL(naturalQuery, projectKey) {
  // Extract result-count hints from the natural query before doing anything else.
  // e.g. "show 100 tickets", "last 50 bugs", "top 10 blockers"
  // This works for both the AI path and the smart-fallback path.
  let suggestedLimit;
  const hasDateRange = /\b(?:last|past)\s+\d+\s+(?:day|days|week|weeks|month|months|year|years)\b/i.test(naturalQuery);
  const explicitLimitMatch = naturalQuery.match(/\b(?:only|give|show|get|fetch|list|top|first)\s+(\d+)\s*(?:results?|tickets?|issues?|bugs?|tasks?|stories?)\b/i);
  const countMatch = naturalQuery.match(/\b(?:show|get|fetch|list|top|first)\s+(\d+)\s*(?:tickets?|issues?|results?|bugs?|tasks?|stories?)?\b/i);

  if (explicitLimitMatch) {
    const n = parseInt(explicitLimitMatch[1], 10);
    if (n >= 1 && n <= 500) suggestedLimit = n;
  } else if (countMatch && !hasDateRange) {
    const n = parseInt(countMatch[1], 10);
    if (n >= 1 && n <= 500) suggestedLimit = n;  // sanity bounds
  }

  // Build smart fallback first (better than raw text search)
  const smartJQL = buildFallbackJQL(naturalQuery, projectKey);
  const fallback = {
    jql: smartJQL,
    aiUsed: false,
    provider: null,
    suggestedLimit,
  };

  const provider = await getProvider();
  if (!provider) return { ...fallback, reason: 'no_provider' };

  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a Jira Query Language (JQL) expert.
Return ONLY valid JSON with keys:
  - "jql": the JQL string (no LIMIT)
  - "limit": optional integer if the user explicitly asked for a result count
No explanation, no markdown, no extra keys.
IMPORTANT: JQL does NOT support LIMIT or any result-count clause. Never include LIMIT in the output.`;

  const userPrompt = `Convert this natural language query to valid JQL.

Natural query: "${naturalQuery}"
Project scope: ${projectKey}
Today's date: ${today}

Rules:
- Always include: project = ${projectKey}
- "this week" = created >= startOfWeek() AND created <= endOfWeek()
- "my tickets" or "mine" = assignee = currentUser()
- "bugs" = issuetype = Bug
- "in progress" = status = "In Progress"
- "high priority" = priority in (High, Blocker)
- Always end with ORDER BY updated DESC unless specified otherwise
- NEVER add LIMIT — result count is controlled separately, not in JQL`;

  try {
    const content = await provider.chat(systemPrompt, userPrompt, {
      temperature: 0.1,
      maxTokens: 200,
      jsonMode: true,
    });

    let parsed = null;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Some providers may return plain JQL; treat content as JQL string.
    }

    let jql = parsed?.jql || content;
    if (!jql || jql.length < 5) throw new Error('Invalid JQL returned');
    jql = String(jql).trim();

    // Safety net: strip any LIMIT clause the AI may have hallucinated despite instructions
    jql = jql.replace(/\s+LIMIT\s+\d+\s*$/i, '').trim();

    // Prefer AI-provided limit if present
    const aiLimit = Number.isInteger(parsed?.limit) ? parsed.limit : null;
    if (aiLimit && aiLimit >= 1 && aiLimit <= 500) suggestedLimit = aiLimit;

    // Normalize "last N days/weeks/months" to relative ranges if AI used startOfMonth(-1)/etc.
    if (shouldUseFallbackDate(naturalQuery, jql)) {
      jql = buildFallbackJQL(naturalQuery, projectKey);
    }

    return { jql, aiUsed: true, provider: provider.name, suggestedLimit };
  } catch (err) {
    logger.warn(`JQL conversion failed (${provider.name}): ${err.message} — using fallback`);
    return { ...fallback, reason: 'api_error', errorMsg: err.message };
  }
}

function shouldUseFallbackDate(naturalQuery, jql) {
  const q = (naturalQuery || '').toLowerCase();
  const wantsCreated = /\bcreated\b/.test(q);
  const hasLastRange =
    /last\s+\d+\s+days?/.test(q) ||
    /last\s+\d+\s+weeks?/.test(q) ||
    /last\s+\d+\s+months?/.test(q) ||
    /\blast\s+month\b/.test(q) ||
    /\blast\s+week\b/.test(q) ||
    /\blast\s+year\b/.test(q);

  if (!hasLastRange) return false;
  // If AI used created when user didn't ask for created, normalize to fallback.
  if (!wantsCreated && /\bcreated\b/i.test(jql)) return true;
  return /startOfMonth\s*\(|endOfMonth\s*\(|startOfWeek\s*\(|endOfWeek\s*\(/i.test(jql);
}

// ── 3. Generate Ticket from Git ───────────────────────────────────────────────

async function generateFromGit(gitContext) {
  const fallback = {
    summary: gitContext.commits?.split('\n')[0]?.replace(/^[a-f0-9]+ /, '') || 'Git-based task',
    description: `Generated from git commits:\n${gitContext.commits || '(none)'}`,
    aiUsed: false,
    provider: null,
  };

  const provider = await getProvider();
  if (!provider) return fallback;

  const systemPrompt = `You are a senior software engineer creating Jira tickets from git changes.
Return ONLY valid JSON with keys "summary" and "description".`;

  const userPrompt = `Create a structured Jira ticket from this git change.

Issue Type: ${gitContext.issueType || 'Task'}
Recent Commits:
${gitContext.commits || '(none)'}

${gitContext.diff ? `Files Changed:\n${gitContext.diff}` : ''}

Return ONLY this JSON:
{
  "summary": "Concise one-line title under 100 chars",
  "description": "Technical description of what changed, why, and how to verify"
}`;

  try {
    const content = await provider.chat(systemPrompt, userPrompt, {
      temperature: 0.3,
      maxTokens: 600,
      jsonMode: true,
    });
    const parsed = JSON.parse(content);
    const validated = validate(AIEnhancedTicketSchema, parsed);
    return { ...validated, aiUsed: true, provider: provider.name };
  } catch (err) {
    logger.warn(`Git-based generation failed (${provider.name}): ${err.message}`);
    return fallback;
  }
}

// ── 4. Summarize Issue ────────────────────────────────────────────────────────

async function summarizeIssue(issue, comments = []) {
  const fields = issue.fields || {};
  const fallback = {
    summary: `${issue.key}: ${fields.summary}\nStatus: ${fields.status?.name}\nAssignee: ${fields.assignee?.displayName || 'Unassigned'}`,
    aiUsed: false,
    provider: null,
  };

  const provider = await getProvider();
  if (!provider) return fallback;

  const commentText = comments
    .slice(0, 5)
    .map((c) => {
      const body = c.body?.content?.[0]?.content?.[0]?.text || '';
      return `- ${c.author?.displayName}: ${body.slice(0, 200)}`;
    })
    .join('\n');

  const description = extractPlainText(fields.description) || '(no description)';

  const systemPrompt = `You summarize Jira tickets for developers. Return clean bullet points only.`;

  const userPrompt = `Summarize this Jira ticket in exactly 3 bullet points for a developer being handed this work.

Ticket: ${issue.key}
Summary: ${fields.summary}
Status: ${fields.status?.name}
Priority: ${fields.priority?.name}
Description: ${description.slice(0, 500)}

Recent Comments:
${commentText || '(none)'}

Return exactly 3 bullets starting with •. No JSON. No headers.`;

  try {
    const text = await provider.chat(systemPrompt, userPrompt, { temperature: 0.3, maxTokens: 250 });
    return { summary: text, aiUsed: true, provider: provider.name };
  } catch (err) {
    logger.warn(`Summarize failed (${provider.name}): ${err.message}`);
    return fallback;
  }
}

// ── 5. Parse Create Prompt ────────────────────────────────────────────────────

/**
 * Parse a natural language prompt into structured create fields.
 * Requires AI provider.
 */
async function parseCreatePrompt(prompt, context) {
  const provider = await getProvider();
  if (!provider) {
    return { ok: false, error: 'No AI provider available' };
  }

  const {
    issueTypes = [],
    priorities = [],
    customFields = {},
    components = [],
    fixVersions = [],
    requiredTextFields = [],
  } = context || {};

  const systemPrompt = `You are a Jira assistant. Convert the user's prompt into JSON.
Return ONLY valid JSON with keys:
  - "issueType" (string or null)
  - "summary" (string)
  - "description" (string)
  - "priority" (string or null)
  - "customFields" (object: field label -> chosen value)
  - "components" (array of strings)
  - "fixVersions" (array of strings)
  - "textFields" (object: required text field label -> text)
Rules:
  - Only choose values from the provided lists.
  - If unsure, set null or omit field.
  - Keep summary concise (<100 chars).
  - CRITICAL: The description MUST be comprehensive and AI-implementation-ready.
    Preserve ALL specific technical details from the user's prompt verbatim:
    model/schema names, file paths, function/method names, config flags, API routes,
    error constants, middleware names, database field names, indexes, validation rules,
    edge cases, and test requirements. A developer or AI agent reading only this
    description must have everything they need to implement the feature — no guessing.
    Use sections with headers (e.g. "## Overview", "## Technical Spec", "## Acceptance Criteria")
    and include concrete examples wherever the user provided them.`;

  const fieldList = Object.entries(customFields)
    .map(([label, values]) => `${label}: [${values.join(', ')}]`)
    .join('\n');

  const userPrompt = `User prompt:
${prompt}

Valid issue types:
${issueTypes.join(', ')}

Valid priorities:
${priorities.join(', ')}

Valid custom fields and values:
${fieldList || '(none)'}

Valid components:
${components.join(', ') || '(none)'}

Valid fix versions:
${fixVersions.join(', ') || '(none)'}

Required text fields (provide if present in prompt):
${requiredTextFields.join(', ') || '(none)'}
`;

  try {
    const content = await provider.chat(systemPrompt, userPrompt, {
      temperature: 0.2,
      maxTokens: 1500,
      jsonMode: true,
    });

    const parsed = JSON.parse(content);
    const result = {
      issueType: parsed.issueType || null,
      summary: parsed.summary || '',
      description: parsed.description || '',
      priority: parsed.priority || null,
      customFields: parsed.customFields || {},
      components: Array.isArray(parsed.components) ? parsed.components : [],
      fixVersions: Array.isArray(parsed.fixVersions) ? parsed.fixVersions : [],
      textFields: parsed.textFields || {},
    };

    return { ok: true, ...result };
  } catch (err) {
    logger.warn(`Prompt parse failed (${provider.name}): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── 6. Enhance arbitrary text field ───────────────────────────────────────────

async function enhanceTextField(label, text) {
  const provider = await getProvider();
  if (!provider) return { text, aiUsed: false };

  const systemPrompt = `You refine Jira field text. Return only the cleaned text.`;
  const userPrompt = `Field: ${label}
Raw text:
${text}

Rewrite this to be clear and concise. Keep any steps as numbered lines if present.`;

  try {
    const content = await provider.chat(systemPrompt, userPrompt, {
      temperature: 0.2,
      maxTokens: 200,
    });
    const cleaned = (content || '').trim();
    return { text: cleaned || text, aiUsed: true };
  } catch (err) {
    logger.warn(`Text enhance failed (${provider.name}): ${err.message}`);
    return { text, aiUsed: false };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPlainText(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (Array.isArray(adf)) return adf.map(extractPlainText).join(' ');
  if (adf.text) return adf.text;
  if (adf.content) return extractPlainText(adf.content);
  return '';
}

module.exports = {
  enhanceTicket,
  convertToJQL,
  generateFromGit,
  summarizeIssue,
  getDescriptionTemplate,
  extractPlainText,
  parseCreatePrompt,
  enhanceTextField,
};

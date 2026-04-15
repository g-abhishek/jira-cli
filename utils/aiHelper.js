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

// ── 2. Convert Plain English to JQL ──────────────────────────────────────────

async function convertToJQL(naturalQuery, projectKey) {
  const fallback = {
    jql: `project = ${projectKey} AND text ~ "${naturalQuery}" ORDER BY updated DESC`,
    aiUsed: false,
    provider: null,
  };

  const provider = await getProvider();
  if (!provider) return fallback;

  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `You are a Jira Query Language (JQL) expert.
Return ONLY the JQL string. No explanation, no markdown, no quotes around it.`;

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
- Always end with ORDER BY updated DESC unless specified otherwise`;

  try {
    const jql = await provider.chat(systemPrompt, userPrompt, { temperature: 0.1, maxTokens: 200 });
    if (!jql || jql.length < 5) throw new Error('Invalid JQL returned');
    return { jql: jql.trim(), aiUsed: true, provider: provider.name };
  } catch (err) {
    logger.warn(`JQL conversion failed (${provider.name}): ${err.message} — using fallback`);
    return fallback;
  }
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
};

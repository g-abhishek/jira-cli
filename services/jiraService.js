'use strict';

/**
 * jiraService.js
 * Core Jira REST API v3 service layer.
 * Uses axios with Basic Auth (email + API token).
 * Includes retry logic on 429/5xx, and response normalization.
 */

const axios = require('axios');
const axiosRetry = require('axios-retry');
const os = require('os');
const path = require('path');
const fs = require('fs');

const logger = require('../utils/logger');

// ─── Config Loading ───────────────────────────────────────────────────────────
// Load from ~/.jira-cli/config.json first, then fall back to env vars
function loadConfig() {
  const configPath = path.join(os.homedir(), '.jira-cli', 'config.json');
  let fileConfig = {};
  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}

  return {
    baseUrl: (fileConfig.JIRA_BASE_URL || process.env.JIRA_BASE_URL || '').replace(/\/$/, ''),
    email: fileConfig.JIRA_EMAIL || process.env.JIRA_EMAIL || '',
    token: fileConfig.JIRA_API_TOKEN || process.env.JIRA_API_TOKEN || '',
  };
}

// ─── Axios Instance ───────────────────────────────────────────────────────────
function createClient() {
  const { baseUrl, email, token } = loadConfig();

  if (!baseUrl || !email || !token) {
    throw new Error(
      'Missing Jira credentials. Run `jira config` or set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in your environment.'
    );
  }

  const client = axios.create({
    baseURL: `${baseUrl}/rest/api/3`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    auth: {
      username: email,
      password: token,
    },
    timeout: 15000,
  });

  // Retry on 429 (rate limit) and 5xx with exponential backoff
  axiosRetry(client, {
    retries: 3,
    retryDelay: axiosRetry.exponentialDelay,
    retryCondition: (err) =>
      axiosRetry.isNetworkOrIdempotentRequestError(err) ||
      err.response?.status === 429 ||
      (err.response?.status >= 500 && err.response?.status < 600),
    onRetry: (count, err) => {
      logger.warn(`Retrying request (attempt ${count}): ${err.message}`);
    },
  });

  // Log all outgoing requests (debug only)
  client.interceptors.request.use((config) => {
    logger.debug(`→ ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  });

  client.interceptors.response.use(
    (res) => {
      logger.debug(`← ${res.status} ${res.config.url}`);
      return res;
    },
    (err) => {
      logger.error(`API Error: ${err.response?.status} ${err.config?.url} — ${JSON.stringify(err.response?.data)}`);
      return Promise.reject(err);
    }
  );

  return client;
}

// ─── Issue Operations ─────────────────────────────────────────────────────────

/**
 * Create a Jira issue.
 * @param {Object} fields - All issue fields (summary, description, issuetype, project, etc.)
 * @returns {Object} { key, id, self }
 */
async function createIssue(fields) {
  const client = createClient();
  const res = await client.post('/issue', { fields });
  return res.data;
}

/**
 * Get a single issue by key with full field expansion.
 * @param {string} key - Issue key like JCP-1234
 * @returns {Object} Full issue object
 */
async function getIssue(key) {
  const client = createClient();
  const res = await client.get(`/issue/${key}`, {
    params: {
      expand: 'names,renderedFields,transitions,editmeta',
    },
  });
  return res.data;
}

/**
 * Update issue fields.
 * @param {string} key - Issue key
 * @param {Object} fields - Fields to update
 */
async function updateIssue(key, fields) {
  const client = createClient();
  await client.put(`/issue/${key}`, { fields });
}

/**
 * Delete an issue.
 * @param {string} key - Issue key
 */
async function deleteIssue(key) {
  const client = createClient();
  await client.delete(`/issue/${key}`);
}

/**
 * Search issues using JQL.
 * @param {string} jql - JQL query string
 * @param {Object} options - { startAt, maxResults, fields }
 * @returns {{ issues, total, startAt, maxResults }}
 */
async function searchIssues(jql, options = {}) {
  const client = createClient();
  const res = await client.post('/search', {
    jql,
    startAt: options.startAt || 0,
    maxResults: options.maxResults || 25,
    fields: options.fields || [
      'summary', 'status', 'priority', 'assignee', 'issuetype',
      'customfield_10026', // Story Points
      'customfield_11371', // JCP Cluster
      'customfield_17322', // JCP Work Type
      'customfield_10014', // Epic Link
      'customfield_10020', // Sprint
      'duedate', 'updated', 'labels', 'components', 'fixVersions',
      'customfield_10091', // Assigned Developer
    ],
  });
  return res.data;
}

/**
 * Get available transitions for an issue.
 * @param {string} key - Issue key
 * @returns {Array} List of transitions [{ id, name, to: { name } }]
 */
async function getTransitions(key) {
  const client = createClient();
  const res = await client.get(`/issue/${key}/transitions`);
  return res.data.transitions || [];
}

/**
 * Transition an issue to a new status.
 * @param {string} key - Issue key
 * @param {string} transitionId - Transition ID (from getTransitions)
 */
async function transitionIssue(key, transitionId) {
  const client = createClient();
  await client.post(`/issue/${key}/transitions`, {
    transition: { id: transitionId },
  });
}

/**
 * Add a comment to an issue (Atlassian Document Format).
 * @param {string} key - Issue key
 * @param {string} text - Plain text comment
 */
async function addComment(key, text) {
  const client = createClient();
  const res = await client.post(`/issue/${key}/comment`, {
    body: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
  return res.data;
}

/**
 * Get comments for an issue.
 * @param {string} key - Issue key
 * @returns {Array} Comments
 */
async function getComments(key) {
  const client = createClient();
  const res = await client.get(`/issue/${key}/comment`, {
    params: { maxResults: 20, orderBy: '-created' },
  });
  return res.data.comments || [];
}

// ─── Project / Metadata ────────────────────────────────────────────────────────

/**
 * Get all visible projects (for search/autocomplete).
 */
async function getProjects() {
  const client = createClient();
  const res = await client.get('/project/search', {
    params: { maxResults: 50, expand: 'issueTypes' },
  });
  return res.data.values || [];
}

/**
 * Get a single project's details.
 */
async function getProject(projectKey) {
  const client = createClient();
  const res = await client.get(`/project/${projectKey}`);
  return res.data;
}

/**
 * Get all versions (fix versions) for a project.
 */
async function getProjectVersions(projectKey) {
  const client = createClient();
  const res = await client.get(`/project/${projectKey}/versions`);
  return res.data || [];
}

/**
 * Get all components for a project.
 */
async function getProjectComponents(projectKey) {
  const client = createClient();
  const res = await client.get(`/project/${projectKey}/components`);
  return res.data || [];
}

/**
 * Get issue create metadata (all fields + allowed values per issue type).
 * Critical for `jira sync`.
 */
async function getCreateMeta(projectKey) {
  const client = createClient();
  const res = await client.get('/issue/createmeta', {
    params: {
      projectKeys: projectKey,
      expand: 'projects.issuetypes.fields',
    },
  });
  return res.data?.projects?.[0] || null;
}

/**
 * Get all issue types for a project.
 */
async function getIssueTypes(projectKey) {
  const client = createClient();
  const res = await client.get(`/issue/createmeta`, {
    params: { projectKeys: projectKey },
  });
  const project = res.data?.projects?.[0];
  return project?.issuetypes || [];
}

/**
 * Get active sprints for a project board.
 * Requires Agile API endpoint.
 */
async function getActiveSprints(boardId) {
  const { baseUrl, email, token } = loadConfig();
  const client = axios.create({
    baseURL: `${baseUrl}/rest/agile/1.0`,
    headers: { Accept: 'application/json' },
    auth: { username: email, password: token },
    timeout: 15000,
  });
  const res = await client.get(`/board/${boardId}/sprint`, {
    params: { state: 'active' },
  });
  return res.data?.values || [];
}

/**
 * Get all boards for a project.
 */
async function getBoards(projectKey) {
  const { baseUrl, email, token } = loadConfig();
  const client = axios.create({
    baseURL: `${baseUrl}/rest/agile/1.0`,
    headers: { Accept: 'application/json' },
    auth: { username: email, password: token },
    timeout: 15000,
  });
  const res = await client.get('/board', {
    params: { projectKeyOrId: projectKey },
  });
  return res.data?.values || [];
}

/**
 * Get all priorities.
 */
async function getPriorities() {
  const client = createClient();
  const res = await client.get('/priority');
  return res.data || [];
}

/**
 * Search for users (for user-picker fields).
 * @param {string} query - Search string (name/email)
 * @param {string} projectKey - Scope to project
 */
async function searchUsers(query, projectKey) {
  const client = createClient();
  const res = await client.get('/user/search', {
    params: {
      query,
      project: projectKey,
      maxResults: 20,
    },
  });
  return res.data || [];
}

/**
 * Get the current authenticated user's account info.
 */
async function getCurrentUser() {
  const client = createClient();
  const res = await client.get('/myself');
  return res.data;
}

/**
 * Test connectivity — used by `jira doctor`.
 * @returns {{ ok: boolean, user: string, error: string }}
 */
async function testConnection() {
  try {
    const user = await getCurrentUser();
    return { ok: true, user: user.displayName, email: user.emailAddress };
  } catch (err) {
    const { parseError } = require('../utils/errorParser');
    return { ok: false, error: parseError(err) };
  }
}

module.exports = {
  createIssue,
  getIssue,
  updateIssue,
  deleteIssue,
  searchIssues,
  getTransitions,
  transitionIssue,
  addComment,
  getComments,
  getProjects,
  getProject,
  getProjectVersions,
  getProjectComponents,
  getCreateMeta,
  getIssueTypes,
  getActiveSprints,
  getBoards,
  getPriorities,
  searchUsers,
  getCurrentUser,
  testConnection,
};

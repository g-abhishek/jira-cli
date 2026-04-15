'use strict';

/**
 * schema.js
 * Zod validation schemas for all CLI inputs and API payloads.
 * Fail fast before any API call is made.
 */

const { z } = require('zod');

// ─── Environment / Config ─────────────────────────────────────────────────────

const EnvSchema = z.object({
  JIRA_BASE_URL: z
    .string()
    .url('JIRA_BASE_URL must be a valid URL (e.g. https://yourcompany.atlassian.net)'),
  JIRA_EMAIL: z.string().email('JIRA_EMAIL must be a valid email address'),
  JIRA_API_TOKEN: z.string().min(10, 'JIRA_API_TOKEN appears too short'),
});

// ─── Issue Keys ────────────────────────────────────────────────────────────────

const IssueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+-\d+$/i, 'Invalid issue key format (expected e.g. JCP-1234)')
  .transform((v) => v.toUpperCase());

const ProjectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+$/i, 'Invalid project key format (expected e.g. JCP)')
  .transform((v) => v.toUpperCase());

// ─── Issue Creation ───────────────────────────────────────────────────────────

const CreateIssueSchema = z.object({
  summary: z.string().min(1, 'Summary cannot be empty').max(255, 'Summary too long (max 255 chars)'),
  description: z.string().optional().default(''),
  issuetype: z.string().min(1, 'Issue type is required'),
  projectKey: ProjectKeySchema,
  priority: z.string().optional(),
  labels: z.array(z.string()).optional().default([]),
  // JCP-specific fields (all optional)
  jcpWorkType: z.string().optional(),
  jcpPlanningType: z.string().optional(),
  jcpCluster: z.string().optional(),
  jcpChannel: z.string().optional(),
  jcpEstimate: z.string().optional(),
  jcpPlannedMonth: z.string().optional(),
  jcpPlannedQuarter: z.string().optional(),
  storyPoints: z.number().int().min(0).max(100).optional(),
  epicLink: z.string().optional(),
  fixVersions: z.array(z.string()).optional().default([]),
  components: z.array(z.string()).optional().default([]),
  assignee: z.string().optional(), // accountId
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Due date must be in YYYY-MM-DD format')
    .optional(),
});

// ─── Issue Update ─────────────────────────────────────────────────────────────

const UpdateIssueSchema = z.object({
  key: IssueKeySchema,
  fields: z.record(z.unknown()).refine((f) => Object.keys(f).length > 0, {
    message: 'At least one field must be provided for update',
  }),
});

// ─── Comment ──────────────────────────────────────────────────────────────────

const CommentSchema = z.object({
  key: IssueKeySchema,
  text: z.string().min(1, 'Comment cannot be empty').max(32767, 'Comment too long'),
});

// ─── AI Response ─────────────────────────────────────────────────────────────

const AIEnhancedTicketSchema = z.object({
  summary: z.string().min(1),
  description: z.string().min(1),
});

// ─── Search / Filter ──────────────────────────────────────────────────────────

const SearchOptionsSchema = z.object({
  status: z.string().optional(),
  assignee: z.string().optional(),
  project: ProjectKeySchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  page: z.number().int().min(0).default(0),
  filter: z.string().optional(),
});

// ─── Validation Helper ────────────────────────────────────────────────────────

/**
 * Validate data against a schema.
 * Throws a formatted error on failure.
 * @param {z.ZodSchema} schema
 * @param {unknown} data
 * @returns Parsed and validated data
 */
function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `  → ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Validation failed:\n${messages}`);
  }
  return result.data;
}

/**
 * Validate environment variables on startup.
 * Warn user about missing config instead of crashing with a stack trace.
 */
function validateEnv() {
  const data = {
    JIRA_BASE_URL: process.env.JIRA_BASE_URL,
    JIRA_EMAIL: process.env.JIRA_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
  };
  return EnvSchema.safeParse(data);
}

module.exports = {
  EnvSchema,
  IssueKeySchema,
  ProjectKeySchema,
  CreateIssueSchema,
  UpdateIssueSchema,
  CommentSchema,
  AIEnhancedTicketSchema,
  SearchOptionsSchema,
  validate,
  validateEnv,
};

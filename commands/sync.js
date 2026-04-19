'use strict';

/**
 * sync.js
 * `jira sync` — Sync project metadata to local cache.
 *
 * Fetches from Jira API and stores in ~/.jira-cli/cache.json:
 *  - Issue types
 *  - Fix versions
 *  - Components
 *  - Priorities
 *  - All custom dropdown fields (dynamically discovered — works for any project)
 *  - Active sprints
 *  - Transitions (from a sample open issue)
 *
 * Run: `jira sync` (or `jira sync --project YOURKEY`)
 * Results are used by create, update, search commands for dropdown options.
 */

const chalk = require('chalk');
const ora = require('ora');
const {
  getProject,
  getProjectVersions,
  getProjectComponents,
  getCreateMeta,
  getPriorities,
  getBoards,
  getActiveSprints,
  searchIssues,
  getTransitions,
} = require('../services/jiraService');
const { resolveProjectKeyInteractive } = require('../utils/projectResolver');
const { printError } = require('../utils/errorParser');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

// No hardcoded field IDs — all custom fields are discovered dynamically from each project's createMeta.

module.exports = {
  command: 'sync',
  desc: 'Sync project metadata (versions, components, fields) to local cache',
  builder: (yargs) =>
    yargs
      .option('project', { alias: 'p', type: 'string', desc: 'Project key to sync' })
      .option('force', { alias: 'f', type: 'boolean', default: false, desc: 'Force re-sync even if cache is fresh' }),

  handler: async (argv) => {
    try {
      const projectKey = argv.project || (await resolveProjectKeyInteractive());

      // Check if cache is still fresh
      const meta = cache.getMeta(projectKey);
      if (meta && !meta.isStale && !argv.force) {
        console.log(chalk.green(`\n✔ ${projectKey} is already synced.`));
        console.log(chalk.dim(`  Last synced: ${meta.lastSynced}`));
        console.log(chalk.dim(`  Use --force to re-sync anyway.\n`));
        return;
      }

      console.log(chalk.bold(`\n🔄 Syncing ${chalk.cyan(projectKey)}...\n`));

      const results = {};
      const errors = [];

      // ── 1. Project Info ────────────────────────────────────────────────────
      const step1 = ora('  Project info...').start();
      try {
        const project = await getProject(projectKey);
        results.projectName = project.name;
        results.projectId = project.id;
        results.issueTypes = project.issueTypes?.map((t) => t.name) || [];
        step1.succeed(`  Project: ${project.name} (${results.issueTypes.length} issue types)`);
      } catch (e) {
        step1.fail('  Project info — failed');
        errors.push(`Project info: ${e.message}`);
      }

      // ── 2. Fix Versions ────────────────────────────────────────────────────
      const step2 = ora('  Fix versions...').start();
      try {
        const versions = await getProjectVersions(projectKey);
        results.fixVersions = versions
          .filter((v) => !v.archived)
          .sort((a, b) => new Date(b.releaseDate || 0) - new Date(a.releaseDate || 0))
          .map((v) => v.name);
        step2.succeed(`  Fix versions: ${results.fixVersions.length} versions`);
      } catch (e) {
        step2.fail('  Fix versions — failed');
        errors.push(`Fix versions: ${e.message}`);
        results.fixVersions = [];
      }

      // ── 3. Components ──────────────────────────────────────────────────────
      const step3 = ora('  Components...').start();
      try {
        const components = await getProjectComponents(projectKey);
        results.components = components.map((c) => c.name).sort();
        step3.succeed(`  Components: ${results.components.length} components`);
      } catch (e) {
        step3.fail('  Components — failed');
        errors.push(`Components: ${e.message}`);
        results.components = [];
      }

      // ── 4. Create Metadata (all custom dropdown fields — fully dynamic) ──────
      const step4 = ora('  Custom field options (discovering all dropdowns)...').start();
      try {
        const meta = await getCreateMeta(projectKey);
        if (meta) {
          // Dynamically discover ALL custom fields that have allowed values.
          // This works for any Jira project — no hardcoded field IDs needed.
          const customFields = {};     // fieldLabel → [option, ...]
          const customFieldIds = {};   // fieldLabel → customfield_XXXXX
          const customFieldMeta = {};  // fieldLabel → { type, items, custom }
          const requiredFields = {};   // fieldLabel → { id, type, items, custom, required }

          meta.issuetypes?.forEach((issueType) => {
            Object.entries(issueType.fields || {}).forEach(([fieldId, fieldMeta]) => {
              // Track required fields (including system fields like components)
              if (fieldMeta?.required && fieldMeta?.name && !requiredFields[fieldMeta.name]) {
                requiredFields[fieldMeta.name] = {
                  id: fieldId,
                  type: fieldMeta.schema?.type || null,
                  items: fieldMeta.schema?.items || null,
                  custom: fieldMeta.schema?.custom || null,
                  required: true,
                };
              }

              if (
                fieldId.startsWith('customfield_') &&
                fieldMeta.allowedValues?.length > 0 &&
                fieldMeta.name &&
                !customFields[fieldMeta.name] // dedup: first issue type wins
              ) {
                const values = fieldMeta.allowedValues
                  .map((v) => v.name || v.value || v.key)
                  .filter(Boolean);
                if (values.length > 0) {
                  customFields[fieldMeta.name] = values;
                  customFieldIds[fieldMeta.name] = fieldId;
                  customFieldMeta[fieldMeta.name] = {
                    type: fieldMeta.schema?.type || null,
                    items: fieldMeta.schema?.items || null,
                    custom: fieldMeta.schema?.custom || null,
                  };
                }
              }
            });
          });

          results.customFields = customFields;
          results.customFieldIds = customFieldIds;
          results.customFieldMeta = customFieldMeta;
          results.requiredFields = requiredFields;

          // Statuses (used by `jira search --interactive`)
          results.statuses = [...new Set(
            meta.issuetypes?.flatMap((t) =>
              Object.values(t.fields || {})
                .filter((f) => f.schema?.type === 'status')
                .flatMap((f) => f.allowedValues?.map((v) => v.name) || [])
            ) || []
          )];

          const fieldCount = Object.keys(customFields).length;
          step4.succeed(`  Custom fields: ${fieldCount} dropdown field(s) discovered`);
        } else {
          step4.succeed('  Custom fields: none found (createMeta returned empty)');
        }
      } catch (e) {
        step4.fail('  Custom fields — failed');
        errors.push(`Custom fields: ${e.message}`);
      }

      // ── 5. Priorities ──────────────────────────────────────────────────────
      const step5 = ora('  Priorities...').start();
      try {
        const priorities = await getPriorities();
        results.priorities = priorities.map((p) => p.name);
        step5.succeed(`  Priorities: ${results.priorities.join(', ')}`);
      } catch (e) {
        step5.fail('  Priorities — failed');
        results.priorities = ['Blocker', 'High', 'Medium', 'Low', 'Minor'];
      }

      // ── 6. Active Sprints ──────────────────────────────────────────────────
      const step6 = ora('  Active sprints...').start();
      try {
        const boards = await getBoards(projectKey);
        if (boards.length > 0) {
          const sprintPromises = boards.slice(0, 3).map((b) => getActiveSprints(b.id).catch(() => []));
          const sprintArrays = await Promise.all(sprintPromises);
          results.activeSprints = sprintArrays.flat().map((s) => ({ id: s.id, name: s.name, boardId: s.originBoardId }));
          results.boards = boards.map((b) => ({ id: b.id, name: b.name }));
          step6.succeed(`  Active sprints: ${results.activeSprints.length} sprints across ${boards.length} boards`);
        } else {
          step6.succeed('  Active sprints: no boards found');
          results.activeSprints = [];
        }
      } catch (e) {
        step6.fail('  Active sprints — failed');
        errors.push(`Sprints: ${e.message}`);
        results.activeSprints = [];
      }

      // ── 7. Sample transitions (from an open issue) ─────────────────────────
      const step7 = ora('  Transition map...').start();
      try {
        // Find the most recently updated open issue to sample transitions
        const openIssues = await searchIssues(
          `project = ${projectKey} AND status != Done AND status != Closed ORDER BY updated DESC`,
          { maxResults: 1, fields: ['status'] }
        );

        if (openIssues.issues?.length > 0) {
          const sampleKey = openIssues.issues[0].key;
          const transitions = await getTransitions(sampleKey);
          results.sampleTransitions = transitions.map((t) => ({
            id: t.id,
            name: t.name,
            toStatus: t.to?.name,
            category: t.to?.statusCategory?.name,
          }));
          step7.succeed(`  Transitions: ${transitions.length} available from "${openIssues.issues[0].fields?.status?.name || 'open'}" state`);
        } else {
          step7.succeed('  Transitions: no open issues to sample from');
          results.sampleTransitions = [];
        }
      } catch (e) {
        step7.fail('  Transition map — failed');
        results.sampleTransitions = [];
        errors.push(`Transition map: ${e.message}`);
      }

      // ── Store everything to cache ─────────────────────────────────────────
      cache.set(`${projectKey}:fields`, results, 86400); // 24h TTL
      cache.set(`${projectKey}:sync_meta`, { synced: true, timestamp: Date.now() }, 86400);

      // ── Summary ───────────────────────────────────────────────────────────
      console.log(chalk.bold(`\n✅ Sync complete for ${chalk.cyan(projectKey)}`));
      console.log(chalk.dim(`   Issue types    : ${(results.issueTypes || []).join(', ')}`));
      const fixCount = (results.fixVersions || []).length;
      const compCount = (results.components || []).length;
      const customCount = Object.keys(results.customFields || {}).length;

      console.log(chalk.dim(`   Fix versions   : ${fixCount}${fixCount === 0 ? ' (not configured in this project)' : ''}`));
      console.log(chalk.dim(`   Components     : ${compCount}${compCount === 0 ? ' (not configured in this project)' : ''}`));
      console.log(chalk.dim(`   Custom fields  : ${customCount} dropdown(s)${customCount === 0 ? ' (none discovered)' : ''}`));
      if (Object.keys(results.customFields || {}).length > 0) {
        console.log(chalk.dim(`     → ${Object.keys(results.customFields).join(', ')}`));
      }
      console.log(chalk.dim(`   Active sprints : ${(results.activeSprints || []).length}`));
      console.log(chalk.dim(`   Cache TTL      : 24 hours\n`));

      if (errors.length > 0) {
        console.log(chalk.yellow(`⚠  Some items failed to sync:`));
        errors.forEach((e) => console.log(chalk.yellow(`   · ${e}`)));
        console.log();
      }

      logger.info(`sync: ${projectKey} — ${JSON.stringify({ versions: results.fixVersions?.length, components: results.components?.length })}`);
    } catch (err) {
      printError(err);
      logger.error(`sync failed: ${err.message}`);
      process.exit(1);
    }
  },
};

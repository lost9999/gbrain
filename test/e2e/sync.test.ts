/**
 * E2E Sync Tests — Tier 1 (no API keys required)
 *
 * Tests the full git-to-DB sync pipeline: create a git repo, commit
 * markdown files, run gbrain sync, verify pages appear in the database.
 * Covers first sync, incremental add/modify/delete, and the critical
 * "edit → sync → search returns corrected text" flow.
 *
 * Run: DATABASE_URL=... bun test test/e2e/sync.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir, homedir } from 'os';
import {
  hasDatabase, setupDB, teardownDB, getEngine,
} from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E sync tests (DATABASE_URL not set)');
}

/** Create a temp git repo with initial markdown files */
function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-sync-e2e-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  // Create initial structure
  mkdirSync(join(dir, 'people'), { recursive: true });
  mkdirSync(join(dir, 'concepts'), { recursive: true });

  writeFileSync(join(dir, 'people/alice.md'), [
    '---',
    'type: person',
    'title: Alice Smith',
    'tags: [engineer, frontend]',
    '---',
    '',
    'Alice is a frontend engineer at Acme Corp.',
    '',
    '---',
    '',
    '- 2026-01-15: Joined Acme Corp',
  ].join('\n'));

  writeFileSync(join(dir, 'concepts/testing.md'), [
    '---',
    'type: concept',
    'title: Testing Philosophy',
    'tags: [engineering]',
    '---',
    '',
    'Every untested path is a path where bugs hide.',
  ].join('\n'));

  // Initial commit
  execSync('git add -A && git commit -m "initial commit"', { cwd: dir, stdio: 'pipe' });

  return dir;
}

function gitCommit(repoPath: string, message: string) {
  execSync(`git add -A && git commit -m "${message}"`, { cwd: repoPath, stdio: 'pipe' });
}

describeE2E('E2E: Git-to-DB Sync Pipeline', () => {
  let repoPath: string;

  beforeAll(async () => {
    await setupDB();
    repoPath = createTestRepo();
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('first sync imports all pages from git repo', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('first_sync');
    // performFullSync delegates to runImport which doesn't populate pagesAffected
    // Verify pages exist in DB directly instead
    const alice = await engine.getPage('people/alice');
    expect(alice).not.toBeNull();
    expect(alice!.title).toBe('Alice Smith');

    const testing = await engine.getPage('concepts/testing');
    expect(testing).not.toBeNull();
    expect(testing!.title).toBe('Testing Philosophy');
  });

  test('second sync with no changes returns up_to_date', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('up_to_date');
    expect(result.added).toBe(0);
    expect(result.modified).toBe(0);
    expect(result.deleted).toBe(0);
  });

  test('incremental sync picks up new files', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a new file
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---',
      'type: person',
      'title: Bob Jones',
      'tags: [designer]',
      '---',
      '',
      'Bob is a product designer who loves typography.',
    ].join('\n'));
    gitCommit(repoPath, 'add bob');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('people/bob');

    const bob = await engine.getPage('people/bob');
    expect(bob).not.toBeNull();
    expect(bob!.title).toBe('Bob Jones');
    expect(bob!.compiled_truth).toContain('typography');
  });

  test('incremental sync picks up modifications — corrected text appears', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Modify alice's page — this is the critical "correction" test
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice Smith',
      'tags: [engineer, frontend]',
      '---',
      '',
      'Alice is a staff frontend engineer at Acme Corp, leading the design system team.',
      '',
      '---',
      '',
      '- 2026-04-01: Promoted to staff engineer',
      '- 2026-01-15: Joined Acme Corp',
    ].join('\n'));
    gitCommit(repoPath, 'update alice - promotion');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.modified).toBe(1);
    expect(result.pagesAffected).toContain('people/alice');

    // THE CRITICAL CHECK: corrected text appears in the DB
    const alice = await engine.getPage('people/alice');
    expect(alice!.compiled_truth).toContain('staff frontend engineer');
    expect(alice!.compiled_truth).toContain('design system team');
    // Old text should be replaced, not appended
    expect(alice!.compiled_truth).not.toBe('Alice is a frontend engineer at Acme Corp.');
  });

  test('keyword search finds corrected text after sync', async () => {
    const engine = getEngine();

    // Search for the new text
    const results = await engine.searchKeyword('design system team');
    expect(results.length).toBeGreaterThanOrEqual(1);

    const aliceResult = results.find((r: any) => r.slug === 'people/alice');
    expect(aliceResult).toBeDefined();
  });

  test('incremental sync handles deletes', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Delete bob's page
    unlinkSync(join(repoPath, 'people/bob.md'));
    gitCommit(repoPath, 'remove bob');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.deleted).toBe(1);

    const bob = await engine.getPage('people/bob');
    expect(bob).toBeNull();
  });

  test('sync skips non-syncable files (README, hidden, .raw)', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add files that should be excluded
    writeFileSync(join(repoPath, 'README.md'), '# Brain Repo\nThis is the readme.');
    mkdirSync(join(repoPath, '.raw'), { recursive: true });
    writeFileSync(join(repoPath, '.raw/data.md'), '---\ntitle: Raw\n---\nRaw data.');
    mkdirSync(join(repoPath, 'ops'), { recursive: true });
    writeFileSync(join(repoPath, 'ops/deploy.md'), '---\ntitle: Deploy\n---\nOps stuff.');
    gitCommit(repoPath, 'add non-syncable files');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    // These should not create pages
    const readme = await engine.getPage('README');
    expect(readme).toBeNull();

    const raw = await engine.getPage('.raw/data');
    expect(raw).toBeNull();

    const ops = await engine.getPage('ops/deploy');
    expect(ops).toBeNull();
  });

  test('sync stores last_commit and last_run in config', async () => {
    const engine = getEngine();

    const lastCommit = await engine.getConfig('sync.last_commit');
    const lastRun = await engine.getConfig('sync.last_run');
    const repoPathConfig = await engine.getConfig('sync.repo_path');

    expect(lastCommit).toBeTruthy();
    expect(lastCommit!.length).toBe(40); // full SHA
    expect(lastRun).toBeTruthy();
    expect(repoPathConfig).toBe(repoPath);
  });

  test('sync logs to ingest_log', async () => {
    const engine = getEngine();

    const logs = await engine.getIngestLog();
    const syncLogs = logs.filter((l: any) => l.source_type === 'git_sync');

    expect(syncLogs.length).toBeGreaterThanOrEqual(1);
    expect(syncLogs[0].source_ref).toContain(repoPath);
  });

  test('--full reimports everything regardless of last_commit', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      full: true,
    });

    expect(result.status).toBe('first_sync');
    // performFullSync delegates to runImport — verify pages exist instead
    const alice = await engine.getPage('people/alice');
    expect(alice).not.toBeNull();
    const testing = await engine.getPage('concepts/testing');
    expect(testing).not.toBeNull();
  });

  test('dry-run shows changes without applying them', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a new file
    writeFileSync(join(repoPath, 'concepts/dry-run-test.md'), [
      '---',
      'type: concept',
      'title: Dry Run Test',
      '---',
      '',
      'This should not be imported.',
    ].join('\n'));
    gitCommit(repoPath, 'add dry run test');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      dryRun: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(1);

    // Page should NOT exist in DB
    const page = await engine.getPage('concepts/dry-run-test');
    expect(page).toBeNull();

    // Clean up: do a real sync so the commit is consumed
    await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
  });

  test('files with spaces in names get slugified slugs', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a file with spaces (Apple Notes style)
    mkdirSync(join(repoPath, 'Apple Notes'), { recursive: true });
    writeFileSync(join(repoPath, 'Apple Notes/2017-05-03 ohmygreen.md'), [
      '---',
      'title: Ohmygreen Notes',
      '---',
      '',
      'Notes about ohmygreen lunch service.',
    ].join('\n'));
    gitCommit(repoPath, 'add apple notes file with spaces');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);

    // Slug should be slugified (lowercase, spaces → hyphens)
    const page = await engine.getPage('apple-notes/2017-05-03-ohmygreen');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Ohmygreen Notes');

    // Original space-based slug should NOT exist
    const rawSlug = await engine.getPage('Apple Notes/2017-05-03 ohmygreen');
    expect(rawSlug).toBeNull();
  });

  test('incremental sync adds file with special characters', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    // Add a file with parens and special chars
    writeFileSync(join(repoPath, 'Apple Notes/meeting notes (draft).md'), [
      '---',
      'title: Draft Meeting Notes',
      '---',
      '',
      'Some draft notes from the meeting.',
    ].join('\n'));
    gitCommit(repoPath, 'add file with parens');

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('synced');

    // Slug should have parens stripped, spaces → hyphens
    const page = await engine.getPage('apple-notes/meeting-notes-draft');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Draft Meeting Notes');
  });
});

/**
 * E2E: --skip-failed loop with structured error code summary.
 *
 * Closes the v0.22.12 ship-blocker gap from issue #500 — the whole code path
 * (record → classify → block → skip → doctor render → second cycle) had only
 * mocked-JSONL unit coverage. This is the integration test that proves the
 * chain holds together with a real Postgres engine, real git history, and
 * real frontmatter validation.
 *
 * Owns its own repo + sync-failures.jsonl lifecycle so it can't leak state
 * into the shared describeE2E above. Saves and restores the user's real
 * ~/.gbrain/sync-failures.jsonl so running E2E on a developer machine
 * doesn't trash their local sync state.
 */
describeE2E('E2E: sync --skip-failed structured summary loop (v0.22.12, issue #500)', () => {
  let repoPath: string;
  const realFailuresPath = join(homedir(), '.gbrain', 'sync-failures.jsonl');
  let savedFailuresContent: string | null = null;

  beforeAll(async () => {
    await setupDB();

    // Save+clear the real ~/.gbrain/sync-failures.jsonl so the test starts from
    // a known-empty state. Restored in afterAll. This file is per-machine, NOT
    // per-repo, so we have to be defensive about a developer running this
    // suite on their actual brain machine.
    if (existsSync(realFailuresPath)) {
      savedFailuresContent = readFileSync(realFailuresPath, 'utf-8');
      unlinkSync(realFailuresPath);
    }

    // Fresh git repo with one valid file. Mirrors createTestRepo above but
    // scoped to this describe block.
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-skipfailed-e2e-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---', 'type: person', 'title: Alice', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });

    // Restore the user's real sync-failures.jsonl, if any.
    if (savedFailuresContent !== null) {
      mkdirSync(join(homedir(), '.gbrain'), { recursive: true });
      writeFileSync(realFailuresPath, savedFailuresContent);
    } else if (existsSync(realFailuresPath)) {
      // Test wrote one but there was none before. Clean up.
      unlinkSync(realFailuresPath);
    }
  });

  test('full --skip-failed loop: blocks on bad file, skip advances bookmark, doctor shows code breakdown', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const { loadSyncFailures, summarizeFailuresByCode } = await import('../../src/core/sync.ts');
    const engine = getEngine();

    // Step 1: First sync of the clean repo — should succeed.
    let result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('first_sync');
    const firstCommit = await engine.getConfig('sync.last_commit');
    expect(firstCommit).toBeTruthy();

    // Step 2: Add a broken file — frontmatter slug doesn't match path-derived slug.
    // The file path is people/bob.md so the path-derived slug is "people/bob",
    // but we declare slug: "wrong-slug" in frontmatter. import-file.ts:368-377
    // raises "Frontmatter slug ... does not match path-derived slug ..." which
    // classifier hits as SLUG_MISMATCH.
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---', 'type: person', 'title: Bob', 'slug: wrong-slug', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add broken bob"', { cwd: repoPath, stdio: 'pipe' });

    // Step 3: Sync should block. Bookmark must NOT advance.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('blocked_by_failures');
    const afterBlockedCommit = await engine.getConfig('sync.last_commit');
    expect(afterBlockedCommit).toBe(firstCommit); // bookmark stuck at the pre-broken commit

    // JSONL has one unacked entry with code SLUG_MISMATCH.
    let failures = loadSyncFailures();
    expect(failures.length).toBe(1);
    expect(failures[0].code).toBe('SLUG_MISMATCH');
    expect(failures[0].acknowledged).toBeFalsy();
    // Group summary aggregates correctly across the unacked set.
    expect(summarizeFailuresByCode(failures)).toEqual([{ code: 'SLUG_MISMATCH', count: 1 }]);

    // Step 4: Run with skipFailed — bookmark advances, entry gets acked.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true, skipFailed: true });
    expect(result.status).toBe('synced');
    const afterSkipCommit = await engine.getConfig('sync.last_commit');
    expect(afterSkipCommit).not.toBe(firstCommit); // bookmark moved past the broken commit
    failures = loadSyncFailures();
    expect(failures.length).toBe(1);
    expect(failures[0].acknowledged).toBe(true);
    expect(typeof failures[0].acknowledged_at).toBe('string');

    // Step 5: Verify what doctor would render for the historical entry.
    // We call the same primitives doctor's `sync_failures` check uses
    // (src/commands/doctor.ts:252-275) — loadSyncFailures + summarizeFailuresByCode —
    // and assert the rendering string. Directly invoking runDoctor() here is a CLI
    // entrypoint with stdout/exit side effects that would truncate this test mid-flow.
    {
      const all = loadSyncFailures();
      const ackedSummary = summarizeFailuresByCode(all);
      const ackedBreakdown = ackedSummary.map(s => `${s.code}=${s.count}`).join(', ');
      // This is the literal string interpolation doctor.ts:271-274 produces.
      const doctorMessage = `${all.length} historical sync failure(s), all acknowledged [${ackedBreakdown}].`;
      expect(doctorMessage).toContain('SLUG_MISMATCH=1');
      expect(doctorMessage).toContain('1 historical');
    }

    // Step 6: Add a second broken file — this one with a different failure code
    // (also SLUG_MISMATCH but on a different file) so the JSONL has 2 entries
    // with DIFFERENT paths but the same code. This proves both: per-file dedup
    // honors path identity, and summary aggregation sums across files.
    //
    // We'd ideally test a different code class here, but the sync path uses
    // parseMarkdown WITHOUT {validate:true}, so the markdown.ts validation
    // codes (MISSING_OPEN/CLOSE, NESTED_QUOTES, EMPTY_FRONTMATTER, NULL_BYTES)
    // don't naturally surface — they'd need {validate:true} plumbed in. That
    // plumbing is the v0.22.13+ follow-up. For v0.22.12, two SLUG_MISMATCH
    // entries from different files still proves the dedup + aggregation chain.
    writeFileSync(join(repoPath, 'people/carol.md'), [
      '---', 'type: person', 'title: Carol', 'slug: also-wrong-slug', '---', '', 'Body.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add carol with bad slug"', { cwd: repoPath, stdio: 'pipe' });

    // Step 7: Sync blocks again on the new failure. Old entry stays acked.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    expect(result.status).toBe('blocked_by_failures');
    failures = loadSyncFailures();
    expect(failures.length).toBe(2);
    const acked = failures.filter(f => f.acknowledged);
    const unacked = failures.filter(f => !f.acknowledged);
    expect(acked.length).toBe(1);
    expect(acked[0].code).toBe('SLUG_MISMATCH');
    expect(acked[0].path).toContain('bob');
    expect(unacked.length).toBe(1);
    expect(unacked[0].code).toBe('SLUG_MISMATCH');
    expect(unacked[0].path).toContain('carol');

    // Step 8: Skip again — both entries acked, summary aggregates the count.
    result = await performSync(engine, { repoPath, noPull: true, noEmbed: true, skipFailed: true });
    expect(result.status).toBe('synced');
    failures = loadSyncFailures();
    expect(failures.length).toBe(2);
    expect(failures.every(f => f.acknowledged)).toBe(true);

    const finalSummary = summarizeFailuresByCode(failures);
    expect(finalSummary).toEqual([{ code: 'SLUG_MISMATCH', count: 2 }]);
  });
});

/**
 * E2E: batch delete pipeline against real Postgres (v0.41.21.0).
 *
 * Closes the production hotspot from PR #1538 — a single commit deleting
 * 73K files used to take ~5 hours (146K individual DB round-trips). The
 * v0.41.21.0 fix batches both phases:
 *   - Phase 1: SELECT slug FROM pages WHERE source_path = ANY($1) at
 *     BATCH_SIZE=100 → ceil(N/100) round-trips
 *   - Phase 2: engine.deletePages([100 slugs]) → ceil(N/100) DELETEs with
 *     RETURNING slug, each wrapped in withRetry(BULK_RETRY_OPTS) for
 *     Supavisor circuit-breaker recovery (v0.41.19 cathedral)
 *
 * These E2E cases run against real Postgres so the FK CASCADE through
 * content_chunks, the array-binding wire format, and the withRetry
 * audit-emission integration all exercise the production path (not the
 * PGLite WASM stand-in).
 */
describeE2E('E2E: batch sync deletes (v0.41.21.0)', () => {
  let repoPath: string;

  beforeAll(async () => {
    await setupDB();
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('engine.deletePages returns deleted slugs and cascades through content_chunks', async () => {
    const engine = getEngine();

    // Seed: insert 100 pages directly + a few chunk rows so we can verify
    // FK cascade. Use a unique source so the assertion isolates from any
    // pre-existing test data on the same DB.
    const sourceId = `e2e-batch-${Date.now()}`;
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [sourceId],
    );

    const slugs = Array.from({ length: 100 }, (_, i) => `bdel/${sourceId}/slug-${String(i).padStart(3, '0')}`);
    for (const slug of slugs) {
      const page = await engine.putPage(slug, {
        type: 'concept',
        title: slug,
        compiled_truth: `Body for ${slug}`,
        timeline: '',
        frontmatter: { type: 'concept' },
      }, { sourceId });
      // Add a content chunk so we can verify CASCADE.
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: page.compiled_truth, chunk_source: 'compiled_truth' },
      ], { sourceId });
    }

    // Sanity: chunks exist before delete.
    const beforeChunks = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id IN
         (SELECT id FROM pages WHERE source_id = $1)`,
      [sourceId],
    );
    expect(beforeChunks[0].n).toBe(100);

    // Single-call batch delete.
    const deleted = await engine.deletePages(slugs, { sourceId });
    expect(deleted.length).toBe(100);
    expect(deleted.sort()).toEqual([...slugs].sort());

    // FK CASCADE removed the chunks too.
    const afterChunks = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM content_chunks WHERE page_id IN
         (SELECT id FROM pages WHERE source_id = $1)`,
      [sourceId],
    );
    expect(afterChunks[0].n).toBe(0);

    // Pages gone.
    const afterPages = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      [sourceId],
    );
    expect(afterPages[0].n).toBe(0);

    // Cleanup the source row.
    await engine.executeRaw(`DELETE FROM sources WHERE id = $1`, [sourceId]);
  }, 60_000);

  test('end-to-end performSync deleting 250 files batches into ≤3 SELECT + ≤3 deletePages calls', async () => {
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-e2e-batch-deletes-'));
    execSync('git init -q', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });

    // Seed: 250 markdown files in concepts/, commit, first-sync, then
    // delete all 250 + commit, then incremental sync. The incremental
    // pass is the one that exercises the delete loop.
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    for (let i = 0; i < 250; i++) {
      const name = `e2e-bulk-${String(i).padStart(4, '0')}`;
      writeFileSync(
        join(repoPath, 'concepts', `${name}.md`),
        `---\ntype: concept\ntitle: ${name}\n---\n\nBaseline.\n`,
      );
    }
    execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });

    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();

    const first = await performSync(engine, {
      repoPath, full: true, noPull: true, noEmbed: true, noExtract: true,
    });
    expect(['first_sync', 'synced']).toContain(first.status);

    // Sanity: pages landed.
    const seeded = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/e2e-bulk-%'`,
    );
    expect(seeded[0].n).toBe(250);

    // Wrap the engine in a counting proxy.
    let phase1Selects = 0;
    let phase2DeletePagesCalls = 0;
    const origExec = engine.executeRaw.bind(engine);
    const origDel = engine.deletePages.bind(engine);
    (engine.executeRaw as unknown) = (async <T>(sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      if (s.includes('select') && s.includes('source_path') && s.includes('any(') && s.includes('order by')) {
        phase1Selects++;
      }
      return origExec<T>(sql, params);
    });
    (engine.deletePages as unknown) = (async (
      ds: string[],
      opts?: { sourceId?: string; signal?: AbortSignal },
    ) => {
      phase2DeletePagesCalls++;
      return origDel(ds, opts);
    });

    try {
      rmSync(join(repoPath, 'concepts'), { recursive: true, force: true });
      execSync('git add -A && git commit -q -m bulk-delete', { cwd: repoPath, stdio: 'pipe' });
      await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    } finally {
      (engine.executeRaw as unknown) = origExec;
      (engine.deletePages as unknown) = origDel;
    }

    // 250 / BATCH_SIZE=100 = 3 batches each.
    expect(phase1Selects).toBeGreaterThan(0);
    expect(phase1Selects).toBeLessThanOrEqual(3);
    expect(phase2DeletePagesCalls).toBeGreaterThan(0);
    expect(phase2DeletePagesCalls).toBeLessThanOrEqual(3);

    // All 250 pages gone.
    const remaining = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/e2e-bulk-%'`,
    );
    expect(remaining[0].n).toBe(0);
  }, 120_000);

  test('abort signal mid-sync returns partial(timeout) with completed-batch pagesAffected', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'gbrain-e2e-abort-deletes-'));
    try {
      execSync('git init -q', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });

      // Seed: 300 files so Phase 1 has 3 batches. Abort after batch 1 →
      // expect pagesAffected to reflect ≤ 100 deletes (Phase 2 didn't run
      // because abort fires at the top of every Phase-1 batch).
      mkdirSync(join(repo, 'concepts'), { recursive: true });
      for (let i = 0; i < 300; i++) {
        const name = `e2e-abort-${String(i).padStart(4, '0')}`;
        writeFileSync(
          join(repo, 'concepts', `${name}.md`),
          `---\ntype: concept\ntitle: ${name}\n---\n\nBaseline.\n`,
        );
      }
      execSync('git add -A && git commit -q -m initial', { cwd: repo, stdio: 'pipe' });

      const { performSync } = await import('../../src/commands/sync.ts');
      const engine = getEngine();
      await performSync(engine, { repoPath: repo, full: true, noPull: true, noEmbed: true, noExtract: true });

      // Delete all 300, commit. Abort the signal before sync starts so the
      // very first batch check trips. partial('timeout') returns; pagesAffected
      // is empty because we aborted before any Phase 2 batch ran.
      rmSync(join(repo, 'concepts'), { recursive: true, force: true });
      execSync('git add -A && git commit -q -m abort-delete', { cwd: repo, stdio: 'pipe' });

      const ac = new AbortController();
      ac.abort();
      const result = await performSync(engine, {
        repoPath: repo, noPull: true, noEmbed: true, noExtract: true, signal: ac.signal,
      });
      expect(result.status).toBe('partial');
      // pagesAffected is the truthful record of completed deletes — should
      // be empty since the abort fires at the top of Phase 1 (before any
      // deletePages call).
      expect(result.pagesAffected.length).toBe(0);

      // The 300 pages are STILL present (abort happened before delete).
      const remaining = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/e2e-abort-%'`,
      );
      expect(remaining[0].n).toBe(300);

      // Cleanup: hard-delete the remaining 300 directly so the next test run
      // doesn't see them.
      const allSlugs = (await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE slug LIKE 'concepts/e2e-abort-%'`,
      )).map(r => r.slug);
      await engine.deletePages(allSlugs);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);
});

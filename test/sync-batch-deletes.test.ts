/**
 * v0.41.21.0 — batch sync deletes (supersedes PR #1538).
 *
 * Coverage targets (decisions D1, D6, D7, D9, D10, D11 from
 * /Users/garrytan/.claude/plans/system-instruction-you-are-working-dynamic-shore.md):
 *
 * Engine-level (`engine.deletePages` PGLite):
 *   - returns deleted slugs (D10)
 *   - empty input → []
 *   - missing slugs in input → returns shorter list
 *   - internal batching at 100 (250 deletes work)
 *   - signal abort between internal batches → returns prefix
 *   - source scoping (opts.sourceId + default-when-unset)
 *
 * Sync-level (`performSync` against PGLite + synthetic git repo, incremental
 * mode so the delete loop fires):
 *   - D6 regression: no-sourceId path scopes to 'default'; sibling source survives
 *   - D7 regression: ORDER BY slug ASC pins deterministic slug pick
 *   - fallback to resolveSlugForPath when no DB row
 *   - D9 regression: query-count is O(N/100) batched
 *
 * Structural source (D1 regression):
 *   - delete block has matching progress.start()/progress.finish() count
 *     (no trailing duplicate finish from the PR #1538 pattern)
 *
 * Test isolation: canonical PGLite block per CLAUDE.md R3 + R4. No
 * module mocks (R2; banned because they leak across files in the shard
 * process — use *.serial.test.ts when unavoidable). No process.env mutations.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureSource(sourceId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId],
  );
}

async function insertPage(slug: string, sourceId = 'default', sourcePath?: string): Promise<void> {
  await ensureSource(sourceId);
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path)
     VALUES ($1, $2, 'concept', $3, 'body', '', '{}'::jsonb, $4, $5)`,
    [sourceId, slug, slug, `hash-${slug}`, sourcePath ?? slug],
  );
}

async function pageExists(slug: string, sourceId: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2`,
    [slug, sourceId],
  );
  return rows[0].n > 0;
}

function gitInit(repo: string): void {
  execSync('git init -q', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
}

function writeConcept(repo: string, name: string): void {
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  writeFileSync(
    join(repo, 'concepts', `${name}.md`),
    `---\ntype: concept\ntitle: ${name}\n---\n\nBaseline.\n`,
  );
}

// ---------------------------------------------------------------------------
// describe 1 — engine.deletePages (7 cases)
// ---------------------------------------------------------------------------

describe('engine.deletePages — engine-level contract (D10 + D11)', () => {
  test('returns the slugs that were actually deleted (D10)', async () => {
    await insertPage('foo');
    await insertPage('bar');
    await insertPage('baz');
    const deleted = await engine.deletePages(['foo', 'bar', 'baz']);
    expect(deleted.sort()).toEqual(['bar', 'baz', 'foo']);
    expect(await pageExists('foo', 'default')).toBe(false);
    expect(await pageExists('bar', 'default')).toBe(false);
    expect(await pageExists('baz', 'default')).toBe(false);
  });

  test('empty input → []', async () => {
    const deleted = await engine.deletePages([]);
    expect(deleted).toEqual([]);
  });

  test('missing slugs in input → returns only the ones that existed', async () => {
    await insertPage('present-a');
    await insertPage('present-b');
    const deleted = await engine.deletePages(['present-a', 'ghost-x', 'present-b', 'ghost-y']);
    expect(deleted.sort()).toEqual(['present-a', 'present-b']);
  });

  test('internal batching at 100 — 250-slug call deletes all 250', async () => {
    const slugs = Array.from({ length: 250 }, (_, i) => `page-${String(i).padStart(4, '0')}`);
    for (const s of slugs) await insertPage(s);
    const deleted = await engine.deletePages(slugs);
    expect(deleted.length).toBe(250);
    const remaining = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'`,
    );
    expect(remaining[0].n).toBe(0);
  });

  test('signal aborted before first batch → returns prefix only', async () => {
    const slugs = Array.from({ length: 250 }, (_, i) => `slug-${String(i).padStart(4, '0')}`);
    for (const s of slugs) await insertPage(s);

    const ac = new AbortController();
    ac.abort();
    const deleted = await engine.deletePages(slugs, { signal: ac.signal });
    expect(deleted).toEqual([]);

    const remaining = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = 'default'`,
    );
    expect(remaining[0].n).toBe(250);
  });

  test('scopes to opts.sourceId — sibling sources survive', async () => {
    await insertPage('shared', 'source-a');
    await insertPage('shared', 'source-b');
    const deleted = await engine.deletePages(['shared'], { sourceId: 'source-a' });
    expect(deleted).toEqual(['shared']);
    expect(await pageExists('shared', 'source-a')).toBe(false);
    expect(await pageExists('shared', 'source-b')).toBe(true);
  });

  test('default sourceId is "default" when opts.sourceId is unset', async () => {
    await insertPage('orphan', 'default');
    await insertPage('orphan', 'other-source');
    const deleted = await engine.deletePages(['orphan']);
    expect(deleted).toEqual(['orphan']);
    expect(await pageExists('orphan', 'default')).toBe(false);
    expect(await pageExists('orphan', 'other-source')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe 2 — performSync delete loop (sync-level, with git repo)
// ---------------------------------------------------------------------------

describe('performSync delete loop — sync-level contract (D6 + D7 + D9)', () => {
  let repoPath: string;

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-batch-deletes-'));
    gitInit(repoPath);
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  // Bootstrap: first full sync sets the bookmark + imports baseline pages.
  // Then we mutate the repo (commit a delete) and call incremental sync.
  // The incremental path is the one that exercises the delete loop.
  async function firstSyncAndDelete(filesToDelete: string[]): Promise<void> {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true, noExtract: true });
    expect(['first_sync', 'synced']).toContain(first.status);

    for (const rel of filesToDelete) rmSync(join(repoPath, rel));
    execSync('git add -A && git commit -q -m delete', { cwd: repoPath, stdio: 'pipe' });

    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    // Don't assert exact status — different combinations of deletes may
    // return 'synced' or 'up_to_date'. The behavioral assertions in each
    // test verify the actual delete happened.
    expect(second).toBeTruthy();
  }

  test('D6 regression: no-sourceId path scopes to source_id=default; sibling source survives', async () => {
    // The page in 'default' tracks the file in the repo. Sibling source
    // 'other-source' has a page with the SAME source_path but a different
    // slug — pre-fix code would resolve THAT slug (no source scope on
    // SELECT) and then DELETE on slug='keep-me' AND source_id='default'
    // which would no-op, leaving the 'default' page un-deleted AND
    // accidentally orphaning the 'other-source' page from the delete sweep.
    // D6 fix scopes BOTH lookup AND delete to 'default'.
    writeConcept(repoPath, 'foo');
    execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });
    await insertPage('keep-me', 'other-source', 'concepts/foo.md');

    await firstSyncAndDelete(['concepts/foo.md']);

    // Default-source 'foo' page is gone (D6 fix worked).
    expect(await pageExists('foo', 'default')).toBe(false);
    // Sibling source's row at the same source_path survives unchanged.
    expect(await pageExists('keep-me', 'other-source')).toBe(true);
  }, 60_000);

  test('D7 regression: ORDER BY slug ASC pins deterministic slug pick when duplicate source_paths exist', async () => {
    // Two rows in 'default' with the same source_path. Pathological but
    // possible (operator hand-inserted, migration drift). The Map collapse
    // in Phase 1 must pick the lexicographically-first slug.
    writeConcept(repoPath, 'dup');
    execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });

    // Pre-seed two pages with the same source_path. One will already exist
    // from the first sync (slug 'concepts/dup'); add a sibling.
    await insertPage('aaa-collision', 'default', 'concepts/dup.md');
    await insertPage('zzz-collision', 'default', 'concepts/dup.md');

    await firstSyncAndDelete(['concepts/dup.md']);

    // ORDER BY slug ASC → 'aaa-collision' wins Map.set first. The sync
    // deletes that one. The 'zzz-collision' sibling survives — proves the
    // pick is deterministic AND the lexicographic-first is chosen.
    expect(await pageExists('aaa-collision', 'default')).toBe(false);
    expect(await pageExists('zzz-collision', 'default')).toBe(true);
  }, 60_000);

  test('fallback to resolveSlugForPath when no DB row matches source_path', async () => {
    // No pre-seed. The page exists in git but never in the brain (no
    // first-sync persistence; we skip importing it by writing AFTER the
    // initial commit and removing it before sync sees it). The delete
    // path should resolve to a path-derived slug and run a no-op DELETE.
    writeConcept(repoPath, 'orphan');
    execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });
    // The first sync imports 'concepts/orphan' as a page. We delete it
    // from the repo so the incremental pass treats it as a deletion.
    // The DB row does exist (from the first sync), so the fallback path
    // is exercised only via the case where source_path is null. For this
    // test, the important assertion is that the delete path completes
    // without throwing on an unmatched fallback.

    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true, noExtract: true });
    expect(['first_sync', 'synced']).toContain(first.status);

    // Null out source_path on the imported row to force the fallback path.
    await engine.executeRaw(
      `UPDATE pages SET source_path = NULL WHERE slug = 'concepts/orphan'`,
    );

    rmSync(join(repoPath, 'concepts/orphan.md'));
    execSync('git add -A && git commit -q -m delete', { cwd: repoPath, stdio: 'pipe' });

    // Should NOT throw, even though the SELECT will return no row and
    // the code must fall through to resolveSlugForPath('concepts/orphan.md').
    const second = await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    expect(second).toBeTruthy();
  }, 60_000);

  test('D9 regression: query-count is O(N/100) batched, not 2N individual queries', async () => {
    // Seed 250 files in the repo, sync them once, then delete all 250 in
    // one commit. The incremental delete loop should fire ≤ 3 batched
    // SELECTs (250/100 = 3 batches) + ≤ 3 deletePages calls.
    // Pre-fix code would fire 250 SELECTs + 250 DELETEs.
    mkdirSync(join(repoPath, 'concepts'), { recursive: true });
    for (let i = 0; i < 250; i++) {
      const name = `bulk-${String(i).padStart(4, '0')}`;
      writeFileSync(
        join(repoPath, 'concepts', `${name}.md`),
        `---\ntype: concept\ntitle: ${name}\n---\n\nBaseline.\n`,
      );
    }
    execSync('git add -A && git commit -q -m initial', { cwd: repoPath, stdio: 'pipe' });

    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true, noExtract: true });
    expect(['first_sync', 'synced']).toContain(first.status);

    // Sanity: all 250 pages landed.
    const seeded = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/bulk-%'`,
    );
    expect(seeded[0].n).toBe(250);

    // Now wrap engine methods to count.
    let phase1Selects = 0;
    let phase2DeletePagesCalls = 0;
    const origExec = engine.executeRaw.bind(engine);
    const origDel = engine.deletePages.bind(engine);
    engine.executeRaw = (async <T>(sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      if (
        s.includes('select') &&
        s.includes('source_path') &&
        s.includes('any(') &&
        s.includes('order by')
      ) {
        phase1Selects++;
      }
      return origExec<T>(sql, params);
    }) as typeof engine.executeRaw;
    engine.deletePages = (async (slugs: string[], opts?: { sourceId?: string; signal?: AbortSignal }) => {
      phase2DeletePagesCalls++;
      return origDel(slugs, opts);
    }) as typeof engine.deletePages;

    try {
      rmSync(join(repoPath, 'concepts'), { recursive: true, force: true });
      execSync('git add -A && git commit -q -m bulk-delete', { cwd: repoPath, stdio: 'pipe' });
      await performSync(engine, { repoPath, noPull: true, noEmbed: true, noExtract: true });
    } finally {
      engine.executeRaw = origExec;
      engine.deletePages = origDel;
    }

    // 250 deletes / 100 per batch = 3 batches each.
    expect(phase1Selects).toBeGreaterThan(0); // batched path actually ran
    expect(phase1Selects).toBeLessThanOrEqual(3);
    expect(phase2DeletePagesCalls).toBeGreaterThan(0);
    expect(phase2DeletePagesCalls).toBeLessThanOrEqual(3);

    // All 250 pages actually deleted.
    const remaining = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE 'concepts/bulk-%'`,
    );
    expect(remaining[0].n).toBe(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// describe 3 — D1 single-finish() regression (source-level structural)
// ---------------------------------------------------------------------------

describe('D1 regression — no trailing duplicate progress.finish() in delete block', () => {
  test('source of sync.ts has matching start/finish counts in the deletes block', () => {
    // PR #1538 wrapped both Phase-2 branches in their own start/finish
    // but kept the legacy outer finish, so finish fired twice for the
    // deletes block. A future refactor that re-adds the extra finish
    // should fail this test.
    const src = readFileSync(
      join(__dirname, '../src/commands/sync.ts'),
      'utf8',
    );
    const startIdx = src.indexOf('if (filtered.deleted.length > 0) {');
    expect(startIdx).toBeGreaterThan(-1);

    // Walk from the opening brace, counting nested braces, to find the
    // matching close.
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = src.slice(startIdx, endIdx);

    // Strip line comments AND block comments before counting — comments
    // mention progress.finish() in prose and would inflate the count.
    const stripped = block
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/.*$/gm, ''); // line comments

    const startCalls = (stripped.match(/progress\.start\(/g) ?? []).length;
    const finishCalls = (stripped.match(/progress\.finish\(\)/g) ?? []).length;

    // The deletes block has 2 phases (resolve + delete). Each phase has:
    //   - 1 progress.start at top
    //   - 1 progress.finish on the abort early-return path
    //   - 1 progress.finish on the normal exit path
    // Total: 2 starts, 4 finishes.
    //
    // Pre-fix bug (PR #1538): 5 finishes for 2 starts — an extra trailing
    // finish() outside both phases. Post-fix: 4 finishes for 2 starts.
    expect(startCalls).toBe(2);
    expect(finishCalls).toBe(4);

    // Structural shape check: NO trailing bare `progress.finish()` after
    // a closing brace that itself contained a finish. This is the literal
    // PR #1538 pattern. Match: `progress.finish();\n  }\n  progress.finish();`
    expect(stripped).not.toMatch(
      /progress\.finish\(\);\s*\n\s*}\s*\n\s*progress\.finish\(\);/,
    );
  });
});

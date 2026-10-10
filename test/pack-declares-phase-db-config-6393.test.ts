/**
 * #6393 — packDeclaresPhase must resolve the active pack through the same engine-aware
 * path as `schema active`, so a brain whose schema_pack is set only in the database
 * config has its pack-gated phases run instead of skipped as not_in_active_pack.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { packDeclaresPhase } from '../src/core/cycle.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const HOME = mkdtempSync(join(tmpdir(), 'gbrain-6393-'));
const WITH_PHASE = 'declares-xa-6393';
const WITHOUT_PHASE = 'declares-nothing-6393';
const paths = new Map<string, string>();

function writePack(name: string, phases: string[]): string {
  const dir = join(HOME, 'schema-packs', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'pack.yaml');
  writeFileSync(path, [
    'api_version: gbrain-schema-pack-v1', `name: ${name}`, 'version: 1.0.0', 'description: ""',
    'gbrain_min_version: 0.38.0', 'extends: null', 'borrow_from: []', 'page_types: []', 'link_types: []',
    'frontmatter_links: []', 'takes_kinds:', '  - fact', 'enrichable_types: []', 'filing_rules: []',
    phases.length ? 'phases:' : 'phases: []', ...phases.map(p => `  - ${p}`), '',
  ].join('\n'), 'utf-8');
  return path;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  paths.set(WITH_PHASE, writePack(WITH_PHASE, ['extract_atoms']));
  paths.set(WITHOUT_PHASE, writePack(WITHOUT_PHASE, []));
  __setPackLocatorForTests((name) => paths.get(name) ?? null);
}, 120_000);

afterAll(async () => {
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  await engine.disconnect();
});

beforeEach(async () => {
  _resetPackCacheForTests();
  await engine.executeRaw("DELETE FROM config WHERE key = 'schema_pack'");
});

// The env var is deliberately unset: the pack is named only in the database config.
const ENV_NO_PACK = { GBRAIN_HOME: HOME, GBRAIN_SCHEMA_PACK: undefined } as unknown as Record<string, string>;

test('a pack named only in the database config declares its phases', async () => {
  await engine.setConfig('schema_pack', WITH_PHASE);
  await withEnv(ENV_NO_PACK, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(true);
  });
});

test('a database-config pack that does not declare the phase still reports false', async () => {
  await engine.setConfig('schema_pack', WITHOUT_PHASE);
  await withEnv(ENV_NO_PACK, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(false);
  });
});

test('an unresolvable database-config pack stays fail-open to false', async () => {
  await engine.setConfig('schema_pack', 'no-such-pack-6393');
  await withEnv(ENV_NO_PACK, async () => {
    expect(await packDeclaresPhase(engine, 'extract_atoms')).toBe(false);
  });
});

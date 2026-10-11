/**
 * #6497 `gbrain decide status` "newer reference available" hint and `calibrations adopt ref:<id>`.
 *
 * The hint must only name a reference for the SAME slot, call site and provider as the calibration the
 * status line reports (the conflict slot has a sweep row and a later review_withdraw row), and the command
 * it prints must run: `adopt` accepts a built-in `ref:<id>` and stores it verbatim, the way
 * `enable --recommended` and the eval flags already do.
 * Serial: captures console output and configures the process gateway with a TypeSafe key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { runDecideCommand } from '../../src/commands/decide.ts';
import { REFERENCE_CALIBRATIONS } from '../../src/core/ai/decide/reference-calibrations.ts';
import { flushDecideWrites, insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';

const SWEEP_REF = 'ref:conflict-jev-1.13.0-2026-09-30';
const WITHDRAW_REF = 'ref:conflict-review-withdraw-jev-1.13.0-2026-10-05';
const CONFLICT_CAL_KEY = 'decide.slots.conflict.calibration';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // The status command reads the key from the configured gateway environment.
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { TYPESAFE_API_KEY: 'test-key-6497' } });
});

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  __resetDecideStoreForTests();
  await resetPgliteState(engine);
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try {
    const code = await runDecideCommand(engine, args);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function conflictStatus() {
  const { code, out } = await run(['status', '--json']);
  expect(code).toBe(0);
  return JSON.parse(out).slots.find((s: { slot: string }) => s.slot === 'conflict');
}

describe('#6497 the conflict slot has two reference rows with different call sites', () => {
  test('fixture sanity: the table still has a sweep row and a later review_withdraw row for the pinned provider', () => {
    const rows = REFERENCE_CALIBRATIONS.filter((r) => r.slot === 'conflict');
    expect(rows.map((r) => `ref:${r.id}`)).toEqual([SWEEP_REF, WITHDRAW_REF]);
    expect(rows.map((r) => r.call_site)).toEqual(['sweep', 'review_withdraw']);
    expect(new Set(rows.map((r) => r.provider)).size).toBe(1);
  });
});

describe('#6497 status hint', () => {
  test('a key-default conflict slot reports the sweep reference and offers no newer reference', async () => {
    const conflict = await conflictStatus();
    expect(conflict.calibration).toBe(SWEEP_REF);
    expect(conflict.newer_reference).toBeNull();
    const human = await run(['status']);
    expect(human.out).not.toContain('newer reference available');
  });
});

describe('#6497 calibrations adopt ref:<id>', () => {
  test('adopting the sweep reference succeeds, is stored verbatim, and status keeps reporting it', async () => {
    const adopted = await run(['calibrations', 'adopt', SWEEP_REF]);
    expect(adopted.code).toBe(0);
    expect(adopted.out).toContain(SWEEP_REF);
    expect(await engine.getConfig(CONFLICT_CAL_KEY)).toBe(SWEEP_REF);
    const conflict = await conflictStatus();
    expect(conflict.calibration).toBe(SWEEP_REF);
    expect(conflict.newer_reference).toBeNull();
  });

  test('adopting the review_withdraw reference is accepted and leaves the sweep status line on the sweep reference with no hint', async () => {
    const adopted = await run(['calibrations', 'adopt', WITHDRAW_REF]);
    expect(adopted.code).toBe(0);
    expect(await engine.getConfig(CONFLICT_CAL_KEY)).toBe(WITHDRAW_REF);
    const conflict = await conflictStatus();
    expect(conflict.calibration).toBe(SWEEP_REF);
    expect(conflict.newer_reference).toBeNull();
  });

  test('an unknown reference exits 1 and leaves the configuration untouched', async () => {
    const adopted = await run(['calibrations', 'adopt', 'ref:no-such-reference']);
    expect(adopted.code).toBe(1);
    expect(adopted.err).toContain('ref:no-such-reference');
    expect(await engine.getConfig(CONFLICT_CAL_KEY)).toBeNull();
  });

  test('retire and restore refuse a built-in reference and leave the configuration untouched', async () => {
    for (const action of ['retire', 'restore']) {
      const result = await run(['calibrations', action, SWEEP_REF]);
      expect(result.code).toBe(1);
      expect(result.err).toContain('built in');
    }
    expect(await engine.getConfig(CONFLICT_CAL_KEY)).toBeNull();
  });

  test('a local id still takes the unchanged local path', async () => {
    const missing = await run(['calibrations', 'adopt', 'local:999']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('calibration local:999 not found');
  });
});

describe('#6497 positive control: a real newer reference for the same call site still produces a runnable hint', () => {
  test('a local sweep calibration in use leaves the sweep reference to offer, and the printed command works', async () => {
    const id = await insertCalibration(engine, {
      slot: 'conflict', call_site: 'sweep', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.8, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.05, retest_sd: 0.01, repack_sd: 0.01, n: 60, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('conflict'), notes: null,
    });
    await flushDecideWrites();
    const adoptLocal = await run(['calibrations', 'adopt', `local:${id}`]);
    expect(adoptLocal.code).toBe(0);

    const before = await conflictStatus();
    expect(before.calibration).toBe(`local:${id}`);
    // The offered reference is for the SAME call site as the calibration in use (sweep), never the later review_withdraw row.
    expect(before.newer_reference).toBe(SWEEP_REF);
    const human = await run(['status']);
    expect(human.out).toContain(`newer reference available: ${SWEEP_REF} (gbrain decide calibrations adopt ${SWEEP_REF})`);

    // The command the hint prints runs, and afterwards the hint is gone.
    const adoptRef = await run(['calibrations', 'adopt', SWEEP_REF]);
    expect(adoptRef.code).toBe(0);
    const after = await conflictStatus();
    expect(after.calibration).toBe(SWEEP_REF);
    expect(after.newer_reference).toBeNull();
  });
});

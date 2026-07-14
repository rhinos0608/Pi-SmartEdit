/**
 * Tests for the static-checks verification config lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import type { StaticCheckConfig } from "../../src/verification/types";
import {
  defaultStaticCheckConfig,
  mergeStaticCheckConfig,
  mergeVerificationConfig,
  defaultVerificationConfig,
} from "../../src/verification/config";

describe("defaultStaticCheckConfig", () => {
  it("returns defaults when env is empty", () => {
    const cfg = defaultStaticCheckConfig({});
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.fakeLogic, true);
    assert.strictEqual(cfg.lint, true);
    assert.strictEqual(cfg.maxFindingsPerCheck, 10);
  });

  it("reads SMART_EDIT_FAKE_LOGIC_ENABLED from env", () => {
    const cfg = defaultStaticCheckConfig({
      SMART_EDIT_FAKE_LOGIC_ENABLED: "false",
    });
    assert.strictEqual(cfg.fakeLogic, false);
    assert.strictEqual(cfg.lint, true);
  });

  it("reads SMART_EDIT_LINT_ENABLED from env", () => {
    const cfg = defaultStaticCheckConfig({
      SMART_EDIT_LINT_ENABLED: "0",
    });
    assert.strictEqual(cfg.lint, false);
    assert.strictEqual(cfg.fakeLogic, true);
  });

  it("accepts mixed-case env values", () => {
    const cfg = defaultStaticCheckConfig({
      SMART_EDIT_FAKE_LOGIC_ENABLED: "TRUE",
      SMART_EDIT_LINT_ENABLED: "NO",
    });
    assert.strictEqual(cfg.fakeLogic, true);
    assert.strictEqual(cfg.lint, false);
  });
});

describe("mergeStaticCheckConfig", () => {
  it("returns base when partial is absent", () => {
    const base = defaultStaticCheckConfig({});
    const merged = mergeStaticCheckConfig(base);
    assert.deepStrictEqual(merged, base);
  });

  it("shallow-merges partial overrides", () => {
    const base = defaultStaticCheckConfig({});
    const merged = mergeStaticCheckConfig(base, {
      fakeLogic: false,
      maxFindingsPerCheck: 42,
    });
    assert.strictEqual(merged.enabled, true);
    assert.strictEqual(merged.fakeLogic, false);
    assert.strictEqual(merged.lint, true);
    assert.strictEqual(merged.maxFindingsPerCheck, 42);
  });
});

describe("mergeVerificationConfig staticChecks lane", () => {
  it("preserves base staticChecks when partial omits it", () => {
    const base = defaultVerificationConfig({});
    const merged = mergeVerificationConfig(base, { enabled: false });
    assert.strictEqual(merged.staticChecks.enabled, true);
    assert.strictEqual(merged.staticChecks.fakeLogic, true);
    assert.strictEqual(merged.staticChecks.lint, true);
    assert.strictEqual(merged.staticChecks.maxFindingsPerCheck, 10);
  });

  it("merges partial staticChecks correctly", () => {
    const base = defaultVerificationConfig({
      SMART_EDIT_FAKE_LOGIC_ENABLED: "false",
    });
    const merged = mergeVerificationConfig(base, {
      staticChecks: { lint: false, maxFindingsPerCheck: 5 } as StaticCheckConfig,
    });
    assert.strictEqual(merged.staticChecks.enabled, true);
    assert.strictEqual(merged.staticChecks.fakeLogic, false);
    assert.strictEqual(merged.staticChecks.lint, false);
    assert.strictEqual(merged.staticChecks.maxFindingsPerCheck, 5);
  });
});

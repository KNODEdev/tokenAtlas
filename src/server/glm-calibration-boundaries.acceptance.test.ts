import { expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { storedGlmMeasurement } from "./glm-limit";
import { buildSubscriptionCapacities } from "./capacity-equivalents";
import type { GlmProbeSample } from "../providers/adapters/glm";
import type { RateCard } from "./pricing";

const noWindows = () => { throw new Error("an invalid sample must not read windows"); };
const observation = {
  ts: "2026-09-17T12:00:00Z", kind: "weekly", window_hours: 168,
  resets_at: "2026-09-20T12:00:00Z", percent: 20, used: 20, allowance: 100,
  remaining: 80, vendor_percent: 20, level: "fixture",
} as GlmProbeSample;

test("a GLM observation after its declared reset cannot calibrate the previous window", () => {
  const db = new Database(":memory:");
  try {
    const invalid = { ...observation, ts: "2026-09-21T12:00:00Z" };
    // An invalid sample never looks up a window (none exists here).
    const measured = storedGlmMeasurement(db, "glm", invalid, Date.parse(invalid.ts), noWindows);
    expect(measured.spend).toBeNull();
    expect(measured.credits_per_mtok).toBeNull();
  } finally { db.close(); }
});

test("selecting no capacity account also skips the configured legacy Claude account", () => {
  const db = new Database(":memory:");
  try {
    const result = buildSubscriptionCapacities(db, {vendors:{},subscriptions:{}} as RateCard, new Map(), {
      subscriptions: [], claudeGauge:{subscription:"claude-fixture",plan:"Max",observations:[]},
      grokGauge:{subscription:"grok-fixture",observations:[]},
    });
    expect(result.size).toBe(0);
  } finally { db.close(); }
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE])(
  "invalid GLM window hours %s cannot throw or create a calibration", hours => {
    const db = new Database(":memory:");
    try {
      const sample = { ...observation, window_hours: hours };
      const measured = storedGlmMeasurement(db, "glm", sample, Date.parse(sample.ts), noWindows);
      expect(measured.spend).toBeNull();
      expect(measured.credits_per_mtok).toBeNull();
      expect(measured.window_start).toBeNull();
    } finally { db.close(); }
  },
);

test.each(["2026-09-13T11:59:59Z", "2026-09-20T12:00:00Z", "invalid"])(
  "GLM sample timestamp %s outside the half-open reset window stays unknown", ts => {
    const db = new Database(":memory:");
    try {
      const measured = storedGlmMeasurement(db, "glm", { ...observation, ts }, Date.parse(ts), noWindows);
      expect(measured.spend).toBeNull();
      expect(measured.credits_per_mtok).toBeNull();
    } finally { db.close(); }
  },
);

test("empty capacity selection returns before inspecting any provider configuration", () => {
  const db = new Database(":memory:");
  try {
    const options = { subscriptions: [] as string[],
      get claudeGauge(): never { throw new Error("Unselected Claude config was inspected"); },
      get grokGauge(): never { throw new Error("Unselected Grok config was inspected"); },
    };
    expect(buildSubscriptionCapacities(db, { vendors: {}, subscriptions: {} } as RateCard, new Map(), options).size).toBe(0);
  } finally { db.close(); }
});

test.each([{ claudeAccounts: undefined }, { claudeAccounts: ["claude-fixture"] }])("nonempty capacity selection skips unselected Claude mode %j", ({ claudeAccounts }) => {
  const db = new Database(":memory:");
  try {
    const result = buildSubscriptionCapacities(db, { vendors: {}, subscriptions: {} } as RateCard, new Map(), {
      subscriptions: ["grok-fixture"], claudeAccounts,
      claudeGauge: { subscription: "claude-fixture", plan: "Max", observations: [] },
      grokGauge: { subscription: "grok-fixture", observations: [] },
    });
    expect([...result.keys()]).toEqual(["grok-fixture"]);
  } finally { db.close(); }
});

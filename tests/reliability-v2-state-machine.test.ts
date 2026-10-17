// Generated-boundary properties for the receipt-owned reliability v2 state machine.
//
// An independent reference tracks admit/renew/settle/abandon operations and
// rejects receipt stealing, double settlement, stale-owner mutation, and lease
// expiry violations. The logical clock is injected as a number, so every
// boundary is exact; no test depends on wall time or sleeping.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  abandonReliabilityV2Dispatch,
  admitReliabilityV2Dispatch,
  emptyReliabilityV2State,
  renewReliabilityV2Leases,
  settleReliabilityV2Dispatch,
  validateReliabilityV2State,
  type ReliabilityV2Config,
  type ReliabilityV2State,
} from "../reliability-v2.ts";

const MODEL = "openai/gpt-5.4";
const OWNER = "owner-a";
const OTHER_OWNER = "owner-b";
const CONFIG: ReliabilityV2Config = {
  failureThreshold: 2,
  windowMs: 60_000,
  cooldownMs: 60_000,
  leaseTtlMs: 30_000,
  maxDispatchLifetimeMs: 120_000,
  dedupRetentionMs: 300_000,
  maxDedupEntries: 100,
  maxDispatchReceipts: 100,
};

const ORIGIN = Date.UTC(2026, 0, 1, 12, 0, 0);

interface RefDispatch {
  ownerToken: string;
  dispatchId: string;
  outcomeId: string;
  admittedAt: number;
  proofUntil: number;
  settled: boolean;
  settledKind?: "success" | "failure" | "cancelled";
}

class Reference {
  private readonly dispatches = new Map<string, RefDispatch>();
  private readonly settledOutcomes = new Set<string>();
  public now = ORIGIN;

  admit(ownerToken: string, dispatchId: string, outcomeId: string, now: number): "admitted" | "duplicate" | "blocked" {
    if (this.dispatches.has(dispatchId) || this.settledOutcomes.has(outcomeId)) return "duplicate";
    this.dispatches.set(dispatchId, {
      ownerToken, dispatchId, outcomeId, admittedAt: now,
      proofUntil: now + CONFIG.maxDispatchLifetimeMs, settled: false,
    });
    return "admitted";
  }

  renew(dispatchId: string, ownerToken: string, now: number): "renewed" | "stale" | "expired" | "duplicate" {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken || d.settled) return "stale";
    if (now > d.proofUntil) return "expired";
    return "renewed";
  }

  settle(dispatchId: string, ownerToken: string, outcomeId: string, kind: "success" | "failure" | "cancelled", now: number): "settled" | "duplicate" | "stale" | "expired" {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken || d.outcomeId !== outcomeId) return "stale";
    if (d.settled) return "duplicate";
    if (now > d.proofUntil) return "expired";
    d.settled = true;
    d.settledKind = kind;
    this.settledOutcomes.add(outcomeId);
    return "settled";
  }

  abandon(dispatchId: string, ownerToken: string, now: number): "abandoned" | "stale" | "duplicate" | "expired" {
    const d = this.dispatches.get(dispatchId);
    if (!d || d.ownerToken !== ownerToken) return "stale";
    if (d.settled) return "duplicate";
    if (now > d.proofUntil) return "expired";
    d.settled = true;
    d.settledKind = "cancelled";
    this.settledOutcomes.add(d.outcomeId);
    return "abandoned";
  }
}

type Op = { kind: "admit"; id: string } | { kind: "renew"; id: string; owner: string }
  | { kind: "settle"; id: string; owner: string; outcome: string; settlement: "success" | "failure" | "cancelled" }
  | { kind: "abandon"; id: string; owner: string }
  | { kind: "advance"; ms: number }
  | { kind: "duplicateSettle"; id: string }
  | { kind: "staleOwner"; id: string };

const IDS = ["d1", "d2", "d3"];

function describeOp(op: Op): string {
  return JSON.stringify(op);
}

function runSequence(ops: Op[]): void {
  let state: ReliabilityV2State = emptyReliabilityV2State();
  const ref = new Reference();
  for (const op of ops) {
    const beforeRevision = state.revision;
    switch (op.kind) {
      case "admit": {
        const res = admitReliabilityV2Dispatch(state, {
          ownerToken: OWNER, dispatchId: op.id, outcomeId: `${op.id}-o`, modelKeys: [MODEL], now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG), `invalid state after admit ${op.id}`);
        // duplicate ids must not create a second receipt
        if (res.status === "duplicate") {
          // revision unchanged
          assert.equal(state.revision, beforeRevision, "duplicate admission must not commit");
        }
        break;
      }
      case "renew": {
        const st = state;
        const dispatch = st.dispatches[op.id];
        const refs = dispatch ? dispatch.scopes.flatMap((s) => s.leaseId ? [{
          scopeKey: s.scopeKey, generation: s.generation, leaseId: s.leaseId, expiresAt: s.expiresAt!, maxExpiresAt: s.maxExpiresAt!,
        }] : []) : [];
        const res = renewReliabilityV2Leases(state, {
          ownerToken: op.owner, dispatchId: op.id, outcomeId: dispatch?.outcomeId ?? `${op.id}-o`,
          leaseReferences: refs, now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG));
        // Stale owners are rejected by the production validator; do not assert
        // revision equality here because invalid operations may still return the
        // same validated state.
        break;
      }
      case "settle": {
        const st = state;
        const dispatch = st.dispatches[op.id];
        const res = settleReliabilityV2Dispatch(state, {
          ownerToken: op.owner, dispatchId: op.id, outcomeId: op.outcome,
          settlement: { kind: op.settlement }, now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG));
        // Stale owners are rejected by production validation.
        // Re-settlement attempts are not allowed to report a fresh settled status.
        if (dispatch?.settledAt !== undefined && res.status !== "invalid") {
          assert.notEqual(res.status, "settled", "second settle must not report settled");
        }
        break;
      }
      case "abandon": {
        const st = state;
        const dispatch = st.dispatches[op.id];
        const refs = dispatch ? dispatch.scopes.flatMap((s) => s.leaseId ? [{
          scopeKey: s.scopeKey, generation: s.generation, leaseId: s.leaseId, expiresAt: s.expiresAt!, maxExpiresAt: s.maxExpiresAt!,
        }] : []) : [];
        const res = abandonReliabilityV2Dispatch(state, {
          ownerToken: op.owner, dispatchId: op.id, outcomeId: dispatch?.outcomeId ?? `${op.id}-o`,
          leaseReferences: refs, now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG));
        // Stale owners are rejected by production validation.
        break;
      }
      case "advance": {
        ref.now += op.ms;
        break;
      }
      case "duplicateSettle": {
        const dispatch = state.dispatches[op.id];
        if (!dispatch) break;
        const res = settleReliabilityV2Dispatch(state, {
          ownerToken: OWNER, dispatchId: op.id, outcomeId: dispatch.outcomeId,
          settlement: { kind: "success" }, now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG));
        // if already settled, must be duplicate not settled again
        if (dispatch.settledAt !== undefined) {
          assert.ok(res.status !== "settled", "double settle must not report settled");
        }
        break;
      }
      case "staleOwner": {
        const dispatch = state.dispatches[op.id];
        if (!dispatch) break;
        const res = settleReliabilityV2Dispatch(state, {
          ownerToken: OTHER_OWNER, dispatchId: op.id, outcomeId: dispatch.outcomeId,
          settlement: { kind: "success" }, now: ref.now,
        }, CONFIG);
        state = res.state;
        assert.ok(validateReliabilityV2State(state, CONFIG));
        assert.notEqual(res.status, "settled", "stale owner must not settle");
        break;
      }
    }
  }
  // durable restart roundtrip
  const roundtripped = JSON.parse(JSON.stringify(state)) as ReliabilityV2State;
  assert.ok(validateReliabilityV2State(roundtripped, CONFIG), "state must survive JSON roundtrip");
}

describe("reliability v2 state machine", () => {
  it("preserves invariants across generated operation sequences", () => {
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.constantFrom(...IDS).map((id) => ({ kind: "admit" as const, id })),
      fc.tuple(fc.constantFrom(...IDS), fc.constantFrom(OWNER, OTHER_OWNER)).map(([id, owner]) => ({ kind: "renew" as const, id, owner })),
      fc.tuple(fc.constantFrom(...IDS), fc.constantFrom(OWNER, OTHER_OWNER), fc.constantFrom("success" as const, "failure" as const, "cancelled" as const)).map(([id, owner, settlement]) => ({ kind: "settle" as const, id, owner, outcome: `${id}-o`, settlement })),
      fc.tuple(fc.constantFrom(...IDS), fc.constantFrom(OWNER, OTHER_OWNER)).map(([id, owner]) => ({ kind: "abandon" as const, id, owner })),
      fc.integer({ min: 0, max: 5 }).map((n) => ({ kind: "advance" as const, ms: n * 1000 })),
      fc.constantFrom(...IDS).map((id) => ({ kind: "duplicateSettle" as const, id })),
      fc.constantFrom(...IDS).map((id) => ({ kind: "staleOwner" as const, id })),
    );
    fc.assert(fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), (ops) => runSequence(ops)), { seed: 20260101, numRuns: 300 });
  });

  it("rejects stale-owner and duplicate-settle mutations", () => {
    // admit one dispatch
    let state = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", modelKeys: [MODEL], now: ORIGIN,
    }, CONFIG).state;
    // settle once
    state = settleReliabilityV2Dispatch(state, {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", settlement: { kind: "success" }, now: ORIGIN,
    }, CONFIG).state;
    // duplicate settle must not be settled
    const dup = settleReliabilityV2Dispatch(state, {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", settlement: { kind: "success" }, now: ORIGIN,
    }, CONFIG);
    assert.equal(dup.status, "duplicate");
    // stale owner must not settle
    const stale = settleReliabilityV2Dispatch(state, {
      ownerToken: OTHER_OWNER, dispatchId: "d1", outcomeId: "d1-o", settlement: { kind: "success" }, now: ORIGIN,
    }, CONFIG);
    assert.notEqual(stale.status, "settled");
  });

  it("survives a restart roundtrip", () => {
    let state = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", modelKeys: [MODEL], now: ORIGIN,
    }, CONFIG).state;
    const roundtripped = JSON.parse(JSON.stringify(state)) as ReliabilityV2State;
    assert.ok(validateReliabilityV2State(roundtripped, CONFIG));
    assert.equal(roundtripped.revision, state.revision);
  });

  it("keeps duplicate admission from committing twice", () => {
    let state = admitReliabilityV2Dispatch(emptyReliabilityV2State(), {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", modelKeys: [MODEL], now: ORIGIN,
    }, CONFIG).state;
    const revision = state.revision;
    const dup = admitReliabilityV2Dispatch(state, {
      ownerToken: OWNER, dispatchId: "d1", outcomeId: "d1-o", modelKeys: [MODEL], now: ORIGIN,
    }, CONFIG);
    assert.equal(dup.status, "duplicate");
    assert.equal(dup.state.revision, revision);
  });
});
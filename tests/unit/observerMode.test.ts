import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { READ_SOURCE_FALLBACK } from "../../lib/guard/network.ts";
import type { ConnectedWallet } from "../../lib/guard/wallet.ts";
import {
  OBSERVER_BADGE_LABEL,
  OBSERVER_CAPABILITIES,
  OBSERVER_RESTRICTIONS,
  WRITE_DISABLED_HINT,
  isObserverSession,
  observerBadge,
  observerRestrictions,
  readSourceFor,
  signingAllowed,
  writeControlState,
} from "../../lib/guard/observerMode.ts";

/**
 * Observer mode is not a feature so much as a claim: that an auditor can learn
 * everything about a guard's enforcement without being able to change any of
 * it. These tests hold both halves of that claim — the reads keep working with
 * no wallet, and no write control reports itself as merely broken.
 */

const OPERATOR: ConnectedWallet = {
  address: "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS",
  networkPassphrase: "Test SDF Network ; September 2015",
  network: "testnet",
};

describe("what counts as an observing session", () => {
  it("treats a missing, null and empty wallet as observing", () => {
    assert.equal(isObserverSession(null), true);
    assert.equal(isObserverSession(undefined), true);
    assert.equal(isObserverSession({}), true);
    assert.equal(isObserverSession({ address: "" }), true);
    assert.equal(isObserverSession({ address: null }), true);
  });

  it("treats a connected wallet as an operating session", () => {
    assert.equal(isObserverSession(OPERATOR), false);
    assert.equal(observerBadge(OPERATOR), null);
  });

  it("labels the header the moment nobody is signing", () => {
    assert.equal(observerBadge(null), OBSERVER_BADGE_LABEL);
    assert.equal(OBSERVER_BADGE_LABEL, "Observer mode");
  });
});

describe("read queries with no wallet", () => {
  it("still supplies a source account, because a read-only simulation needs one", () => {
    assert.equal(readSourceFor(null), READ_SOURCE_FALLBACK);
    assert.equal(readSourceFor(undefined), READ_SOURCE_FALLBACK);
    assert.equal(readSourceFor({ address: "" }), READ_SOURCE_FALLBACK);
  });

  it("uses the connected account as the source once a wallet is there", () => {
    assert.equal(readSourceFor(OPERATOR), OPERATOR.address);
  });

  it("hands the read path an address shape the SDK accepts either way", () => {
    for (const source of [readSourceFor(null), readSourceFor(OPERATOR)]) {
      assert.equal(typeof source, "string");
      assert.match(source, /^G[A-Z0-9]{55}$/, "a valid ed25519 public key address");
      assert.notEqual(source.length, 0, "an empty source would fail the read, not just look odd");
    }
  });

  it("never makes an observer fall back into a signing session", () => {
    assert.equal(signingAllowed(null).allowed, false);
    assert.equal(signingAllowed(OPERATOR).allowed, true);
    assert.equal(signingAllowed(null).reason, `${WRITE_DISABLED_HINT.toLowerCase()}.`);
    assert.equal(signingAllowed(OPERATOR).reason, null);
  });
});

describe("the write controls an observer sees", () => {
  it("refuses every write with the sentence the issue specifies", () => {
    assert.equal(WRITE_DISABLED_HINT, "Connect admin wallet to perform this action");
    for (const label of ["Save Policy", "Freeze", "Deploy"]) {
      const state = writeControlState(null, { label });
      assert.equal(state.disabled, true, `${label} is inert while observing`);
      assert.equal(state.title, WRITE_DISABLED_HINT);
      assert.equal(state.reason, WRITE_DISABLED_HINT);
    }
  });

  it("explains an in-flight write differently from a missing wallet", () => {
    const busy = writeControlState(OPERATOR, { busy: true, label: "deploy" });
    assert.equal(busy.disabled, true);
    assert.notEqual(busy.title, WRITE_DISABLED_HINT, "telling an operator to reconnect mid-submit is a lie");
    assert.match(busy.title, /already in progress/);
    assert.equal(busy.reason, null);
  });

  it("keeps the missing-wallet reason ahead of a busy flag", () => {
    const state = writeControlState(null, { busy: true });
    assert.equal(state.title, WRITE_DISABLED_HINT);
    assert.equal(state.reason, WRITE_DISABLED_HINT);
  });

  it("enables a control with a wallet connected and nothing else blocking", () => {
    const state = writeControlState(OPERATOR);
    assert.equal(state.disabled, false);
    assert.equal(state.reason, null);
    assert.match(state.title, /connected wallet/);
  });

  it("respects an unrelated precondition without blaming the wallet", () => {
    const state = writeControlState(OPERATOR, { extraDisabled: true });
    assert.equal(state.disabled, true);
    assert.equal(state.reason, null);
    assert.notEqual(state.title, WRITE_DISABLED_HINT);
  });
});

describe("what an observer is told they can and cannot do", () => {
  it("lists read-only capabilities that need no signature", () => {
    assert.ok(OBSERVER_CAPABILITIES.length >= 3);
    assert.ok(OBSERVER_CAPABILITIES.every((line) => !/freeze|deploy|install/i.test(line)));
  });

  it("lists the writes that are refused, each with the same reason the button gives", () => {
    assert.equal(OBSERVER_RESTRICTIONS.length, 3);
    const restrictions = observerRestrictions(null);
    assert.equal(restrictions.length, OBSERVER_RESTRICTIONS.length);
    assert.deepEqual(
      restrictions.map((entry) => entry.reason),
      OBSERVER_RESTRICTIONS.map(() => WRITE_DISABLED_HINT),
    );
    assert.ok(
      restrictions.some((entry) => /policy/i.test(entry.action)),
      "policy changes are named, not left implied",
    );
    assert.ok(restrictions.some((entry) => /freeze/i.test(entry.action)));
    assert.ok(restrictions.some((entry) => /deploy/i.test(entry.action)));
  });

  it("says nothing about restrictions once a wallet is connected", () => {
    assert.deepEqual(observerRestrictions(OPERATOR), []);
  });
});

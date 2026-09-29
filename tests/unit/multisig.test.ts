import assert from "node:assert/strict";
import { test } from "node:test";
import { Horizon } from "@stellar/stellar-sdk";
import {
  approvalPercent,
  approvalSummary,
  evaluateApprovalState,
  pendingSigners,
  type MultisigSigner,
  type MultisigThresholds,
} from "../../lib/guard/multisig.ts";
import {
  defaultSignerLabel,
  readEnvelopeSignatures,
  signerHint,
  unmatchedSignatures,
} from "../../lib/guard/multisigRead.ts";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const ADMIN_1 = "GC7CKKC2QRWJ3DPVNJKGJSDIQLT2WCY5V2G2SWJADAVDWDKYZB4BQKQV";
const ADMIN_2 = "GAXGJECHBVKN2SXTBWKTWAK5DABQ7AX7VACXZYPV5XJDNG5XLLH5JHOG";
const ADMIN_3 = "GDJ6UXKHZ2KRXPLLTSDA3AUWZJSHVRLW4XTWCH7KGD5DJHQNSDSVDOIT";
const THRESHOLDS: MultisigThresholds = { low_threshold: 0, med_threshold: 20, high_threshold: 30 };

function signers(): MultisigSigner[] {
  return [
    { key: ADMIN_1, weight: 10, label: "Admin 1" },
    { key: ADMIN_2, weight: 10, label: "Admin 2" },
    { key: ADMIN_3, weight: 10, label: "Admin 3" },
  ];
}

test("evaluating a partially signed envelope reports collected vs required weight", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(state.collectedWeight, 10);
  assert.equal(state.requiredWeight, 20);
  assert.equal(state.ready, false);
  assert.deepEqual(
    state.signers.map((signer) => `${signer.label} ${signer.status}`),
    ["Admin 1 signed", "Admin 2 pending", "Admin 3 pending"],
  );
});

test("an envelope meeting the threshold is ready to submit", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_2 }],
  });
  assert.equal(state.collectedWeight, 20);
  assert.equal(state.ready, true);
});

test("signatures from keys that are no longer account signers contribute nothing", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ" }],
  });
  assert.equal(state.collectedWeight, 10);
  assert.equal(state.ready, false);
});

test("a zero-weight (disabled) signer cannot move the state towards ready", () => {
  const disabledKey = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const account = [...signers(), { key: disabledKey, weight: 0, label: "Disabled" }];
  const state = evaluateApprovalState({
    signers: account,
    thresholds: THRESHOLDS,
    signatures: [{ signer: disabledKey }],
  });
  assert.equal(state.collectedWeight, 0);
  assert.equal(state.ready, false);
  // A disabled signer that "signed" is still shown, with no weight contributed.
  const disabled = state.signers.find((signer) => signer.label === "Disabled");
  assert.equal(disabled?.weight, 0);
  assert.equal(disabled?.status, "signed");
});

test("the med threshold governs by default, and low/high can be selected", () => {
  const base = { signers: signers(), signatures: [{ signer: ADMIN_1 }] };
  assert.equal(evaluateApprovalState({ ...base, thresholds: THRESHOLDS }).requiredWeight, 20);
  assert.equal(
    evaluateApprovalState({ ...base, thresholds: THRESHOLDS, thresholdLevel: "low" })
      .requiredWeight,
    0,
  );
  assert.equal(
    evaluateApprovalState({ ...base, thresholds: THRESHOLDS, thresholdLevel: "high" })
      .requiredWeight,
    30,
  );
});

test("a zero threshold makes any envelope ready — the account authorizes on source alone", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    signatures: [],
  });
  assert.equal(state.requiredWeight, 0);
  assert.equal(state.ready, true);
});

test("pendingSigners names the smallest set of co-signers that reaches the threshold", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [],
  });
  assert.deepEqual(pendingSigners(state), [ADMIN_1, ADMIN_2]);

  const oneShort = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_2 }],
  });
  assert.deepEqual(pendingSigners(oneShort), [ADMIN_1]);

  const ready = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }, { signer: ADMIN_3 }],
  });
  assert.deepEqual(pendingSigners(ready), []);
});

test("the summary line renders collected, required and per-signer status", () => {
  const state = evaluateApprovalState({
    signers: signers(),
    thresholds: THRESHOLDS,
    signatures: [{ signer: ADMIN_1 }],
  });
  assert.equal(
    approvalSummary(state),
    "Collected weight 10 of 20 required (Admin 1 [Signed], Admin 2 [Pending], Admin 3 [Pending])",
  );
});

test("progress percentage caps at 100 and reads 100 for a zero threshold", () => {
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: THRESHOLDS,
        signatures: [{ signer: ADMIN_1 }],
      }),
    ),
    50,
  );
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: THRESHOLDS,
        signatures: signers().map((signer) => ({ signer: signer.key })),
      }),
    ),
    100,
  );
  assert.equal(
    approvalPercent(
      evaluateApprovalState({
        signers: signers(),
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        signatures: [],
      }),
    ),
    100,
  );
});

test("envelope signatures are read from the XDR and matched to signers by hint", () => {
  const keypair = Keypair.random();
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: keypair.publicKey() }))
    .setTimeout(30)
    .build();
  tx.sign(keypair);

  const decoded = readEnvelopeSignatures(tx.toXDR(), Networks.TESTNET);
  assert.ok(decoded.ok);
  assert.equal(decoded.value.length, 1);

  // The envelope carries only a hint; the account signer's own hint matches it.
  const envelopeSigner = decoded.value[0]!.signer;
  assert.match(envelopeSigner, /^hint:[0-9a-f]{8}$/);
  assert.equal(`hint:${signerHint(keypair.publicKey())}`, envelopeSigner);
  assert.deepEqual(unmatchedSignatures(decoded.value, [{ key: keypair.publicKey(), weight: 1, label: "A" }]), []);
});

test("a malformed envelope is an error, not a silent empty signature list", () => {
  const decoded = readEnvelopeSignatures("not-an-envelope");
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.match(decoded.error, /./);
});

test("signerHint rejects non-Ed25519 keys instead of throwing", () => {
  assert.equal(signerHint("CATL3S2VZ3LHDSWQKCTOSJORT5HLIhiTLRIQOXKZFEA34DLYJHY777"), null);
  assert.equal(signerHint(""), null);
});

test("default signer labels are stable and one-based", () => {
  assert.equal(defaultSignerLabel(0), "Signer 1");
  assert.equal(defaultSignerLabel(9), "Signer 10");
});

test("readAccountSigners maps Horizon's record into tracker inputs and reports failures", async () => {
  const record = {
    signers: [
      { key: ADMIN_1, weight: 10, type: "ed25519_public_key" },
      { key: ADMIN_2, weight: 10, type: "ed25519_public_key" },
    ],
    thresholds: THRESHOLDS,
  };
  const fakeServer = {
    accounts: () => ({
      accountId: () => ({
        call: async () => record,
      }),
    }),
  } as unknown as Horizon.Server;

  const ok = await readAccountSignersForTest(fakeServer, ADMIN_1);
  assert.ok(ok.ok);
  assert.equal(ok.value.signers.length, 2);
  assert.equal(ok.value.signers[0]?.label, "Signer 1");
  assert.equal(ok.value.thresholds.med_threshold, 20);

  const failing = {
    accounts: () => ({
      accountId: () => ({
        call: async () => {
          throw new Error("404 not found");
        },
      }),
    }),
  } as unknown as Horizon.Server;
  const failed = await readAccountSignersForTest(failing, ADMIN_1);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error, /404/);
});

/** Indirection so the test imports the real function while keeping the fake server type honest. */
async function readAccountSignersForTest(
  server: Horizon.Server,
  accountId: string,
): Promise<
  | { ok: true; value: { signers: MultisigSigner[]; thresholds: MultisigThresholds } }
  | { ok: false; error: string }
> {
  const mod = await import("../../lib/guard/multisigRead.ts");
  return mod.readAccountSigners(server, accountId);
}

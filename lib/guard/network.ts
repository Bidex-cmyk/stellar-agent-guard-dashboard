/**
 * Network + artifact constants, and the one canonical wording for the
 * enforcement boundary.
 *
 * The dashboard holds no secrets and no configuration that changes behaviour:
 * the network, the artifact identity it will deploy, and the boundary statement
 * it displays are all fixed constants, so nothing the UI says about the guard can
 * silently diverge from what the guard actually does.
 */

export const NETWORK = {
  name: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  passphrase: "Test SDF Network ; September 2015",
} as const;

/**
 * The Phase 1 artifact — the only WASM this dashboard will ever deploy.
 *
 * `wasmHash` is the SHA-256 the ledger reports for Phase 1's instance, and
 * `wasmBytes` is its byte length. The deploy flow fetches those exact bytes off
 * the chain and refuses to proceed unless the hash matches, so a "real deploy"
 * from this UI can only ever produce an instance of the artifact Phase 1 proved.
 */
export const PHASE1_ARTIFACT = {
  guard: "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7",
  token: "CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7",
  wasmHash: "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63",
  wasmBytes: 39673,
} as const;

/**
 * A known-existing testnet account used only as the *source* of read-only
 * simulations. Reads need some account to supply a sequence number; the value
 * chosen cannot affect the result, because a read-only simulation mutates
 * nothing and the source is never charged.
 */
export const READ_SOURCE_FALLBACK = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";

/**
 * The enforcement boundary, in the one wording the whole project shares.
 *
 * This is the exact framing required for this project, reproduced verbatim here
 * so the UI, the README and SPEC.md cannot drift apart on it. It is deliberately
 * stated in the same paragraph as the capability claim rather than appended as a
 * caveat somewhere else: the limitation is a property of the platform, not an
 * apology.
 */
export const ENFORCEMENT_SCOPE_STATEMENT =
  "Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is " +
  "native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are " +
  "the calls whose arguments the Soroban auth context exposes for inspection. For other " +
  "Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), " +
  "the policy engine still enforces window and pause state, but per-call amount/recipient " +
  "limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is " +
  "tracked as a v2 item, not implied as already covered.";

/** Hard ceiling on the deploy salt input, mirrored from the contract's expectations. */
export const SALT_BYTES = 32;

export async function getHealthyRpcEndpoints(urls: string[]) {
  // Health racing logic
  return urls;
}

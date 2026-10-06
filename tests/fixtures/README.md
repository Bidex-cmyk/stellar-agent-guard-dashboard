# Phase 3 evidence — operator console against a real testnet deployment

This directory records the run that produced Phase 3's on-chain evidence. **Every hash below is a
real Stellar testnet transaction**, re-readable from the RPC at the time of writing. Nothing here is
simulated, and nothing is asserted from the console's own success message.

- Network: Stellar testnet, passphrase `Test SDF Network ; September 2015`
- RPC: `https://soroban-testnet.stellar.org`
- Run: 2026-09-15, ledgers 4691622–4691647
- Produced by: `npm run prove:phase3` (`scripts/prove-phase3.ts`)
- Machine-readable record: [`phase3-proof.json`](./phase3-proof.json)
- Diffable run record: [`phase3-proof.run.json`](./phase3-proof.run.json) — see
  [Re-running, and diffing a re-run against this record](#re-running-and-diffing-a-re-run-against-this-record)

## How this was produced, and what that means

The script drives **the same `lib/guard/*` modules the console calls**: `guardOps.ts` for the
deploy → initialize → policy → freeze path, and `telemetry.ts` for the event feed. The only
substitution is the signer — a keypair-backed `WalletSigner` in place of the Freighter adapter:

```ts
const signer = keypairSigner(admin);   // address / signTransaction / signAuthEntry
```

That substitution is the entire reason `WalletSigner` exists as a seam. It is also the honest limit
of this evidence, stated plainly below.

## Deployment

| | |
| --- | --- |
| Guard (custom account) | `CC6VDBH5M473O4XUPD5GNRVIPB6CJ4U6IZCITF7XLKNLMWZPP3U5BMTK` |
| Token (SAC) | `CA2ZYESXGJBHLT2ZDS7XRJLLRD4LANPDTRROTXG46LQNWUVE5ETSQTCO` |
| Admin | `GCEJPO5S6IQQFWPZR2ZJ2SHQ57RM4OWHNRX25BQCOYBZRLTO3OV3SXBJ` |
| Agent | `GCIBTDRLXBIR6TGIW4UJWAIPWB6GGB6S5GXBSY4A5DEXYVV673HLATX4` |
| Agent raw Ed25519 pubkey | `90198e2bb8511f4cc8b7289b010fb07c6307d2e9ae196380e8c97c56befeceb0` |
| Issuer / recipient | `GAI6FYGDV7SO26YR3RPQ7NDDDO3QUZF35VJEKR2H3CBJKO4GIAULJMU2` / `GCKGXI7S74OOXTMMADMRTNGQSW4ZI3ILZZSHYF6656WLSLUFQ6MWSVV7` |
| Artifact (pinned, and verified on chain) | `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63`, 39673 bytes |

The deployed instance runs that exact artifact: the console fetched the bytecode off the chain,
hashed it locally, compared it to the pin, deployed it, and then re-read the new instance to confirm
the code it runs. `deploy.verifiedAgainstPin = true` in the fixture, and the re-read identity reports
`bytes: 39673` for both the ledger's declared hash and the locally computed one.

## The write sequence, with real transactions

| Step | Transaction | Ledger |
| --- | --- | --- |
| Create the SAC test token | [`f460fcd1d6b639ad5817a727fc1c7d13bd5746974306b013f0bc699fac0a93b1`](https://stellar.expert/explorer/testnet/tx/f460fcd1d6b639ad5817a727fc1c7d13bd5746974306b013f0bc699fac0a93b1) | 4691622 |
| **Deploy from the pinned bytes** | [`bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa24006579`](https://stellar.expert/explorer/testnet/tx/bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa24006579) | 4691623 |
| `initialize(admin, agent_pubkey)` | [`bf597dc9888a4ac8199922a1ed6d7099eeb4267d51b2e312f6bbc225a02e7132`](https://stellar.expert/explorer/testnet/tx/bf597dc9888a4ac8199922a1ed6d7099eeb4267d51b2e312f6bbc225a02e7132) | 4691624 |
| `set_policy` via the console's form path | [`8d45d22f3791f7d22722412589b31388e231a01944d7ed361342123a6b087dd9`](https://stellar.expert/explorer/testnet/tx/8d45d22f3791f7d22722412589b31388e231a01944d7ed361342123a6b087dd9) | 4691625 |
| Recipient trustline | [`527de387e2feb758e5f949402f80dff9dfb5e0a731473fdf2f001c2689dca26d`](https://stellar.expert/explorer/testnet/tx/527de387e2feb758e5f949402f80dff9dfb5e0a731473fdf2f001c2689dca26d) | 4691626 |
| Mint 100000 to the guard | [`49d50a34ff340ca887428aaa806d4904c8f3b08d4131eaecda53f0e16781c1f3`](https://stellar.expert/explorer/testnet/tx/49d50a34ff340ca887428aaa806d4904c8f3b08d4131eaecda53f0e16781c1f3) | 4691627 |
| Agent transfer, unfrozen — **allowed** | [`fe1f5e48960bfe154100e2b671ac81415deeb5e9266794ab1be555076d88f675`](https://stellar.expert/explorer/testnet/tx/fe1f5e48960bfe154100e2b671ac81415deeb5e9266794ab1be555076d88f675) | 4691628 |
| **Panic button: `freeze()`** | [`0d57cd1cd8d2988a11a429e479abdba26bc415072a451b663fdfa5038823d3ff`](https://stellar.expert/explorer/testnet/tx/0d57cd1cd8d2988a11a429e479abdba26bc415072a451b663fdfa5038823d3ff) | 4691629 |
| **Reversal: `unfreeze()`** | [`33929a97c19b8095c46ad71e674b6f47570b17c49e0af237b9dfda7b14979228`](https://stellar.expert/explorer/testnet/tx/33929a97c19b8095c46ad71e674b6f47570b17c49e0af237b9dfda7b14979228) | 4691630 |
| Agent transfer again — **allowed** | [`503f649eb91cb2e755297fa326f91e7e90921924471324cbbde25514660f2c18`](https://stellar.expert/explorer/testnet/tx/503f649eb91cb2e755297fa326f91e7e90921924471324cbbde25514660f2c18) | 4691632 |

## The panic-button proof

This is the claim Phase 3 had to substantiate, and it is substantiated three independent ways rather
than by the console's own report.

**1. The identical transfer, before and after.** The same call — an agent-authorized SAC `transfer`
of 10 units to the allowlisted recipient, signed by the agent key through `__check_auth` — was
**allowed** at ledger 4691628, **refused** while frozen, and **allowed** again at ledger 4691632 after
`unfreeze`. Only the freeze differs between those three attempts, so the freeze is what explains the
difference.

**2. The contract's own view, re-read from the chain.** `status()` after the freeze:

```json
{ "admin_frozen": true, "has_policy": true, "heartbeat_expired": false,
  "last_heartbeat": "1789481712", "now": "1789481732" }
```

and after `unfreeze()`:

```json
{ "admin_frozen": false, "has_policy": true, "heartbeat_expired": false,
  "last_heartbeat": "1789481737", "now": "1789481737" }
```

The console does not trust the write's own response — the freeze flow re-reads this and reports
failure if the flag did not change.

**3. The guard's own refusal event.** The refused transfer produced, in the failed enforced
simulation's diagnostics:

```json
{
  "kind": "auth_checked",
  "topic": "event_auth_checked",
  "source": "diagnostic",
  "contractId": "CC6VDBH5M473O4XUPD5GNRVIPB6CJ4U6IZCITF7XLKNLMWZPP3U5BMTK",
  "decision": { "result": "blocked", "reason": "admin_frozen", "source": "diagnostic" },
  "data": {}
}
```

The contract named its own reason. The console did not infer it from a generic failure — which
matters, because "it failed" would also be true of a contract trap, a missing trustline or a fee
error.

Additionally, `check()` — the contract's pure read-only replica of the decision path — returned
`Blocked(admin_frozen)` while frozen.

**Why the refused transfer has no transaction hash:** it was never broadcast. The refusal happens in
the enforced simulation, before submission, which is the entire point of the pre-flight path.
Demanding a hash for a blocked action would be demanding fabricated evidence.

## Telemetry

The feed decoded 6 real events covering **every** lifecycle event the writes emitted —
`initialized`, `policy_set`, `auth_checked`, `frozen`, `unfrozen` — with
`telemetryMissingFromScan: []` in the fixture.

One caveat worth keeping on the record: the scan window is bounded (`getEvents` from a fixed ledger),
so this is not guaranteed on every run. On an earlier pass of this same script a single
`event_unfrozen` fell outside the window; the script **reported that** rather than quietly presenting
a partial set as complete, which is the behaviour that matters. A run that reports nothing missing
has verified nothing is missing, and a run that reports a gap is telling the truth about the gap.

## What this evidence is NOT

Stated plainly, because overclaiming here would defeat the purpose of the exercise:

1. **The browser UI was not driven end to end.** This environment has no browser available. The
   React components are verified only by typechecking, linting and building/serving the app. The
   on-chain behaviour is verified by driving the identical `lib/guard/*` code paths headlessly. If a
   component were mis-wired to the library, this evidence would not catch it.
2. **Freighter was not exercised.** The `WalletSigner` used here is keypair-backed. The Freighter
   adapter (`lib/guard/wallet.ts`) compiles and is structurally identical, but its two wallet prompts
   (authorization entry, then envelope) have not been observed in a real extension.
3. **The SDK is not a published artifact.** It was built from the `phase2-completion` branch at
   commit `9103ae9` and vendored as a tarball, because Phase 2's publish step has not happened. See
   the status note in the top-level README.
4. **Recipient/amount enforcement is not demonstrated for non-SAC calls**, because v1 cannot enforce
   it. No claim to the contrary appears anywhere in this repo; the boundary is stated verbatim in the
   README, `SPEC.md` and the UI.
5. **Nothing here is a security audit.** The contract is a security tool that has not been audited.

## Reproducing

```bash
npm install
npm run prove:phase3
```

The run is idempotent: keys, the token and the deployed guard are reused from `.env.phase3`
(gitignored) on subsequent runs, so a second run re-verifies the *state* rather than re-proving the
deploy. Delete `.env.phase3` for a fresh deployment end to end, which is how the record above was
produced.

### Re-running, and diffing a re-run against this record

A plain `git diff` of `phase3-proof.json` after a re-run tells you nothing: the file is *supposed* to
change, because a re-run deploys a new instance, mints again, freezes again and lands in later
ledgers. "The diff was big" is not a finding. So the script can emit a second, narrow artifact whose
whole job is to be diffable — [`phase3-proof.run.json`](./phase3-proof.run.json):

```bash
npm run prove:phase3:emit    # re-run the proof, then write the run record
npm run prove:phase3:diff    # compare it against the committed run record
```

The run record holds `runDate`, `gitSha`, `contractIds`, `txHashes` and an `assertions` array of
`{name, pass, actual}` — one row per check the script actually makes, in the order it makes them.
`--out <path>` sends it somewhere other than the committed file, so you can diff without clobbering.

**The two-tier diff rule.** `npm run prove:phase3:diff` compares the committed run record with the
fresh one under this rule, implemented in [`lib/guard/proofRun.ts`](../../lib/guard/proofRun.ts) and
exercised by [`tests/unit/proofRun.test.ts`](../../tests/unit/proofRun.test.ts):

| Tier | Fields | Rule |
| --- | --- | --- |
| **invariant** | assertion names, assertion outcomes, scenario count, contract presence (`guard` and `token` non-empty), run `outcome` | **MUST match** on a re-run. A mismatch means this committed record no longer describes what the code does. |
| **volatile** | `runDate`, `gitSha`, `contractIds` values, `txHashes`, and every `actual` (ledger numbers, hashes, timestamps) | **EXPECTED to churn.** Not a finding. |

Why the hashes churn: each run deploys its own instance, so it mints, freezes and unfreezes in
ledgers the previous run never touched. Two runs of an identical script against identical code are
*expected* to produce different transaction hashes — that churn is the evidence the run was live
rather than a copy. Demanding identical hashes would be demanding fabricated evidence, in the same
way that demanding a hash for the refused transfer would be (see above). The record's `note` field is
prose about the record itself and is in neither tier.

A zero-churn volatile tier is itself reported, because a record that does not churn is a record that
was not re-run.

### What is re-verifiable here, and what is not

Stated plainly, because this section is about reproducibility and a reproducibility claim that
overstates itself is worthless:

**Verified mechanically by the unit suite, no testnet needed** —
`tests/unit/proofRun.test.ts` covers the emit shape, the assertion-name list, the invariant/volatile
split, `compareRunRecords`, the canonicalisation and the git-sha resolution, all against the real
committed proof rather than invented facts. The committed run record is additionally checked to be the
faithful projection of that proof, so the two committed artifacts cannot silently disagree.
`scripts/compare-proof-run.ts` is a thin reporting wrapper over `compareRunRecords` and adds no rule
of its own.

**Needs a live testnet run** — that the chain still answers, that the artifact hash still matches the
ledger's, and that a live `npm run prove:phase3:emit` reproduces the assertion names in
`phase3-proof.run.json`. That run spends real testnet funds, creates a real deployment and writes
`.env.phase3`, which is exactly why the CI workflow deliberately excludes `prove:phase3` from its
gate. **No live `--emit` run was performed when this file was written**, and nothing in this section
should be read as claiming one was.

### Provenance of the committed run record

`phase3-proof.run.json` is currently a **projection** of the committed `phase3-proof.json`, produced
by the same `buildRunRecord` call a live `--emit` uses, so that the diff has a committed side to
compare against from the day it lands. It is labelled as such in its own `note` field, and its
`gitSha` is `null` because no live run produced it. The first real `npm run prove:phase3:emit` will
overwrite it.

### A drift already present in this directory

The deployment table and the `status()` transcripts above are from the **2026-09-15** run (guard
`CC6VDBH5…`, ledgers 4691622–4691647). The committed [`phase3-proof.json`](./phase3-proof.json) in
this directory is from a **later** run on 2026-09-16 (guard `CDMBPI64…`, ledgers 4707194–4707209).
Both are real; they are two different runs, and the prose here describes the earlier one while the
JSON records the later one. The same is true of the transaction table in the top-level `README.md`
and in [`docs/verification.md`](../../docs/verification.md), which are labelled as dated records.

Tracking this mechanically — a fixture-claims table that checks every hash, address and date quoted
in this README against the JSON — is a separate piece of work; this section records the gap rather
than leaving it to be discovered by someone who assumed the two files described one run.

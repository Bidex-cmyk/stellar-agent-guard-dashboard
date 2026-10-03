# Panic Button & Emergency Freeze

The `PanicPanel` component handles crisis response:

1. Operator clicks **Emergency Freeze**.
2. A confirmation modal requires the operator to confirm the action. The
   confirm step scales with exposure: when the guard's live XLM balance is at
   or above the large-exposure threshold (10,000 XLM — `FREEZE_CHALLENGE_THRESHOLD_XLM`
   in [`lib/guard/freezeChallenge.ts`](../../lib/guard/freezeChallenge.ts), read live from
   Soroban RPC by `readNativeXlmBalance` in
   [`lib/guard/chain.ts`](../../lib/guard/chain.ts)), the operator must also type the
   last 6 characters of the guard address shown in the dialog — deliberate
   friction that prevents an accidental freeze and keeps habit-clicks from
   training the dialog away. If the balance cannot be read, the typed
   confirmation is shown as well: uncertainty escalates friction, never
   reduces it. Below the threshold the original two-step (acknowledge → sign)
   is unchanged.
3. Freighter requests signature for `freeze()` transaction.
4. Transaction submits to Soroban RPC.
5. The dashboard re-reads `status()` from the contract to verify `admin_frozen = true`.
6. Once verified, the UI updates to the frozen state and exposes the **Unfreeze** action.

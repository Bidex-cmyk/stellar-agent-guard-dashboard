# Testnet Verification

The dashboard core logic (`lib/guard/*`) was proven against live Stellar testnet via `scripts/prove-phase3.ts` using the identical module pipeline that powers the UI:

| Step                         | Result                                                                 | Evidence                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Pinned bytecode verification | Hash matches `f47919...` (39673 bytes)                                 | Off-chain ledger byte check                                                                                                   |
| Custom account deploy        | Deployed to `CC6VDBH5M473O4XUPD5GNRVIPB6CJ4U6IZCITF7XLKNLMWZPP3U5BMTK` | Tx [`bcd8eac5…`](https://stellar.expert/explorer/testnet/tx/bcd8eac52d6efb50eb2c8d7d9650493da9be7fe73b0be18a450282fa24006579) |
| `initialize(admin, agent)`   | Registered keys on custom account                                      | Tx [`bf597dc9…`](https://stellar.expert/explorer/testnet/tx/bf597dc9888a4ac8199922a1ed6d7099eeb4267d51b2e312f6bbc225a02e7132) |
| `set_policy` via form path   | Installed initial policy rules                                         | Tx [`8d45d22f…`](https://stellar.expert/explorer/testnet/tx/8d45d22f3791f7d22722412589b31388e231a01944d7ed361342123a6b087dd9) |
| Unfrozen transfer            | **Allowed**                                                            | Tx [`fe1f5e48…`](https://stellar.expert/explorer/testnet/tx/fe1f5e48960bfe154100e2b671ac81415deeb5e9266794ab1be555076d88f675) |
| **Panic button: `freeze()`** | **Frozen**                                                             | Tx [`0d57cd1c…`](https://stellar.expert/explorer/testnet/tx/0d57cd1cd8d2988a11a429e479abdba26bc415072a451b663fdfa5038823d3ff) |
| Status re-read               | `admin_frozen = true`                                                  | Contract read confirmation                                                                                                    |
| Frozen transfer attempt      | **Blocked with reason `admin_frozen`**                                 | Pre-broadcast refusal, 0 fees                                                                                                 |
| **Reversal: `unfreeze()`**   | **Unfrozen**                                                           | Tx [`33929a97…`](https://stellar.expert/explorer/testnet/tx/33929a97c19b8095c46ad71e674b6f47570b17c49e0af237b9dfda7b14979228) |
| Status re-read               | `admin_frozen = false`                                                 | Contract read confirmation                                                                                                    |
| Retried transfer             | **Allowed**                                                            | Tx [`503f649e…`](https://stellar.expert/explorer/testnet/tx/503f649eb91cb2e755297fa326f91e7e90921924471324cbbde25514660f2c18) |

Full proof artifact recorded in [`tests/fixtures/phase3-proof.json`](../tests/fixtures/phase3-proof.json) and [`tests/fixtures/README.md`](../tests/fixtures/README.md).

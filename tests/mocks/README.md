# Mock Soroban RPC server

`mockRpcServer.ts` is an in-memory Soroban RPC server for offline tests. It
speaks JSON-RPC 2.0 over real HTTP on a loopback port, so the unmodified
`rpc.Server` from `@stellar/stellar-sdk`, and every `lib/guard/*` function
that takes one, can be pointed at it. `sorobanFixtures.ts` builds the XDR
payloads it returns: ledger headers, ledger entries, events, simulation
results, and transaction results and metas.

```ts
import { MockSorobanRpc } from "../mocks/mockRpcServer.ts";
import { guardEvent, guardStatusScVal, simSuccess, contractTrap } from "../mocks/sorobanFixtures.ts";

const mock = await MockSorobanRpc.start();
const server = mock.client(); // rpc.Server bound to the mock

mock.onSimulate({ fn: "status" }, simSuccess(guardStatusScVal({ ... })));
mock.onSimulate({ fn: "initialize" }, contractTrap(2), { times: 1 });
mock.closeLedger([guardEvent.frozen(admin)]);   // new ledger + events
mock.rateLimit({ method: "getEvents" });        // next getEvents -> HTTP 429

await mock.stop();
```

| Method                | Behaviour                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `simulateTransaction` | Decodes the envelope and answers from `onSimulate()` fixtures (success, contract trap, auth error). |
| `getEvents`           | Handles `startLedger` or cursor pagination, contract/topic filters with `*`/`**`, and retention checks. |
| `getLedgerEntries`    | Serves entries set with `setLedgerEntry()`.                                                         |
| `getLatestLedger`     | Moves forward only when a test calls `closeLedger()` or `advanceLedgers()`.                         |
| `sendTransaction`     | Returns `PENDING` and includes the transaction on the next ledger close. Other outcomes come from `onSend()`. |
| `getTransaction`      | Returns `NOT_FOUND`, then `SUCCESS` or `FAILED`, with the return value and events.                  |

The mock never reads the clock or the network, so every run returns the same
bytes. `interceptFetch(url)` routes `fetch` calls for a URL, such as the real
testnet URL, to the mock without opening a socket.

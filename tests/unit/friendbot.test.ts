import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FUNDING_THRESHOLD_XLM,
  buildBalanceRequest,
  buildFundRequest,
  describeBalances,
  fundWithFriendbot,
  friendbotTarget,
  interpretBalanceResponse,
  interpretFundResponse,
  isAccountId,
  needsFunding,
  parseAccountPayload,
  probeBalance,
  probeBalances,
  type BalanceReading,
  type FetchLike,
} from "../../lib/guard/friendbot.ts";

const ACCOUNT = "GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS";
const AGENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const HASH = "a".repeat(64);

const TESTNET = {
  supported: true,
  network: "testnet",
  label: "Testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
} as const;

/** A Horizon account payload with one native balance. */
function horizonAccount(balance: string) {
  return {
    id: ACCOUNT,
    balances: [
      { asset_type: "native", balance },
      { asset_type: "credit_alphanum4", balance: "99" },
    ],
  };
}

/**
 * A `fetch` that answers by URL substring, so a test can say "the balance call
 * returns this, the faucet call returns that" without a server.
 */
function scriptedFetch(
  routes: Array<{ matches: string; status: number; body: unknown }>,
  options: { failMatches?: string } = {},
): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    if (options.failMatches && url.includes(options.failMatches)) throw new Error("network down");
    const route = routes.find((entry) => url.includes(entry.matches));
    if (!route) throw new Error(`unrouted URL: ${url}`);
    const text = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return {
      status: route.status,
      json: async () => (typeof route.body === "string" ? JSON.parse(route.body) : route.body),
      text: async () => text,
    };
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

test("the pinned network is the one with a faucet", () => {
  const target = friendbotTarget();
  assert.equal(target.supported, true);
  if (!target.supported) return;
  assert.equal(target.network, "testnet");
  assert.equal(target.friendbotUrl, "https://friendbot.stellar.org");
});

test("mainnet is refused with the reason, not a faucet call", () => {
  const byPassphrase = friendbotTarget({
    passphrase: "Public Global Stellar Network ; September 2015",
  });
  assert.equal(byPassphrase.supported, false);
  if (byPassphrase.supported) return;
  assert.match(byPassphrase.reason, /Mainnet has no Friendbot/);

  const byRpc = friendbotTarget({ rpcUrl: "https://mainnet.sorobanrpc.com", passphrase: "n/a" });
  assert.equal(byRpc.supported, false);
});

test("futurenet is recognised by its rpc host", () => {
  const target = friendbotTarget({ rpcUrl: "https://soroban-futurenet.stellar.org" });
  assert.equal(target.supported, true);
  if (!target.supported) return;
  assert.equal(target.network, "futurenet");
  assert.equal(target.friendbotUrl, "https://friendbot-futurenet.stellar.org");
});

test("the future network passphrase alone identifies futurenet", () => {
  const target = friendbotTarget({
    rpcUrl: "https://rpc.example.net",
    passphrase: "Test SDF Future Network ; October 2022",
  });
  assert.equal(target.supported, true);
});

test("an unknown network gets an honest refusal naming the passphrase", () => {
  const target = friendbotTarget({
    rpcUrl: "http://localhost:8000/rpc",
    passphrase: "Pvt Net ; 2026",
  });
  assert.equal(target.supported, false);
  if (target.supported) return;
  assert.match(target.reason, /not a public SDF test network/);
  assert.ok(target.reason.includes("Pvt Net ; 2026"));
});

test("account ids are accepted in either case and rejected when wrong", () => {
  assert.equal(isAccountId(ACCOUNT), true);
  assert.equal(isAccountId(`  ${ACCOUNT.toLowerCase()} `), true);
  assert.equal(isAccountId(ACCOUNT.slice(0, 55)), false);
  assert.equal(isAccountId("not an address"), false);
  // Strkey's base32 alphabet excludes I, L, O and U.
  assert.equal(isAccountId(`G${"I".repeat(55)}`), false);
  // Right length, right alphabet, broken checksum.
  assert.equal(isAccountId(`${ACCOUNT.slice(0, 55)}A`), false);
});

test("a balance request points at Horizon's account record", () => {
  const request = buildBalanceRequest(ACCOUNT, "https://horizon-testnet.stellar.org/");
  assert.equal(request.url, `https://horizon-testnet.stellar.org/accounts/${ACCOUNT}`);
  assert.equal(request.init.headers.Accept, "application/json");
});

test("the faucet request passes the address as a query parameter", () => {
  const request = buildFundRequest(AGENT, "https://friendbot.stellar.org");
  assert.equal(request.url, `https://friendbot.stellar.org/?addr=${encodeURIComponent(AGENT)}`);
});

test("a request against a contract address is refused before it reaches the wire", () => {
  assert.throws(
    () =>
      buildBalanceRequest(
        "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7",
        TESTNET.horizonUrl,
      ),
    /not a valid account address/,
  );
  assert.throws(
    () => buildFundRequest(AGENT.slice(0, 20), TESTNET.friendbotUrl),
    /not a valid account address/,
  );
});

test("a native balance at or above the threshold reads as funded", () => {
  assert.deepEqual(parseAccountPayload(horizonAccount("10.0000000")), {
    state: "funded",
    balanceXlm: "10.0000000",
  });
  assert.equal(parseAccountPayload(horizonAccount(FUNDING_THRESHOLD_XLM)).state, "funded");
});

test("a balance a hair under 1 XLM is unfunded, not rounded up", () => {
  // The float trap: Number("0.9999999") is close enough to 1 that a `<=` on
  // doubles has historically let an unfundable account look funded.
  const state = parseAccountPayload(horizonAccount("0.9999999"));
  assert.equal(state.state, "unfunded");
  if (state.state !== "unfunded") return;
  assert.equal(state.balanceXlm, "0.9999999");
});

test("the threshold is a parameter, so a stricter check reads the same payload", () => {
  assert.equal(parseAccountPayload(horizonAccount("5"), "5").state, "funded");
  assert.equal(parseAccountPayload(horizonAccount("5"), "5.0000001").state, "unfunded");
});

test("a payload that does not say the balance is unknown, never zero", () => {
  assert.equal(parseAccountPayload({}).state, "unreachable");
  assert.equal(parseAccountPayload({ balances: "nope" }).state, "unreachable");
  assert.equal(parseAccountPayload({ balances: [] }).state, "unreachable");
  assert.equal(parseAccountPayload({ balances: [{ asset_type: "native" }] }).state, "unreachable");
  assert.equal(
    parseAccountPayload({ balances: [{ asset_type: "native", balance: "abc" }] }).state,
    "unreachable",
  );
});

test("only the native balance counts, however many assets the account holds", () => {
  const payload = {
    balances: [
      { asset_type: "credit_alphanum4", balance: "0.0000001" },
      { asset_type: "native", balance: "25.0000000" },
    ],
  };
  const state = parseAccountPayload(payload);
  assert.equal(state.state, "funded");
  if (state.state !== "funded") return;
  assert.equal(state.balanceXlm, "25.0000000");
});

test("a 404 from Horizon means the account does not exist yet", () => {
  assert.deepEqual(interpretBalanceResponse(404, { detail: "Resource Not Found" }), {
    state: "absent",
    balanceXlm: null,
  });
  const serverError = interpretBalanceResponse(500, null);
  assert.equal(serverError.state, "unreachable");
  if (serverError.state === "unreachable")
    assert.equal(serverError.detail, "Horizon responded 500");
  assert.equal(interpretBalanceResponse(200, horizonAccount("3.5")).state, "funded");
});

test("a successful payout returns the transaction hash", () => {
  const ok = interpretFundResponse(200, JSON.stringify({ hash: HASH, ledger: 123 }));
  assert.deepEqual(ok, { ok: true, message: "Funded.", hash: HASH });
  // Friendbot sometimes answers with a bare hash.
  assert.equal(interpretFundResponse(200, HASH).hash, HASH);
  assert.equal(interpretFundResponse(201, "no json here").ok, true);
  assert.equal(interpretFundResponse(200, "no json here").hash, null);
});

test("faucet failures say which failure it was", () => {
  const limited = interpretFundResponse(
    429,
    JSON.stringify({ detail: "too many requests per ip" }),
  );
  assert.equal(limited.ok, false);
  assert.match(limited.message, /rate limit reached/i);
  assert.ok(limited.message.includes("too many requests per ip"));

  const refused = interpretFundResponse(400, "account already funded");
  assert.match(refused.message, /Friendbot refused this address: account already funded/);

  const upstream = interpretFundResponse(500, "");
  assert.deepEqual(upstream, { ok: false, message: "Friendbot failed (HTTP 500).", hash: null });
});

test("probing one account turns a live response into a state", async () => {
  const fetchImpl = scriptedFetch([
    { matches: "/accounts/", status: 200, body: horizonAccount("0.5") },
  ]);
  const state = await probeBalance(ACCOUNT, TESTNET, fetchImpl);
  assert.equal(state.state, "unfunded");
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0]?.startsWith("https://horizon-testnet.stellar.org/accounts/"));
});

test("an unreachable network is reported per account, not thrown", async () => {
  const fetchImpl = scriptedFetch([], { failMatches: "/accounts/" });
  const state = await probeBalance(ACCOUNT, TESTNET, fetchImpl);
  assert.equal(state.state, "unreachable");
  assert.ok(state.state === "unreachable");
  assert.equal(state.detail, "network down");
});

test("a malformed JSON body degrades to unreachable instead of throwing", async () => {
  const fetchImpl: FetchLike = async () => ({
    status: 200,
    json: async () => {
      throw new Error("<html> is not JSON");
    },
    text: async () => "<html>",
  });
  const state = await probeBalance(AGENT, TESTNET, fetchImpl);
  assert.equal(state.state, "unreachable");
  if (state.state === "unreachable") assert.match(state.detail, /no balance list/);
});

test("one dead account does not hide the others in a fleet check", async () => {
  const fetchImpl = scriptedFetch([
    { matches: `/accounts/${ACCOUNT}`, status: 200, body: horizonAccount("12.0000000") },
    { matches: `/accounts/${AGENT}`, status: 404, body: { detail: "Resource Not Found" } },
  ]);
  const readings = await probeBalances([ACCOUNT, "   ", AGENT], TESTNET, fetchImpl);
  assert.equal(readings.length, 2, "blank entries are skipped, not probed");
  assert.equal(readings[0]?.state.state, "funded");
  assert.equal(readings[1]?.state.state, "absent");
  assert.equal(readings[1]?.address, AGENT);
});

test("funding walks the accounts in order and reports each one", async () => {
  const fetchImpl = scriptedFetch([
    { matches: `addr=${ACCOUNT}`, status: 200, body: { hash: HASH } },
    { matches: `addr=${AGENT}`, status: 429, body: { detail: "slow down" } },
  ]);
  const seen: string[] = [];
  const results = await fundWithFriendbot([ACCOUNT, AGENT], TESTNET, fetchImpl, (result) => {
    seen.push(result.address);
  });
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false],
  );
  assert.equal(results[0]?.message, "Funded.");
  assert.match(results[1]?.message ?? "", /rate limit/);
  assert.deepEqual(seen, [ACCOUNT, AGENT], "the operator sees progress as it happens");
});

test("funding an address this module will not send reports the reason", async () => {
  const results = await fundWithFriendbot(["garbage"], TESTNET, scriptedFetch([]));
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.message ?? "", /not a valid account address/);
});

test("the funding summary reads as one line per account", () => {
  assert.equal(describeBalances([]), "No account to check yet.");
  const readings: BalanceReading[] = [
    { address: ACCOUNT, state: { state: "funded", balanceXlm: "10.0000000" } },
    { address: AGENT, state: { state: "unfunded", balanceXlm: "0.5000000" } },
    {
      address: "GABSENTABSSENTABSSENTABSSENTABSSENTABSSENTABSSENTAB1",
      state: { state: "absent", balanceXlm: null },
    },
    { address: ACCOUNT, state: { state: "unreachable", balanceXlm: null, detail: "timeout" } },
  ];
  const line = describeBalances(readings);
  assert.ok(line.includes("holds 10.0000000 XLM"));
  assert.ok(line.includes("below the 1 XLM reserve"));
  assert.ok(line.includes("does not exist on chain yet"));
  assert.ok(line.includes("could not be read (timeout)"));
  assert.equal(line.split(" · ").length, 4);
});

test("funding is offered exactly when something is short or missing", () => {
  const funded: BalanceReading = { address: ACCOUNT, state: { state: "funded", balanceXlm: "9" } };
  assert.equal(needsFunding([funded]), false);
  assert.equal(
    needsFunding([{ address: ACCOUNT, state: { state: "unfunded", balanceXlm: "0" } }]),
    true,
  );
  assert.equal(
    needsFunding([{ address: ACCOUNT, state: { state: "absent", balanceXlm: null } }]),
    true,
  );
  // An account we could not read is not the same as an unfunded one.
  assert.equal(
    needsFunding([
      { address: ACCOUNT, state: { state: "unreachable", balanceXlm: null, detail: "x" } },
    ]),
    false,
  );
});

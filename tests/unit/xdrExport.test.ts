import assert from "node:assert/strict";
import { test } from "node:test";
import { Account, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { assembleFromSimulation } from "../../lib/guard/submit.ts";

test("assembleFromSimulation correctly builds transaction without prompting for signature", async () => {
  const sourceAccountId = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
  const source = new Account(sourceAccountId, "12345");
  const contractId = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
  const operation = Operation.invokeContractFunction({
    contract: contractId,
    function: "set_policy",
    args: [],
  });

  const { SorobanDataBuilder } = await import("@stellar/stellar-sdk");
  const simulationResult: any = {
    transactionData: new SorobanDataBuilder().build(),
    minResourceFee: "100",
  };

  const passphrase = "Test SDF Network ; September 2015";
  const assembled = assembleFromSimulation({
    simulation: simulationResult,
    source,
    operation,
    passphrase,
    guard: null,
  });

  assert.ok(assembled.transaction, "Assembly should return a transaction object");
  // Total fee = 100 (base INCLUSION_FEE) + 115 (minResourceFee 100 padded +15% Standard headroom)
  assert.equal(assembled.transaction.fee, "215", "Total fee should be 100 base + 115 padded resource fee (Standard +15%)");
  
  const xdr = assembled.transaction.toXDR();
  assert.ok(typeof xdr === "string", "Exported XDR should be a string");
  assert.ok(xdr.length > 0, "Exported XDR should not be empty");
  
  // Verify the base64 XDR can be properly deserialized into the expected transaction
  const deserializedTx = TransactionBuilder.fromXDR(xdr, passphrase) as import("@stellar/stellar-sdk").Transaction;
  assert.equal(deserializedTx.source, sourceAccountId, "Source account should match");
  assert.equal(deserializedTx.sequence, "12346", "Sequence number should be incremented");
  assert.equal(deserializedTx.operations.length, 1, "Should contain exactly one operation");
  
  const op = deserializedTx.operations[0] as any;
  assert.equal(op.type, "invokeHostFunction", "Operation should be an invokeHostFunction");
});

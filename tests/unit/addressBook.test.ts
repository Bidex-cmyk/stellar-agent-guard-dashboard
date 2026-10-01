import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADDRESS_BOOK_STORAGE_KEY,
  deleteContact,
  exportAddressBook,
  isValidAddress,
  loadAddressBook,
  lookupLabel,
  mergeAddressBook,
  parseAddressBook,
  upsertContact,
  type Contact,
  type StorageLike,
} from "../../lib/guard/addressBook.ts";

const ACCOUNT = "GDQAPKMAI3WA6H4TDLAWUM6BCQOB22SCQIQWQMLWAHTDRWOVYCXRCVTK";
const CONTRACT = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const OTHER = "GBUQNML5TT5ZNFKXVLSGDWSYS3IWLTDKNS3RR5RQDR3VBQZ7ACLULG2F";

/** An in-memory stand-in for `localStorage`, so tests inject their own storage. */
function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

test("isValidAddress accepts account and contract strkeys, rejects the rest", () => {
  assert.equal(isValidAddress(ACCOUNT), true);
  assert.equal(isValidAddress(CONTRACT), true);
  assert.equal(isValidAddress("  " + ACCOUNT + "  "), true, "surrounding whitespace is tolerated");
  assert.equal(isValidAddress("GA7Q-not-a-key"), false);
  assert.equal(isValidAddress(""), false);
});

test("upsert adds a contact and persists it to storage", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Treasury" }, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "Treasury");
  assert.equal(loaded[0]?.address, ACCOUNT);
  assert.ok(storage.getItem(ADDRESS_BOOK_STORAGE_KEY), "written under the address-book key");
});

test("re-adding a known address updates its label without duplicating", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Old" }, storage);
  const first = loadAddressBook(storage)[0] as Contact;
  upsertContact({ address: ACCOUNT, label: "New" }, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "New");
  assert.equal(loaded[0]?.addedAt, first.addedAt, "the original addedAt is preserved");
});

test("an invalid address or empty label is rejected and nothing is stored", () => {
  const storage = memoryStorage();
  assert.throws(() => upsertContact({ address: "nonsense", label: "X" }, storage), /valid Stellar/);
  assert.throws(() => upsertContact({ address: ACCOUNT, label: "   " }, storage), /label/);
  assert.equal(loadAddressBook(storage).length, 0);
});

test("lookupLabel finds a stored nickname and returns null otherwise", () => {
  const storage = memoryStorage();
  upsertContact({ address: CONTRACT, label: "Soroswap Router" }, storage);
  assert.equal(lookupLabel(CONTRACT, storage), "Soroswap Router");
  assert.equal(lookupLabel(" " + CONTRACT + " ", storage), "Soroswap Router", "trimmed on lookup");
  assert.equal(lookupLabel(OTHER, storage), null);
  assert.equal(lookupLabel("", storage), null);
});

test("deleteContact removes one and leaves the rest", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "A" }, storage);
  upsertContact({ address: OTHER, label: "B" }, storage);
  deleteContact(ACCOUNT, storage);
  const loaded = loadAddressBook(storage);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.address, OTHER);
  // Deleting an unknown address is a no-op, not an error.
  assert.equal(
    deleteContact("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", storage).length,
    1,
  );
});

test("a corrupt or non-array payload loads as an empty book", () => {
  assert.deepEqual(
    loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: "{ not json" })),
    [],
  );
  assert.deepEqual(loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: '{"a":1}' })), []);
});

test("entries with an invalid address or blank label are dropped on load", () => {
  const raw = JSON.stringify([
    { address: ACCOUNT, label: "good" },
    { address: "bad", label: "dropped" },
    { address: OTHER, label: "  " },
  ]);
  const loaded = loadAddressBook(memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: raw }));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]?.label, "good");
});

test("the book round-trips through the JSON export/import format", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Treasury Multisig" }, storage);
  upsertContact({ address: CONTRACT, label: "Soroswap Router" }, storage);
  const exported = exportAddressBook(loadAddressBook(storage));
  const reparsed = parseAddressBook(exported);
  assert.equal(reparsed.length, 2);
  assert.equal(
    lookupLabel(ACCOUNT, memoryStorage({ [ADDRESS_BOOK_STORAGE_KEY]: JSON.stringify(reparsed) })),
    "Treasury Multisig",
  );
});

test("parseAddressBook rejects invalid JSON, non-arrays, bad addresses and blank labels", () => {
  assert.throws(() => parseAddressBook("not json"), /valid JSON/);
  assert.throws(() => parseAddressBook('{"address":"x"}'), /array/);
  assert.throws(
    () => parseAddressBook('[{"address":"nope","label":"x"}]'),
    /Contact 1.*valid Stellar/,
  );
  assert.throws(
    () => parseAddressBook(`[{"address":"${ACCOUNT}","label":""}]`),
    /label is required/,
  );
});

test("parseAddressBook rejects a duplicate address within one import", () => {
  const dupe = JSON.stringify([
    { address: ACCOUNT, label: "one" },
    { address: ACCOUNT, label: "two" },
  ]);
  assert.throws(() => parseAddressBook(dupe), /duplicate address/);
});

test("merge is additive: keeps existing contacts, updates collisions, reports counts", () => {
  const storage = memoryStorage();
  upsertContact({ address: ACCOUNT, label: "Keep me" }, storage);
  upsertContact({ address: CONTRACT, label: "Old Router" }, storage);
  const tally = mergeAddressBook(
    loadAddressBook(storage),
    [
      { address: CONTRACT, label: "Soroswap Router", addedAt: new Date().toISOString() },
      { address: OTHER, label: "Cold Wallet", addedAt: new Date().toISOString() },
    ],
    storage,
  );
  assert.equal(tally.added, 1, "OTHER is new");
  assert.equal(tally.updated, 1, "CONTRACT relabelled");
  assert.equal(tally.total, 3);
  assert.equal(lookupLabel(ACCOUNT, storage), "Keep me", "untouched existing contact survives");
  assert.equal(lookupLabel(CONTRACT, storage), "Soroswap Router");
  assert.equal(lookupLabel(OTHER, storage), "Cold Wallet");
});

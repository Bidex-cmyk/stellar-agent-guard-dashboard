"use client";

/**
 * The operator address book modal (issue #100).
 *
 * Lets the operator name Stellar addresses ("Treasury Multisig", "Soroswap
 * Router") so the rest of the console can render those names instead of a wall
 * of look-alike strkeys. Add, edit and delete are validated against the SDK's
 * address parser before they touch storage, and the whole book exports to and
 * imports from portable JSON so it can move between browsers.
 *
 * The dialog reuses the focus discipline established by the freeze confirmation
 * in `PanicPanel`: focus moves in on open, Escape closes, focus returns to
 * whoever opened it.
 */

import { useEffect, useRef, useState } from "react";
import {
  deleteContact,
  exportAddressBook,
  loadAddressBook,
  mergeAddressBook,
  parseAddressBook,
  subscribeAddressBook,
  upsertContact,
  type Contact,
} from "../lib/guard/addressBook.ts";

export function AddressBookModal({ onClose }: { onClose: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>(() => loadAddressBook());
  const [editingAddress, setEditingAddress] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => subscribeAddressBook(() => setContacts(loadAddressBook())), []);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  function save() {
    setError(null);
    setNotice(null);
    try {
      upsertContact({ address: editingAddress, label: editingLabel });
      setEditingAddress("");
      setEditingLabel("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function edit(contact: Contact) {
    setEditingAddress(contact.address);
    setEditingLabel(contact.label);
    setError(null);
  }

  function remove(address: string) {
    deleteContact(address);
    if (editingAddress === address) {
      setEditingAddress("");
      setEditingLabel("");
    }
  }

  function doExport() {
    const blob = new Blob([exportAddressBook(contacts)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "stellar-agent-guard-address-book.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function doImport(file: File) {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const incoming = parseAddressBook(text);
      const tally = mergeAddressBook(loadAddressBook(), incoming);
      setNotice(
        `Imported ${tally.added} new and updated ${tally.updated} contact(s); the book now has ${tally.total}.`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="address-book-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <strong id="address-book-title">Address book</strong>
        <p className="tiny muted">
          Give the addresses you operate a name. Nicknames appear beside truncated addresses
          wherever the console shows them; the full address is always available on hover.
        </p>

        <label className="field">
          <span className="lbl">Address (G… account or C… contract)</span>
          <input
            value={editingAddress}
            onChange={(event) => {
              setEditingAddress(event.target.value);
              setError(null);
            }}
            placeholder="GBUQ…"
            aria-label="Contact address"
          />
        </label>
        <label className="field">
          <span className="lbl">Nickname</span>
          <input
            value={editingLabel}
            onChange={(event) => {
              setEditingLabel(event.target.value);
              setError(null);
            }}
            placeholder="Treasury Multisig"
            aria-label="Contact nickname"
          />
        </label>
        {error && (
          <div className="error" role="alert">
            <span className="t">Could not save that contact</span>
            <span className="mono">{error}</span>
          </div>
        )}
        {notice && <div className="notice info">{notice}</div>}

        <div className="row">
          <button onClick={save}>
            {contacts.some((contact) => contact.address === editingAddress.trim())
              ? "Update contact"
              : "Add contact"}
          </button>
          <button className="secondary" onClick={doExport} disabled={contacts.length === 0}>
            Export JSON
          </button>
          <button className="secondary" onClick={() => fileInputRef.current?.click()}>
            Import JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="visually-hidden"
            aria-label="Import address book file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void doImport(file);
            }}
          />
        </div>

        <div className="stack" style={{ marginTop: 12 }}>
          {contacts.length === 0 ? (
            <p className="tiny muted">No contacts yet. Add one above.</p>
          ) : (
            contacts.map((contact) => (
              <div
                key={contact.address}
                className="checkline"
                style={{ justifyContent: "space-between" }}
              >
                <span>
                  <strong style={{ fontSize: 13 }}>{contact.label}</strong>{" "}
                  <span className="mono tiny muted" title={contact.address}>
                    {contact.address.slice(0, 6)}…{contact.address.slice(-4)}
                  </span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button className="secondary" onClick={() => edit(contact)}>
                    Edit
                  </button>
                  <button className="secondary" onClick={() => remove(contact.address)}>
                    Delete
                  </button>
                </span>
              </div>
            ))
          )}
        </div>

        <div className="row">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

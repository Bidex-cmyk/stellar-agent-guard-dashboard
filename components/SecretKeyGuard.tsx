"use client";

/**
 * The global accidental key-leak guard (view half).
 *
 * Installs the document-level secret-key screen from
 * `lib/guard/inputSanitizer.ts` once per page and renders its alert as a
 * high-priority `alertdialog`. Mounted by the root layout so every route and
 * every text field — including ones inside panels this file never imports —
 * is covered.
 *
 * Focus follows the freeze-confirmation pattern: moved into the dialog on
 * open, trapped while it is up, restored to the dismissed field on close.
 * The dialog renders in a portal at the document body so no panel's stacking
 * context can sit on top of a security warning.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  installSecretKeyGuard,
  subscribeSecretKeyAlerts,
  dismissSecretKeyAlert,
  type SecretKeyAlert,
} from "../lib/guard/inputSanitizer.ts";

export function SecretKeyGuard() {
  const [alert, setAlert] = useState<SecretKeyAlert | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // One effect per concern: the screen itself is a side effect with no render
  // output; the alert subscription is a store binding. Both are stable, so
  // neither re-subscribes on unrelated re-renders.
  useEffect(() => installSecretKeyGuard(), []);
  useEffect(() => subscribeSecretKeyAlerts(setAlert), []);

  // Focus management for the alert dialog. While the alert is open, Tab cycles
  // inside it; Escape and Acknowledge dismiss it; and whichever field the
  // operator was typing into gets focus back, because a paste guard that eats
  // the caret is itself a usability bug.
  useEffect(() => {
    if (alert === null) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    previousFocus.current = document.activeElement as HTMLElement | null;
    dialog.focus();

    const focusables = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissSecretKeyAlert();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && dialog.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previousFocus.current?.focus();
    };
  }, [alert]);

  if (alert === null) return null;

  // Portal to the body: a security warning must not participate in any
  // panel's z-index ordering. An alert can only exist once a paste or change
  // event has fired in the browser, so reaching this line guarantees a DOM —
  // no mounted flag is needed to gate the portal.
  return createPortal(
    <div className="modal-backdrop">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="secret-key-alert-title"
        aria-describedby="secret-key-alert-body"
        ref={dialogRef}
        tabIndex={-1}
      >
        <strong id="secret-key-alert-title" style={{ color: "var(--danger)" }}>
          ⚠︎ Secret key detected
        </strong>
        <p className="tiny" id="secret-key-alert-body">
          {alert.message}
        </p>
        <p className="tiny muted">
          The input was cleared before anything was stored or sent. This dashboard only ever asks
          for public keys (G…), contract IDs (C…) and raw public keys (hex) — never seeds.
        </p>
        {alert.attempts > 1 && (
          <p className="tiny muted">Blocked {alert.attempts} attempts in this session.</p>
        )}
        <div className="row">
          <button className="danger" onClick={dismissSecretKeyAlert}>
            Acknowledge
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

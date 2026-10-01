/**
 * The clipboard write, as a pure, testable core (issue #33).
 *
 * `CopyButton` is the component face; this module is the logic it binds to, so
 * the arg-exactness and failure-path guarantees are testable without mounting a
 * React tree.
 *
 * Secure-context note (the failure the issue is about): the async Clipboard API
 * only exists in a secure context (HTTPS, or `file:`/localhost exemptions) and
 * only when the user's agent has granted write access. A dev server reached
 * over plain `http://` from a LAN address, or a permission denial, makes
 * `writeText` throw — the caller must surface that as a visible failure (the
 * component shows the manual-select hint and announces it), never as silence.
 */

/** The outcome of one copy attempt. `failure` carries what went wrong, briefly. */
export type CopyResult = { ok: true } | { ok: false; error: string };

/** The shape of `navigator.clipboard` this module needs (the write half only). */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** Read the live clipboard writer, or `null` outside a browser context. */
function liveClipboard(): ClipboardWriter | null {
  if (typeof navigator === "undefined") return null;
  const writer = (navigator as Navigator & { clipboard?: ClipboardWriter }).clipboard;
  return writer ?? null;
}

/**
 * True when the current context can plausibly support the async Clipboard API.
 *
 * `window.isSecureContext` is the browser's own answer; jsdom and other test
 * environments leave it undefined, so the absence of the API is treated as the
 * same "not available" case — which is exactly the insecure-context failure the
 * copy button must render rather than swallow.
 */
export function secureContextOk(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === true && liveClipboard() !== null;
}

/**
 * Copy `text` through the async Clipboard API.
 *
 * Never throws: a rejection (insecure context, permission denied) comes back as
 * `{ ok: false, error }`. The `writer` parameter exists for tests to inject a
 * capturing or rejecting mock; production callers omit it.
 */
export async function copyToClipboard(text: string, writer?: ClipboardWriter): Promise<CopyResult> {
  const target = writer ?? liveClipboard();
  if (!target) {
    return {
      ok: false,
      error:
        "clipboard is unavailable — this browser context is not secure or has denied clipboard access",
    };
  }
  try {
    await target.writeText(text);
    return { ok: true };
  } catch (caught) {
    return {
      ok: false,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

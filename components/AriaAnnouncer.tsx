"use client";

/**
 * The live regions that actually speak.
 *
 * Two regions are rendered up front and never replaced: one `polite` for
 * routine lifecycle updates, one `assertive` for critical alerts. Swapping a
 * region's node would detach it from the accessibility tree and silence it,
 * so the regions are static and only their text content changes.
 *
 * The queue is drained one message at a time with a short gap, and the region
 * is cleared before each message is written. The clear/write pair happens in
 * two ticks on purpose: setting the same text twice in one tick produces no
 * DOM mutation a screen reader would notice, which would silently drop a
 * legitimate repeat announcement (e.g. two confirmations on the same ledger).
 */

import { useEffect, useRef, useState } from "react";
import {
  shiftAnnouncement,
  subscribeAnnouncements,
  type Announcement,
} from "../lib/guard/useAnnounce.ts";

/** Delay before the text is written, so clear + set are two separate mutations. */
const SPEAK_DELAY_MS = 60;

/** Gap between messages, so each lands as its own utterance. */
const SPEAK_GAP_MS = 400;

export function AriaAnnouncer() {
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);
  const [queue, setQueue] = useState<Announcement[]>([]);

  // Subscribing flushes any backlog that accumulated before mount.
  useEffect(() => subscribeAnnouncements(setQueue), []);

  const current = queue[0];
  useEffect(() => {
    if (current === undefined) return;
    const region = current.priority === "assertive" ? assertiveRef.current : politeRef.current;
    if (!region) return;

    region.textContent = "";
    const speak = setTimeout(() => {
      region.textContent = current.message;
    }, SPEAK_DELAY_MS);
    const next = setTimeout(() => shiftAnnouncement(), SPEAK_GAP_MS);

    return () => {
      clearTimeout(speak);
      clearTimeout(next);
    };
  }, [current]);

  return (
    <>
      <div ref={politeRef} className="visually-hidden" aria-live="polite" aria-atomic="true" />
      <div
        ref={assertiveRef}
        className="visually-hidden"
        aria-live="assertive"
        aria-atomic="true"
      />
    </>
  );
}

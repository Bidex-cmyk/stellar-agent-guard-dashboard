"use client";

/**
 * Registers the static-shell service worker.
 *
 * The worker caches only the app shell; every chain read bypasses it (see
 * `public/sw.js`). Registration waits for `load` so it never competes with the
 * first paint for bandwidth, and it is skipped outside production because a
 * cache-first shell in development would serve a stale build back at the
 * developer.
 *
 * Renders nothing: this is a side-effect-only component mounted by the root
 * layout so every route, not just the console overview, becomes installable.
 */

import { useEffect } from "react";
import { SERVICE_WORKER_PATH } from "../lib/guard/pwa.ts";

export function PwaRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      void navigator.serviceWorker.register(SERVICE_WORKER_PATH).catch((error: unknown) => {
        // A failed registration only costs the offline shell; the console
        // itself keeps working, so this is logged, never surfaced as an error.
        console.warn("Service worker registration failed:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

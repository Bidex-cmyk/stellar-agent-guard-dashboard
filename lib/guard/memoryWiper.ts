export type WiperCallback = () => void;

class MemoryWiper {
  private callbacks = new Set<WiperCallback>();

  /**
   * Register a cleanup function to be called on wipe.
   * Returns a function to unregister the callback.
   */
  add(cb: WiperCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  /**
   * Zero out sensitive state and run all registered cleanup callbacks.
   */
  wipe(): void {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.clear();
    }
    
    for (const cb of this.callbacks) {
      try {
        cb();
      } catch {
        // Ignore errors during wipe to ensure all callbacks run.
      }
    }
  }

  /**
   * Bind the wiper to browser lifecycle events.
   * Runs the wipe when the page is hidden or before it unloads.
   */
  registerBrowserEvents(): () => void {
    if (typeof window === "undefined") return () => {};

    const handler = () => this.wipe();
    window.addEventListener("pagehide", handler);
    window.addEventListener("beforeunload", handler);

    return () => {
      window.removeEventListener("pagehide", handler);
      window.removeEventListener("beforeunload", handler);
    };
  }
}

export const memoryWiper = new MemoryWiper();

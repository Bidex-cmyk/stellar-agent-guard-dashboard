"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A portal component that renders children into a DOM node outside the normal DOM hierarchy.
 * Useful for tooltips, modals, and other UI elements that need to break out of their container.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement("div");
    el.setAttribute("data-portal", "");
    document.body.appendChild(el);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContainer(el);

    return () => {
      if (el.parentNode) {
        el.parentNode.removeChild(el);
      }
    };
  }, []);

  if (!container) {
    return null;
  }

  return createPortal(children, container);
}

"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { Portal } from "./Portal.tsx";

/**
 * An accessible tooltip component implementing the WAI-ARIA Tooltip pattern.
 *
 * Features:
 * - Appears on mouse enter or keyboard focus
 * - Dismisses on mouse leave, blur, or Escape keypress
 * - Automatic positioning (top, bottom, left, right) to stay within viewport
 * - Delay timers to prevent accidental showing
 * - Fully accessible with proper ARIA attributes
 */
export function Tooltip({
  children,
  content,
  delay = 500,
  distance = 10,
}: {
  children?: React.ReactElement;
  content: string;
  delay?: number; // milliseconds to wait before showing
  distance?: number; // pixels from trigger
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [position, setPosition] = useState<"top" | "bottom" | "left" | "right">("top");
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({
    position: "fixed",
    zIndex: 1000,
    pointerEvents: "none",
  });
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Update tooltip position when window resizes or scrolls
  useEffect(() => {
    if (!showTooltip || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      // Get tooltip dimensions
      let tooltipWidth = 0;
      let tooltipHeight = 0;
      if (tooltipRect) {
        tooltipWidth = tooltipRect.width;
        tooltipHeight = tooltipRect.height;
      } else if (tooltipRef.current) {
        const rect = tooltipRef.current.getBoundingClientRect();
        tooltipWidth = rect.width;
        tooltipHeight = rect.height;
      }

      // Calculate potential positions
      const positions: Array<{
        side: "top" | "bottom" | "left" | "right";
        x: number;
        y: number;
        fits: boolean;
      }> = [];

      // Top position
      positions.push({
        side: "top",
        x: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
        y: triggerRect.top - distance - tooltipHeight,
        fits:
          triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2 >= 0 &&
          triggerRect.left + triggerRect.width / 2 + tooltipWidth / 2 <= viewportWidth &&
          triggerRect.top - distance - tooltipHeight >= 0,
      });

      // Bottom position
      positions.push({
        side: "bottom",
        x: triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2,
        y: triggerRect.bottom + distance,
        fits:
          triggerRect.left + triggerRect.width / 2 - tooltipWidth / 2 >= 0 &&
          triggerRect.left + triggerRect.width / 2 + tooltipWidth / 2 <= viewportWidth &&
          triggerRect.bottom + distance + tooltipHeight <= viewportHeight,
      });

      // Left position
      positions.push({
        side: "left",
        x: triggerRect.left - distance - tooltipWidth,
        y: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        fits:
          triggerRect.left - distance - tooltipWidth >= 0 &&
          triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2 >= 0 &&
          triggerRect.top + triggerRect.height / 2 + tooltipHeight / 2 <= viewportHeight,
      });

      // Right position
      positions.push({
        side: "right",
        x: triggerRect.right + distance,
        y: triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2,
        fits:
          triggerRect.right + distance + tooltipWidth <= viewportWidth &&
          triggerRect.top + triggerRect.height / 2 - tooltipHeight / 2 >= 0 &&
          triggerRect.top + triggerRect.height / 2 + tooltipHeight / 2 <= viewportHeight,
      });

      // Find the first position that fits, or default to top if none fit
      const bestPosition = positions.find((pos) => pos.fits) ?? positions[0];
      const side = bestPosition ? bestPosition.side : "top";
      setPosition(side);

      let style: React.CSSProperties = {
        position: "fixed",
        zIndex: 1000,
        pointerEvents: "none",
      };

      switch (side) {
        case "top":
          style = {
            ...style,
            bottom: `calc(100vh - ${triggerRect.top}px + ${distance}px)`,
            left: `${triggerRect.left + triggerRect.width / 2 - 50}px`,
            transform: "translateX(-50%)",
          };
          break;
        case "bottom":
          style = {
            ...style,
            top: `${triggerRect.bottom + distance}px`,
            left: `${triggerRect.left + triggerRect.width / 2 - 50}px`,
            transform: "translateX(-50%)",
          };
          break;
        case "left":
          style = {
            ...style,
            right: `calc(100vw - ${triggerRect.left}px + ${distance}px)`,
            top: `${triggerRect.top + triggerRect.height / 2 - 25}px`,
            transform: "translateY(-50%)",
          };
          break;
        case "right":
          style = {
            ...style,
            left: `${triggerRect.right + distance}px`,
            top: `${triggerRect.top + triggerRect.height / 2 - 25}px`,
            transform: "translateY(-50%)",
          };
          break;
      }
      setTooltipStyle(style);
    };

    // Update position on resize and scroll
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition);

    // Initial position update
    updatePosition();

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition);
    };
  }, [showTooltip, distance, tooltipRect]);

  // Handle mouse enter on trigger
  const handleMouseEnter = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setShowTooltip(true), delay);
  }, [delay]);

  // Handle mouse leave on trigger
  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setShowTooltip(false);
  }, []);

  // Handle focus on trigger
  const handleFocus = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setShowTooltip(true), delay);
  }, [delay]);

  // Handle blur on trigger
  const handleBlur = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setShowTooltip(false);
  }, []);

  // Ensure DOM event dispatching (like in tests) triggers handlers
  useEffect(() => {
    const el = triggerRef.current;
    if (!el) return;

    el.addEventListener("mouseenter", handleMouseEnter);
    el.addEventListener("mouseleave", handleMouseLeave);
    el.addEventListener("focus", handleFocus);
    el.addEventListener("blur", handleBlur);

    return () => {
      el.removeEventListener("mouseenter", handleMouseEnter);
      el.removeEventListener("mouseleave", handleMouseLeave);
      el.removeEventListener("focus", handleFocus);
      el.removeEventListener("blur", handleBlur);
    };
  }, [handleMouseEnter, handleMouseLeave, handleFocus, handleBlur]);

  // Handle escape key to dismiss tooltip
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showTooltip) {
        setShowTooltip(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [showTooltip]);

  const tooltipCallbackRef = useCallback((node: HTMLDivElement | null) => {
    tooltipRef.current = node;
    if (node) {
      setTooltipRect(node.getBoundingClientRect());
    }
  }, []);

  if (!children) {
    return null;
  }

  // Don't render tooltip content when not showing (for performance)
  if (!showTooltip) {
    return (
      <>
        {React.cloneElement(children, {
          ref: triggerRef,
          "aria-describedby": null,
          onMouseEnter: handleMouseEnter,
          onMouseLeave: handleMouseLeave,
          onFocus: handleFocus,
          onBlur: handleBlur,
        } as any)}
      </>
    );
  }

  return (
    <>
      {/* Trigger element */}
      {React.cloneElement(children, {
        ref: triggerRef,
        "aria-describedby": showTooltip ? "tooltip-content" : undefined,
        onMouseEnter: handleMouseEnter,
        onMouseLeave: handleMouseLeave,
        onFocus: handleFocus,
        onBlur: handleBlur,
      } as any)}

      {/* Tooltip content (rendered in portal to avoid z-index issues) */}
      <Portal>
        <div
          role="tooltip"
          id="tooltip-content"
          ref={tooltipCallbackRef}
          className="tooltip"
          style={tooltipStyle}
        >
          <div className="tooltip-content">{content}</div>
        </div>
      </Portal>
    </>
  );
}

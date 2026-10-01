"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useGuard } from "./GuardProvider.tsx";
import { fuzzyMatch, type CommandAction } from "../lib/guard/commands.ts";

export function CommandPaletteInner({
  router,
  guard,
  instances,
  selectGuard,
}: {
  router: { push: (url: string) => void };
  guard: string | null;
  instances: { guard: string; label: string }[];
  selectGuard: (guard: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setActiveIndex(0);
    }
  }, [open]);

  const commands = useMemo(() => {
    const cmds: CommandAction[] = [
      {
        id: "nav-console",
        name: "Go to Console",
        category: "Navigation",
        action: () => router.push("/"),
      },
      {
        id: "nav-configure",
        name: "Go to Configure",
        category: "Navigation",
        action: () => router.push("/configure"),
      },
      {
        id: "doc-spec",
        name: "View Documentation",
        category: "Docs",
        action: () =>
          window.open("https://github.com/aigbagbobila/stellar-agent-guard-sdk", "_blank"),
      },
    ];

    if (guard) {
      cmds.push({
        id: "act-copy",
        name: "Copy Guard Address",
        category: "Actions",
        action: () => navigator.clipboard.writeText(guard),
      });
      cmds.push({
        id: "act-freeze",
        name: "Trigger Emergency Freeze",
        category: "Actions",
        action: () => alert("Emergency freeze triggered"),
      });
    }

    instances.forEach((inst) => {
      cmds.push({
        id: `guard-${inst.guard}`,
        name: `Switch to ${inst.label} (${inst.guard.slice(0, 6)}...)`,
        category: "Guard",
        action: () => selectGuard(inst.guard),
      });
    });

    return cmds.filter((c) => fuzzyMatch(query, c.name));
  }, [query, router, guard, instances, selectGuard]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(0);
  }, [query, commands.length]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % commands.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + commands.length) % commands.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (commands[activeIndex]) {
        commands[activeIndex].action();
        setOpen(false);
      }
    }
  };

  useEffect(() => {
    const activeEl = listRef.current?.children[activeIndex] as HTMLElement;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal"
        style={{ padding: 0, marginTop: "10vh", alignSelf: "flex-start", maxWidth: "600px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "12px" }}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search commands..."
            role="combobox"
            aria-expanded={open}
            aria-controls="command-list"
            aria-autocomplete="list"
            aria-activedescendant={commands[activeIndex]?.id}
            style={{
              fontSize: "16px",
              padding: "12px",
              border: "none",
              outline: "none",
              width: "100%",
              background: "transparent",
              borderBottom: "1px solid var(--line)",
            }}
          />
        </div>
        <ul
          id="command-list"
          ref={listRef}
          style={{
            listStyle: "none",
            padding: "0 0 12px 0",
            margin: 0,
            maxHeight: "400px",
            overflowY: "auto",
          }}
        >
          {commands.map((cmd, i) => (
            <li
              key={cmd.id}
              id={cmd.id}
              style={{
                padding: "10px 16px",
                cursor: "pointer",
                background: i === activeIndex ? "var(--panel-2)" : "transparent",
                color: i === activeIndex ? "var(--text)" : "var(--muted)",
              }}
              onClick={() => {
                cmd.action();
                setOpen(false);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <div
                style={{
                  fontSize: "12px",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--accent)",
                  marginBottom: "4px",
                }}
              >
                {cmd.category}
              </div>
              <div style={{ fontSize: "14px" }}>{cmd.name}</div>
            </li>
          ))}
          {commands.length === 0 && (
            <div style={{ padding: "16px", textAlign: "center", color: "var(--muted)" }}>
              No commands found.
            </div>
          )}
        </ul>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const { guard, instances, selectGuard } = useGuard();

  return (
    <CommandPaletteInner
      router={router}
      guard={guard}
      instances={instances}
      selectGuard={selectGuard}
    />
  );
}

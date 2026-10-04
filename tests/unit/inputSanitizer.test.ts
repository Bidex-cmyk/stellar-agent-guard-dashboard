import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { installDom, loadReact, sleep, type Act } from "./domHarness.ts";
import {
  SECRET_KEY_PATTERN,
  SECRET_KEY_WARNING,
  dismissSecretKeyAlert,
  findSecretKeyInText,
  getSecretKeyAlert,
  installSecretKeyGuard,
  isStellarSecretKey,
  raiseSecretKeyAlert,
  sanitizeAddressInput,
  subscribeSecretKeyAlerts,
} from "../../lib/guard/inputSanitizer.ts";

installDom();

let act: Act;

before(async () => {
  const loaded = await loadReact();
  act = loaded.act;
});

// Fixtures are generated so their length is exactly right by construction — a
// hand-typed 56-character seed is one miscount away from testing nothing.
const SECRET = `S${"A3Y5Q".repeat(11)}`; // S + 55 base32 chars
const PUBLIC = `G${"AB2C4".repeat(11)}`; // G + 55 base32 chars
const CONTRACT = `C${"AB2C4".repeat(11)}`; // C + 55 base32 chars

describe("secret seed detection", () => {
  it("matches the exact Stellar secret seed regex", () => {
    assert.match(SECRET, SECRET_KEY_PATTERN);
    assert.equal(isStellarSecretKey(SECRET), true);
  });

  it("accepts every character the shape allows, including digits after S", () => {
    assert.ok(SECRET_KEY_PATTERN.test(`S${"0".repeat(55)}`));
    assert.ok(SECRET_KEY_PATTERN.test(`S${"9".repeat(55)}`));
    assert.ok(SECRET_KEY_PATTERN.test(`S${"A".repeat(55)}`));
  });

  it("rejects the wrong length, prefix, alphabet and empty input", () => {
    assert.equal(isStellarSecretKey(""), false);
    assert.equal(isStellarSecretKey("S"), false);
    // 54 payload chars: one short.
    assert.equal(isStellarSecretKey(`S${"A".repeat(54)}`), false);
    // 56 payload chars: one long.
    assert.equal(isStellarSecretKey(`S${"A".repeat(56)}`), false);
    // Public-key and contract-id prefixes are never secrets.
    assert.equal(isStellarSecretKey(PUBLIC), false);
    assert.equal(isStellarSecretKey(CONTRACT), false);
    // Lowercase is never a strkey.
    assert.equal(isStellarSecretKey(`s${"a".repeat(55)}`), false);
    // Punctuation and interior spaces break the alphabet.
    assert.equal(isStellarSecretKey(`S${"A".repeat(54)}!`), false);
    assert.equal(isStellarSecretKey(`S ${"A".repeat(54)}`), false);
  });

  it("tolerates surrounding whitespace but not interior gaps", () => {
    assert.equal(isStellarSecretKey(`  ${SECRET}  `), true);
    assert.equal(isStellarSecretKey(`\n${SECRET}\t`), true);
    assert.equal(isStellarSecretKey(`${SECRET} extra`), false);
  });

  it("rejects non-string garbage without throwing", () => {
    assert.equal(isStellarSecretKey(String(undefined)), false);
  });
});

describe("finding a secret inside pasted text", () => {
  it("catches a bare secret", () => {
    assert.equal(findSecretKeyInText(SECRET), SECRET);
  });

  it("catches a secret pasted with a label, JSON or newline separation", () => {
    assert.equal(findSecretKeyInText(`my key: ${SECRET}`), SECRET);
    assert.equal(findSecretKeyInText(`{"secret":"${SECRET}"}`), SECRET);
    assert.equal(findSecretKeyInText(`${PUBLIC}\n${SECRET}`), SECRET);
  });

  it("returns null for clean text of every ordinary kind", () => {
    assert.equal(findSecretKeyInText(PUBLIC), null);
    assert.equal(findSecretKeyInText(CONTRACT), null);
    assert.equal(findSecretKeyInText("1000"), null);
    assert.equal(findSecretKeyInText("not an address"), null);
    assert.equal(findSecretKeyInText(""), null);
  });

  it("does not flag secret-shaped runs that are part of a longer token", () => {
    // A longer run, or one embedded inside other alphanumerics, is not a
    // standalone strkey and must not false-positive.
    assert.equal(findSecretKeyInText(`X${SECRET}`), null);
    assert.equal(findSecretKeyInText(`${SECRET}X`), null);
  });
});

describe("sanitizeAddressInput", () => {
  it("passes ordinary values through untouched", () => {
    assert.equal(sanitizeAddressInput(PUBLIC), PUBLIC);
    assert.equal(sanitizeAddressInput(CONTRACT), CONTRACT);
    assert.equal(sanitizeAddressInput("1000"), "1000");
    assert.equal(sanitizeAddressInput("not-an-address"), "not-an-address");
    assert.equal(sanitizeAddressInput(""), "");
  });

  it("replaces a secret seed with the empty string", () => {
    assert.equal(sanitizeAddressInput(SECRET), "");
    assert.equal(sanitizeAddressInput(`  ${SECRET} `), "");
    assert.equal(sanitizeAddressInput(`key: ${SECRET}`), "");
  });

  it("clears the whole value when a secret is anywhere in it", () => {
    // There is no partial keep: a value that arrived with a secret in it is
    // tainted, and keeping the "clean" remainder would still store evidence.
    assert.equal(sanitizeAddressInput(`${PUBLIC}\n${SECRET}`), "");
  });
});

describe("security alert store", () => {
  it("starts with no alert and notifies subscribers immediately on subscribe", () => {
    dismissSecretKeyAlert();
    assert.equal(getSecretKeyAlert(), null);
    let seen: unknown = "unset";
    const unsubscribe = subscribeSecretKeyAlerts((alert) => {
      seen = alert;
    });
    assert.equal(seen, null);
    unsubscribe();
  });

  it("raises the exact required warning text", () => {
    dismissSecretKeyAlert();
    raiseSecretKeyAlert();
    const alert = getSecretKeyAlert();
    assert.ok(alert);
    assert.equal(alert.message, SECRET_KEY_WARNING);
    assert.equal(
      alert.message,
      "SECURITY ALERT: You pasted a secret key. This dashboard never requires secret keys. Do not share your private key.",
    );
  });

  it("counts repeated attempts on one alert instead of stacking dialogs", () => {
    dismissSecretKeyAlert();
    raiseSecretKeyAlert();
    raiseSecretKeyAlert();
    const alert = getSecretKeyAlert();
    assert.equal(alert?.attempts, 2);
    dismissSecretKeyAlert();
    assert.equal(getSecretKeyAlert(), null);
  });

  it("stops notifying after unsubscribe", () => {
    dismissSecretKeyAlert();
    let calls = 0;
    const unsubscribe = subscribeSecretKeyAlerts(() => {
      calls += 1;
    });
    assert.equal(calls, 1); // the immediate flush on subscribe
    raiseSecretKeyAlert();
    assert.equal(calls, 2);
    unsubscribe();
    raiseSecretKeyAlert();
    dismissSecretKeyAlert();
    assert.equal(calls, 2);
  });
});

describe("document-level paste/input/change interception", () => {
  // A per-test guard handle plus a mirror of the store, reset before each case
  // so no assertion can pass on a leftover alert from a previous test.
  let uninstall: (() => void) | null = null;
  let lastAlert: { message: string } | null = null;

  before(() => {
    subscribeSecretKeyAlerts((alert) => {
      lastAlert = alert;
    });
  });

  function reset(): void {
    uninstall?.();
    uninstall = null;
    dismissSecretKeyAlert();
    lastAlert = null;
  }

  function install(): void {
    uninstall = installSecretKeyGuard();
  }

  function makeField(type = "text"): HTMLInputElement {
    const field = document.createElement("input");
    field.type = type;
    document.body.appendChild(field);
    return field;
  }

  /** A paste event carrying the given clipboard text, dispatched at the target. */
  function paste(target: HTMLInputElement | HTMLTextAreaElement, text: string): void {
    const event = document.createEvent("Event") as Event & { clipboardData?: unknown };
    event.initEvent("paste", true, true);
    event.clipboardData = {
      getData: (type: string) => (type === "text/plain" || type === "text" ? text : ""),
    };
    target.dispatchEvent(event);
  }

  /** Set the field's value (unless omitted) and dispatch a bubbling event. */
  function fire(
    target: HTMLInputElement | HTMLTextAreaElement,
    type: "input" | "change",
    value?: string,
  ): void {
    if (value !== undefined) target.value = value;
    const event = document.createEvent("Event");
    event.initEvent(type, true, false);
    target.dispatchEvent(event);
  }

  it("blocks a pasted secret before it reaches the field and raises the warning", () => {
    reset();
    install();
    try {
      const field = makeField();
      field.value = "typing already here";
      paste(field, SECRET);

      // The spec is explicit: a blocked paste clears the input buffer — the
      // field must end empty, not with whatever sat there before the paste.
      assert.equal(field.value, "", "the paste must be blocked and the buffer cleared");
      assert.ok(lastAlert, "a security alert must be raised");
      assert.equal(lastAlert?.message, SECRET_KEY_WARNING);
      assert.ok(getSecretKeyAlert());
    } finally {
      reset();
    }
  });

  it("lets ordinary pastes through untouched", () => {
    reset();
    install();
    try {
      const field = makeField();
      field.value = "preset";
      paste(field, PUBLIC);
      // jsdom performs no default paste insertion, so an unblocked paste means
      // the field keeps exactly what it had and the guard stays silent.
      assert.equal(field.value, "preset");
      assert.equal(getSecretKeyAlert(), null);
    } finally {
      reset();
    }
  });

  it("clears the field when a secret arrives via input without clipboard data", () => {
    reset();
    install();
    try {
      const field = makeField();
      fire(field, "input", SECRET);
      assert.equal(field.value, "", "the input net must clear a secret already in the field");
      assert.ok(lastAlert);
    } finally {
      reset();
    }
  });

  it("still catches a secret on change (blur) if earlier layers missed it", () => {
    reset();
    install();
    try {
      const field = makeField();
      fire(field, "change", SECRET);
      assert.equal(field.value, "", "the change net must clear the field before focus moves on");
      assert.ok(lastAlert);
    } finally {
      reset();
    }
  });

  it("ignores non-text targets", () => {
    reset();
    install();
    try {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      document.body.appendChild(checkbox);
      paste(checkbox, SECRET);
      fire(checkbox, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null, "checkboxes are never screened");
    } finally {
      reset();
    }
  });

  it("screens textareas, including secrets pasted inside other text", () => {
    reset();
    install();
    try {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      paste(textarea, `surrounded ${SECRET}`);
      assert.equal(textarea.value, "", "a textarea paste carrying a secret must be blocked");

      fire(textarea, "change", PUBLIC);
      assert.equal(textarea.value, PUBLIC, "clean values pass through");
    } finally {
      reset();
    }
  });

  it("skips disabled and readonly fields", () => {
    reset();
    install();
    try {
      const locked = makeField();
      locked.disabled = true;
      fire(locked, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null);

      const readonly = makeField();
      readonly.readOnly = true;
      fire(readonly, "input", SECRET);
      assert.equal(getSecretKeyAlert(), null);
    } finally {
      reset();
    }
  });

  it("covers password, number and search fields too", () => {
    reset();
    install();
    try {
      for (const type of ["password", "number", "search"]) {
        const field = makeField(type);
        fire(field, "input", SECRET);
        assert.equal(field.value, "", `a ${type} field must be cleared`);
        dismissSecretKeyAlert();
      }
    } finally {
      reset();
    }
  });

  it("stops screening once uninstalled", () => {
    reset();
    install();
    const field = makeField();
    try {
      fire(field, "input", SECRET);
      assert.equal(field.value, "");

      uninstall?.();
      uninstall = null;
      dismissSecretKeyAlert();
      fire(field, "input", SECRET);
      assert.equal(field.value, SECRET, "with the guard down the field keeps whatever it holds");
    } finally {
      reset();
      field.remove();
    }
  });

  it("clears a React-controlled field whose onChange runs the sanitizer", async () => {
    // The state layer (DeployPanel-style wiring): a secret typed through React's
    // own event path must come back as an empty value in both state and DOM.
    reset();
    const { react, createRoot } = await loadReact();
    const container = document.createElement("div");
    document.body.appendChild(container);

    let latest: string | null = null;
    function Controlled() {
      const [value, setValue] = react.useState("");
      react.useEffect(() => {
        latest = value;
      });
      return react.createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) =>
          setValue(sanitizeAddressInput(event.target.value)),
      });
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(react.createElement(Controlled));
    });

    try {
      const field = container.querySelector("input")!;
      // The standard controlled-input typing simulation: write through the
      // native prototype setter so React's value tracker sees a change, then
      // dispatch the input event React listens for.
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      assert.ok(setValue);
      setValue.call(field, SECRET);
      const event = document.createEvent("Event");
      event.initEvent("input", true, false);
      field.dispatchEvent(event);

      await act(async () => {
        await sleep(0);
      });
      assert.equal(field.value, "", "DOM value ends cleared");
      assert.equal(latest, "", "React state settles on the sanitized (empty) value");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      reset();
    }
  });

  it("leaves state and DOM consistent when the guard clears a controlled field", async () => {
    // The DOM layer under a controlled component: the guard's capture-phase
    // clear runs before React sees the event, and the field settles empty with
    // no secret ever reaching the component's state.
    reset();
    install();
    const { react, createRoot } = await loadReact();
    const container = document.createElement("div");
    document.body.appendChild(container);

    const seen: string[] = [];
    function Controlled() {
      const [value, setValue] = react.useState("");
      react.useEffect(() => {
        seen.push(value);
      });
      return react.createElement("input", {
        value,
        onChange: (event: { target: { value: string } }) => setValue(event.target.value),
      });
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(react.createElement(Controlled));
    });

    try {
      const field = container.querySelector("input")!;
      fire(field, "input", SECRET);
      await act(async () => {
        await sleep(0);
      });
      assert.equal(field.value, "", "DOM value cleared by the guard");
      assert.ok(
        seen.every((value) => !value.includes(SECRET)),
        "no render may ever hold the secret",
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      reset();
    }
  });
});

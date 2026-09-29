import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import {
  AudioAlerter,
  BEEP_COUNT,
  DEFAULT_ALERT_SETTINGS,
  MAX_ALERT_AUDIO_MS,
  ALERT_SETTINGS_STORAGE_KEY,
  alertPlanDurationMs,
  alertReasonFor,
  alertTonePlan,
  alertsArmed,
  buildNotificationPayload,
  clampVolume,
  createAlertTracker,
  deliverNotification,
  gainForVolume,
  isSecurityCritical,
  loadAlertSettings,
  notificationPermissionState,
  requestNotificationPermission,
  saveAlertSettings,
  type AudioContextLike,
  type GainLike,
  type NotificationApi,
  type OscillatorLike,
} from "../../lib/guard/audioAlert.ts";

/**
 * Alerting is the one feature here that interrupts a human being, so the tests
 * are strict about the two properties that make it tolerable: the chime is
 * short, and it only ever sounds for an event the guard actually refused or an
 * admin actually changed the rules.
 */

function event(overrides: Partial<GuardEvent> = {}): GuardEvent {
  return {
    kind: "auth_checked",
    topic: "event_auth_checked",
    source: "ledger",
    contractId: null,
    ledger: 100,
    ledgerClosedAt: "2026-09-25T12:00:00.000Z",
    transactionHash: "a".repeat(64),
    decision: { result: "allowed", reason: null, source: "ledger" },
    data: {},
    ...overrides,
  };
}

// ── A fake AudioContext that records exactly what was scheduled ────────────

interface FakeOscillator extends OscillatorLike {
  readonly startedAt: (number | undefined)[];
  readonly stoppedAt: (number | undefined)[];
}

function createFakeAudioContext(startOfTime = 1000) {
  const oscillators: FakeOscillator[] = [];
  const gains: GainLike[] = [];
  let resumes = 0;
  let closes = 0;

  const context: AudioContextLike = {
    currentTime: startOfTime,
    destination: { id: "destination" },
    state: "running",
    createOscillator() {
      const startedAt: (number | undefined)[] = [];
      const stoppedAt: (number | undefined)[] = [];
      const oscillator: FakeOscillator = {
        type: "sine",
        frequency: { value: 440 },
        startedAt,
        stoppedAt,
        connect: () => oscillator,
        start: (when) => void startedAt.push(when),
        stop: (when) => void stoppedAt.push(when),
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      const gain: GainLike = { gain: { value: 1 }, connect: () => ({}) };
      gains.push(gain);
      return gain;
    },
    resume: async () => {
      resumes += 1;
      return undefined;
    },
    close: async () => {
      closes += 1;
      return undefined;
    },
  };

  return {
    context,
    oscillators,
    gains,
    resumes: () => resumes,
    closes: () => closes,
  };
}

function fakeNotificationApi(
  permission: string,
  options: { requestPermission?: () => Promise<string>; show?: NotificationApi["show"] } = {},
): NotificationApi & { shown: { title: string; options: unknown }[] } {
  const shown: { title: string; options: unknown }[] = [];
  return {
    permission,
    requestPermission: options.requestPermission ?? (async () => permission),
    show:
      options.show ??
      ((title, payload) => {
        shown.push({ title, options: payload });
        return {};
      }),
    shown,
  };
}

describe("alert condition matching", () => {
  it("sounds for a blocked decision, which is the case the operator must not miss", () => {
    assert.equal(
      alertReasonFor(event({ decision: { result: "blocked", reason: "cap_exceeded", source: "diagnostic" } })),
      "blocked",
    );
    assert.equal(isSecurityCritical(event({ decision: { result: "blocked", reason: null, source: "ledger" } })), true);
  });

  it("treats an admin freeze and a revoked policy as security-critical", () => {
    assert.equal(alertReasonFor(event({ kind: "frozen", topic: "event_frozen", decision: null })), "frozen");
    assert.equal(
      alertReasonFor(event({ kind: "policy_revoked", topic: "event_policy_revoked", decision: null })),
      "policy_revoked",
    );
  });

  it("stays quiet for routine events, which is what keeps the alert unmuted", () => {
    assert.equal(alertReasonFor(event()), null);
    assert.equal(alertReasonFor(event({ kind: "heartbeat", topic: "event_heartbeat", decision: null })), null);
    assert.equal(alertReasonFor(event({ kind: "policy_set", topic: "event_policy_set", decision: null })), null);
    assert.equal(alertReasonFor(event({ kind: "unfrozen", topic: "event_unfrozen", decision: null })), null);
    assert.equal(alertReasonFor(event({ kind: "initialized", topic: "event_initialized", decision: null })), null);
  });

  it("tolerates a missing event rather than inventing an alert", () => {
    assert.equal(alertReasonFor(null), null);
    assert.equal(alertReasonFor(undefined), null);
    assert.equal(
      alertReasonFor(event({ decision: null })),
      null,
      "an auth_checked event with no decoded decision says nothing about a block",
    );
  });

  it("is armed only when a channel is on, and both default to off", () => {
    assert.deepEqual(DEFAULT_ALERT_SETTINGS, { audio: false, desktop: false, volume: 0.4 });
    assert.equal(alertsArmed(DEFAULT_ALERT_SETTINGS), false);
    assert.equal(alertsArmed({ ...DEFAULT_ALERT_SETTINGS, audio: true }), true);
    assert.equal(alertsArmed({ ...DEFAULT_ALERT_SETTINGS, desktop: true }), true);
  });
});

describe("the chime", () => {
  it("is two beeps totalling under the 200ms ceiling", () => {
    const plan = alertTonePlan();
    assert.equal(plan.length, BEEP_COUNT);
    assert.equal(plan[0]!.startMs, 0);
    assert.ok(plan[1]!.startMs > plan[0]!.startMs + plan[0]!.durationMs, "the beeps are separated by silence");
    assert.ok(
      alertPlanDurationMs(plan) < MAX_ALERT_AUDIO_MS,
      `a ${alertPlanDurationMs(plan)}ms chime is an interrupt, not a jingle`,
    );
    for (const tone of plan) assert.equal(tone.durationMs, 80);
  });

  it("never sounds before the first user gesture, per the autoplay policy", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 0.5 });

    const refused = alerter.play();
    assert.equal(refused.played, false);
    assert.equal(refused.reason, "not-unlocked");
    assert.equal(fake.oscillators.length, 0, "no oscillator may exist before a gesture");
    assert.equal(alerter.unlocked, false);

    assert.equal(alerter.unlock(), "ready");
    assert.equal(alerter.unlocked, true);
    assert.equal(fake.resumes(), 1, "unlocking is what resumes the context");
  });

  it("schedules one oscillator per beep against the context clock when it plays", () => {
    const fake = createFakeAudioContext(42);
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 0.5 });
    alerter.unlock();

    const report = alerter.play();
    assert.deepEqual(
      { played: report.played, reason: report.reason, beeps: report.beeps, durationMs: report.durationMs },
      { played: true, reason: "played", beeps: 2, durationMs: alertPlanDurationMs() },
    );
    assert.equal(fake.oscillators.length, 2);
    const tones = alertTonePlan();
    fake.oscillators.forEach((oscillator, index) => {
      assert.equal(oscillator.frequency.value, tones[index]!.frequencyHz);
      assert.equal(oscillator.startedAt[0], 42 + tones[index]!.startMs / 1000);
      assert.equal(oscillator.stoppedAt[0], 42 + (tones[index]!.startMs + tones[index]!.durationMs) / 1000);
    });
  });

  it("routes every beep through a single gain node set from the volume", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context, volume: 1 });
    alerter.unlock();
    alerter.play();
    assert.equal(fake.gains.length, 1, "one shared gain, so volume changes apply to the whole chime");
    assert.equal(fake.gains[0]!.gain.value, 1);

    alerter.setVolume(0);
    fake.gains.length = 0;
    alerter.play();
    assert.equal(fake.gains[0]!.gain.value, 0);
  });

  it("reports unsupported instead of throwing where there is no Web Audio", () => {
    const alerter = new AudioAlerter({ contextFactory: null });
    assert.equal(alerter.unlock(), "unsupported");
    assert.equal(alerter.play().played, false);
    assert.equal(alerter.play().reason, "unsupported");
  });

  it("survives a constructor that throws, which is what a locked-down browser does", () => {
    const alerter = new AudioAlerter({
      contextFactory: () => {
        throw new Error("AudioContext construction blocked");
      },
    });
    assert.equal(alerter.unlock(), "unsupported");
    assert.equal(alerter.play().reason, "unsupported");
  });

  it("keeps the volume inside a safe range, including a NaN from a form field", () => {
    assert.equal(clampVolume(-3), 0);
    assert.equal(clampVolume(7), 1);
    assert.equal(clampVolume(Number.NaN), DEFAULT_ALERT_SETTINGS.volume);
    assert.equal(gainForVolume(1), 1);
    assert.equal(gainForVolume(0), 0);
    assert.ok(gainForVolume(0.25) > 0.25, "the curve favours audibility at low settings");
  });

  it("closes the context and forgets the gesture on shutdown", () => {
    const fake = createFakeAudioContext();
    const alerter = new AudioAlerter({ contextFactory: () => fake.context });
    alerter.unlock();
    alerter.close();
    assert.equal(fake.closes(), 1);
    assert.equal(alerter.unlocked, false);
    assert.equal(alerter.play().played, false);
  });
});

describe("notification payload generation", () => {
  const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

  it("names the refusal and the guard, so a notification on its own is actionable", () => {
    const payload = buildNotificationPayload(
      event({ decision: { result: "blocked", reason: "cap_exceeded", source: "diagnostic" } }),
      GUARD,
    );
    assert.ok(payload);
    assert.equal(payload.title, "Agent Guard: transfer blocked");
    assert.match(payload.body, /refused a call \(cap_exceeded\)/);
    assert.ok(payload.body.includes(GUARD.slice(0, 6)), "the guard is identified, not just described");
    assert.equal(payload.tag, "agent-guard-blocked", "a stable tag collapses repeats into one notification");
    assert.equal(payload.requireInteraction, true);
  });

  it("words an admin action differently from a refusal", () => {
    const frozen = buildNotificationPayload(event({ kind: "frozen", decision: null }), "CABC");
    const revoked = buildNotificationPayload(event({ kind: "policy_revoked", decision: null }), "CABC");
    assert.equal(frozen?.title, "Agent Guard: account frozen");
    assert.match(frozen!.body, /frozen by an admin/);
    assert.equal(revoked?.title, "Agent Guard: policy revoked");
    assert.match(revoked!.body, /policy was revoked/i);
  });

  it("produces nothing for a non-critical event, so a caller cannot notify on a heartbeat", () => {
    assert.equal(buildNotificationPayload(event({ kind: "heartbeat", decision: null }), "CABC"), null);
    assert.equal(buildNotificationPayload(event(), "CABC"), null);
  });
});

describe("notification permission and delivery", () => {
  it("reports unsupported where the browser has no Notification constructor", () => {
    assert.equal(notificationPermissionState(null), "unsupported");
    const delivery = deliverNotification(
      { title: "t", body: "b", tag: "g", requireInteraction: true },
      null,
    );
    assert.deepEqual(delivery, { delivered: false, reason: "unavailable" });
  });

  it("refuses to construct a notification the browser would not show", () => {
    const api = fakeNotificationApi("denied");
    assert.equal(notificationPermissionState(api), "denied");
    const delivery = deliverNotification({ title: "t", body: "b", tag: "g", requireInteraction: true }, api);
    assert.deepEqual(delivery, { delivered: false, reason: "not-allowed" });
    assert.equal(api.shown.length, 0, "an ungranted permission must not even attempt construction");
  });

  it("delivers once permission is granted, passing the payload through", () => {
    const api = fakeNotificationApi("granted");
    assert.equal(notificationPermissionState(api), "granted");
    const payload = { title: "Agent Guard: transfer blocked", body: "b", tag: "agent-guard-blocked", requireInteraction: true };
    assert.deepEqual(deliverNotification(payload, api), { delivered: true, reason: "delivered" });
    assert.deepEqual(api.shown, [{ title: payload.title, options: payload }]);
  });

  it("maps a permission request onto the browser's answer", async () => {
    assert.equal(await requestNotificationPermission(fakeNotificationApi("granted")), "granted");
    assert.equal(
      await requestNotificationPermission(fakeNotificationApi("default", { requestPermission: async () => "denied" })),
      "denied",
    );
    assert.equal(
      await requestNotificationPermission(
        fakeNotificationApi("default", {
          requestPermission: async () => {
            throw new Error("prompt blocked");
          },
        }),
      ),
      "default",
      "a thrown prompt falls back to the permission the browser already reports",
    );
    assert.equal(await requestNotificationPermission(null), "unsupported");
  });

  it("reports a constructor that throws as a failed delivery", () => {
    const api = fakeNotificationApi("granted", {
      show: () => {
        throw new Error("notifications disabled by policy");
      },
    });
    assert.deepEqual(
      deliverNotification({ title: "t", body: "b", tag: "g", requireInteraction: true }, api),
      { delivered: false, reason: "failed" },
    );
  });
});

describe("not re-alerting on an event that was already announced", () => {
  it("reports each event once across repeated polls", () => {
    const tracker = createAlertTracker();
    const blocked = event({ ledger: 7, decision: { result: "blocked", reason: "paused", source: "ledger" } });
    const allowed = event({ ledger: 8 });

    assert.deepEqual(tracker.unseen([blocked, allowed]).map((entry) => entry.ledger), [7, 8]);
    assert.deepEqual(tracker.unseen([blocked, allowed]), [], "the same rows must not chime twice");
    assert.equal(tracker.unseen([blocked]).length, 0);

    const later = event({ ledger: 9, transactionHash: "b".repeat(64) });
    assert.deepEqual(tracker.unseen([later, blocked]).map((entry) => entry.ledger), [9]);
  });

  it("keys on the decision, not only the topic", () => {
    const tracker = createAlertTracker();
    const first = event({ ledger: 1, decision: { result: "allowed", reason: null, source: "ledger" } });
    const second = event({ ledger: 1, decision: { result: "blocked", reason: "cap_exceeded", source: "ledger" } });
    assert.equal(tracker.unseen([first, second]).length, 2);
  });

  it("starts over on reset, which is what switching guards requires", () => {
    const tracker = createAlertTracker();
    const blocked = event({ decision: { result: "blocked", reason: "paused", source: "ledger" } });
    tracker.unseen([blocked]);
    assert.equal(tracker.unseen([blocked]).length, 0);
    tracker.reset();
    assert.equal(tracker.unseen([blocked]).length, 1);
    assert.equal(tracker.size, 1);
  });

  it("stays bounded so a console open for a week cannot grow without limit", () => {
    const tracker = createAlertTracker(3);
    for (let ledger = 0; ledger < 10; ledger += 1) {
      tracker.unseen([event({ ledger, transactionHash: `${ledger}`.padEnd(64, "0") })]);
    }
    assert.ok(tracker.size <= 3);
  });
});

describe("alert settings persistence", () => {
  function createMockStorage(initial: Record<string, string> = {}) {
    const map = new Map<string, string>(Object.entries(initial));
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      raw: () => map.get(ALERT_SETTINGS_STORAGE_KEY) ?? null,
    };
  }

  it("defaults to both channels off when nothing was stored", () => {
    assert.deepEqual(loadAlertSettings(createMockStorage()), DEFAULT_ALERT_SETTINGS);
  });

  it("round-trips what the operator chose", () => {
    const storage = createMockStorage();
    saveAlertSettings({ audio: true, desktop: false, volume: 0.8 }, storage);
    assert.deepEqual(loadAlertSettings(storage), { audio: true, desktop: false, volume: 0.8 });
    assert.equal(JSON.parse(storage.raw()!).audio, true);
  });

  it("clamps a stored volume out of range instead of trusting it", () => {
    const storage = createMockStorage();
    saveAlertSettings({ audio: true, desktop: true, volume: 5 }, storage);
    assert.equal(loadAlertSettings(storage).volume, 1);
  });

  it("treats corrupt or hostile storage as no preference, never as enabled alerts", () => {
    for (const value of ["{not json", "null", '"yes"', '{"audio":"true","volume":"loud"}']) {
      const storage = createMockStorage({ [ALERT_SETTINGS_STORAGE_KEY]: value });
      assert.deepEqual(loadAlertSettings(storage), DEFAULT_ALERT_SETTINGS, `for ${value}`);
    }
  });

  it("is inert with no storage at all, which is the server-render path", () => {
    assert.deepEqual(loadAlertSettings(null), DEFAULT_ALERT_SETTINGS);
    assert.doesNotThrow(() => saveAlertSettings({ audio: true, desktop: true, volume: 0.2 }, null));
  });
});

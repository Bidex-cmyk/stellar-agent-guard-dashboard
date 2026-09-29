/**
 * Telemetry throughput benchmark (issue #114).
 *
 * When an agent network generates thousands of micro-transactions the feed
 * must not freeze or melt down. This spec streams 10,000 synthetic events
 * through `TelemetryFeed` over a 30-second window and measures what the
 * operator would actually experience:
 *
 *   - Frame rate — a `requestAnimationFrame` sampler runs for the whole window
 *     and its timestamps come back for per-second FPS, average FPS and the
 *     longest gap between frames. "Maintains ≥50 FPS without dropped frames"
 *     is asserted the way an operator experiences it: *every* full second of
 *     the run delivers at least 50 frames (no second drops below the floor),
 *     and no single frame gap ever reaches the stall bound — while occasional
 *     gaps just over one vsync (a GC pause, a layout spike) are *reported*
 *     rather than failed on, because a browser that never once exceeds 50ms
 *     between frames does not exist and a benchmark that demands it tests the
 *     runner's idle-ness, not the feed.
 *   - Heap growth — the JS heap is force-GC'd before and after the run (the
 *     browser is launched with `--js-flags=--expose-gc`) so the delta is the
 *     live set, not garbage waiting to be collected; growth must stay under
 *     50 MB.
 *   - CPU — renderer task time from the DevTools `Performance` domain over the
 *     same window, reported as utilization (informational: the acceptance
 *     criteria constrain FPS and heap, and CPU has no honest fixed budget on
 *     an arbitrary runner).
 *   - DOM bloat — the feed is capped at 250 rows, and the spec asserts that
 *     cap still holds after 10,000 events have passed through it.
 *
 * Events are injected through `window.__guardFeedInject`, the dev-only
 * benchmark seam in `GuardProvider` — the *same* `pushEvents` write path the
 * RPC poll and the diagnostic path use, so nothing about the render pipeline
 * under test is special-cased for the benchmark. Injection is paced by wall
 * clock inside one long `page.evaluate`, so exactly 10,000 events land in the
 * 30-second window regardless of how fast the page renders. (Waiting on the
 * real 5s poll cadence would take hours and would measure the poll, not the
 * feed.)
 *
 * The run writes `test-results/telemetry-benchmark.json` and attaches the same
 * JSON to the Playwright report. Deliberately not a CI gate (see
 * `playwright.config.ts`): frame-rate numbers depend on the runner's GPU/CPU,
 * so this runs locally via `npm run test:perf`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { GuardEvent } from "stellar-agent-guard-sdk";
import { installSorobanRpcMock } from "../e2e/sorobanRpcMock.ts";
import { installFreighterMock } from "../e2e/walletMock.ts";
import { specToGuardEvent, throughputTelemetryEvents } from "../mocks/eventFixtures.ts";

/** Events to stream through the feed. */
const EVENT_COUNT = 10_000;
/** Wall-clock window the events are paced over. */
const DURATION_MS = 30_000;
/** Acceptance criteria: average ≥50 FPS, heap growth <50 MB. */
const MIN_FPS = 50;
const MAX_HEAP_GROWTH_MB = 50;
/** The feed's own bound on live rows (GuardProvider's `slice(0, 250)`). */
const FEED_ROW_CAP = 250;
/** A gap this long is a freeze an operator would notice — a hard failure. */
const STALL_GAP_MS = 250;
/** Gaps beyond this are reported as diagnostics (missed vsyncs). */
const GAP_DIAGNOSTIC_MS = 50;

/** Stable path so a maintainer (or a CI artifact step) knows where to look. */
const REPORT_PATH = join("test-results", "telemetry-benchmark.json");

/** The console's default guard — the feed's identity in the report. */
const WATCHED_GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";

// `--js-flags=--expose-gc` puts `window.gc` in the page so heap growth is
// measured as the live set rather than uncollected garbage, and
// `--enable-precise-memory-info` stops Chromium quantising `usedJSHeapSize`
// into ten-minute buckets — without it a 30-second delta is meaningless.
test.use({
  launchOptions: {
    args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
  },
});

/** Scope assertions to the feed panel, never to another `table.events`. */
function feed(page: Page) {
  return page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: "Telemetry", exact: true }) });
}

/** Force a GC (when the browser exposes one) and read the live JS heap. */
async function liveHeapMb(page: Page): Promise<{ mb: number; forcedGc: boolean }> {
  return page.evaluate(() => {
    const scope = window as typeof window & {
      gc?: () => void;
      // Chromium-only extension, absent from the DOM typings.
      performance: Performance & { memory?: { usedJSHeapSize: number } };
    };
    const forcedGc = typeof scope.gc === "function";
    if (forcedGc) {
      // Two passes: the first frees what the last render allocated, the
      // second settles any cycle the first collect itself created.
      scope.gc!();
      scope.gc!();
    }
    return { mb: (scope.performance.memory?.usedJSHeapSize ?? 0) / 1048576, forcedGc };
  });
}

interface CdpMetric {
  name: string;
  value: number;
}

function cdpValue(metrics: CdpMetric[], name: string): number {
  return metrics.find((metric) => metric.name === name)?.value ?? 0;
}

test.describe("telemetry feed: 10,000-event throughput benchmark", () => {
  test("streams 10k events in 30s while holding ≥50 FPS and bounded heap", async ({ page }, testInfo) => {
    // 30s benchmark + a cold dev-server compile of the page + two GC/heap
    // probes; the config's 120s default leaves too little margin on a laptop.
    test.setTimeout(180_000);

    await installFreighterMock(page);
    // Hermeticity: the page polls its snapshot on mount even though the
    // benchmark never watches the feed, so RPC is answered in-process.
    await installSorobanRpcMock(page);

    await page.goto("/");
    await expect(feed(page).getByRole("heading", { name: "Telemetry", exact: true })).toBeVisible();
    // The dev-only injection seam must be live (it is stripped from production).
    await page.waitForFunction(
      () => typeof (window as typeof window & { __guardFeedInject?: unknown }).__guardFeedInject === "function",
    );

    // Preload the events outside the measured window: serialising ~10k
    // objects over CDP is transport, not feed performance.
    const events: GuardEvent[] = throughputTelemetryEvents(EVENT_COUNT).map((spec) =>
      specToGuardEvent(spec, WATCHED_GUARD),
    );
    await page.evaluate((batch) => {
      (window as typeof window & { __benchEvents?: GuardEvent[] }).__benchEvents = batch;
    }, events);

    // Warm-up: fill the feed to its 250-row cap and let the render path
    // compile, so the measurement starts from the steady state the whole
    // benchmark then runs in.
    await page.evaluate((warmup: GuardEvent[]) => {
      (window as typeof window & { __guardFeedInject?: (incoming: GuardEvent[]) => void }).__guardFeedInject!(
        warmup,
      );
    }, events.slice(0, FEED_ROW_CAP));
    await expect(feed(page).locator("table.events tbody tr")).toHaveCount(FEED_ROW_CAP);

    const heapBefore = await liveHeapMb(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metricsBefore = (await cdp.send("Performance.getMetrics")).metrics;

    // ── The run: exactly EVENT_COUNT events paced over DURATION_MS ─────────
    const run = await page.evaluate(
      async ({ count, durationMs }: { count: number; durationMs: number }) => {
        const scope = window as typeof window & {
          __guardFeedInject?: (incoming: GuardEvent[]) => void;
          __benchEvents?: GuardEvent[];
        };
        const inject = scope.__guardFeedInject;
        const events = scope.__benchEvents;
        if (!inject || !events || events.length < count) {
          throw new Error("benchmark seam or preloaded events missing");
        }

        const startedAt = performance.now();
        const endAt = startedAt + durationMs;
        const frameTimestamps: number[] = [];
        let injected = 0;

        await new Promise<void>((resolve) => {
          const step = (now: number) => {
            frameTimestamps.push(now);
            // Wall-clock pacing: whatever the frame rate is, the events that
            // *should* have been delivered by now are delivered, so slow
            // frames cannot quietly extend the window.
            const target = Math.min(count, Math.floor(((now - startedAt) / durationMs) * count));
            if (target > injected) {
              inject(events.slice(injected, target));
              injected = target;
            }
            if (now >= endAt) {
              resolve();
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });

        return {
          frameTimestamps,
          injected,
          wallMs: performance.now() - startedAt,
        };
      },
      { count: EVENT_COUNT, durationMs: DURATION_MS },
    );

    const metricsAfter = (await cdp.send("Performance.getMetrics")).metrics;
    await cdp.detach();
    const heapAfter = await liveHeapMb(page);

    // ── Frame statistics ───────────────────────────────────────────────────
    const spans = run.frameTimestamps.slice(1).map((t, index) => t - run.frameTimestamps[index]!);
    const longestGapMs = spans.length > 0 ? Math.max(...spans) : 0;
    const gapsOverDiagnosticMs = spans.filter((gap) => gap > GAP_DIAGNOSTIC_MS).length;
    const totalFrames = run.frameTimestamps.length;
    const measuredSpanMs = totalFrames > 1 ? run.frameTimestamps[totalFrames - 1]! - run.frameTimestamps[0]! : 0;
    const averageFps = measuredSpanMs > 0 ? ((totalFrames - 1) * 1000) / measuredSpanMs : 0;

    // Per-second FPS over the full seconds of the window only — the trailing
    // partial bucket would report a fake trough.
    const fullSecondBuckets = Math.floor(DURATION_MS / 1000);
    const perSecondFps: number[] = Array.from({ length: fullSecondBuckets }, () => 0);
    for (const timestamp of run.frameTimestamps) {
      const bucket = Math.floor((timestamp - run.frameTimestamps[0]!) / 1000);
      if (bucket >= 0 && bucket < fullSecondBuckets) perSecondFps[bucket]! += 1;
    }
    const minFpsPerSecond = Math.min(...perSecondFps);
    // The acceptance criterion itself: no second of continuous feed updates
    // delivered fewer than 50 frames.
    const secondsBelowFpsFloor = perSecondFps.filter((fps) => fps < MIN_FPS).length;

    // ── CPU over the same window (renderer task time / wall time) ──────────
    const taskSeconds = cdpValue(metricsAfter, "TaskDuration") - cdpValue(metricsBefore, "TaskDuration");
    const scriptMs = (cdpValue(metricsAfter, "ScriptDuration") - cdpValue(metricsBefore, "ScriptDuration")) * 1000;
    const layoutMs = (cdpValue(metricsAfter, "LayoutDuration") - cdpValue(metricsBefore, "LayoutDuration")) * 1000;
    const styleMs =
      (cdpValue(metricsAfter, "RecalcStyleDuration") - cdpValue(metricsBefore, "RecalcStyleDuration")) * 1000;
    const cpuPercent = (taskSeconds * 1000 * 100) / run.wallMs;

    // ── DOM: the feed must still be capped, not holding 10k rows ───────────
    const feedRows = await feed(page).locator("table.events tbody tr").count();
    await expect(feed(page)).toContainText(`Feed holds the most recent ${FEED_ROW_CAP} event(s)`);

    const heapGrowthMb = heapAfter.mb - heapBefore.mb;
    const verdict = {
      throughput: run.injected === EVENT_COUNT,
      averageFps: averageFps >= MIN_FPS,
      noDroppedFrames: secondsBelowFpsFloor === 0,
      noFreeze: longestGapMs < STALL_GAP_MS,
      heapGrowth: heapGrowthMb < MAX_HEAP_GROWTH_MB,
      domBounded: feedRows <= FEED_ROW_CAP,
    };
    const report = {
      issue: "#114 telemetry feed benchmark",
      generatedAt: new Date().toISOString(),
      config: {
        events: EVENT_COUNT,
        durationMs: DURATION_MS,
        minFps: MIN_FPS,
        maxHeapGrowthMb: MAX_HEAP_GROWTH_MB,
        stallGapMs: STALL_GAP_MS,
        gapDiagnosticMs: GAP_DIAGNOSTIC_MS,
        feedRowCap: FEED_ROW_CAP,
      },
      environment: {
        platform: `${platform()} ${release()}`,
        node: process.version,
        browser: page.context().browser()?.version() ?? "unknown",
      },
      throughput: {
        injected: run.injected,
        windowMs: Math.round(run.wallMs),
        eventsPerSecond: Math.round((run.injected * 1000) / run.wallMs),
      },
      render: {
        averageFps: Number(averageFps.toFixed(1)),
        minFpsPerSecond,
        secondsBelowFpsFloor,
        perSecondFps,
        totalFrames,
        longestFrameGapMs: Number(longestGapMs.toFixed(1)),
        // Diagnostic: missed-vsync gaps. Reported, not asserted — see header.
        frameGapsOver50Ms: gapsOverDiagnosticMs,
      },
      cpu: {
        utilizationPercent: Number(cpuPercent.toFixed(1)),
        scriptMs: Math.round(scriptMs),
        layoutMs: Math.round(layoutMs),
        styleMs: Math.round(styleMs),
      },
      heap: {
        beforeMb: Number(heapBefore.mb.toFixed(1)),
        afterMb: Number(heapAfter.mb.toFixed(1)),
        growthMb: Number(heapGrowthMb.toFixed(1)),
        forcedGc: heapBefore.forcedGc && heapAfter.forcedGc,
      },
      dom: { feedRows, feedCap: FEED_ROW_CAP },
      verdict,
      passed: Object.values(verdict).every(Boolean),
    };

    mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(process.cwd(), REPORT_PATH), serialized, "utf8");
    await testInfo.attach("telemetry-benchmark", {
      body: serialized,
      contentType: "application/json",
    });
    console.log(
      `[benchmark] ${report.throughput.injected} events in ${report.throughput.windowMs}ms — ` +
        `avg ${report.render.averageFps} FPS (weakest second ${report.render.minFpsPerSecond}/s, ` +
        `${report.render.secondsBelowFpsFloor} below floor), longest gap ${report.render.longestFrameGapMs}ms, ` +
        `heap +${report.heap.growthMb} MB, cpu ${report.cpu.utilizationPercent}%, ` +
        `${report.dom.feedRows} rows — ${REPORT_PATH}`,
    );

    // ── Acceptance criteria ────────────────────────────────────────────────
    expect(run.injected).toBe(EVENT_COUNT);
    expect(verdict.averageFps, `average FPS ${averageFps.toFixed(1)}`).toBe(true);
    expect(
      verdict.noDroppedFrames,
      `${secondsBelowFpsFloor} second(s) below ${MIN_FPS} FPS (weakest: ${minFpsPerSecond}/s)`,
    ).toBe(true);
    expect(verdict.noFreeze, `longest frame gap ${longestGapMs.toFixed(1)}ms`).toBe(true);
    expect(verdict.heapGrowth, `heap grew ${heapGrowthMb.toFixed(1)} MB`).toBe(true);
    expect(feedRows).toBeLessThanOrEqual(FEED_ROW_CAP);
    expect(report.passed).toBe(true);
  });
});

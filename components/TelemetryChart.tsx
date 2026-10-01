"use client";

/**
 * Outcome and spend chart for the telemetry panel.
 *
 * Stacked bars show allowed vs blocked decisions per interval. The shaded area
 * shows settled spend volume from the guard's on-chain rolling window. It is
 * plain SVG with no charting library, and all the arithmetic lives in
 * `lib/guard/telemetryAggregator.ts`.
 *
 * Accessibility: the SVG is `role="img"` with a one-sentence summary as its
 * name. It is focusable, and the arrow keys move between intervals, with the
 * same readout the mouse tooltip shows announced politely. The complete data
 * is in a real table below the chart.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  CHART_WINDOWS,
  aggregateTelemetry,
  defaultTimeOf,
  describeAggregate,
  formatInstant,
  formatStroops,
  type ChartBucket,
  type ChartWindow,
} from "../lib/guard/telemetryAggregator.ts";
import { useGuard, useGuardEvents } from "./GuardProvider.tsx";

const WIDTH = 720;
const HEIGHT = 200;
const PAD = { top: 12, right: 12, bottom: 26, left: 34 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;
const CLOCK_TICK_MS = 10_000;

/** `part / whole` as a float in [0, 1] without squeezing bigints through a double first. */
function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Number((part * 1_000_000n) / whole) / 1_000_000;
}

export function TelemetryChart() {
  const events = useGuardEvents();
  const { snapshot, guard } = useGuard();
  const [windowKey, setWindowKey] = useState<ChartWindow>("1h");
  const [now, setNow] = useState<number>(() => Date.now());
  const [active, setActive] = useState<number | null>(null);

  // Real time: keep the window sliding even when no new events arrive.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const spends = useMemo(() => {
    if (!snapshot || snapshot.guard !== guard || !snapshot.window.ok) return [];
    return snapshot.window.value?.entries ?? [];
  }, [snapshot, guard]);

  const aggregate = useMemo(
    () =>
      aggregateTelemetry({
        events,
        spends,
        window: windowKey,
        now,
        // First sight is stamped with the real clock, not the ticking `now`,
        // so a refusal is placed when it arrived.
        timeOf: (event) => defaultTimeOf(event),
      }),
    [events, spends, windowKey, now],
  );

  const { buckets, maxCount, maxSpend } = aggregate;
  const slot = PLOT_W / buckets.length;
  const barWidth = Math.max(2, slot * 0.62);
  const countScale = Math.max(1, maxCount);
  const countTicks = niceTicks(countScale);
  const summary = describeAggregate(aggregate);
  const focused = active === null ? null : (buckets[active] ?? null);

  const spendPoints = buckets.map((bucket, index) => {
    const x = PAD.left + slot * index + slot / 2;
    const y = PAD.top + PLOT_H - ratio(bucket.spend, maxSpend) * PLOT_H;
    return [x, y] as const;
  });
  const spendLine = spendPoints
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const baseline = PAD.top + PLOT_H;
  const spendArea =
    spendPoints.length > 0
      ? `${spendLine} L${spendPoints[spendPoints.length - 1]![0].toFixed(1)},${baseline} L${spendPoints[0]![0].toFixed(1)},${baseline} Z`
      : "";
  const labelEvery = Math.ceil(buckets.length / 6);

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const last = buckets.length - 1;
    const current = active ?? last;
    const next =
      event.key === "ArrowRight"
        ? Math.min(last, current + 1)
        : event.key === "ArrowLeft"
          ? Math.max(0, current - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : event.key === "Escape"
                ? null
                : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  }

  return (
    <section className="tchart" aria-labelledby="tchart-title">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 id="tchart-title" style={{ margin: 0, fontSize: 15 }}>
          Outcomes and spend
        </h3>
        <div className="row" role="group" aria-label="Chart time window">
          {(Object.keys(CHART_WINDOWS) as ChartWindow[]).map((key) => (
            <button
              key={key}
              className={key === windowKey ? undefined : "secondary"}
              aria-pressed={key === windowKey}
              onClick={() => {
                setWindowKey(key);
                setActive(null);
              }}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      <div className="row tiny" style={{ marginTop: 6, gap: 14 }} aria-hidden="true">
        <span>
          <span className="tchart-key tchart-allowed" /> allowed
        </span>
        <span>
          <span className="tchart-key tchart-blocked" /> blocked
        </span>
        <span>
          <span className="tchart-key tchart-spend" /> settled spend (stroops)
        </span>
      </div>

      <div className="tchart-frame">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          aria-describedby="tchart-help"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onMouseLeave={() => setActive(null)}
          preserveAspectRatio="none"
          className="tchart-svg"
        >
          {countTicks.map((tick) => {
            const y = PAD.top + PLOT_H - (tick / countScale) * PLOT_H;
            return (
              <g key={tick}>
                <line className="tchart-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y} y2={y} />
                <text className="tchart-axis" x={PAD.left - 6} y={y + 3.5} textAnchor="end">
                  {tick}
                </text>
              </g>
            );
          })}

          {spendArea && <path className="tchart-spend-area" d={spendArea} />}
          {spendLine && <path className="tchart-spend-line" d={spendLine} />}

          {buckets.map((bucket, index) => {
            const x = PAD.left + slot * index + (slot - barWidth) / 2;
            const allowedH = (bucket.allowed / countScale) * PLOT_H;
            const blockedH = (bucket.blocked / countScale) * PLOT_H;
            return (
              <g key={bucket.start}>
                {bucket.allowed > 0 && (
                  <rect
                    className="tchart-allowed"
                    x={x}
                    width={barWidth}
                    y={baseline - allowedH}
                    height={allowedH}
                  />
                )}
                {bucket.blocked > 0 && (
                  <rect
                    className="tchart-blocked"
                    x={x}
                    width={barWidth}
                    y={baseline - allowedH - blockedH}
                    height={blockedH}
                  />
                )}
                {index % labelEvery === 0 && (
                  <text
                    className="tchart-axis"
                    x={x + barWidth / 2}
                    y={HEIGHT - 8}
                    textAnchor="middle"
                  >
                    {bucket.label}
                  </text>
                )}
                {active === index && (
                  <rect
                    className="tchart-cursor"
                    x={PAD.left + slot * index}
                    width={slot}
                    y={PAD.top}
                    height={PLOT_H}
                  />
                )}
                {/* Hit area: the whole column, so thin or empty bars are still easy to hover. */}
                <rect
                  className="tchart-hit"
                  x={PAD.left + slot * index}
                  width={slot}
                  y={PAD.top}
                  height={PLOT_H}
                  onMouseEnter={() => setActive(index)}
                />
              </g>
            );
          })}
          <line
            className="tchart-baseline"
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={baseline}
            y2={baseline}
          />
        </svg>

        {focused && active !== null && (
          <div
            className="tchart-tip"
            style={{
              left: `${((PAD.left + slot * active + slot / 2) / WIDTH) * 100}%`,
              transform: active > buckets.length / 2 ? "translateX(-100%)" : undefined,
            }}
            aria-hidden="true"
          >
            <BucketReadout bucket={focused} timeZone={aggregate.timeZone} />
          </div>
        )}
      </div>

      <p id="tchart-help" className="tiny muted" style={{ margin: "6px 0 0" }}>
        Focus the chart and use the arrow keys to step through intervals. Counts are guard decisions
        in this feed; blocked decisions only appear if this console produced them (a refusal never
        reaches the ledger). Spend is read from the guard&apos;s on-chain rolling window, which only
        keeps spends inside the policy&apos;s window.
        {aggregate.skipped.outOfWindow > 0 &&
          ` ${aggregate.skipped.outOfWindow} buffered event(s) fall outside this window.`}
      </p>

      {/* Keyboard readout for screen readers, mirroring the hover tooltip. */}
      <div className="visually-hidden" role="status" aria-live="polite">
        {focused ? readoutText(focused, aggregate.timeZone) : ""}
      </div>

      <details style={{ marginTop: 8 }}>
        <summary className="tiny">Data table</summary>
        <div className="scrolly">
          <table className="chart-data">
            <caption className="visually-hidden">{summary}</caption>
            <thead>
              <tr>
                <th scope="col">Interval start</th>
                <th scope="col">Allowed</th>
                <th scope="col">Blocked</th>
                <th scope="col">Other events</th>
                <th scope="col">Settled spend (stroops)</th>
                <th scope="col">Spends</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.start}>
                  <th scope="row" className="mono tiny">
                    {formatInstant(bucket.start, aggregate.timeZone)}
                  </th>
                  <td>{bucket.allowed}</td>
                  <td>{bucket.blocked}</td>
                  <td>{bucket.other}</td>
                  <td className="mono tiny">{formatStroops(bucket.spend)}</td>
                  <td>{bucket.spendCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function BucketReadout({ bucket, timeZone }: { bucket: ChartBucket; timeZone: string }) {
  return (
    <>
      <div className="mono tiny">
        {formatInstant(bucket.start, timeZone)} to {formatInstant(bucket.end, timeZone)}
      </div>
      <div>
        <span className="tchart-key tchart-allowed" /> {bucket.allowed} allowed
      </div>
      <div>
        <span className="tchart-key tchart-blocked" /> {bucket.blocked} blocked
      </div>
      <div>
        <span className="tchart-key tchart-spend" />{" "}
        <span className="mono">{formatStroops(bucket.spend)}</span> stroops
        {bucket.spendCount > 0 &&
          ` (${bucket.spendCount} spend${bucket.spendCount === 1 ? "" : "s"})`}
      </div>
    </>
  );
}

function readoutText(bucket: ChartBucket, timeZone: string): string {
  return (
    `${formatInstant(bucket.start, timeZone)} to ${formatInstant(bucket.end, timeZone)}: ` +
    `${bucket.allowed} allowed, ${bucket.blocked} blocked, ${formatStroops(bucket.spend)} stroops settled.`
  );
}

/** Up to five whole-number gridlines from 0 to `max`. */
function niceTicks(max: number): number[] {
  const step = Math.max(1, Math.ceil(max / 4));
  const ticks: number[] = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}

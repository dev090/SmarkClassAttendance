import { useState, type MouseEvent } from 'react';
import { fmtClock, fmtTime } from '../api';
import { useWidth } from './useWidth';

interface Props {
  samples: Array<{ at: number; present: number; away: number }>;
  startedAt: number;
  endAt: number;
  enrolled: number;
}

const H = 150;
const PAD = { top: 10, right: 14, bottom: 22, left: 30 };

/** Single-series area chart of PRESENT students over the class. Hover = crosshair + tooltip. */
export function OccupancyChart({ samples, startedAt, endAt, enrolled }: Props) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  const x0 = PAD.left;
  const x1 = width - PAD.right;
  const y0 = PAD.top;
  const y1 = H - PAD.bottom;
  const tMin = startedAt;
  const tMax = Math.max(endAt, startedAt + 60);
  const yMax = Math.max(1, enrolled, ...samples.map((s) => s.present));
  const xs = (t: number): number => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
  const ys = (v: number): number => y1 - (v / yMax) * (y1 - y0);

  const path = samples.map((s, i) => `${i ? 'L' : 'M'}${xs(s.at).toFixed(1)},${ys(s.present).toFixed(1)}`).join(' ');
  const first = samples[0];
  const last = samples[samples.length - 1];
  const area = first && last ? `${path} L${xs(last.at).toFixed(1)},${y1} L${xs(first.at).toFixed(1)},${y1} Z` : '';
  const yTicks = yMax <= 5 ? [0, yMax] : [0, Math.round(yMax / 2), yMax];
  const xTicks = [tMin, tMin + (tMax - tMin) / 2, tMax];
  const peak = samples.reduce<{ at: number; present: number } | null>((b, s) => (!b || s.present > b.present ? s : b), null);

  const onMove = (e: MouseEvent<SVGSVGElement>): void => {
    if (!samples.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = tMin + ((e.clientX - rect.left - x0) / (x1 - x0)) * (tMax - tMin);
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i]!.at - t) < Math.abs(samples[best]!.at - t)) best = i;
    setHover(best);
  };
  const h = hover !== null ? samples[hover] : undefined;

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Occupancy over time</h2>
          <div className="small muted">Students present{peak ? ` · peak ${peak.present} at ${fmtClock(peak.at)}` : ''}</div>
        </div>
        <button className="btn sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <div style={{ maxHeight: 220, overflow: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th className="num">Present</th>
                <th className="num">Away</th>
              </tr>
            </thead>
            <tbody>
              {[...samples].reverse().slice(0, 60).map((s) => (
                <tr key={s.at}>
                  <td className="mono">{fmtTime(s.at)}</td>
                  <td className="num">{s.present}</td>
                  <td className="num">{s.away}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={ref}>
          <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Students present over time">
            <g className="grid">
              {yTicks.map((v) => (
                <line key={v} x1={x0} x2={x1} y1={ys(v)} y2={ys(v)} />
              ))}
            </g>
            <g className="axis">
              <line x1={x0} x2={x1} y1={y1} y2={y1} />
            </g>
            {yTicks.map((v) => (
              <text key={v} x={x0 - 6} y={ys(v) + 4} textAnchor="end">
                {v}
              </text>
            ))}
            {xTicks.map((t, i) => (
              <text key={t} x={xs(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
                {fmtClock(t)}
              </text>
            ))}
            {samples.length > 1 && <path className="area" d={area} />}
            {samples.length > 0 && <path className="line" d={path} />}
            {last && <circle className="marker" cx={xs(last.at)} cy={ys(last.present)} r={4} />}
            {last && (
              <text x={Math.min(xs(last.at) + 8, x1 - 20)} y={ys(last.present) + 4} style={{ fill: 'var(--ink)', fontWeight: 600 }}>
                {last.present}
              </text>
            )}
            {h && (
              <>
                <line className="crosshair" x1={xs(h.at)} x2={xs(h.at)} y1={y0} y2={y1} />
                <circle className="marker" cx={xs(h.at)} cy={ys(h.present)} r={5} />
              </>
            )}
          </svg>
          {h && (
            <div className="tooltip" style={{ left: xs(h.at), top: ys(h.present) - 10 }}>
              {fmtTime(h.at)} · {h.present} present · {h.away} away
            </div>
          )}
          {samples.length === 0 && <div className="empty small">Waiting for the first sample…</div>}
        </div>
      )}
    </div>
  );
}

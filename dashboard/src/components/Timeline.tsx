import { useState } from 'react';
import { fmtClock, fmtTime } from '../api';
import type { Snapshot } from '../types';
import { useWidth } from './useWidth';

export interface Seg {
  kind: 'present' | 'away';
  from: number;
  to: number;
}

/** Turns the per-student event stream into present/away segments. */
export function segmentsFor(events: Array<{ type: string; at: number }>, endAt: number): Seg[] {
  const segs: Seg[] = [];
  let open: Seg | null = null;
  const close = (at: number): void => {
    if (open) {
      open.to = at;
      segs.push(open);
      open = null;
    }
  };
  for (const e of events) {
    if (e.type === 'present' || e.type === 'returned') {
      close(e.at);
      open = { kind: 'present', from: e.at, to: endAt };
    } else if (e.type === 'away') {
      close(e.at);
      open = { kind: 'away', from: e.at, to: endAt };
    } else if (e.type === 'left' || e.type === 'lost') {
      close(e.at);
    }
  }
  if (open) segs.push(open);
  return segs.filter((s) => s.to > s.from);
}

const ROW = 22;
const LABEL_W = 150;

export function Timeline({ snapshot }: { snapshot: Snapshot }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const { session } = snapshot;
  const endAt = session.endedAt ?? snapshot.now;
  const tMin = session.startedAt;
  const tMax = Math.max(endAt, tMin + 60);
  const x0 = LABEL_W;
  const x1 = width - 10;
  const xs = (t: number): number => x0 + ((Math.min(Math.max(t, tMin), tMax) - tMin) / (tMax - tMin)) * (x1 - x0);

  const byUser = new Map<string, Array<{ type: string; at: number }>>();
  for (const e of snapshot.timeline) {
    if (!byUser.has(e.userId)) byUser.set(e.userId, []);
    byUser.get(e.userId)!.push(e);
  }
  const rows = snapshot.students
    .filter((s) => byUser.has(s.userId))
    .map((s) => ({ student: s, segs: segmentsFor(byUser.get(s.userId)!, endAt) }));
  const height = 24 + rows.length * ROW + 8;
  const ticks = [tMin, tMin + (tMax - tMin) / 2, tMax];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Timeline</h2>
        <div className="legend" aria-label="legend">
          <span>
            <i className="k" style={{ background: 'var(--seq-450)' }} />
            Present
          </span>
          <span>
            <i className="k" style={{ background: 'var(--seq-150)' }} />
            Away
          </span>
        </div>
      </div>
      <div className="chart timeline" ref={ref}>
        {rows.length === 0 ? (
          <div className="empty small">No arrivals yet.</div>
        ) : (
          <svg width={width} height={height} role="img" aria-label="Per-student presence timeline">
            <g className="axis">
              <line x1={x0} x2={x1} y1={18} y2={18} />
            </g>
            {ticks.map((t, i) => (
              <text key={t} x={xs(t)} y={12} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
                {fmtClock(t)}
              </text>
            ))}
            {rows.map(({ student, segs }, i) => {
              const y = 24 + i * ROW;
              return (
                <g key={student.userId} className="timeline-row">
                  <text x={0} y={y + 14}>
                    {student.name.length > 20 ? `${student.name.slice(0, 19)}…` : student.name}
                  </text>
                  <line x1={x0} x2={x1} y1={y + ROW - 1} y2={y + ROW - 1} style={{ stroke: 'var(--grid)' }} />
                  {segs.map((s, j) => (
                    <rect
                      key={j}
                      className={`seg ${s.kind}`}
                      x={xs(s.from) + 1}
                      y={y + 4}
                      width={Math.max(2, xs(s.to) - xs(s.from) - 2)}
                      height={ROW - 10}
                      rx={3}
                      onMouseMove={(e) =>
                        setHover({
                          x: e.nativeEvent.offsetX,
                          y,
                          text: `${student.name}: ${s.kind} ${fmtTime(s.from)} – ${s.to >= endAt && !session.endedAt ? 'now' : fmtTime(s.to)}`,
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                    />
                  ))}
                </g>
              );
            })}
          </svg>
        )}
        {hover && (
          <div className="tooltip" style={{ left: hover.x, top: hover.y }}>
            {hover.text}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, type CSSProperties } from 'react';

interface Props {
  zones: Array<{ zone: string; count: number }>;
}

const STEPS = ['--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600'];
const QUAD = ['front-left', 'front-right', 'back-left', 'back-right'];

/** Front/back × left/right density grid. Sequential single hue: more students = darker. */
export function Heatmap({ zones }: Props) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...zones.map((z) => z.count));
  const quad = QUAD.every((q) => zones.some((z) => z.zone === q));
  const ordered = quad ? QUAD.map((q) => zones.find((z) => z.zone === q)!) : [...zones].sort((a, b) => a.zone.localeCompare(b.zone));

  const cellStyle = (count: number): CSSProperties => {
    if (count === 0) return { background: 'var(--surface-2)', color: 'var(--ink-2)' };
    const idx = Math.min(STEPS.length - 1, Math.floor((count / max) * (STEPS.length - 1) + 0.5));
    return { background: `var(${STEPS[idx]})`, color: idx >= 2 ? '#fff' : 'var(--ink)' };
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Where they sit</h2>
        <button className="btn sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? 'Grid' : 'Table'}
        </button>
      </div>
      {table ? (
        <table>
          <thead>
            <tr>
              <th>Zone</th>
              <th className="num">Students</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((z) => (
              <tr key={z.zone}>
                <td>{z.zone}</td>
                <td className="num">{z.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <>
          <div className="heat-caption">
            <span>Front · projector</span>
          </div>
          <div className="heat" style={{ gridTemplateColumns: `repeat(${quad ? 2 : 1}, 1fr)` }}>
            {ordered.map((z) => (
              <div key={z.zone} className="cell" style={cellStyle(z.count)} title={`${z.zone}: ${z.count}`}>
                <span className="z">{z.zone.replace('-', ' ')}</span>
                <span className="n">{z.count}</span>
              </div>
            ))}
          </div>
          <div className="heat-caption">
            <span>Back</span>
            <span>approximate density, not seats</span>
          </div>
        </>
      )}
    </div>
  );
}

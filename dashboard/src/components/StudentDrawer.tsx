import { useState } from 'react';
import { ago, fmtClock, fmtDuration } from '../api';
import type { StudentView } from '../types';
import { StateBadge } from './StateBadge';

interface Props {
  student: StudentView;
  now: number;
  onClose: () => void;
  onOverride: (state: 'present' | 'absent' | 'excused' | null, note: string | null) => Promise<void>;
}

export function StudentDrawer({ student: s, now, onClose, onOverride }: Props) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (state: 'present' | 'absent' | 'excused' | null): Promise<void> => {
    setBusy(true);
    try {
      await onOverride(state, note || null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${s.name} details`}>
        <div className="row between">
          <div>
            <h1>{s.name}</h1>
            <div className="muted small">
              {s.studentNumber ?? ''} {s.platform ? `· ${s.platform}` : ''}
            </div>
          </div>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="row wrap">
          <StateBadge state={s.effectiveState} manual={!!s.manual} />
          {s.late && <span className="pill late">{s.veryLate ? 'very late' : 'late'}</span>}
          {s.leftEarly && <span className="pill">left early</span>}
        </div>
        <dl className="kv">
          <div>
            <dt>Arrival</dt>
            <dd>{fmtClock(s.arrivalAt)}</dd>
          </div>
          <div>
            <dt>Last detected</dt>
            <dd>{s.lastSeen ? `${fmtClock(s.lastSeen)} (${ago(s.lastSeen, now)})` : '—'}</dd>
          </div>
          <div>
            <dt>Time present</dt>
            <dd>{fmtDuration(s.presentSeconds)}</dd>
          </div>
          <div>
            <dt>Time away</dt>
            <dd>
              {fmtDuration(s.awaySeconds)} {s.awayEpisodes ? `· ${s.awayEpisodes}×` : ''}
            </dd>
          </div>
          <div>
            <dt>Detection confidence</dt>
            <dd>
              {s.confidenceLabel} <span className="muted">({s.confidence}/100)</span>
            </dd>
          </div>
          <div>
            <dt>Zone</dt>
            <dd>{s.zone ?? '—'}</dd>
          </div>
          <div>
            <dt>Observations</dt>
            <dd>{s.observations}</dd>
          </div>
          <div>
            <dt>Automatic state</dt>
            <dd>{s.state}</dd>
          </div>
        </dl>
        <div>
          <h3>Heard by (last minute)</h3>
          {s.scanners.length === 0 ? (
            <div className="muted small">No scanner hears this device right now.</div>
          ) : (
            <table>
              <tbody>
                {[...s.scanners]
                  .sort((a, b) => b.rssi - a.rssi)
                  .map((sc) => (
                    <tr key={sc.scannerId}>
                      <td>{sc.scannerId}</td>
                      <td className="num">{sc.rssi} dBm</td>
                      <td className="muted small">{ago(sc.lastSeen, now)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="stack">
          <h3>Manual override</h3>
          {s.manual && (
            <div className="small ink2">
              Currently set to <b>{s.manual.state}</b> by {s.manual.by} at {fmtClock(s.manual.at)}
              {s.manual.note ? ` — “${s.manual.note}”` : ''}
            </div>
          )}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional, e.g. phone battery died)" />
          <div className="row wrap">
            <button className="btn" disabled={busy} onClick={() => void act('present')}>
              Mark present
            </button>
            <button className="btn danger" disabled={busy} onClick={() => void act('absent')}>
              Mark absent
            </button>
            <button className="btn" disabled={busy} onClick={() => void act('excused')}>
              Excused
            </button>
            {s.manual && (
              <button className="btn sm" disabled={busy} onClick={() => void act(null)}>
                Back to automatic
              </button>
            )}
          </div>
          <div className="muted small">Overrides are recorded with your name and shown as “manual” everywhere.</div>
        </div>
      </aside>
    </>
  );
}

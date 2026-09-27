import { ago, fmtClock, fmtDuration } from '../api';
import type { StudentView } from '../types';
import { STATE_ORDER, StateBadge } from './StateBadge';

interface Props {
  students: StudentView[];
  now: number;
  onSelect: (s: StudentView) => void;
}

export function sortStudents(students: StudentView[]): StudentView[] {
  return [...students].sort((a, b) => STATE_ORDER[a.effectiveState] - STATE_ORDER[b.effectiveState] || a.name.localeCompare(b.name));
}

export function StudentTable({ students, now, onSelect }: Props) {
  return (
    <table>
      <thead>
        <tr>
          <th>Student</th>
          <th>Status</th>
          <th>Arrival</th>
          <th>Last seen</th>
          <th className="num">Present</th>
          <th>Zone</th>
          <th>Confidence</th>
        </tr>
      </thead>
      <tbody>
        {sortStudents(students).map((s) => (
          <tr key={s.userId} className="clickable" onClick={() => onSelect(s)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onSelect(s)}>
            <td>
              <div className="name">{s.name}</div>
              <div className="sub">{s.studentNumber ?? ''}</div>
            </td>
            <td>
              <div className="row wrap">
                <StateBadge state={s.effectiveState} manual={!!s.manual} />
                {s.late && s.effectiveState === 'present' && <span className="pill late">{s.veryLate ? 'very late' : 'late'}</span>}
              </div>
            </td>
            <td className="mono">{fmtClock(s.arrivalAt)}</td>
            <td className="mono">{s.lastSeen ? ago(s.lastSeen, now) : '—'}</td>
            <td className="num">{s.presentSeconds ? fmtDuration(s.presentSeconds) : '—'}</td>
            <td>{s.effectiveState === 'present' && s.zone ? s.zone : <span className="muted">—</span>}</td>
            <td>
              {s.confidence > 0 ? (
                <span className="ink2">
                  {s.confidenceLabel} <span className="muted small mono">{s.confidence}</span>
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import { useEffect, useState } from 'react';
import { api, fmtClock, fmtDate, fmtDuration } from '../api';
import type { Summary } from '../types';
import { StateBadge } from './StateBadge';

const VERDICT: Record<Summary['students'][number]['verdict'], string> = {
  attended: 'Attended',
  partial: 'Partial',
  absent: 'Absent',
  excused: 'Excused',
};

export function SummaryView({ sessionId, onHome }: { sessionId: string; onHome: () => void }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Summary>(`/sessions/${sessionId}/summary`).then(setSummary).catch((e) => setError((e as Error).message));
  }, [sessionId]);

  if (error) return <main className="page"><div className="card error">{error}</div></main>;
  if (!summary) return <main className="page"><div className="card empty">Loading summary…</div></main>;
  const { session } = summary;

  const exportCsv = (): void => {
    const rows = [
      ['name', 'student_number', 'verdict', 'attendance_percent', 'arrival', 'present_minutes', 'away_minutes', 'late', 'left_early', 'manual', 'note'],
      ...summary.students.map((s) => [
        s.name,
        s.studentNumber ?? '',
        s.verdict,
        s.attendancePercent ?? '',
        s.arrivalAt ? new Date(s.arrivalAt * 1000).toISOString() : '',
        Math.round(s.presentSeconds / 60),
        Math.round(s.awaySeconds / 60),
        s.late ? 'yes' : 'no',
        s.leftEarly ? 'yes' : 'no',
        s.manual?.state ?? '',
        s.manual?.note ?? '',
      ]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${session.courseCode.replace(/\s+/g, '')}-${fmtDate(session.startedAt).replace(/[^\w]+/g, '-')}.csv`;
    a.click();
  };

  return (
    <main className="page">
      <div className="card">
        <div className="row between wrap">
          <div>
            <h1>
              {session.courseCode} <span className="ink2" style={{ fontWeight: 500 }}>{session.courseName}</span>{' '}
              {session.demo && <span className="pill demo">demo</span>}
            </h1>
            <div className="muted small">
              {fmtDate(session.startedAt)} · {fmtClock(session.startedAt)} – {fmtClock(session.endedAt ?? session.scheduledEnd)} · {fmtDuration(summary.durationSeconds)} · Room {session.roomId}
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={exportCsv}>
              Export CSV
            </button>
            <button className="btn primary" onClick={onHome}>
              Home
            </button>
          </div>
        </div>
      </div>

      <div className="card hero">
        <div>
          <div className="big">
            {summary.attendanceRate}
            <span>%</span>
          </div>
          <div className="label">Attendance rate</div>
        </div>
        <div className="tiles">
          <div className="tile">
            <div className="v">
              {summary.students.filter((s) => s.verdict === 'attended').length} / {summary.counts.enrolled}
            </div>
            <div className="l">Attended (≥75% of class)</div>
          </div>
          <div className="tile">
            <div className="v">{summary.averageArrival ? fmtClock(summary.averageArrival) : '—'}</div>
            <div className="l">Average arrival</div>
          </div>
          <div className="tile">
            <div className="v">{summary.lateArrivals}</div>
            <div className="l">Late arrivals</div>
          </div>
          <div className="tile">
            <div className="v">{summary.earlyDepartures}</div>
            <div className="l">Early departures</div>
          </div>
          <div className="tile">
            <div className="v">{summary.peakOccupancy?.present ?? 0}</div>
            <div className="l">Peak occupancy {summary.peakOccupancy ? `at ${fmtClock(summary.peakOccupancy.at)}` : ''}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Students</h2>
          <span className="small muted">policy: ≥75% attended · 50–74% partial · &lt;50% absent (configurable)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Student</th>
              <th>Verdict</th>
              <th className="num">Attendance</th>
              <th>Arrival</th>
              <th className="num">Present</th>
              <th className="num">Away</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {[...summary.students]
              .sort((a, b) => (b.attendancePercent ?? -1) - (a.attendancePercent ?? -1) || a.name.localeCompare(b.name))
              .map((s) => (
                <tr key={s.userId}>
                  <td>
                    <div className="name">{s.name}</div>
                    <div className="sub">{s.studentNumber ?? ''}</div>
                  </td>
                  <td>
                    <StateBadge
                      state={s.verdict === 'attended' ? 'present' : s.verdict === 'partial' ? 'away' : s.verdict === 'excused' ? 'excused' : 'absent'}
                      manual={!!s.manual}
                    />
                    <span className="small muted" style={{ marginLeft: 6 }}>
                      {VERDICT[s.verdict]}
                    </span>
                  </td>
                  <td className="num">{s.attendancePercent === null ? '—' : `${s.attendancePercent}%`}</td>
                  <td className="mono">{fmtClock(s.arrivalAt)}</td>
                  <td className="num">{s.presentSeconds ? fmtDuration(s.presentSeconds) : '—'}</td>
                  <td className="num">{s.awaySeconds ? fmtDuration(s.awaySeconds) : '—'}</td>
                  <td>
                    <div className="row wrap">
                      {s.late && <span className="pill late">{s.veryLate ? 'very late' : 'late'}</span>}
                      {s.leftEarly && <span className="pill">left early</span>}
                      {s.manual && <span className="pill">manual: {s.manual.state}</span>}
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

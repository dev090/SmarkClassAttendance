import { useEffect, useState } from 'react';
import { api, fmtClock, fmtDuration, useLiveSession } from '../api';
import type { Snapshot, StudentView } from '../types';
import { EventFeed } from './EventFeed';
import { Heatmap } from './Heatmap';
import { OccupancyChart } from './OccupancyChart';
import { ScannerHealth } from './ScannerHealth';
import { StudentDrawer } from './StudentDrawer';
import { StudentTable } from './StudentTable';
import { Timeline } from './Timeline';
import { useNow } from './useNow';

interface Props {
  sessionId: string;
  onEnded: (sessionId: string) => void;
}

export function LiveView({ sessionId, onEnded }: Props) {
  const { snapshot, scanners, connected, ended } = useLiveSession(sessionId);
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  useEffect(() => {
    if (ended === sessionId) onEnded(sessionId);
  }, [ended, sessionId, onEnded]);

  if (!snapshot) {
    return (
      <main className="page">
        <div className="card empty">Connecting to the class…</div>
      </main>
    );
  }
  const { session, counts } = snapshot;
  const student: StudentView | undefined = selected ? snapshot.students.find((s) => s.userId === selected) : undefined;
  const liveScanners = (scanners ?? snapshot.scanners).filter((s) => s.roomId === session.roomId);

  const endClass = async (): Promise<void> => {
    if (!window.confirm(`End ${session.courseCode} now? Attendance will be finalised.`)) return;
    setEnding(true);
    try {
      await api(`/sessions/${session.id}/end`, { method: 'POST' });
      onEnded(session.id);
    } finally {
      setEnding(false);
    }
  };

  const override = async (state: 'present' | 'absent' | 'excused' | null, note: string | null): Promise<void> => {
    if (!student) return;
    await api(`/sessions/${session.id}/attendance/${student.userId}/override`, { method: 'POST', body: JSON.stringify({ state, note }) });
  };

  return (
    <main className="page">
      <div className="card">
        <div className="row between wrap">
          <div>
            <div className="row wrap">
              <h1>
                {session.courseCode} <span className="ink2" style={{ fontWeight: 500 }}>{session.courseName}</span>
              </h1>
              {session.demo && <span className="pill demo">demo mode</span>}
              <span className={`live-dot ${connected ? '' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
            </div>
            <div className="muted small">
              Room {session.roomId} · started {fmtClock(session.startedAt)} · running {fmtDuration(now - session.startedAt)} · scheduled end {fmtClock(session.scheduledEnd)}
              {' · '}present after {session.config.presentConfirmationSeconds}s, away after {session.config.awayGraceSeconds}s, left after {session.config.leftThresholdSeconds}s
            </div>
          </div>
          <button className="btn danger" onClick={() => void endClass()} disabled={ending}>
            {ending ? 'Ending…' : 'End class'}
          </button>
        </div>
      </div>

      <div className="card hero">
        <div>
          <div className="big">
            {counts.present}
            <span>/ {counts.enrolled}</span>
          </div>
          <div className="label">Present now</div>
        </div>
        <Tiles counts={counts} visitors={snapshot.visitors} />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Students</h2>
            <span className="small muted">click a row for details and overrides</span>
          </div>
          <StudentTable students={snapshot.students} now={now} onSelect={(s) => setSelected(s.userId)} />
        </div>
        <div className="stack">
          <Heatmap zones={snapshot.zones} />
          <OccupancyChart samples={snapshot.occupancy} startedAt={session.startedAt} endAt={session.endedAt ?? now} enrolled={counts.enrolled} />
          <div className="card">
            <div className="card-head">
              <h2>Scanners in {session.roomId}</h2>
              <span className="small muted">
                {liveScanners.filter((s) => s.online).length} / {liveScanners.length} online
              </span>
            </div>
            <ScannerHealth scanners={liveScanners} now={now} />
          </div>
        </div>
      </div>

      <Timeline snapshot={snapshot} />
      <EventFeed events={snapshot.events} />

      {student && <StudentDrawer student={student} now={now} onClose={() => setSelected(null)} onOverride={override} />}
    </main>
  );
}

function Tiles({ counts, visitors }: { counts: Snapshot['counts']; visitors: number }) {
  const tiles: Array<{ l: string; v: number; cls: string; icon: string }> = [
    { l: 'Present', v: counts.present, cls: 'present', icon: '✓' },
    { l: 'Late', v: counts.late, cls: 'late', icon: '◷' },
    { l: 'Away', v: counts.away, cls: 'away', icon: '◔' },
    { l: 'Left', v: counts.left, cls: 'left', icon: '↗' },
    { l: 'Detecting', v: counts.detected, cls: 'detected', icon: '…' },
    { l: 'Not detected', v: counts.absent, cls: 'absent', icon: '✕' },
  ];
  if (counts.excused) tiles.push({ l: 'Excused', v: counts.excused, cls: 'excused', icon: '≋' });
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <div key={t.l} className="tile">
          <div className="v">{t.v}</div>
          <div className="l">
            <span className={`badge ${t.cls}`} style={{ padding: 0, background: 'transparent' }}>
              <i aria-hidden />
            </span>
            {t.l}
          </div>
        </div>
      ))}
      {visitors > 0 && (
        <div className="tile" title="Registered SmartClass devices heard in the room that are not enrolled in this course">
          <div className="v">{visitors}</div>
          <div className="l">Unenrolled devices</div>
        </div>
      )}
    </div>
  );
}

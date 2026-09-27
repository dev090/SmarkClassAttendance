import { useCallback, useEffect, useState } from 'react';
import { api, fmtClock, fmtDate } from '../api';
import type { Course, ScannerView, SessionRow, User } from '../types';
import { ScannerHealth } from './ScannerHealth';
import { useNow } from './useNow';

interface ActiveSession {
  id: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  roomId: string;
  startedAt: number;
  demo: boolean;
}

interface Props {
  user: User;
  onOpenLive: (sessionId: string) => void;
  onOpenSummary: (sessionId: string) => void;
}

export function Home({ user, onOpenLive, onOpenSummary }: Props) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [scanners, setScanners] = useState<ScannerView[]>([]);
  const [history, setHistory] = useState<SessionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const refresh = useCallback(async () => {
    try {
      const [c, a, s, h] = await Promise.all([
        api<Course[]>('/courses'),
        api<ActiveSession[]>('/sessions/active'),
        api<ScannerView[]>('/scanners'),
        api<SessionRow[]>('/sessions?limit=15'),
      ]);
      setCourses(c);
      setActive(a);
      setScanners(s);
      setHistory(h.filter((x) => x.status === 'ended'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <main className="page">
      <div className="row between wrap">
        <div>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user.name.replace(/^Prof\.?\s*/, '')}</h1>
          <div className="muted small">Start a class to begin automatic attendance. Demo mode uses short thresholds so judges don't wait.</div>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      {active.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>
              <span className="live-dot" style={{ display: 'inline-block', marginRight: 8 }} />
              Live now
            </h2>
          </div>
          <div className="stack">
            {active.map((s) => (
              <div key={s.id} className="row between wrap">
                <div>
                  <span className="name">{s.courseCode}</span> <span className="ink2">{s.courseName}</span> · {s.roomId} · since {fmtClock(s.startedAt)}{' '}
                  {s.demo && <span className="pill demo">demo</span>}
                </div>
                <button className="btn primary" onClick={() => onOpenLive(s.id)}>
                  Open live dashboard
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid-3">
        {courses.map((c) => (
          <CourseCard key={c.id} course={c} active={active.find((a) => a.courseId === c.id)} onOpenLive={onOpenLive} onStarted={refresh} />
        ))}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Past classes</h2>
          </div>
          {history.length === 0 ? (
            <div className="empty small">No classes yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Course</th>
                  <th className="num">Attended</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {fmtDate(h.startedAt)} <span className="muted">{fmtClock(h.startedAt)}</span>
                    </td>
                    <td>
                      <span className="name">{h.courseCode}</span> {h.demo && <span className="pill demo">demo</span>}
                    </td>
                    <td className="num">
                      {h.attended} / {h.enrolled}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => onOpenSummary(h.id)}>
                        Summary
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Scanners</h2>
            <span className="small muted">
              {scanners.filter((s) => s.online).length} / {scanners.length} online
            </span>
          </div>
          <ScannerHealth scanners={scanners} now={now} />
        </div>
      </div>
    </main>
  );
}

function CourseCard({
  course,
  active,
  onOpenLive,
  onStarted,
}: {
  course: Course;
  active?: ActiveSession;
  onOpenLive: (id: string) => void;
  onStarted: () => Promise<void>;
}) {
  const [demo, setDemo] = useState(true);
  const [minutes, setMinutes] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const snap = await api<{ session: { id: string } }>('/sessions/start', {
        method: 'POST',
        body: JSON.stringify({ courseId: course.id, demo, durationMinutes: demo ? minutes : course.durationMinutes }),
      });
      await onStarted();
      onOpenLive(snap.session.id);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg === 'room_busy' ? `Another class is already running in ${course.roomName}.` : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card course">
      <div className="row between">
        <span className="code">{course.code}</span>
        <span className="pill">{course.roomName}</span>
      </div>
      <div className="ink2">{course.name}</div>
      <div className="small muted">
        {course.schedule ?? 'No schedule'} · {course.enrolled} enrolled · {course.durationMinutes} min
      </div>
      {active ? (
        <button className="btn primary" onClick={() => onOpenLive(active.id)}>
          Open live dashboard
        </button>
      ) : (
        <>
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /> Demo mode
            </label>
            {demo && (
              <label className="check">
                <input type="number" min={5} max={180} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} style={{ width: 70 }} /> min
              </label>
            )}
          </div>
          <button className="btn primary" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Start class'}
          </button>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}

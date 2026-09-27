import { fmtTime } from '../api';
import type { Snapshot } from '../types';

const describe = (e: Snapshot['events'][number]): string => {
  const who = e.name ?? 'Someone';
  switch (e.type) {
    case 'session_started':
      return `Class started${e.data.demo ? ' (demo mode)' : ''}`;
    case 'session_ended':
      return 'Class ended';
    case 'detected':
      return `${who} detected by ${String(e.data.scannerId ?? 'a scanner')} (${String(e.data.rssi)} dBm)`;
    case 'present':
      return `${who} confirmed present${e.data.late ? ' — late' : ''}`;
    case 'away':
      return `${who} temporarily away`;
    case 'left':
      return `${who} left`;
    case 'returned':
      return `${who} returned`;
    case 'lost':
      return `${who} heard briefly, then vanished`;
    case 'zone':
      return `${who} moved ${String(e.data.from)} → ${String(e.data.to)}`;
    case 'manual_override':
      return `${who}: professor set ${e.data.state ? String(e.data.state) : 'automatic'}${e.data.note ? ` (${String(e.data.note)})` : ''}`;
    case 'duplicate_room':
      return `⚠ ${who}'s device heard in another room (${String(e.data.otherRoom)}) — possible clone`;
    case 'config_changed':
      return 'Thresholds changed';
    default:
      return `${who}: ${e.type}`;
  }
};

export function EventFeed({ events }: { events: Snapshot['events'] }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Activity</h2>
        <span className="small muted">latest first</span>
      </div>
      <ul className="events">
        {events.length === 0 && <li className="muted">Nothing yet.</li>}
        {events.slice(0, 40).map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <time>{fmtTime(e.at)}</time>
            <span>{describe(e)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

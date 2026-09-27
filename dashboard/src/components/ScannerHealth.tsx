import { ago } from '../api';
import type { ScannerView } from '../types';

export function ScannerHealth({ scanners, now, compact }: { scanners: ScannerView[]; now: number; compact?: boolean }) {
  return (
    <div className="scanner-list">
      {scanners.length === 0 && <div className="muted small">No scanners registered.</div>}
      {scanners.map((s) => (
        <div key={s.id} className="scanner">
          <span className={`dot ${s.online ? 'on' : ''}`} aria-hidden />
          <span className="name">{s.id}</span>
          <span className="muted">{s.zone}</span>
          <span className="grow" />
          <span className="small ink2">{s.online ? 'Online' : 'Offline'}</span>
          {!compact && (
            <span className="small muted mono">
              {s.wifiRssi !== null ? `Wi-Fi ${s.wifiRssi} dBm · ` : ''}
              {s.lastHeartbeat ? ago(s.lastHeartbeat, now) : 'never seen'}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

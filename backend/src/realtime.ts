import type { WebSocket } from 'ws';
import type { ScannerView, Snapshot } from './snapshot.ts';

interface Client {
  socket: WebSocket;
  sessionId: string | null; // specific id, or 'active' for any active session
}

/** Debounced full-snapshot broadcaster. Simple by design: one message type carries the whole truth. */
export class Hub {
  private readonly clients = new Set<Client>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly snapshotFor: (sessionId: string) => Promise<Snapshot | null>;
  private readonly debounceMs: number;
  private readonly log: (e: unknown) => void;

  constructor(snapshotFor: (sessionId: string) => Promise<Snapshot | null>, debounceMs = 300, log: (e: unknown) => void = console.error) {
    this.snapshotFor = snapshotFor;
    this.debounceMs = debounceMs;
    this.log = log;
  }

  add(socket: WebSocket): void {
    const client: Client = { socket, sessionId: null };
    this.clients.add(client);
    socket.on('message', (raw) => {
      void (async () => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; sessionId?: string };
          if (msg.type === 'subscribe' && typeof msg.sessionId === 'string') {
            client.sessionId = msg.sessionId;
            if (msg.sessionId !== 'active') {
              const snap = await this.snapshotFor(msg.sessionId);
              if (snap) this.send(client, { type: 'snapshot', snapshot: snap });
            }
          } else if (msg.type === 'ping') {
            this.send(client, { type: 'pong' });
          }
        } catch {
          /* ignore malformed */
        }
      })();
    });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
  }

  markDirty(sessionId: string): void {
    this.dirty.add(sessionId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const ids = [...this.dirty];
      this.dirty.clear();
      void this.flush(ids);
    }, this.debounceMs);
  }

  private async flush(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        const snap = await this.snapshotFor(id);
        if (!snap) continue;
        for (const c of this.clients) {
          if (c.sessionId === id || c.sessionId === 'active') this.send(c, { type: 'snapshot', snapshot: snap });
        }
      } catch (e) {
        this.log(e);
      }
    }
  }

  broadcastScanners(scanners: ScannerView[]): void {
    for (const c of this.clients) this.send(c, { type: 'scanners', scanners });
  }

  sessionStarted(sessionId: string): void {
    for (const c of this.clients) if (c.sessionId === 'active') this.send(c, { type: 'session_started', sessionId });
    this.markDirty(sessionId);
  }

  async sessionEnded(sessionId: string): Promise<void> {
    const snap = await this.snapshotFor(sessionId);
    for (const c of this.clients) {
      if (c.sessionId === sessionId || c.sessionId === 'active') {
        if (snap) this.send(c, { type: 'snapshot', snapshot: snap });
        this.send(c, { type: 'session_ended', sessionId });
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  private send(c: Client, msg: unknown): void {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(msg));
  }
}

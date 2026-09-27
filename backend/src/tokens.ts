import { createHmac } from 'node:crypto';
import { config, now } from './config.ts';
import type { Store } from './store.ts';

export const TOKEN_CONTEXT = 'smartclass:v1:';

/** BLE token for a window: first 8 bytes of HMAC_SHA256(secret, "smartclass:v1:<window>") as 16 hex chars. */
export function deriveToken(secretHex: string, window: number): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(`${TOKEN_CONTEXT}${window}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

export const currentWindow = (unixSeconds = now()): number => Math.floor(unixSeconds / config.tokenWindowSeconds);

export interface Resolved {
  userId: string;
  window: number;
}

/**
 * Keeps every student's secret in memory (refreshed from MongoDB every 30 s and whenever a secret rotates)
 * and precomputes tokens for windows w-1, w, w+1 so a detection resolves synchronously in O(1).
 */
export class TokenResolver {
  private students: Array<{ id: string; secret: string }> = [];
  private map = new Map<string, Resolved>();
  private builtForWindow = -1;
  private timer: NodeJS.Timeout | null = null;
  private readonly store: Store;
  private readonly log: (e: unknown) => void;

  constructor(store: Store, log: (e: unknown) => void = console.error) {
    this.store = store;
    this.log = log;
  }

  async refresh(): Promise<void> {
    const rows = await this.store.users
      .find({ role: 'student', secret: { $ne: null } }, { projection: { _id: 1, secret: 1 } })
      .toArray();
    this.students = rows.map((r) => ({ id: r._id, secret: r.secret as string }));
    this.builtForWindow = -1;
  }

  start(intervalMs = 30_000): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh().catch(this.log), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Call after a secret rotates (device migration / first login). */
  invalidate(): Promise<void> {
    return this.refresh().catch(this.log);
  }

  private ensure(): void {
    const w = currentWindow();
    if (w === this.builtForWindow) return;
    const next = new Map<string, Resolved>();
    for (const { id, secret } of this.students) {
      for (const win of [w - 1, w, w + 1]) next.set(deriveToken(secret, win), { userId: id, window: win });
    }
    this.map = next;
    this.builtForWindow = w;
  }

  resolve(tokenHex: string): Resolved | null {
    this.ensure();
    return this.map.get(tokenHex.toUpperCase()) ?? null;
  }

  size(): number {
    this.ensure();
    return this.map.size;
  }
}

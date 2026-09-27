import { useEffect, useRef, useState } from 'react';
import type { Snapshot, ScannerView } from './types';

const TOKEN_KEY = 'smartclass.token';
const USER_KEY = 'smartclass.user';

export const getToken = (): string | null => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setSession = (token: string | null, user: unknown): void => {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* private mode */
  }
};
export const getStoredUser = <T>(): T | null => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body;
}

type WsMessage =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'scanners'; scanners: ScannerView[] }
  | { type: 'session_started'; sessionId: string }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'pong' };

/** Subscribes to live snapshots for a session id (or 'active'). Reconnects with backoff. */
export function useLiveSession(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [scanners, setScanners] = useState<ScannerView[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    if (!sessionId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => {
        attempts.current = 0;
        setConnected(true);
        ws?.send(JSON.stringify({ type: 'subscribe', sessionId }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        if (msg.type === 'snapshot') {
          if (sessionId === 'active' || msg.snapshot.session.id === sessionId) setSnapshot(msg.snapshot);
        } else if (msg.type === 'scanners') setScanners(msg.scanners);
        else if (msg.type === 'session_ended') setEnded(msg.sessionId);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(10_000, 500 * 2 ** attempts.current++);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    // fall back to a REST fetch so the page is never empty while the socket warms up
    if (sessionId !== 'active') api<Snapshot>(`/sessions/${sessionId}`).then(setSnapshot).catch(() => {});

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [sessionId]);

  return { snapshot, scanners, connected, ended };
}

export const fmtTime = (unix: number | null | undefined): string =>
  unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const fmtClock = (unix: number | null | undefined): string =>
  unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtDate = (unix: number): string =>
  new Date(unix * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const fmtDuration = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const ago = (unix: number | null | undefined, now: number): string => (unix ? `${fmtDuration(now - unix)} ago` : '—');

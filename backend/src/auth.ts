import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config, now } from './config.ts';

export type Role = 'student' | 'professor' | 'admin';
export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    rawBody?: string;
  }
}

// ---------- passwords ----------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// ---------- bearer tokens (compact HMAC-signed, no external JWT lib) ----------
interface TokenPayload {
  uid: string;
  role: Role;
  exp: number;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function signToken(uid: string, role: Role, ttlSeconds = config.authTtlSeconds): string {
  const payload: TokenPayload = { uid, role, exp: now() + ttlSeconds };
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', config.authSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', config.authSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- scanner request signatures ----------
export function scannerSignature(secret: string, timestamp: number | string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyScannerSignature(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(ts - now()) > config.scannerSkewSeconds) return false;
  const expected = scannerSignature(secret, timestamp, rawBody);
  const a = Buffer.from(signature.toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- fastify guards ----------
export type UserLookup = (uid: string) => Promise<AuthUser | null> | AuthUser | null;

export function requireUser(lookup: UserLookup, roles?: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    const user = payload ? await lookup(payload.uid) : null;
    if (!payload || !user) {
      reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (roles && !roles.includes(user.role)) {
      reply.code(403).send({ error: 'forbidden' });
      return;
    }
    req.user = user;
  };
}

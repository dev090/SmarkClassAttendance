import type { AuthUser } from './auth.ts';
import type { Engine } from './engine.ts';
import type { Hub } from './realtime.ts';
import type { CourseDoc, Store } from './store.ts';
import type { TokenResolver } from './tokens.ts';

export interface Ctx {
  store: Store;
  engine: Engine;
  hub: Hub;
  resolver: TokenResolver;
  lookupUser: (uid: string) => Promise<AuthUser | null>;
}

export interface CourseView {
  id: string;
  code: string;
  name: string;
  roomId: string;
  roomName: string;
  schedule: string | null;
  durationMinutes: number;
  enrolled: number;
  /** iBeacon major of the room (phones monitor one region per room in the background) */
  beaconMajor: number | null;
}

export async function coursesForUser(store: Store, user: AuthUser): Promise<CourseView[]> {
  const filter =
    user.role === 'student' ? { studentIds: user.id } : user.role === 'professor' ? { professorId: user.id } : {};
  const [courses, rooms] = await Promise.all([store.courses.find(filter).sort({ code: 1 }).toArray(), store.roomsById()]);
  return courses.map((c: CourseDoc) => ({
    id: c._id,
    code: c.code,
    name: c.name,
    roomId: c.roomId,
    roomName: rooms.get(c.roomId)?.name ?? c.roomId,
    schedule: c.schedule,
    durationMinutes: c.durationMinutes,
    enrolled: c.studentIds.length,
    beaconMajor: rooms.get(c.roomId)?.beaconMajor ?? null,
  }));
}

/** Drops the SmartClass database and re-seeds it. Usage: pnpm reset-db */
import { Store } from '../src/store.ts';

const store = await Store.connect();
if (store.ephemeral) {
  console.log('In-memory MongoDB: nothing to reset (data lives only while the server runs).');
} else {
  await store.db.dropDatabase();
  await store.ensureIndexes();
  await store.seedIfEmpty();
  console.log(`Dropped and re-seeded database "${store.db.databaseName}".`);
}
await store.close();

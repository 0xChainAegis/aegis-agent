import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY,address TEXT NOT NULL,message TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,address TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (scope TEXT PRIMARY KEY,hash TEXT NOT NULL,status INTEGER NOT NULL,payload TEXT NOT NULL);`);
  }
  get<T>(kind: string, id: string, owner?: string): T | undefined {
    const row = this.db.prepare('SELECT owner,payload FROM entities WHERE kind=? AND id=?').get(kind, id) as { owner: string; payload: string } | undefined;
    if (!row || (owner && row.owner.toLowerCase() !== owner.toLowerCase())) return undefined;
    return JSON.parse(row.payload) as T;
  }
  put(kind: string, id: string, owner: string, payload: unknown) {
    this.db.prepare('INSERT INTO entities(kind,id,owner,payload) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, id, owner.toLowerCase(), JSON.stringify(payload));
  }
  list<T>(kind: string, owner?: string): T[] {
    const rows = owner ? this.db.prepare('SELECT payload FROM entities WHERE kind=? AND owner=? ORDER BY rowid').all(kind, owner.toLowerCase()) : this.db.prepare('SELECT payload FROM entities WHERE kind=? ORDER BY rowid').all(kind);
    return rows.map(row => JSON.parse(String(row.payload)) as T);
  }
  close() { this.db.close(); }
}

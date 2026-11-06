import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { HHEvent } from '../shared/types.js'

// Append-only event log. Every event keeps who, where and which run, so the same log can later be
// shipped to a team server unchanged.
export class EventStore {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists events (
        id integer primary key autoincrement,
        ts text not null,
        kind text not null,
        repo text,
        run text,
        body text not null
      );
      create index if not exists events_ts on events(ts);
      create table if not exists kv (k text primary key, v text not null);
    `)
  }

  append(e: HHEvent): void {
    this.db.prepare('insert into events (ts, kind, repo, run, body) values (?, ?, ?, ?, ?)')
      .run(e.ts, e.kind, e.repo ?? null, e.run ?? null, JSON.stringify(e))
  }

  since(iso: string): HHEvent[] {
    const rows = this.db.prepare('select body from events where ts >= ? order by ts, id').all(iso) as { body: string }[]
    return rows.map((r) => JSON.parse(r.body) as HHEvent)
  }

  count(): number {
    return (this.db.prepare('select count(*) as n from events').get() as { n: number }).n
  }

  prune(beforeIso: string): number {
    return Number(this.db.prepare('delete from events where ts < ?').run(beforeIso).changes)
  }

  get<T>(k: string): T | undefined {
    const row = this.db.prepare('select v from kv where k = ?').get(k) as { v: string } | undefined
    return row ? (JSON.parse(row.v) as T) : undefined
  }

  set(k: string, v: unknown): void {
    this.db.prepare('insert into kv (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, JSON.stringify(v))
  }

  close(): void {
    this.db.close()
  }
}

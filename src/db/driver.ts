// The only place that talks to the database engine. Today this is Cloudflare D1.
// For the Vercel standby, add a second implementation of `SqlDriver` for an
// SQLite-compatible database; nothing above this file changes.
//
// D1 queries made through the plain binding (no `withSession()`) go to the
// primary database, so every write and every check here reads current data.

import type { Sql } from "./sql";

export interface SqlMeta {
  changes: number;
  rows_read: number;
  rows_written: number;
}

export interface SqlResult<T> {
  results: T[];
  meta: SqlMeta;
}

export interface SqlDriver {
  all<T = Record<string, unknown>>(q: Sql): Promise<SqlResult<T>>;
  /** Runs all statements as one transaction, in order. Any error rolls back all of them. */
  batch(qs: Sql[]): Promise<SqlResult<Record<string, unknown>>[]>;
  /** Rows read/written by this driver so far (per request), for measurement. */
  readonly usage: { rows_read: number; rows_written: number; queries: number };
}

export class D1Driver implements SqlDriver {
  usage = { rows_read: 0, rows_written: 0, queries: 0 };
  constructor(private readonly d1: D1Database) {}

  private track(meta: Partial<D1Meta> | undefined): SqlMeta {
    const m = {
      changes: Number(meta?.changes ?? 0),
      rows_read: Number(meta?.rows_read ?? 0),
      rows_written: Number(meta?.rows_written ?? 0),
    };
    this.usage.rows_read += m.rows_read;
    this.usage.rows_written += m.rows_written;
    return m;
  }

  async all<T>(q: Sql): Promise<SqlResult<T>> {
    this.usage.queries++;
    const r = await this.d1.prepare(q.text).bind(...q.params).all<T>();
    return { results: r.results ?? [], meta: this.track(r.meta) };
  }

  async batch(qs: Sql[]): Promise<SqlResult<Record<string, unknown>>[]> {
    this.usage.queries++;
    const rs = await this.d1.batch<Record<string, unknown>>(qs.map((q) => this.d1.prepare(q.text).bind(...q.params)));
    return rs.map((r) => ({ results: r.results ?? [], meta: this.track(r.meta) }));
  }
}

/**
 * Tiny in-memory stand-in for the Supabase query builder, enough for
 * the WhatsApp Forms modules: select / eq / is / in / order / limit /
 * maybeSingle / single / insert / update / upsert, filtered over plain
 * row arrays. Test-only.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

export interface FakeDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  writes: { table: string; op: string; values: unknown }[];
}

export function fakeDb(tables: Record<string, Row[]>): FakeDb {
  const writes: FakeDb['writes'] = [];
  const client = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'update' | 'insert' | 'upsert' = 'select';
      let values: unknown = null;
      const rows = () => (tables[table] ??= []).filter((r) => filters.every((f) => f(r)));
      const result = () => {
        if (op === 'select') return { data: rows(), error: null };
        writes.push({ table, op, values });
        if (op === 'update') {
          const hit = rows();
          hit.forEach((r) => Object.assign(r, values as Row));
          return { data: hit, error: null };
        }
        const list = (Array.isArray(values) ? values : [values]) as Row[];
        const inserted = list.map((v, i) => ({ id: `new-${table}-${i}`, ...v }));
        tables[table].push(...inserted);
        return { data: inserted, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters.push((r) => r[col] === val);
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (r[col] ?? null) === val);
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          filters.push((r) => vals.includes(r[col]));
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        update: (v: unknown) => {
          op = 'update';
          values = v;
          return builder;
        },
        insert: (v: unknown) => {
          op = 'insert';
          values = v;
          return builder;
        },
        upsert: (v: unknown) => {
          op = 'upsert';
          values = v;
          return builder;
        },
        maybeSingle: async () => {
          const { data } = result();
          return { data: (data as Row[])[0] ?? null, error: null };
        },
        single: async () => {
          const { data } = result();
          return { data: (data as Row[])[0] ?? null, error: null };
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, tables, writes };
}

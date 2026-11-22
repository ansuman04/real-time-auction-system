import pg from 'pg';
import { database } from './tracing.js';

export function tracedPool(options: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(options);
  function instrument(client: pg.Pool | pg.PoolClient) {
    const query = client.query;
    client.query = function (this: pg.Pool | pg.PoolClient, ...args: unknown[]) {
      const first = args[0];
      const text = typeof first === 'string' ? first : typeof first === 'object' && first !== null && 'text' in first ? String(first.text) : '';
      const operation = /^(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/i.exec(text.trim())?.[1]?.toLowerCase() ?? 'operation';
      // pg callback use must keep its original callback semantics.
      if (typeof args.at(-1) === 'function') return Reflect.apply(query, this, args);
      return database(operation, () => Reflect.apply(query, this, args));
    } as typeof client.query;
  }
  instrument(pool);
  pool.on('connect', instrument);
  return pool;
}

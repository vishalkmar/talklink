// In-memory stand-in for Redis (used when REDIS_URL is empty - one server instance, no Redis
// service to pay for). Implements exactly the ioredis commands this backend uses, with the same
// return shapes (strings for values / scores, numbers for counters, 'OK' / null for SET), key
// expiry (EX / PX / EXPIRE) and MULTI ... EXEC. Data lives in this process only: a restart clears
// presence, counters and locks (users, credits, chats are in MongoDB and are not affected).
const { EventEmitter } = require('events');

const SWEEP_MS = 60 * 1000;

const parseBound = (v) => {
  const s = String(v);
  if (s === '-inf') return { value: -Infinity, open: false };
  if (s === '+inf' || s === 'inf') return { value: Infinity, open: false };
  if (s.startsWith('(')) return { value: Number(s.slice(1)), open: true };
  return { value: Number(s), open: false };
};
const inRange = (score, min, max) =>
  (min.open ? score > min.value : score >= min.value) &&
  (max.open ? score < max.value : score <= max.value);
const sliceRange = (arr, start, stop) => {
  const n = arr.length;
  let s = Number(start);
  let e = Number(stop);
  if (s < 0) s = Math.max(n + s, 0);
  if (e < 0) e = n + e;
  if (s > e || s >= n) return [];
  return arr.slice(s, Math.min(e, n - 1) + 1);
};

class MemoryRedis extends EventEmitter {
  constructor(store) {
    super();
    // shared between duplicates, like two connections to one server
    this.store = store || { data: new Map(), expires: new Map() };
    this.status = 'ready';
    if (!store) {
      this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
      this.sweeper.unref();
    }
  }

  // ---------- connection lifecycle (no-ops) ----------
  async connect() {
    this.status = 'ready';
  }

  async quit() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.status = 'end';
    return 'OK';
  }

  duplicate() {
    return new MemoryRedis(this.store);
  }

  // ---------- internals ----------
  sweep() {
    const now = Date.now();
    for (const [k, at] of this.store.expires) if (at <= now) this.drop(k);
  }

  drop(key) {
    this.store.data.delete(key);
    this.store.expires.delete(key);
  }

  entry(key) {
    const at = this.store.expires.get(key);
    if (at !== undefined && at <= Date.now()) this.drop(key);
    return this.store.data.get(key);
  }

  typed(key, type, create) {
    let e = this.entry(key);
    if (e && e.type !== type) {
      throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    }
    if (!e && create) {
      e = {
        type,
        value:
          type === 'string'
            ? null
            : type === 'hash'
              ? new Map()
              : type === 'set'
                ? new Set()
                : new Map(),
      };
      this.store.data.set(key, e);
    }
    return e;
  }

  // a hash / set / zset that became empty disappears, like in Redis
  cleanup(key, e) {
    if (e && e.type !== 'string' && e.value.size === 0) this.drop(key);
  }

  // ---------- keys ----------
  async del(...keys) {
    let n = 0;
    for (const k of keys.flat()) {
      if (this.entry(k)) {
        this.drop(k);
        n += 1;
      }
    }
    return n;
  }

  async exists(...keys) {
    return keys.flat().filter((k) => this.entry(k)).length;
  }

  async expire(key, sec) {
    return this.pexpire(key, Number(sec) * 1000);
  }

  async pexpire(key, ms) {
    if (!this.entry(key)) return 0;
    this.store.expires.set(key, Date.now() + Number(ms));
    return 1;
  }

  async pttl(key) {
    if (!this.entry(key)) return -2;
    const at = this.store.expires.get(key);
    return at === undefined ? -1 : Math.max(at - Date.now(), 0);
  }

  async ttl(key) {
    const ms = await this.pttl(key);
    return ms < 0 ? ms : Math.ceil(ms / 1000);
  }

  async flushdb() {
    this.store.data.clear();
    this.store.expires.clear();
    return 'OK';
  }

  async flushall() {
    return this.flushdb();
  }

  // ---------- strings ----------
  async get(key) {
    const e = this.typed(key, 'string');
    return e ? e.value : null;
  }

  async mget(...keys) {
    return Promise.all(keys.flat().map((k) => this.get(k)));
  }

  // SET key value [EX s | PX ms] [NX | XX]
  async set(key, value, ...opts) {
    let ttlMs = null;
    let nx = false;
    let xx = false;
    for (let i = 0; i < opts.length; i += 1) {
      const o = String(opts[i]).toUpperCase();
      if (o === 'EX') ttlMs = Number(opts[(i += 1)]) * 1000;
      else if (o === 'PX') ttlMs = Number(opts[(i += 1)]);
      else if (o === 'NX') nx = true;
      else if (o === 'XX') xx = true;
    }
    const exists = Boolean(this.entry(key));
    if ((nx && exists) || (xx && !exists)) return null;
    this.store.data.set(key, { type: 'string', value: String(value) });
    if (ttlMs !== null) this.store.expires.set(key, Date.now() + ttlMs);
    else this.store.expires.delete(key);
    return 'OK';
  }

  async getdel(key) {
    const v = await this.get(key);
    if (v !== null) this.drop(key);
    return v;
  }

  async incrby(key, by) {
    const e = this.typed(key, 'string', true);
    const n = (e.value === null ? 0 : Number(e.value)) + Number(by);
    if (!Number.isInteger(n)) throw new Error('ERR value is not an integer or out of range');
    e.value = String(n);
    return n;
  }

  async incr(key) {
    return this.incrby(key, 1);
  }

  async decrby(key, by) {
    return this.incrby(key, -Number(by));
  }

  async decr(key) {
    return this.incrby(key, -1);
  }

  // ---------- hashes ----------
  // HSET key field value [field value ...]  |  HSET key { field: value }
  async hset(key, ...args) {
    const pairs =
      args.length === 1 && typeof args[0] === 'object'
        ? Object.entries(args[0])
        : Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]);
    const e = this.typed(key, 'hash', true);
    let added = 0;
    for (const [f, v] of pairs) {
      if (!e.value.has(String(f))) added += 1;
      e.value.set(String(f), String(v));
    }
    return added;
  }

  async hsetnx(key, field, value) {
    const e = this.typed(key, 'hash', true);
    if (e.value.has(String(field))) return 0;
    e.value.set(String(field), String(value));
    return 1;
  }

  async hget(key, field) {
    const e = this.typed(key, 'hash');
    return e && e.value.has(String(field)) ? e.value.get(String(field)) : null;
  }

  async hgetall(key) {
    const e = this.typed(key, 'hash');
    return e ? Object.fromEntries(e.value) : {};
  }

  async hdel(key, ...fields) {
    const e = this.typed(key, 'hash');
    if (!e) return 0;
    let n = 0;
    for (const f of fields.flat()) if (e.value.delete(String(f))) n += 1;
    this.cleanup(key, e);
    return n;
  }

  async hincrby(key, field, by) {
    const e = this.typed(key, 'hash', true);
    const n = Number(e.value.get(String(field)) || 0) + Number(by);
    e.value.set(String(field), String(n));
    return n;
  }

  // ---------- sets ----------
  async sadd(key, ...members) {
    const e = this.typed(key, 'set', true);
    let n = 0;
    for (const m of members.flat()) {
      if (!e.value.has(String(m))) {
        e.value.add(String(m));
        n += 1;
      }
    }
    return n;
  }

  async srem(key, ...members) {
    const e = this.typed(key, 'set');
    if (!e) return 0;
    let n = 0;
    for (const m of members.flat()) if (e.value.delete(String(m))) n += 1;
    this.cleanup(key, e);
    return n;
  }

  async smembers(key) {
    const e = this.typed(key, 'set');
    return e ? [...e.value] : [];
  }

  async sismember(key, member) {
    const e = this.typed(key, 'set');
    return e && e.value.has(String(member)) ? 1 : 0;
  }

  async scard(key) {
    const e = this.typed(key, 'set');
    return e ? e.value.size : 0;
  }

  // ---------- sorted sets ----------
  sorted(key) {
    const e = this.typed(key, 'zset');
    if (!e) return [];
    return [...e.value.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort(
        (a, b) => a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0),
      );
  }

  // ZADD key [NX|XX] [GT|LT] score member [score member ...]
  async zadd(key, ...args) {
    const flags = new Set();
    while (args.length && /^(NX|XX|GT|LT|CH)$/i.test(String(args[0]))) {
      flags.add(String(args.shift()).toUpperCase());
    }
    const e = this.typed(key, 'zset', !flags.has('XX'));
    if (!e) return 0;
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const score = Number(args[i]);
      const member = String(args[i + 1]);
      const has = e.value.has(member);
      if ((flags.has('NX') && has) || (flags.has('XX') && !has)) continue;
      const old = e.value.get(member);
      if (has && flags.has('GT') && !(score > old)) continue;
      if (has && flags.has('LT') && !(score < old)) continue;
      if (!has) added += 1;
      e.value.set(member, score);
    }
    this.cleanup(key, e);
    return added;
  }

  async zincrby(key, by, member) {
    const e = this.typed(key, 'zset', true);
    const n = (e.value.get(String(member)) || 0) + Number(by);
    e.value.set(String(member), n);
    return String(n);
  }

  async zrem(key, ...members) {
    const e = this.typed(key, 'zset');
    if (!e) return 0;
    let n = 0;
    for (const m of members.flat()) if (e.value.delete(String(m))) n += 1;
    this.cleanup(key, e);
    return n;
  }

  async zscore(key, member) {
    const e = this.typed(key, 'zset');
    return e && e.value.has(String(member)) ? String(e.value.get(String(member))) : null;
  }

  async zcard(key) {
    const e = this.typed(key, 'zset');
    return e ? e.value.size : 0;
  }

  async zcount(key, min, max) {
    const lo = parseBound(min);
    const hi = parseBound(max);
    return this.sorted(key).filter((x) => inRange(x.score, lo, hi)).length;
  }

  out(items, withScores) {
    return withScores
      ? items.flatMap((x) => [x.member, String(x.score)])
      : items.map((x) => x.member);
  }

  async zrange(key, start, stop, ...opts) {
    return this.out(sliceRange(this.sorted(key), start, stop), /WITHSCORES/i.test(opts.join(' ')));
  }

  async zrevrange(key, start, stop, ...opts) {
    return this.out(
      sliceRange(this.sorted(key).reverse(), start, stop),
      /WITHSCORES/i.test(opts.join(' ')),
    );
  }

  async zrangebyscore(key, min, max, ...opts) {
    const lo = parseBound(min);
    const hi = parseBound(max);
    let items = this.sorted(key).filter((x) => inRange(x.score, lo, hi));
    const li = opts.findIndex((o) => /^LIMIT$/i.test(String(o)));
    if (li >= 0)
      items = items.slice(Number(opts[li + 1]), Number(opts[li + 1]) + Number(opts[li + 2]));
    return this.out(
      items,
      opts.some((o) => /^WITHSCORES$/i.test(String(o))),
    );
  }

  async zremrangebyscore(key, min, max) {
    const lo = parseBound(min);
    const hi = parseBound(max);
    const e = this.typed(key, 'zset');
    if (!e) return 0;
    let n = 0;
    for (const [m, s] of e.value) {
      if (inRange(s, lo, hi)) {
        e.value.delete(m);
        n += 1;
      }
    }
    this.cleanup(key, e);
    return n;
  }

  async zrevrank(key, member) {
    const i = this.sorted(key)
      .reverse()
      .findIndex((x) => x.member === String(member));
    return i < 0 ? null : i;
  }

  // ---------- MULTI / pipeline: queued calls, exec -> [[err, result], ...] ----------
  multi() {
    const queue = [];
    const self = this;
    const chain = new Proxy(
      {},
      {
        get(_, name) {
          if (name === 'exec') {
            return async () => {
              const results = [];
              for (const [cmd, args] of queue) {
                try {
                  results.push([null, await self[cmd](...args)]);
                } catch (err) {
                  results.push([err, null]);
                }
              }
              return results;
            };
          }
          if (typeof self[name] !== 'function') return undefined;
          return (...args) => {
            queue.push([name, args]);
            return chain;
          };
        },
      },
    );
    return chain;
  }

  pipeline() {
    return this.multi();
  }
}

module.exports = { MemoryRedis };

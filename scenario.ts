// The scenario identity: the login the trial's bearer token names.
// The suite's scenario is a pure function of one constant seed (kit wire.ts):
// deriving the same viewer login (adaiversen) from that seed is what lets
// GET /repos/{owner}/{repo} 404 for any other owner and lets viewer.login read back.

const SEED = 0x6a09e667f3bcc909n;
const MASK = 0xffffffffffffffffn;

function fnv(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK;
  }
  return h;
}

function mix(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}

class Rng {
  #s: bigint;
  constructor(seed: bigint) {
    const m = seed & MASK;
    this.#s = m === 0n ? SEED : m;
  }
  u64(): bigint {
    let x = this.#s;
    x = (x ^ (x >> 12n)) & MASK;
    x = (x ^ (x << 25n)) & MASK;
    x = (x ^ (x >> 27n)) & MASK;
    this.#s = x;
    return (x * 0x2545f4914f6cdd1dn) & MASK;
  }
  u32(): number {
    return Number(this.u64() >> 32n);
  }
  int(max: number): number {
    if (max === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % max);
    for (;;) {
      const v = this.u32();
      if (v < limit) return v % max;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
}

const FIRST = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function buildUsers(count: number): ScenarioUser[] {
  const rng = new Rng(mix(SEED ^ fnv('users')));
  const used = new Set<string>();
  const out: ScenarioUser[] = [];
  for (let i = 0; i < count; i++) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let n = 2;
    while (used.has(login)) {
      login = `${base}-${n}`;
      n++;
    }
    used.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}

const USERS = buildUsers(12);
/** The login the trial's bearer token names. */
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
export const TEAMMATE: ScenarioUser = USERS[1] as ScenarioUser;
export const STRANGER: ScenarioUser = USERS[2] as ScenarioUser;
export const ALL_USERS: readonly ScenarioUser[] = USERS;

// Mock data values: a seeded random source and one function per generator, each giving a value as text (the
// database converts it, as with Import CSV). Built in, English only, no dependency. No `vscode`, no I/O.

/** A random number in [0, 1). Seeded, so the same seed gives the same values. */
export type Rng = () => number;

/** mulberry32: small, fast and good enough for test data (not for anything secret). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

/** An integer in [min, max] (BigInt, so bigint columns keep their full range). */
export function randomInteger(rng: Rng, min: bigint, max: bigint): bigint {
  const span = max - min + 1n;
  if (span <= 1n) return min;
  if (span <= 2n ** 32n) return min + BigInt(Math.floor(rng() * Number(span)));
  // Wider ranges: enough 32-bit draws to cover the span (a little modulo bias doesn't matter here).
  let value = 0n;
  for (let bits = 0n; 1n << bits < span; bits += 32n) value = (value << 32n) | BigInt(Math.floor(rng() * 4294967296));
  return min + (value % span);
}

const FIRST = [
  'Aiden', 'Alice', 'Amara', 'Andre', 'Anna', 'Arjun', 'Ava', 'Ben', 'Carlos', 'Chloe', 'Daniel', 'Elena', 'Emma', 'Ethan',
  'Fatima', 'Felix', 'Grace', 'Hana', 'Hugo', 'Isabel', 'Ivan', 'Jack', 'James', 'Julia', 'Kai', 'Kenji', 'Lara', 'Leo',
  'Liam', 'Lucas', 'Maya', 'Mei', 'Mia', 'Nadia', 'Noah', 'Olivia', 'Omar', 'Priya', 'Rosa', 'Ryan', 'Sara', 'Sofia',
  'Tariq', 'Thomas', 'Uma', 'Victor', 'Wei', 'Yara', 'Yuki', 'Zoe',
] as const;
const LAST = [
  'Adams', 'Ali', 'Baker', 'Brown', 'Chen', 'Clark', 'Costa', 'Davis', 'Diaz', 'Evans', 'Fischer', 'Garcia', 'Green',
  'Hall', 'Hansen', 'Ito', 'Jones', 'Khan', 'Kim', 'Kowalski', 'Lee', 'Lopez', 'Martin', 'Meyer', 'Miller', 'Moreau',
  'Murphy', 'Nguyen', 'Novak', 'Okafor', 'Patel', 'Perez', 'Rossi', 'Sato', 'Schmidt', 'Silva', 'Singh', 'Smith',
  'Tanaka', 'Taylor', 'Thomas', 'Walker', 'Wang', 'White', 'Wilson', 'Wright', 'Young', 'Zhang',
] as const;
const CITIES = [
  'Amsterdam', 'Athens', 'Austin', 'Bangkok', 'Barcelona', 'Berlin', 'Boston', 'Cairo', 'Cape Town', 'Chicago', 'Denver',
  'Dublin', 'Hamburg', 'Helsinki', 'Istanbul', 'Jakarta', 'Lagos', 'Lima', 'Lisbon', 'London', 'Lyon', 'Madrid', 'Manila',
  'Melbourne', 'Milan', 'Montreal', 'Mumbai', 'Nairobi', 'Osaka', 'Oslo', 'Paris', 'Porto', 'Prague', 'Seattle', 'Seoul',
  'Singapore', 'Stockholm', 'Sydney', 'Taipei', 'Tokyo', 'Toronto', 'Vienna', 'Warsaw', 'Yangon', 'Zurich',
] as const;
const COUNTRIES = [
  'Argentina', 'Australia', 'Austria', 'Brazil', 'Canada', 'Chile', 'China', 'Denmark', 'Egypt', 'Finland', 'France',
  'Germany', 'Greece', 'India', 'Indonesia', 'Ireland', 'Italy', 'Japan', 'Kenya', 'Mexico', 'Myanmar', 'Netherlands',
  'New Zealand', 'Nigeria', 'Norway', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Singapore', 'South Africa',
  'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Thailand', 'Turkey', 'United Kingdom', 'United States', 'Vietnam',
] as const;
const STREETS = ['Oak', 'Maple', 'Cedar', 'Pine', 'Elm', 'Lake', 'Hill', 'Park', 'River', 'Station', 'Church', 'Mill', 'Garden', 'Bridge', 'King', 'Queen', 'High', 'Market'] as const;
const STREET_KINDS = ['Street', 'Avenue', 'Road', 'Lane', 'Way', 'Drive', 'Court', 'Place'] as const;
const COMPANY_WORDS = ['Acme', 'Apex', 'Blue', 'Bright', 'Cedar', 'Delta', 'Echo', 'Global', 'Harbor', 'Iron', 'Lumen', 'Nova', 'North', 'Orbit', 'Peak', 'Pixel', 'Quantum', 'Silver', 'Summit', 'Vertex'] as const;
const COMPANY_KINDS = ['Labs', 'Systems', 'Group', 'Works', 'Partners', 'Digital', 'Foods', 'Logistics', 'Studio', 'Holdings'] as const;
const COMPANY_ENDS = ['Inc.', 'Ltd.', 'LLC', 'Co.', 'GmbH'] as const;
const DOMAINS = ['example.com', 'example.org', 'example.net'] as const;
const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna ' +
  'aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute ' +
  'irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non ' +
  'proident sunt culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

const lower = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const digits = (rng: Rng, n: number) => Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');
const words = (rng: Rng, min: number, max: number) => Array.from({ length: min + Math.floor(rng() * (max - min + 1)) }, () => pick(rng, LOREM));
const sentence = (rng: Rng, min = 4, max = 10) => {
  const w = words(rng, min, max).join(' ');
  return `${w[0].toUpperCase()}${w.slice(1)}.`;
};

export const firstName = (rng: Rng) => pick(rng, FIRST);
export const lastName = (rng: Rng) => pick(rng, LAST);
export const fullName = (rng: Rng) => `${firstName(rng)} ${lastName(rng)}`;
export const email = (rng: Rng) => `${lower(firstName(rng))}.${lower(lastName(rng))}${rng() < 0.5 ? Math.floor(rng() * 100) : ''}@${pick(rng, DOMAINS)}`;
export const username = (rng: Rng) => `${lower(firstName(rng))}${pick(rng, ['_', '.', ''])}${lower(lastName(rng)).slice(0, 4)}${Math.floor(rng() * 100)}`;
/** Phone numbers in the 555-01xx range reserved for fiction. */
export const phone = (rng: Rng) => `+1-555-01${digits(rng, 2)}-${digits(rng, 4)}`;
export const company = (rng: Rng) => `${pick(rng, COMPANY_WORDS)} ${pick(rng, COMPANY_KINDS)} ${pick(rng, COMPANY_ENDS)}`;
export const street = (rng: Rng) => `${1 + Math.floor(rng() * 999)} ${pick(rng, STREETS)} ${pick(rng, STREET_KINDS)}`;
export const city = (rng: Rng) => pick(rng, CITIES);
export const country = (rng: Rng) => pick(rng, COUNTRIES);
export const postalCode = (rng: Rng) => digits(rng, 5);
export const url = (rng: Rng) => `https://${lower(pick(rng, COMPANY_WORDS))}${lower(pick(rng, COMPANY_KINDS))}.${pick(rng, DOMAINS)}/${pick(rng, LOREM)}`;
export const loremWords = (rng: Rng) => words(rng, 2, 5).join(' ');
export const loremSentence = (rng: Rng) => sentence(rng);
export const loremParagraph = (rng: Rng) => Array.from({ length: 3 + Math.floor(rng() * 3) }, () => sentence(rng)).join(' ');

/** A version 4 UUID from the seeded source. */
export function uuid(rng: Rng): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rng() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A small JSON object, as JSON text. */
export function jsonObject(rng: Rng): string {
  return JSON.stringify({ id: 1 + Math.floor(rng() * 10_000), name: fullName(rng), active: rng() < 0.5, tags: words(rng, 1, 3) });
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Days since 1970-01-01 (UTC) for a `YYYY-MM-DD` date. */
export function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dateOf(day: number): string {
  const t = new Date(day * 86_400_000);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const timeOf = (second: number) => `${pad(Math.floor(second / 3600))}:${pad(Math.floor((second % 3600) / 60))}:${pad(second % 60)}`;

/**
 * Makes a value different for a unique column: a number before an email's `@`, or at the end, keeping within
 * `maxLength` by shortening the value rather than the number.
 */
export function withSuffix(value: string, n: number, maxLength?: number): string {
  const suffix = String(n);
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    const domain = value.slice(at);
    const room = maxLength === undefined ? local.length : Math.max(0, maxLength - domain.length - suffix.length);
    if (maxLength === undefined || room > 0) return `${local.slice(0, room)}${suffix}${domain}`;
  }
  const room = maxLength === undefined ? value.length : Math.max(0, maxLength - suffix.length);
  return `${value.slice(0, room)}${suffix}`.slice(0, maxLength ?? Infinity);
}

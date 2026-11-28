// Generate Mock Data: which generator each column gets (from its name and type), the form's settings checked
// and parsed, and the rows themselves, unique where the table needs them and with foreign keys taken from
// existing parent rows. Pure: the extension reads the design, existing values and parent keys and passes them
// in (views/MockForm.ts). No `vscode`, no I/O.
import type { TableDesign } from '../design/model';
import type { Cell } from '../types';
import * as g from './generators';

export type GeneratorId =
  | 'skip'
  | 'null'
  | 'fixed'
  | 'list'
  | 'foreignKey'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'uuid'
  | 'json'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'email'
  | 'username'
  | 'phone'
  | 'company'
  | 'street'
  | 'city'
  | 'country'
  | 'postalCode'
  | 'url'
  | 'words'
  | 'sentence'
  | 'paragraph';

/** Which inputs a generator has in the form. */
export type OptionField = 'range' | 'places' | 'length' | 'dates' | 'values' | 'value';

export interface GeneratorMeta {
  id: GeneratorId;
  label: string;
  fields: OptionField[];
}

const TEXT: OptionField[] = ['length'];

export const GENERATORS: GeneratorMeta[] = [
  { id: 'skip', label: 'Skip (database default)', fields: [] },
  { id: 'null', label: 'NULL', fields: [] },
  { id: 'fixed', label: 'Fixed value', fields: ['value'] },
  { id: 'list', label: 'One of a list', fields: ['values'] },
  { id: 'foreignKey', label: 'Foreign key (existing rows)', fields: [] },
  { id: 'integer', label: 'Integer', fields: ['range'] },
  { id: 'decimal', label: 'Decimal', fields: ['range', 'places'] },
  { id: 'boolean', label: 'Boolean (0 / 1)', fields: [] },
  { id: 'date', label: 'Date', fields: ['dates'] },
  { id: 'datetime', label: 'Date and time', fields: ['dates'] },
  { id: 'time', label: 'Time', fields: [] },
  { id: 'uuid', label: 'UUID', fields: [] },
  { id: 'json', label: 'JSON object', fields: [] },
  { id: 'firstName', label: 'First name', fields: TEXT },
  { id: 'lastName', label: 'Last name', fields: TEXT },
  { id: 'fullName', label: 'Full name', fields: TEXT },
  { id: 'email', label: 'Email', fields: TEXT },
  { id: 'username', label: 'Username', fields: TEXT },
  { id: 'phone', label: 'Phone', fields: TEXT },
  { id: 'company', label: 'Company', fields: TEXT },
  { id: 'street', label: 'Street address', fields: TEXT },
  { id: 'city', label: 'City', fields: TEXT },
  { id: 'country', label: 'Country', fields: TEXT },
  { id: 'postalCode', label: 'Postal code', fields: TEXT },
  { id: 'url', label: 'URL', fields: TEXT },
  { id: 'words', label: 'Words', fields: TEXT },
  { id: 'sentence', label: 'Sentence', fields: TEXT },
  { id: 'paragraph', label: 'Paragraph', fields: TEXT },
];

const META = new Map(GENERATORS.map((m) => [m.id, m]));
export const isGenerator = (v: unknown): v is GeneratorId => typeof v === 'string' && META.has(v as GeneratorId);

const TEXT_GENERATORS: Record<string, (rng: g.Rng) => string> = {
  firstName: g.firstName,
  lastName: g.lastName,
  fullName: g.fullName,
  email: g.email,
  username: g.username,
  phone: g.phone,
  company: g.company,
  street: g.street,
  city: g.city,
  country: g.country,
  postalCode: g.postalCode,
  url: g.url,
  words: g.loremWords,
  sentence: g.loremSentence,
  paragraph: g.loremParagraph,
};

/** Form input values: text as typed (`values` is a comma list). Parsed and checked by `checkMock`. */
export interface MockOptions {
  min?: string;
  max?: string;
  places?: string;
  maxLength?: string;
  from?: string;
  to?: string;
  values?: string;
  value?: string;
}

export interface ColumnSetting {
  generator: GeneratorId;
  options: MockOptions;
}

// ---- Types ----

export type TypeKind = 'integer' | 'decimal' | 'float' | 'boolean' | 'text' | 'date' | 'datetime' | 'time' | 'year' | 'uuid' | 'json' | 'binary' | 'other';

export interface TypeInfo {
  kind: TypeKind;
  /** Integer range of the type. */
  min?: bigint;
  max?: bigint;
  /** numeric(precision, scale). */
  precision?: number;
  scale?: number;
  /** varchar(n) and the like. */
  length?: number;
}

const INT_RANGES: [RegExp, number][] = [
  [/^tinyint\b/, 8],
  [/^(smallint|int2|smallserial|serial2)\b/, 16],
  [/^mediumint\b/, 24],
  [/^(bigint|int8|bigserial|serial8)\b/, 64],
  [/^(int|integer|int4|serial|serial4)\b/, 32],
];

/** What kind of value a column takes, from its type as the database reports it (all three dialects). */
export function typeInfo(type: string): TypeInfo {
  const t = type.trim().toLowerCase();
  if (/\[\]$/.test(t) || /^_/.test(t)) return { kind: 'other' };
  if (/^(bool|boolean)$/.test(t) || /^tinyint\s*\(\s*1\s*\)/.test(t)) return { kind: 'boolean' };
  if (/^bit\b/.test(t)) return { kind: 'other' };
  for (const [re, bits] of INT_RANGES) {
    if (!re.test(t)) continue;
    const unsigned = /\bunsigned\b/.test(t);
    const half = 1n << BigInt(bits - 1);
    return unsigned ? { kind: 'integer', min: 0n, max: (half << 1n) - 1n } : { kind: 'integer', min: -half, max: half - 1n };
  }
  const dec = /^(decimal|numeric|dec|fixed)\b\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/.exec(t);
  if (dec) return { kind: 'decimal', precision: dec[2] ? Number(dec[2]) : undefined, scale: dec[2] ? Number(dec[3] ?? 0) : undefined };
  if (/^(real|float|double|float4|float8|money)\b/.test(t)) return { kind: 'float' };
  if (t === 'date') return { kind: 'date' };
  if (/^(datetime|timestamp|smalldatetime)\b/.test(t)) return { kind: 'datetime' };
  if (/^time\b/.test(t)) return { kind: 'time' };
  if (/^year\b/.test(t)) return { kind: 'year', min: 1901n, max: 2155n };
  if (t === 'uuid' || t === 'uniqueidentifier') return { kind: 'uuid' };
  if (t === 'json' || t === 'jsonb') return { kind: 'json' };
  if (/^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|image)\b/.test(t)) return { kind: 'binary' };
  if (/^(enum|set)\s*\(/.test(t)) return { kind: 'text' };
  const text = /^(character varying|varchar|nvarchar|national character varying|character|char|nchar|bpchar|text|tinytext|mediumtext|longtext|citext|string|clob|name|varchar2)\b/.exec(t);
  if (text) {
    const length = /\(\s*(\d+)\s*\)/.exec(t);
    return { kind: 'text', length: length ? Number(length[1]) : undefined };
  }
  // SQLite type affinity, for declared types the lists above don't know.
  if (t === '') return { kind: 'text' };
  if (t.includes('int')) return { kind: 'integer', min: -(1n << 63n), max: (1n << 63n) - 1n };
  if (/char|clob|text/.test(t)) return { kind: 'text' };
  if (t.includes('blob')) return { kind: 'binary' };
  if (/real|floa|doub/.test(t)) return { kind: 'float' };
  return { kind: 'other' };
}

// ---- CHECK (col IN (…)) ----

// '' and MySQL's \' and \\ inside a string. (A PostgreSQL value with a literal backslash before a quote or
// another backslash would be read one backslash short; the database still checks the row.)
const LITERAL = /^\s*(?:_\w+)?'((?:[^'\\]|''|\\.)*)'|^\s*(-?\d+(?:\.\d+)?)/;
const CAST = /^\s*::\s*[a-z_][\w ]*(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])?/i;

/**
 * The column and allowed values of a check that is only `col IN (…)` (SQLite, MySQL) or PostgreSQL's
 * `(col)::text = ANY ((ARRAY[…])::text[])`. Anything else gives undefined: other checks aren't evaluated.
 */
export function checkInList(expression: string): { column: string; values: string[] } | undefined {
  let s = expression.trim();
  // A column (bare, "quoted" or `quoted`), maybe in brackets and cast (PostgreSQL: `status::text`, `(status)::text`).
  const head = /^[(\s]*(?:([A-Za-z_][\w$]*)|"((?:[^"]|"")+)"|`((?:[^`]|``)+)`)\s*\)?(?:\s*::\s*[a-z_][\w ]*?)?\s*(?:in\s*\(|=\s*any\s*\(\s*\(?\s*array\s*\[)/i.exec(s);
  if (!head) return undefined;
  const column = head[1] ?? head[2]?.replace(/""/g, '"') ?? head[3].replace(/``/g, '`');
  s = s.slice(head[0].length);
  const values: string[] = [];
  for (;;) {
    const lit = LITERAL.exec(s);
    if (!lit) return undefined;
    values.push(lit[1] !== undefined ? lit[1].replace(/''/g, "'").replace(/\\(['\\])/g, '$1') : lit[2]);
    s = s.slice(lit[0].length);
    const cast = CAST.exec(s);
    if (cast) s = s.slice(cast[0].length);
    const sep = /^\s*,/.exec(s);
    if (!sep) break;
    s = s.slice(sep[0].length);
  }
  // Only closing brackets, casts and whitespace may follow.
  if (!/^[\s\])]*(?:::\s*[a-z_][\w ]*(?:\[\])?[\s)]*)?$/i.test(s)) return undefined;
  return values.length ? { column, values } : undefined;
}

// ---- The table ----

export interface MockColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  generated: boolean;
  hasDefault: boolean;
  /** In a single-column unique key (or the primary key). */
  unique: boolean;
  /** Index into `MockTable.foreignKeys` of the first FK this column is in. */
  foreignKey?: number;
  info: TypeInfo;
  /** Allowed values from an enum / set type or a CHECK … IN list. */
  choices?: string[];
  allowed: GeneratorId[];
  /** Default options per generator, so switching generators in the form starts from sensible values. */
  defaults: Partial<Record<GeneratorId, MockOptions>>;
  /** The auto-picked generator. */
  setting: ColumnSetting;
}

export interface MockForeignKey {
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
}

export interface MockTable {
  columns: MockColumn[];
  /** Primary key (unless every column auto-increments) and unique indexes, as column indexes. */
  uniqueKeys: number[][];
  foreignKeys: MockForeignKey[];
  /** CHECK constraints that aren't simple IN lists: not evaluated. */
  otherChecks: number;
  /** NULLs never clash in a unique key (TableFeatures.uniqueNullsDistinct); false: NULL counts as one value. */
  nullsDistinct: boolean;
}

/** The columns with their auto-picked generators, from the table's design and `Driver.columnChoices`. */
export function mockTable(design: TableDesign, choices: Record<string, string[]>, nullsDistinct = true): MockTable {
  const index = new Map(design.columns.map((c, i) => [c.name, i]));
  const checkValues = new Map<string, string[]>();
  let otherChecks = 0;
  for (const c of design.checks) {
    const list = checkInList(c.expression);
    if (list && index.has(list.column)) checkValues.set(list.column, list.values);
    else otherChecks++;
  }
  const uniqueKeys: number[][] = [];
  const pk = design.columns.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0);
  if (pk.length) uniqueKeys.push(pk);
  for (const x of design.indexes) {
    if (!x.unique) continue;
    const cols = x.columns.map((n) => index.get(n));
    if (cols.every((i): i is number => i !== undefined) && !uniqueKeys.some((k) => k.join() === cols.join())) uniqueKeys.push(cols);
  }
  const foreignKeys: MockForeignKey[] = design.foreignKeys
    .filter((f) => f.columns.every((c) => index.has(c)) && f.columns.length === f.refColumns.length)
    .map((f) => ({ columns: f.columns, refSchema: f.refSchema, refTable: f.refTable, refColumns: f.refColumns }));
  const columns = design.columns.map((c, i): MockColumn => {
    const fk = foreignKeys.findIndex((f) => f.columns.includes(c.name));
    const col: MockColumn = {
      name: c.name,
      type: c.type,
      nullable: c.nullable && !c.primaryKey,
      primaryKey: c.primaryKey,
      autoIncrement: c.autoIncrement,
      generated: !!c.generated,
      hasDefault: !!c.default.trim(),
      unique: uniqueKeys.some((k) => k.length === 1 && k[0] === i),
      foreignKey: fk >= 0 ? fk : undefined,
      info: typeInfo(c.type),
      choices: choices[c.name]?.length ? choices[c.name] : checkValues.get(c.name),
      allowed: [],
      defaults: {},
      setting: { generator: 'skip', options: {} },
    };
    col.allowed = allowedGenerators(col);
    col.defaults = Object.fromEntries(col.allowed.map((id) => [id, defaultOptions(col, id)]));
    const generator = pickGenerator(col);
    col.setting = { generator, options: { ...col.defaults[generator] } };
    return col;
  });
  return { columns, uniqueKeys, foreignKeys, otherChecks, nullsDistinct };
}

function allowedGenerators(c: MockColumn): GeneratorId[] {
  if (c.generated) return ['skip'];
  return GENERATORS.map((m) => m.id).filter((id) => {
    if (id === 'skip') return c.hasDefault || c.autoIncrement || c.nullable;
    if (id === 'null') return c.nullable;
    if (id === 'foreignKey') return c.foreignKey !== undefined;
    return true;
  });
}

/** The generator a column starts with: the database's own value first, then keys, lists, type and name. */
export function pickGenerator(c: MockColumn): GeneratorId {
  if (c.generated || c.autoIncrement || c.hasDefault) return 'skip';
  if (c.foreignKey !== undefined) return 'foreignKey';
  if (c.choices) return 'list';
  const n = c.name.toLowerCase();
  switch (c.info.kind) {
    case 'boolean':
    case 'uuid':
    case 'json':
    case 'date':
    case 'datetime':
    case 'time':
      return c.info.kind;
    case 'integer':
    case 'year':
      return 'integer';
    case 'decimal':
    case 'float':
      return 'decimal';
    case 'text':
      return textByName(n, c.info.length);
    default:
      // Binary, arrays, spatial and unknown types: not generated.
      return c.nullable ? 'null' : 'fixed';
  }
}

function textByName(n: string, length?: number): GeneratorId {
  if (/e_?mail/.test(n)) return 'email';
  if (/^(first_?name|fname|given_?name|forename)$/.test(n)) return 'firstName';
  if (/^(last_?name|lname|surname|family_?name)$/.test(n)) return 'lastName';
  if (/^(name|full_?name|display_?name|contact_?name|customer_?name|author|owner)$/.test(n)) return 'fullName';
  if (/user_?name|login|handle|nick/.test(n)) return 'username';
  if (/phone|mobile|tel$|^tel|fax/.test(n)) return 'phone';
  if (/company|organi[sz]ation|employer|vendor|supplier/.test(n)) return 'company';
  if (/address|street/.test(n)) return 'street';
  if (/city|town/.test(n)) return 'city';
  if (/country/.test(n)) return 'country';
  if (/zip|postal|postcode/.test(n)) return 'postalCode';
  if (/url|website|link|homepage|avatar|image|photo/.test(n)) return 'url';
  if (/uuid|guid/.test(n)) return 'uuid';
  if (/(_at|_on)$|^(date|created|updated|deleted)$|_date$|timestamp/.test(n)) return 'datetime';
  if (/desc|body|content|bio|note|comment|summary|message|text|details/.test(n)) return length !== undefined && length < 100 ? 'sentence' : 'paragraph';
  if (/title|subject|headline|caption/.test(n)) return length !== undefined && length < 30 ? 'words' : 'sentence';
  return 'words';
}

const DATE_FROM = '2020-01-01';
const DATE_TO = '2025-12-31';

function integerRange(c: MockColumn): [bigint, bigint] {
  const n = c.name.toLowerCase();
  let [lo, hi] = [1n, 100_000n];
  if (c.info.kind === 'year' || /year/.test(n)) [lo, hi] = [1990n, 2030n];
  else if (/(^|_)age$/.test(n)) [lo, hi] = [18n, 90n];
  else if (/qty|quantity|count|stock/.test(n)) [lo, hi] = [0n, 100n];
  else if (/rating|stars|score/.test(n)) [lo, hi] = [1n, 5n];
  else if (/percent|pct/.test(n)) [lo, hi] = [0n, 100n];
  const { min, max } = c.info;
  if (min !== undefined && lo < min) lo = min;
  if (max !== undefined && hi > max) hi = max;
  return [lo, hi];
}

function decimalDefaults(c: MockColumn): MockOptions {
  const n = c.name.toLowerCase();
  const geo = /^(lat|latitude|lng|lon|long|longitude)$/.test(n);
  const places = c.info.scale ?? (geo ? 6 : 2);
  let [lo, hi] = [1, 1000];
  if (/^(lat|latitude)$/.test(n)) [lo, hi] = [-90, 90];
  else if (geo) [lo, hi] = [-180, 180];
  if (c.info.precision !== undefined) {
    const top = 10 ** (c.info.precision - places) - 10 ** -places;
    hi = Math.min(hi, top);
    lo = Math.max(lo, -top);
    if (lo > hi) lo = 0;
  }
  const fmt = (v: number) => (places ? v.toFixed(places).replace(/\.?0+$/, '') : v.toFixed(0)) || '0';
  return { min: fmt(lo), max: fmt(hi), places: String(places) };
}

function defaultOptions(c: MockColumn, id: GeneratorId): MockOptions {
  switch (id) {
    case 'integer': {
      const [lo, hi] = c.info.kind === 'integer' || c.info.kind === 'year' ? integerRange(c) : [1n, 1000n];
      return { min: String(lo), max: String(hi) };
    }
    case 'decimal':
      return decimalDefaults(c);
    case 'date':
    case 'datetime':
      return { from: DATE_FROM, to: DATE_TO };
    case 'list':
      return { values: (c.choices ?? []).join(', ') };
    case 'fixed':
      return { value: '' };
    default:
      return META.get(id)?.fields.includes('length') ? { maxLength: c.info.length !== undefined ? String(c.info.length) : '' } : {};
  }
}

// ---- Checking the form's settings ----

/** A column's setting, parsed. */
export interface ParsedSetting {
  generator: GeneratorId;
  min?: bigint;
  max?: bigint;
  minNumber?: number;
  maxNumber?: number;
  places?: number;
  maxLength?: number;
  fromDay?: number;
  toDay?: number;
  values?: string[];
  value?: string;
}

export interface MockRequest {
  rows: number;
  seed: number;
  settings: ParsedSetting[];
}

export const MAX_ROWS = 10_000;
const MAX_TEXT = 10_000;

/** Checks the form's row count, seed and per-column settings. Errors name the column. */
export function checkMock(table: MockTable, rows: unknown, seed: unknown, raw: unknown): { request?: MockRequest; errors: string[] } {
  const errors: string[] = [];
  const count = typeof rows === 'string' && /^\d+$/.test(rows.trim()) ? Number(rows) : typeof rows === 'number' ? rows : NaN;
  if (!Number.isInteger(count) || count < 1 || count > MAX_ROWS) errors.push(`Rows: choose a number from 1 to ${MAX_ROWS.toLocaleString('en-US')}.`);
  const s = typeof seed === 'string' && /^\d+$/.test(seed.trim()) ? Number(seed) : typeof seed === 'number' ? seed : NaN;
  if (!Number.isInteger(s) || s < 0 || s > 0xffffffff) errors.push('Seed: use a whole number from 0 to 4294967295.');
  if (!Array.isArray(raw) || raw.length !== table.columns.length) return { errors: [...errors, 'The column settings don’t match the table. Reload the form.'] };
  const settings = table.columns.map((c, i) => parseSetting(c, raw[i], (text) => errors.push(`${c.name}: ${text}`)));
  if (!settings.some((p) => p.generator !== 'skip')) errors.push('Choose a generator for at least one column.');
  return errors.length ? { errors } : { request: { rows: count, seed: s, settings }, errors };
}

const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);

function parseSetting(c: MockColumn, raw: unknown, fail: (text: string) => void): ParsedSetting {
  const r = raw && typeof raw === 'object' ? (raw as { generator?: unknown; options?: unknown }) : {};
  const generator = isGenerator(r.generator) && c.allowed.includes(r.generator) ? r.generator : undefined;
  if (!generator) {
    fail('choose a generator.');
    return { generator: 'skip' };
  }
  const o = (r.options && typeof r.options === 'object' ? r.options : {}) as Record<string, unknown>;
  const p: ParsedSetting = { generator };
  const fields = META.get(generator)?.fields ?? [];
  if (fields.includes('range')) {
    const min = str(o.min, 40)?.trim() ?? '';
    const max = str(o.max, 40)?.trim() ?? '';
    if (generator === 'integer') {
      if (!/^-?\d{1,38}$/.test(min) || !/^-?\d{1,38}$/.test(max)) fail('Min and Max must be whole numbers.');
      else {
        p.min = BigInt(min);
        p.max = BigInt(max);
        if (p.min > p.max) fail('Max must be at least Min.');
      }
    } else {
      p.minNumber = /^-?\d+(\.\d+)?$/.test(min) ? Number(min) : NaN;
      p.maxNumber = /^-?\d+(\.\d+)?$/.test(max) ? Number(max) : NaN;
      if (!Number.isFinite(p.minNumber) || !Number.isFinite(p.maxNumber)) fail('Min and Max must be numbers.');
      else if (p.minNumber > p.maxNumber) fail('Max must be at least Min.');
    }
  }
  if (fields.includes('places')) {
    const places = str(o.places, 3)?.trim() ?? '';
    p.places = /^\d{1,2}$/.test(places) ? Number(places) : NaN;
    if (!(p.places >= 0 && p.places <= 12)) fail('Decimal places must be from 0 to 12.');
  }
  if (fields.includes('length')) {
    const len = str(o.maxLength, 7)?.trim() ?? '';
    if (len) {
      p.maxLength = /^\d+$/.test(len) ? Number(len) : NaN;
      if (!(p.maxLength >= 1 && p.maxLength <= 100_000)) fail('Max length must be from 1 to 100000, or empty.');
    }
  }
  if (fields.includes('dates')) {
    const from = str(o.from, 10) ?? '';
    const to = str(o.to, 10) ?? '';
    if (!validDate(from) || !validDate(to)) fail('From and To must be dates (YYYY-MM-DD).');
    else {
      p.fromDay = g.dayNumber(from);
      p.toDay = g.dayNumber(to);
      if (p.fromDay > p.toDay) fail('To must be on or after From.');
    }
  }
  if (fields.includes('values')) {
    const text = str(o.values, 100_000);
    p.values = (text ?? '').split(',').map((v) => v.trim()).filter((v) => v.length);
    if (text === undefined || !p.values.length) fail('List at least one value (comma separated).');
    else if (p.values.length > 1_000) fail('List at most 1,000 values.');
  }
  if (fields.includes('value')) {
    p.value = str(o.value);
    if (p.value === undefined) fail('The value is too long.');
  }
  return p;
}

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

// ---- Generating ----

/** What the extension read from the database for one generation. */
export interface MockData {
  /** Per unique key (same order as `MockTable.uniqueKeys`): the values already in the table. */
  existing: { rows: Cell[][]; capped: boolean }[];
  /** Per foreign key (same order as `MockTable.foreignKeys`): a sample of the parent's key values. */
  parents: { rows: Cell[][]; capped: boolean }[];
}

/** A row can't be generated with these settings (e.g. not enough distinct values for a unique column). */
export class MockError extends Error {}

export interface MockNote {
  tone: 'info' | 'warning' | 'error';
  text: string;
}

/** How many different values a setting can make, when that's small enough to matter. */
function capacity(p: ParsedSetting): bigint | undefined {
  switch (p.generator) {
    case 'fixed':
      return 1n;
    case 'boolean':
      return 2n;
    case 'list':
      return BigInt(new Set(p.values).size);
    case 'integer':
      return p.min !== undefined && p.max !== undefined ? p.max - p.min + 1n : undefined;
    case 'date':
      return p.fromDay !== undefined && p.toDay !== undefined ? BigInt(p.toDay - p.fromDay + 1) : undefined;
    case 'decimal':
      return p.minNumber !== undefined && p.maxNumber !== undefined && p.places !== undefined
        ? BigInt(Math.floor((p.maxNumber - p.minNumber) * 10 ** p.places) + 1)
        : undefined;
    case 'time':
      return 86_400n;
    default:
      return undefined;
  }
}

const tupleKey = (values: Cell[]) => JSON.stringify(values);

/**
 * `count` rows for the columns whose generator isn't Skip, in table order. The same seed, settings and data
 * give the same rows, so the preview's rows are the first rows inserted.
 */
export function generateRows(table: MockTable, request: MockRequest, data: MockData, count = request.rows): Cell[][] {
  const rng = g.seededRng(request.seed);
  const { settings } = request;
  const used = settings.map((p, i) => (p.generator === 'skip' ? -1 : i)).filter((i) => i >= 0);
  // Only keys whose columns are all generated here can be checked; the database checks the rest.
  const keys = table.uniqueKeys
    .map((cols, k) => ({ cols, k }))
    .filter(({ cols }) => cols.every((i) => settings[i].generator !== 'skip'));
  const seen = keys.map(({ k }) => new Set((data.existing[k]?.rows ?? []).map(tupleKey)));
  for (const { cols } of keys) {
    if (cols.length !== 1) continue;
    // Where NULL counts as a value in a unique key (SQL Server), the NULL generator makes exactly one.
    const cap = settings[cols[0]].generator === 'null' && !table.nullsDistinct ? 1n : capacity(settings[cols[0]]);
    const fk = settings[cols[0]].generator === 'foreignKey' ? table.columns[cols[0]].foreignKey : undefined;
    const limit = fk !== undefined ? BigInt(usableParents(data, fk).length) : cap;
    if (limit !== undefined && limit < BigInt(request.rows)) {
      throw new MockError(`${table.columns[cols[0]].name} is unique, but its settings make only ${limit.toLocaleString()} different value${limit === 1n ? '' : 's'} for ${request.rows.toLocaleString()} rows.`);
    }
  }
  const parentRows = table.foreignKeys.map((_, f) => usableParents(data, f));
  const rows: Cell[][] = [];
  for (let r = 0; r < count; r++) {
    const row: Cell[] = new Array<Cell>(settings.length).fill(null);
    const fill = (only?: number[]) => {
      const tuples = new Map<number, Cell[]>();
      for (const i of only ?? used) {
        const p = settings[i];
        if (p.generator === 'foreignKey') {
          const f = table.columns[i].foreignKey!;
          let tuple = tuples.get(f);
          if (!tuple) {
            if (!parentRows[f].length) {
              if (!table.columns[i].nullable) throw new MockError(`${table.columns[i].name}: ${table.foreignKeys[f].refTable} has no rows to point to.`);
              tuple = parentRows[f][0] ?? [];
            } else tuple = g.pick(rng, parentRows[f]);
            tuples.set(f, tuple);
          }
          row[i] = tuple[table.foreignKeys[f].columns.indexOf(table.columns[i].name)] ?? null;
        } else row[i] = value(rng, p);
      }
    };
    fill();
    for (const [n, { cols }] of keys.entries()) {
      for (let attempt = 0; ; attempt++) {
        const values = cols.map((i) => row[i]);
        if ((table.nullsDistinct && values.some((v) => v === null)) || !seen[n].has(tupleKey(values))) break;
        if (attempt >= 100) {
          throw new MockError(
            `Row ${r + 1}: couldn’t make a new value for unique ${cols.map((i) => table.columns[i].name).join(', ')} after 100 tries. Widen its range or choose another generator.`,
          );
        }
        // Regenerate the key's columns (with all columns of an FK they share); text gets a number after a few tries.
        const again = new Set(cols);
        for (const i of cols) {
          const f = settings[i].generator === 'foreignKey' ? table.columns[i].foreignKey : undefined;
          if (f !== undefined) for (const name of table.foreignKeys[f].columns) again.add(table.columns.findIndex((c) => c.name === name));
        }
        fill([...again].filter((i) => i >= 0 && settings[i].generator !== 'skip'));
        if (attempt >= 20 && cols.length === 1) {
          // A nearly full range: walk from the random value to the next free one instead of drawing again.
          const free = nextFree(settings[cols[0]], row[cols[0]], (v) => !seen[n].has(tupleKey([v])));
          if (free !== undefined) row[cols[0]] = free;
        }
        if (attempt >= 5) {
          for (const i of cols) {
            if (TEXT_GENERATORS[settings[i].generator] && row[i] !== null) row[i] = g.withSuffix(row[i]!, 1 + Math.floor(rng() * 999_999), settings[i].maxLength);
          }
        }
      }
    }
    // A regenerated key may clash with an earlier key's values again; the database is the last check.
    keys.forEach(({ cols }, n) => {
      const values = cols.map((i) => row[i]);
      if (!table.nullsDistinct || !values.some((v) => v === null)) seen[n].add(tupleKey(values));
    });
    rows.push(used.map((i) => row[i]));
  }
  return rows;
}

const SCAN_LIMIT = 1_000_000;

/** The next value after `start` (wrapping around) of an integer or date range that `free` accepts. */
function nextFree(p: ParsedSetting, start: Cell, free: (v: string) => boolean): string | undefined {
  if (start === null) return undefined;
  if (p.generator === 'integer' && p.min !== undefined && p.max !== undefined) {
    const span = p.max - p.min + 1n;
    let v = BigInt(start);
    for (let i = 0n; i < span && i < BigInt(SCAN_LIMIT); i++) {
      v = v >= p.max ? p.min : v + 1n;
      if (free(String(v))) return String(v);
    }
  } else if (p.generator === 'date' && p.fromDay !== undefined && p.toDay !== undefined) {
    let day = g.dayNumber(start);
    for (let i = 0; i <= p.toDay - p.fromDay && i < SCAN_LIMIT; i++) {
      day = day >= p.toDay ? p.fromDay : day + 1;
      if (free(g.dateOf(day))) return g.dateOf(day);
    }
  }
  return undefined;
}

/** Parent key tuples without NULLs or binary values. */
function usableParents(data: MockData, f: number): Cell[][] {
  return (data.parents[f]?.rows ?? []).filter((t) => t.every((v) => typeof v === 'string'));
}

function value(rng: g.Rng, p: ParsedSetting): Cell {
  const text = TEXT_GENERATORS[p.generator];
  if (text) {
    const v = text(rng);
    return p.maxLength !== undefined ? v.slice(0, p.maxLength) : v;
  }
  switch (p.generator) {
    case 'null':
      return null;
    case 'fixed':
      return p.value ?? '';
    case 'list':
      return g.pick(rng, p.values ?? ['']);
    case 'integer':
      return String(g.randomInteger(rng, p.min ?? 1n, p.max ?? 1000n));
    case 'decimal': {
      const places = p.places ?? 2;
      const lo = p.minNumber ?? 0;
      const hi = p.maxNumber ?? 1000;
      // Whole steps of the last place, so every value is exactly representable as text.
      const steps = Math.floor((hi - lo) * 10 ** places);
      const v = lo + Math.floor(rng() * (steps + 1)) / 10 ** places;
      return Math.min(v, hi).toFixed(places);
    }
    case 'boolean':
      return rng() < 0.5 ? '1' : '0';
    case 'date':
      return g.dateOf(randomDay(rng, p));
    case 'datetime':
      return `${g.dateOf(randomDay(rng, p))} ${g.timeOf(Math.floor(rng() * 86_400))}`;
    case 'time':
      return g.timeOf(Math.floor(rng() * 86_400));
    case 'uuid':
      return g.uuid(rng);
    case 'json':
      return g.jsonObject(rng);
    default:
      return null;
  }
}

const randomDay = (rng: g.Rng, p: ParsedSetting) => (p.fromDay ?? 0) + Math.floor(rng() * ((p.toDay ?? 0) - (p.fromDay ?? 0) + 1));

/** What the form should say about these settings before Insert (besides generation errors). */
export function mockNotes(table: MockTable, request: MockRequest, data: MockData): MockNote[] {
  const notes: MockNote[] = [];
  const { settings } = request;
  table.foreignKeys.forEach((f, n) => {
    const users = table.columns.filter((c, i) => c.foreignKey === n && settings[i].generator === 'foreignKey');
    if (!users.length) return;
    const parent = f.refSchema ? `${f.refSchema}.${f.refTable}` : f.refTable;
    const rows = usableParents(data, n).length;
    if (!rows) {
      const required = users.filter((c) => !c.nullable);
      if (required.length) notes.push({ tone: 'error', text: `${required.map((c) => c.name).join(', ')}: ${parent} has no rows to point to. Add rows there first.` });
      else notes.push({ tone: 'warning', text: `${users.map((c) => c.name).join(', ')}: ${parent} has no rows, so these stay NULL.` });
    } else if (data.parents[n]?.capped) {
      notes.push({ tone: 'info', text: `${users.map((c) => c.name).join(', ')}: ${parent} has more than ${rows.toLocaleString('en-US')} rows; values come from the first ${rows.toLocaleString('en-US')}.` });
    }
  });
  table.uniqueKeys.forEach((cols, k) => {
    if (data.existing[k]?.capped && cols.every((i) => settings[i].generator !== 'skip')) {
      notes.push({
        tone: 'warning',
        text: `${cols.map((i) => table.columns[i].name).join(', ')}: only the first ${data.existing[k].rows.length.toLocaleString('en-US')} existing values were read; a clash with a later one makes the database reject the insert, and nothing is kept.`,
      });
    }
  });
  table.columns.forEach((c, i) => {
    const gen = settings[i].generator;
    if ((c.info.kind === 'binary' || c.info.kind === 'other') && gen !== 'skip' && gen !== 'null') {
      notes.push({ tone: 'warning', text: `${c.name} (${c.type}): DB Deck doesn’t generate this type; the value is sent as text for the database to convert.` });
    }
    if (c.autoIncrement && gen !== 'skip') notes.push({ tone: 'warning', text: `${c.name} auto-increments; giving it values can fail (identity columns) or leave the sequence behind.` });
  });
  if (table.otherChecks) {
    notes.push({ tone: 'info', text: `The table has ${table.otherChecks} CHECK constraint${table.otherChecks === 1 ? '' : 's'} DB Deck doesn’t evaluate; rows that fail one make the insert fail, and nothing is kept.` });
  }
  return notes;
}

// Exact text for Oracle values node-oracledb's Thin mode turns into lossy JavaScript values (core.md rule 5).
// Pure: no oracledb, no `vscode`, no I/O, so it's tested in plain Node. oracleLib.ts installs `parseOracleDate`.

/**
 * A DATE / TIMESTAMP value as Oracle sent it, decoded from its bytes. Thin would make a JavaScript Date: milliseconds
 * only, the offset dropped, and year 1 read as 1901 (Date's two-digit-year rule). A plain branded object, not a class:
 * oracleLib.ts and the driver are separate bundles, so `instanceof` wouldn't match.
 */
export interface OracleDateTime {
  oracleDateTime: true;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Fraction of a second in nanoseconds; undefined for DATE and for timestamps sent without one (7 bytes). */
  nanos?: number;
  /** TIMESTAMP WITH TIME ZONE: the parts are UTC, and this is the value's own offset in minutes… */
  offset?: number;
  /** …or Oracle's number for a named region (America/New_York), which Thin has no table for. */
  region?: number;
  /** TIMESTAMP WITH LOCAL TIME ZONE: the parts are in the database time zone, this many minutes from UTC. */
  dbOffset?: number;
}

export function isOracleDateTime(value: unknown): value is OracleDateTime {
  return typeof value === 'object' && value !== null && (value as { oracleDateTime?: unknown }).oracleDateTime === true;
}

/** Oracle's date bytes (excess-100 century and year, 1-based time parts, nanoseconds, time zone bytes). */
export function decodeOracleDate(buf: Uint8Array, dbOffset?: number): OracleDateTime {
  const value: OracleDateTime = {
    oracleDateTime: true,
    year: (buf[0] - 100) * 100 + buf[1] - 100,
    month: buf[2],
    day: buf[3],
    hour: buf[4] - 1,
    minute: buf[5] - 1,
    second: buf[6] - 1,
  };
  if (buf.length >= 11) value.nanos = ((buf[7] << 24) >>> 0) + (buf[8] << 16) + (buf[9] << 8) + buf[10];
  if (buf.length >= 13) {
    // TZ_HOUR_OFFSET 20 and TZ_MINUTE_OFFSET 60; the high bit of the hour byte marks a region id instead.
    if (buf[11] & 0x80) value.region = ((buf[11] & 0x7f) << 6) | ((buf[12] & 0xfc) >> 2);
    else value.offset = (buf[11] - 20) * 60 + (buf[12] - 60);
  }
  if (dbOffset !== undefined) value.dbOffset = dbOffset;
  return value;
}

/**
 * Thin's decoder class, whose `parseOracleDate` every DATE / TIMESTAMP value goes through (rows, binds, JSON). Replaced
 * once with `decodeOracleDate`. TIMESTAMP WITH LOCAL TIME ZONE is sent in the database time zone, which Thin keeps in
 * `caps.dbTzOffset` (minutes); Thin refuses it when the database time zone is a region name, and so does this.
 */
export interface ThinBuffer {
  prototype: { parseOracleDate(buf: Buffer, useLocalTime?: boolean, useDbTz?: boolean): unknown };
}

const INSTALLED = Symbol.for('dbDeck.oracleExactDates');

export function installExactDates(base: ThinBuffer): void {
  const proto = base.prototype as ThinBuffer['prototype'] & { [INSTALLED]?: true; caps?: { dbTzOffset?: number | null; dbTzRegion?: string | null } };
  if (proto[INSTALLED]) return;
  proto[INSTALLED] = true;
  proto.parseOracleDate = function (this: typeof proto, buf: Buffer, _useLocalTime?: boolean, useDbTz?: boolean) {
    if (useDbTz && this.caps?.dbTzRegion) {
      throw new Error(`TIMESTAMP WITH LOCAL TIME ZONE can’t be read while the database time zone is a region name (${this.caps.dbTzRegion}).`);
    }
    return decodeOracleDate(buf, useDbTz ? (this.caps?.dbTzOffset ?? 0) : undefined);
  };
}

/** The column a value came from, to write it as Oracle does: DATE, TIMESTAMP(p), WITH (LOCAL) TIME ZONE. */
export type DateKind = 'date' | 'timestamp' | 'tz' | 'ltz';

/**
 * Oracle's own text (`TO_CHAR` with `YYYY-MM-DD HH24:MI:SS.FF<p>` and `TZH:TZM`): `precision` fraction digits, the
 * value's own offset for WITH TIME ZONE, the session time zone for WITH LOCAL TIME ZONE. A named-region value has no
 * name here (decision 11), so it's shown as UTC with " UTC". `sessionOffset` gives the session's offset in minutes at
 * a UTC instant (milliseconds), for LOCAL TIME ZONE.
 */
export function dateTimeText(v: OracleDateTime, kind: DateKind, precision: number | undefined, sessionOffset?: (utcMs: number) => number): string {
  let parts = { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second };
  let zone = '';
  if (kind === 'tz') {
    if (v.offset !== undefined) {
      parts = shiftMinutes(parts, v.offset);
      zone = ` ${offsetText(v.offset)}`;
    } else {
      zone = ' UTC';
    }
  } else if (kind === 'ltz') {
    const utc = shiftMinutes(parts, -(v.dbOffset ?? 0));
    parts = shiftMinutes(utc, sessionOffset ? sessionOffset(utcMillis(utc)) : 0);
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  const year = parts.year < 0 ? `-${String(-parts.year).padStart(4, '0')}` : String(parts.year).padStart(4, '0');
  let text = `${year}-${p2(parts.month)}-${p2(parts.day)} ${p2(parts.hour)}:${p2(parts.minute)}:${p2(parts.second)}`;
  const digits = kind === 'date' ? 0 : Math.max(0, Math.min(9, precision ?? 6));
  if (digits) text += `.${String(v.nanos ?? 0).padStart(9, '0').slice(0, digits)}`;
  return text + zone;
}

/** `+05:30`, `-03:00`, `+00:00` */
export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const m = Math.abs(minutes);
  return `${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * The parts moved by whole minutes, on the proleptic Gregorian calendar (days from civil, H. Hinnant), so years 1 and
 * 9999 and BC years work, unlike Date. Oracle uses the Julian calendar before 1582-10-15; only a time zone shift
 * across that date could differ, by the calendar change itself.
 */
function shiftMinutes(p: Parts, minutes: number): Parts {
  if (!minutes) return p;
  const total = daysFromCivil(p.year, p.month, p.day) * 1440 + p.hour * 60 + p.minute + minutes;
  const days = Math.floor(total / 1440);
  const rest = total - days * 1440;
  const { year, month, day } = civilFromDays(days);
  return { year, month, day, hour: Math.floor(rest / 60), minute: rest % 60, second: p.second };
}

function utcMillis(p: Parts): number {
  return (daysFromCivil(p.year, p.month, p.day) * 86400 + p.hour * 3600 + p.minute * 60 + p.second) * 1000;
}

function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z: number): { year: number; month: number; day: number } {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/**
 * The session time zone's offset at an instant, from Oracle's SESSIONTIMEZONE: a fixed `+06:30`, or a region name
 * (`Asia/Yangon`), looked up with Intl (VS Code's Node has the full time zone data). Unknown names count as UTC.
 */
export function sessionOffsetFor(zone: string): (utcMs: number) => number {
  const fixed = /^([+-])(\d{1,2}):(\d{2})$/.exec(zone.trim());
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3]);
    return () => (fixed[1] === '-' ? -minutes : minutes);
  }
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone.trim(), timeZoneName: 'longOffset' });
  } catch {
    return () => 0;
  }
  return (utcMs) => {
    const name = format.formatToParts(new Date(utcMs)).find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
    if (!m) return 0;
    const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === '-' ? -minutes : minutes;
  };
}

/**
 * An INTERVAL DAY TO SECOND as Oracle writes it: `+02 03:04:05.000000`. Thin doesn't say a column's day and fraction
 * digits (Oracle's TO_CHAR pads to them), so days get at least two digits and the fraction its exact nanoseconds,
 * trailing zeros dropped down to six digits (the default `DAY(2) TO SECOND(6)`): the same value, never rounded.
 */
export function intervalDsText(v: { days?: number; hours?: number; minutes?: number; seconds?: number; fseconds?: number }): string {
  const parts = [v.days ?? 0, v.hours ?? 0, v.minutes ?? 0, v.seconds ?? 0, v.fseconds ?? 0];
  const negative = parts.some((n) => n < 0);
  const [d, h, m, s, f] = parts.map(Math.abs);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const fraction = String(f).padStart(9, '0').replace(/0+$/, '').padEnd(6, '0');
  return `${negative ? '-' : '+'}${p2(d)} ${p2(h)}:${p2(m)}:${p2(s)}.${fraction}`;
}

/** An INTERVAL YEAR TO MONTH as Oracle writes it: `+02-03` (years get at least two digits, as for DAY TO SECOND). */
export function intervalYmText(v: { years?: number; months?: number }): string {
  const negative = (v.years ?? 0) < 0 || (v.months ?? 0) < 0;
  return `${negative ? '-' : '+'}${String(Math.abs(v.years ?? 0)).padStart(2, '0')}-${String(Math.abs(v.months ?? 0)).padStart(2, '0')}`;
}

/** BINARY_FLOAT arrives as a double; its shortest float32 text (3.4028235e+38, not 3.4028234663852886e+38). */
export function float32Text(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  for (let digits = 1; digits <= 9; digits++) {
    const text = value.toPrecision(digits);
    if (Math.fround(Number(text)) === value) return String(Number(text));
  }
  return String(value);
}

/** Oracle's NUMBER text with a leading zero (`0.1`, `-0.5` rather than `.1`, `-.5`; decision 14). Digits unchanged. */
export function numberText(text: string): string {
  return text.replace(/^(-?)\./, '$10.');
}

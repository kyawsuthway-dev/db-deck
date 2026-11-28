/**
 * Exact text for SQL Server values that tedious would turn into JS numbers or Dates (core rule 5):
 * decimal / numeric and money lose digits as numbers, datetimeoffset loses its offset, datetime2 / time keep
 * only milliseconds in a Date, and every date type would be a Date shown in some time zone. tedious's row parsers call `valueParser.readValue` through the module's exports at
 * every value, so wrapping that one export changes these types and leaves every other type to tedious.
 *
 * Checked against tedious 19.2.2 (pinned in package.json): each type is a 1-byte length (0 = NULL) followed by
 * its payload, as in tedious's own `readValue`. A short buffer throws tedious's `NotEnoughDataError`, so a row
 * split across network packets is read again once more data arrives, like tedious does.
 */

/** The parts of `tedious/lib/token/helpers` used here. */
export interface TediousHelpers {
  Result: new (value: unknown, offset: number) => { value: unknown; offset: number };
  NotEnoughDataError: new (byteCount: number) => Error;
}

/** The parts of `tedious/lib/value-parser` used here. */
export interface TediousValueParser {
  readValue: (buf: Buffer, offset: number, metadata: ValueMetadata, options: unknown) => { value: unknown; offset: number };
}

interface ValueMetadata {
  type: { name: string };
  scale?: number;
}

const WRAPPED = Symbol('dbDeckExactValues');

/** Wraps `readValue` once (tedious is loaded once per extension host, shared by every connection). */
export function installExactValues(parser: TediousValueParser, helpers: TediousHelpers): void {
  const original = parser.readValue as TediousValueParser['readValue'] & { [WRAPPED]?: true };
  if (original[WRAPPED]) return;
  const wrapped = Object.assign(
    (buf: Buffer, offset: number, metadata: ValueMetadata, options: unknown) =>
      readExact(buf, offset, metadata, helpers) ?? original(buf, offset, metadata, options),
    { [WRAPPED]: true as const },
  );
  parser.readValue = wrapped;
}

/** Undefined for types tedious keeps reading itself. */
function readExact(buf: Buffer, offset: number, metadata: ValueMetadata, helpers: TediousHelpers) {
  const name = metadata.type.name;
  const scale = metadata.scale ?? 7;
  // Fixed-length money types have no length byte.
  if (name === 'Money') return result(helpers, moneyText(bytes(buf, offset, 8, helpers)), offset + 8);
  if (name === 'SmallMoney') return result(helpers, moneyText(bytes(buf, offset, 4, helpers)), offset + 4);
  if (name === 'DateTime') return result(helpers, legacyDateTimeText(bytes(buf, offset, 8, helpers)), offset + 8);
  if (name === 'SmallDateTime') return result(helpers, legacyDateTimeText(bytes(buf, offset, 4, helpers)), offset + 4);
  if (!['MoneyN', 'DateTimeN', 'NumericN', 'DecimalN', 'Time', 'Date', 'DateTime2', 'DateTimeOffset'].includes(name)) return undefined;
  const length = bytes(buf, offset, 1, helpers)[0];
  const start = offset + 1;
  if (length === 0) return result(helpers, null, start);
  const data = bytes(buf, start, length, helpers);
  const end = start + length;
  switch (name) {
    case 'MoneyN':
      return result(helpers, moneyText(data), end);
    case 'DateTimeN':
      return result(helpers, legacyDateTimeText(data), end);
    case 'NumericN':
    case 'DecimalN':
      return result(helpers, decimalText(data[0] !== 1, unsignedLE(data.subarray(1)), scale), end);
    case 'Time':
      return result(helpers, timeText(unsignedLE(data), scale), end);
    case 'Date':
      return result(helpers, dateText(Number(unsignedLE(data))), end);
    case 'DateTime2': {
      const time = data.subarray(0, length - 3);
      return result(helpers, `${dateText(Number(unsignedLE(data.subarray(length - 3))))} ${timeText(unsignedLE(time), scale)}`, end);
    }
    default: {
      // DateTimeOffset: UTC time and date, then the offset in minutes; shown in its own offset, as SQL Server does.
      const time = data.subarray(0, length - 5);
      const days = Number(unsignedLE(data.subarray(length - 5, length - 2)));
      const minutes = data.readInt16LE(length - 2);
      return result(helpers, offsetText(days, unsignedLE(time), scale, minutes), end);
    }
  }
}

function bytes(buf: Buffer, offset: number, count: number, helpers: TediousHelpers): Buffer {
  if (buf.length < offset + count) throw new helpers.NotEnoughDataError(offset + count);
  return buf.subarray(offset, offset + count);
}

function result(helpers: TediousHelpers, value: string | null, offset: number) {
  return new helpers.Result(value, offset);
}

function unsignedLE(data: Buffer): bigint {
  let value = 0n;
  for (let i = data.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(data[i]);
  return value;
}

/** `-123.4500` from sign, magnitude and scale; trailing zeros kept, as SQL Server shows them. */
export function decimalText(negative: boolean, magnitude: bigint, scale: number): string {
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative && magnitude !== 0n ? '-' : ''}${whole}${fraction}`;
}

/** money (8 bytes: high int32, then low uint32) or smallmoney (4 bytes, int32), in ten-thousandths. */
export function moneyText(data: Buffer): string {
  const value = data.length === 4 ? BigInt(data.readInt32LE(0)) : (BigInt(data.readInt32LE(0)) << 32n) | BigInt(data.readUInt32LE(4));
  return decimalText(value < 0n, value < 0n ? -value : value, 4);
}

/** Days from 0001-01-01 to 1900-01-01, where datetime and smalldatetime count from. */
const DAYS_TO_1900 = 693_595;

/**
 * datetime (8 bytes: int32 days since 1900, uint32 1/300 seconds) as `YYYY-MM-DD HH:MM:SS.mmm`, rounded to
 * milliseconds the way SQL Server shows it (.000 / .003 / .007); smalldatetime (4 bytes: uint16 days, uint16
 * minutes) as `YYYY-MM-DD HH:MM:SS`.
 */
export function legacyDateTimeText(data: Buffer): string {
  if (data.length === 4) {
    const minutes = BigInt(data.readUInt16LE(2));
    return `${dateText(DAYS_TO_1900 + data.readUInt16LE(0))} ${timeText(minutes * 60n, 0)}`;
  }
  const ms = BigInt(Math.round((data.readUInt32LE(4) * 10) / 3));
  return `${dateText(DAYS_TO_1900 + data.readInt32LE(0))} ${timeText(ms, 3)}`;
}

const TICKS_PER_DAY = (scale: number) => 86_400n * 10n ** BigInt(scale);

/** `HH:MM:SS.fffffff` from 10^-scale-second ticks, with exactly `scale` fraction digits. */
export function timeText(ticks: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  const seconds = ticks / unit;
  const fraction = scale ? `.${(ticks % unit).toString().padStart(scale, '0')}` : '';
  const pad = (n: bigint) => n.toString().padStart(2, '0');
  return `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}${fraction}`;
}

/** `YYYY-MM-DD` from days since 0001-01-01 (proleptic Gregorian, like SQL Server). */
export function dateText(days: number): string {
  // Howard Hinnant's civil_from_days, shifted from 1970-01-01 to 0001-01-01 (719,162 days earlier).
  const z = days - 719_162 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD HH:MM:SS.fffffff +HH:MM`: the stored UTC moment moved to its own offset. */
export function offsetText(utcDays: number, utcTicks: bigint, scale: number, offsetMinutes: number): string {
  const perDay = TICKS_PER_DAY(scale);
  const offsetTicks = BigInt(offsetMinutes) * 60n * 10n ** BigInt(scale);
  let total = BigInt(utcDays) * perDay + utcTicks + offsetTicks;
  const days = total / perDay;
  total -= days * perDay;
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${dateText(Number(days))} ${timeText(total, scale)} ${offset}`;
}

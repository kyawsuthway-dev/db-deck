// A streaming CSV parser (RFC 4180, as Excel and DB Deck's own export write it). No `vscode`, no I/O, so it
// can be tested in plain Node. Text goes in in chunks; records come out with the line they start on.
//
//   - Fields are separated by `delimiter`; records by \n, \r\n or a lone \r.
//   - A quoted field may contain the delimiter, newlines and "" (an escaped quote).
//   - With `nullEmpty`, an empty unquoted field is null; a quoted "" is always the empty string. That's the
//     reverse of DB Deck's CSV export (NULL → empty field, '' → ""), so the two round-trip.
//   - Blank lines are skipped. A stray quote inside an unquoted field, or text after a closing quote, is kept
//     as written (lenient, like Excel).

export interface CsvRecord {
  /** 1-based line the record starts on. */
  line: number;
  fields: (string | null)[];
}

export interface CsvOptions {
  delimiter: string;
  nullEmpty: boolean;
}

export class CsvError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** Delimiters DB Deck detects and offers. */
export const DELIMITERS = [',', ';', '\t', '|'] as const;

export class CsvParser {
  private fields: (string | null)[] = [];
  private field = '';
  /** The current field started with a quote (so an empty one is '' even with nullEmpty). */
  private quotedField = false;
  /** Inside quotes, and whether the last character was a quote (closing, or the first of ""). */
  private inQuotes = false;
  private quoteSeen = false;
  /** The last chunk ended with \r: a \n starting the next chunk belongs to it. */
  private pendingCr = false;
  private line = 1;
  private recordLine = 1;
  private started = false;

  constructor(private readonly options: CsvOptions) {}

  push(chunk: string): CsvRecord[] {
    const out: CsvRecord[] = [];
    const d = this.options.delimiter;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.pendingCr) {
        this.pendingCr = false;
        if (c === '\n') continue;
      }
      if (this.inQuotes) {
        if (this.quoteSeen) {
          this.quoteSeen = false;
          if (c === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false; // that quote closed the field; handle c below as unquoted
        } else if (c === '"') {
          this.quoteSeen = true;
          continue;
        } else {
          if (c === '\n' || c === '\r') {
            this.line++;
            if (c === '\r') {
              if (chunk[i + 1] === '\n') i++;
              else if (i + 1 === chunk.length) this.pendingCr = true;
              this.field += '\n';
              continue;
            }
          }
          this.field += c;
          continue;
        }
      }
      if (c === d) {
        this.started = true;
        this.endField();
      } else if (c === '\n' || c === '\r') {
        if (c === '\r') {
          if (chunk[i + 1] === '\n') i++;
          else if (i + 1 === chunk.length) this.pendingCr = true;
        }
        const record = this.endRecord();
        if (record) out.push(record);
        this.line++;
        this.recordLine = this.line;
      } else if (c === '"' && this.field === '' && !this.quotedField) {
        this.inQuotes = true;
        this.quotedField = true;
        this.started = true;
      } else {
        this.started = true;
        this.field += c;
      }
    }
    return out;
  }

  /** The last record (a file needn't end with a newline). Throws CsvError for an unclosed quote. */
  end(): CsvRecord[] {
    if (this.inQuotes && !this.quoteSeen) throw new CsvError(this.recordLine, `Line ${this.recordLine}: a quoted field is never closed.`);
    this.inQuotes = false;
    const record = this.endRecord();
    return record ? [record] : [];
  }

  private endField(): void {
    const empty = this.field === '' && !this.quotedField;
    this.fields.push(empty && this.options.nullEmpty ? null : this.field);
    this.field = '';
    this.quotedField = false;
    this.quoteSeen = false;
  }

  private endRecord(): CsvRecord | undefined {
    if (!this.started && this.fields.length === 0 && this.field === '') return undefined; // a blank line
    this.endField();
    const record = { line: this.recordLine, fields: this.fields };
    this.fields = [];
    this.started = false;
    return record;
  }
}

/** Parses a whole text (tests, previews). */
export function parseCsv(text: string, options: CsvOptions): CsvRecord[] {
  const parser = new CsvParser(options);
  return [...parser.push(text), ...parser.end()];
}

/**
 * The delimiter that splits the first lines most consistently (same number of fields, more than one),
 * ignoring delimiters inside quotes. Falls back to a comma.
 */
export function detectDelimiter(sample: string): string {
  let best: { delimiter: string; score: number } = { delimiter: ',', score: 0 };
  for (const delimiter of DELIMITERS) {
    let records: CsvRecord[];
    try {
      const parser = new CsvParser({ delimiter, nullEmpty: false });
      records = parser.push(sample).slice(0, 20);
    } catch {
      continue;
    }
    if (records.length === 0) continue;
    const counts = records.map((r) => r.fields.length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((n) => n === first).length / counts.length;
    const score = consistent * 100 + Math.min(first, 50);
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

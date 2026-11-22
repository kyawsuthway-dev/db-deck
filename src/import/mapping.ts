// Which CSV column goes into which table column, and what's wrong with a mapping. No `vscode`, no I/O.
import type { ColumnInfo } from '../types';
import { isBinaryType } from '../export/formats';

/** A table column the CSV can fill (binary and generated columns aren't offered). */
export function importTargets(columns: ColumnInfo[]): ColumnInfo[] {
  return columns.filter((c) => !c.generated && !isBinaryType(c.type));
}

/** Header names compared loosely: case, `_`, `-`, spaces and a BOM don't matter. */
export function normalizeName(name: string): string {
  return name.replace(/^﻿/, '').toLowerCase().replace(/[\s_\-]+/g, '');
}

/**
 * The table column for each CSV column: by header name, or by position without a header. `null` skips.
 * A table column is used at most once (the first CSV column that matches it).
 */
export function autoMap(csvColumns: number, headers: string[] | undefined, targets: ColumnInfo[]): (string | null)[] {
  const used = new Set<string>();
  const result: (string | null)[] = [];
  for (let i = 0; i < csvColumns; i++) {
    let match: ColumnInfo | undefined;
    if (headers) {
      const wanted = normalizeName(headers[i] ?? '');
      match = targets.find((t) => !used.has(t.name) && normalizeName(t.name) === wanted);
    } else {
      match = targets[i] && !used.has(targets[i].name) ? targets[i] : undefined;
    }
    if (match) used.add(match.name);
    result.push(match ? match.name : null);
  }
  return result;
}

export interface MappingCheck {
  /** Block the import. */
  errors: string[];
  /** Shown, but the database decides (it may have triggers or defaults DB Deck can't see). */
  warnings: string[];
}

export function checkMapping(mapping: (string | null)[], targets: ColumnInfo[]): MappingCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const names = new Set(targets.map((t) => t.name));
  const mapped = mapping.filter((m): m is string => m !== null);
  if (!mapped.length) errors.push('Map at least one CSV column to a table column.');
  const unknown = mapped.filter((m) => !names.has(m));
  if (unknown.length) errors.push(`Unknown table column: ${unknown.join(', ')}.`);
  const seen = new Set<string>();
  for (const m of mapped) {
    if (seen.has(m)) errors.push(`Two CSV columns go into ${m}. Map one of them to another column or Skip.`);
    seen.add(m);
  }
  for (const t of targets) {
    if (seen.has(t.name)) continue;
    if (!t.nullable && !t.hasDefault) warnings.push(`${t.name} is required (NOT NULL, no default) but nothing is mapped to it.`);
  }
  return { errors: [...new Set(errors)], warnings };
}

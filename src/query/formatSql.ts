// Format SQL for the editor's Format Document / Format Selection. Pure: no vscode, no I/O.
// Only the dialects DB Deck supports are imported, which keeps sql-formatter's share of the bundle small.
import { formatDialect, mysql, plsql, postgresql, sql, sqlite, transactsql, type DialectOptions } from 'sql-formatter';
import type { FormatLanguage } from '../drivers';

const DIALECTS: Record<FormatLanguage | 'sql', DialectOptions> = { postgresql, mysql, sqlite, transactsql, plsql, sql };

/**
 * Reformats whitespace and line breaks only; keywords keep the case they were typed in.
 * Throws when sql-formatter can't parse the text, so the caller can leave it unchanged.
 */
export function formatSql(text: string, language: FormatLanguage | 'sql', options: { tabWidth: number; useTabs: boolean }): string {
  return formatDialect(text, {
    dialect: DIALECTS[language],
    tabWidth: options.tabWidth,
    useTabs: options.useTabs,
    keywordCase: 'preserve',
  });
}

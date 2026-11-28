// What a SQL script file contains, before it runs: its statements with line numbers, and whether it
// manages its own transactions or changes the schema. No `vscode`, no I/O, so it can be tested in plain Node.
import { splitBatches, splitSqlRanges, stripLeadingComments } from '../query/splitSql';
import { codeOnly } from '../tools/plan';
import type { DbType } from '../types';

/** A statement, or for SQL Server a `GO` batch (several statements sent as one request). */
export interface ScriptStatement {
  sql: string;
  /** 1-based line where the statement's code starts, for "failed at line N". */
  line: number;
}

export interface ScriptAnalysis {
  statements: ScriptStatement[];
  /** BEGIN / COMMIT / ROLLBACK / START TRANSACTION / SAVEPOINT in the file: DB Deck mustn't wrap it. */
  ownTransactions: boolean;
  /** CREATE / ALTER / DROP / RENAME / TRUNCATE, which some databases commit on their own. */
  schemaChanges: boolean;
  /** A MySQL DELIMITER line: DB Deck's splitter doesn't support it. */
  delimiter: boolean;
}

const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION|SAVEPOINT|RELEASE)\b/i;
const SCHEMA_CHANGE = /^(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i;
/** T-SQL transaction control anywhere in a batch (BEGIN … END and BEGIN TRY blocks aren't). */
const TSQL_TRANSACTION = /\b(BEGIN\s+(DISTRIBUTED\s+)?TRAN(SACTION)?|COMMIT|ROLLBACK|SAVE\s+TRAN(SACTION)?)\b/i;
const TSQL_SCHEMA_CHANGE = /\b(CREATE|ALTER|DROP|TRUNCATE)\b|\bsp_rename\b/i;

export function analyzeScript(text: string, dialect: DbType): ScriptAnalysis {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const statements: ScriptStatement[] = [];
  let ownTransactions = false;
  let schemaChanges = false;
  if (dialect === 'sqlserver') {
    // A batch is what SQL Server runs as one request: its variables and temp tables live for the batch.
    for (const batch of splitBatches(text)) {
      const code = codeOnly(batch.sql, dialect);
      if (TSQL_TRANSACTION.test(code)) ownTransactions = true;
      if (TSQL_SCHEMA_CHANGE.test(code)) schemaChanges = true;
      for (let i = 0; i < batch.repeat; i++) statements.push({ sql: batch.sql, line: lineOf(batch.start) });
    }
    return { statements, ownTransactions, schemaChanges, delimiter: false };
  }
  for (const range of splitSqlRanges(text, dialect)) {
    const code = stripLeadingComments(range.text).trim();
    // A comment-only tail or a stray `;` isn't a statement.
    if (!code || code === ';') continue;
    statements.push({ sql: range.text, line: lineOf(range.codeStart) });
    if (TRANSACTION_CONTROL.test(code)) ownTransactions = true;
    if (SCHEMA_CHANGE.test(code)) schemaChanges = true;
  }
  return { statements, ownTransactions, schemaChanges, delimiter: dialect === 'mysql' && /^[ \t]*DELIMITER[ \t]+\S/im.test(text) };
}

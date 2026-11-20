import { Client, type CustomTypesConfig, type QueryResult } from 'pg';
import { splitSql } from '../query/splitSql';
import type { ColumnInfo, ConnectionConfig, Driver, FilterOperator, SslMode, StatementResult, TableInfo, TablePage } from '../types';
import { buildPageQuery, FILTER_OPERATORS, filterCondition, identifierFor, quoteIdent, runEach } from './common';

const BOOL_OID = 16;

/** Keep PostgreSQL's own text form for every value (exact numerics, timestamps as stored), except booleans. */
const textTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number) =>
    oid === BOOL_OID ? (v: string) => (v === 't' ? 'true' : 'false') : (v: string) => v) as CustomTypesConfig['getTypeParser'],
};

export class PostgresDriver implements Driver {
  private client?: Client;
  private connecting?: Promise<Client>;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
  ) {}

  async connect(): Promise<void> {
    await this.getClient();
  }

  async listTables(): Promise<TableInfo[]> {
    const client = await this.getClient();
    const { rows } = await client.query<{ schema: string; name: string; type: string }>(
      `SELECT table_schema AS schema, table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       UNION ALL
       SELECT schemaname, matviewname, 'VIEW' FROM pg_matviews`,
    );
    return rows
      .map((r): TableInfo => ({
        name: r.name,
        schema: r.schema === 'public' ? undefined : r.schema,
        kind: r.type === 'VIEW' ? 'view' : 'table',
      }))
      .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name));
  }

  async listColumns(table: TableInfo): Promise<ColumnInfo[]> {
    const client = await this.getClient();
    const { rows } = await client.query<{ name: string; type: string; nullable: string; pk: string }>(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              COALESCE(a.attnum = ANY (i.indkey), false) AS pk
         FROM pg_attribute a
         LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [qualifiedName(table)],
    );
    return rows.map((r) => ({ name: r.name, type: r.type, nullable: r.nullable === 'true', primaryKey: r.pk === 'true' }));
  }

  async query(sql: string): Promise<StatementResult[]> {
    const client = await this.getClient();
    return runEach(splitSql(sql, 'postgres'), async (statement) => {
      const res: unknown = await client.query({ text: statement, rowMode: 'array' });
      // If the splitter ever leaves two statements together, pg returns an array; show the last.
      const r = (Array.isArray(res) ? res[res.length - 1] : res) as QueryResult<unknown[]>;
      const columns = r.fields.map((f) => f.name);
      return { columns, rows: r.rows, affectedRows: columns.length === 0 ? (r.rowCount ?? undefined) : undefined };
    });
  }

  previewSql(table: TableInfo, page: TablePage): string {
    return buildPageQuery(qualifiedName(table), '"', page);
  }

  async selectPage(table: TableInfo, page: TablePage, where?: string): Promise<StatementResult> {
    const sql = buildPageQuery(qualifiedName(table), '"', page, filterCondition(where, 'postgres'));
    const client = await this.getClient();
    const [result] = await runEach([sql], async (statement) => {
      const r = await client.query<unknown[]>({ text: statement, rowMode: 'array' });
      return { columns: r.fields.map((f) => f.name), rows: r.rows };
    });
    return result;
  }

  /** Unquoted names fold to lowercase in PostgreSQL, so anything with uppercase must be quoted. */
  filterIdentifier(name: string): string {
    return identifierFor(name, '"', /^[a-z_][a-z0-9_]*$/);
  }

  filterOperators(): FilterOperator[] {
    const likeAt = FILTER_OPERATORS.findIndex((o) => o.label === 'NOT LIKE') + 1;
    return [
      ...FILTER_OPERATORS.slice(0, likeAt),
      { label: 'ILIKE', insert: 'ILIKE ' },
      { label: 'NOT ILIKE', insert: 'NOT ILIKE ' },
      ...FILTER_OPERATORS.slice(likeAt),
    ];
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.end();
  }

  /** One long-lived client, so session state (transactions, SET) carries across runs. Reopened if it drops. */
  private getClient(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const c = this.config;
    const client = new Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password: this.password,
      database: c.database || 'postgres',
      ssl: sslOption(c.ssl),
      connectionTimeoutMillis: 10_000,
      application_name: 'DB Deck',
      types: textTypes,
    });
    const drop = () => {
      if (this.client === client) this.client = undefined;
    };
    client.on('error', drop);
    client.on('end', drop);
    await client.connect();
    this.client = client;
    return client;
  }
}

function qualifiedName(table: TableInfo): string {
  return `${quoteIdent(table.schema ?? 'public', '"')}.${quoteIdent(table.name, '"')}`;
}

function sslOption(mode: SslMode | undefined) {
  if (mode === 'require') return true;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return false;
}

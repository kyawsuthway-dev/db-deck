import type { ConnectionConfig, DbType, Driver } from '../types';
import { MysqlDriver } from './mysql';
import { PostgresDriver } from './postgres';
import { SqliteDriver } from './sqlite';

/** To add a database: write a Driver in this folder, add its DbType, and add it here and to DB_KINDS. */
export function createDriver(config: ConnectionConfig, password: string | undefined): Driver {
  switch (config.type) {
    case 'sqlite':
      if (!config.filePath) throw new Error('No SQLite file chosen for this connection.');
      return new SqliteDriver(config.filePath);
    case 'postgres':
      return new PostgresDriver(config, password);
    case 'mysql':
      return new MysqlDriver(config, password);
  }
}

/** Choices shown in the add-connection wizard. Several kinds can share one driver. */
export interface DbKind {
  label: string;
  type: DbType;
  defaultPort?: number;
  defaultUser?: string;
  defaultDatabase?: string;
}

export const DB_KINDS: DbKind[] = [
  { label: 'SQLite', type: 'sqlite' },
  { label: 'PostgreSQL', type: 'postgres', defaultPort: 5432, defaultUser: 'postgres', defaultDatabase: 'postgres' },
  { label: 'MySQL', type: 'mysql', defaultPort: 3306, defaultUser: 'root' },
  { label: 'MariaDB', type: 'mysql', defaultPort: 3306, defaultUser: 'root' },
];

export function typeLabel(type: DbType): string {
  return DB_KINDS.find((k) => k.type === type)?.label ?? type;
}

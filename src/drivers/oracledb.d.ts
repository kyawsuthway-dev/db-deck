// The part of node-oracledb 26.0.0 (Thin mode, pinned) that DB Deck uses. The package ships no types, and
// @types/oracledb would be another dependency for a few calls; anything not declared here isn't used.

declare module 'oracledb' {
  namespace oracledb {
    /** A database type: one of the library's DB_TYPE_* constant objects (compared by identity). */
    interface DbType {
      readonly num: number;
      readonly name: string;
    }

    interface Metadata {
      name: string;
      dbType?: DbType;
      dbTypeName?: string;
      precision?: number;
      scale?: number;
      nullable?: boolean;
    }

    interface FetchTypeResult {
      type: number | DbType;
      converter?: (value: unknown) => unknown;
    }

    interface Result {
      metaData?: Metadata[];
      rows?: unknown[][];
      rowsAffected?: number;
      outBinds?: Record<string, unknown>;
      /** Cursors returned with DBMS_SQL.RETURN_RESULT, as row arrays (with `metaData` lost). */
      implicitResults?: (unknown[][] | ResultSet)[];
      resultSet?: ResultSet;
    }

    interface ResultSet {
      metaData: Metadata[];
      getRows(count: number): Promise<unknown[][]>;
      close(): Promise<void>;
    }

    interface ExecuteOptions {
      outFormat?: number;
      autoCommit?: boolean;
      fetchTypeHandler?: (metadata: Metadata) => FetchTypeResult | undefined;
      resultSet?: boolean;
      maxRows?: number;
    }

    interface BindDefinition {
      dir?: number;
      type?: number;
      val?: unknown;
      maxSize?: number;
      maxArraySize?: number;
    }

    interface Connection {
      oracleServerVersion: number;
      oracleServerVersionString: string;
      callTimeout: number;
      execute(sql: string, binds?: unknown[] | Record<string, unknown>, options?: ExecuteOptions): Promise<Result>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
      close(): Promise<void>;
      isHealthy(): boolean;
    }

    interface ConnectionAttributes {
      user?: string;
      password?: string;
      connectString: string;
      privilege?: number;
      connectTimeout?: number;
      sslServerDNMatch?: boolean;
      expireTime?: number;
    }

    const thin: boolean;
    const OUT_FORMAT_ARRAY: number;
    const STRING: number;
    const BUFFER: number;
    const BIND_IN: number;
    const BIND_OUT: number;
    const BIND_INOUT: number;
    const NUMBER: number;

    const DB_TYPE_NUMBER: DbType;
    const DB_TYPE_BINARY_FLOAT: DbType;
    const DB_TYPE_BINARY_DOUBLE: DbType;
    const DB_TYPE_BINARY_INTEGER: DbType;
    const DB_TYPE_DATE: DbType;
    const DB_TYPE_TIMESTAMP: DbType;
    const DB_TYPE_TIMESTAMP_TZ: DbType;
    const DB_TYPE_TIMESTAMP_LTZ: DbType;
    const DB_TYPE_INTERVAL_DS: DbType;
    const DB_TYPE_INTERVAL_YM: DbType;
    const DB_TYPE_CLOB: DbType;
    const DB_TYPE_NCLOB: DbType;
    const DB_TYPE_BLOB: DbType;
    const DB_TYPE_LONG: DbType;
    const DB_TYPE_LONG_RAW: DbType;
    const DB_TYPE_JSON: DbType;

    const SYSDBA: number;
    const SYSOPER: number;
    const SYSBACKUP: number;
    const SYSDG: number;
    const SYSKM: number;
    const SYSRAC: number;

    function getConnection(attributes: ConnectionAttributes): Promise<Connection>;
  }
  export = oracledb;
}

declare module 'oracledb/lib/impl/datahandlers/buffer.js' {
  /** The buffer class every Thin decoder extends; DB Deck replaces `parseOracleDate` on its prototype (oracleValues.ts). */
  export const BaseBuffer: { prototype: { parseOracleDate(buf: Buffer, useLocalTime?: boolean, useDbTz?: boolean): unknown } };
}

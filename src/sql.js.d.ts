declare module 'sql.js' {
  interface QueryExecResult {
    columns: string[];
    values: Array<Array<unknown>>;
  }

  interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    run(params?: unknown[]): void;
    free(): void;
  }

  interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}

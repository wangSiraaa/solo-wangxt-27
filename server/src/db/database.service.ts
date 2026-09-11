import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

export type Q = (sql: string, params?: any[]) => Promise<any[]>;

/**
 * PGlite = 官方 PostgreSQL 的 WASM 构建，单文件嵌入式运行，
 * 数据持久化在 PGDATA 目录（默认 ./pgdata）。
 * 单连接串行执行；跨请求的正确性由“条件 UPDATE + 事务”保证，
 * 同样的写法在多连接的 PostgreSQL 服务器上依然成立。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: PGlite;

  async onModuleInit() {
    const dir = process.env.PGDATA || path.join(process.cwd(), 'pgdata');
    this.db = new PGlite(dir);
    await this.db.waitReady;
    const candidates = [
      path.join(__dirname, '..', 'schema.sql'),      // dist/
      path.join(__dirname, '..', '..', 'src', 'schema.sql'), // 源码目录回退
    ];
    const schemaPath = candidates.find((p) => fs.existsSync(p));
    if (!schemaPath) throw new Error('schema.sql 未找到');
    await this.db.exec(fs.readFileSync(schemaPath, 'utf8'));
  }

  async onModuleDestroy() {
    await this.db.close();
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const r = await this.db.query(sql, params);
    return r.rows as T[];
  }

  /** 在事务中执行；fn 抛错则整体回滚 */
  async transaction<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      fn(async (sql, params = []) => {
        const r = await tx.query(sql, params);
        return r.rows;
      }),
    );
  }
}

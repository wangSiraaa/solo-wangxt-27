import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { DatabaseService, Q } from '../db/database.service';
import { D } from '../common/units';

/**
 * 库存核心：所有质量变动都走“条件 UPDATE + 台账插入”，
 * 条件 UPDATE 是原子的——两人同时取样时，数据库保证只有
 * 余量足够的请求能扣减成功，绝不出现负库存或超发。
 */
@Injectable()
export class InventoryService {
  constructor(private db: DatabaseService) {}

  async getAvailable(sampleId: string): Promise<Decimal> {
    const rows = await this.db.query(
      'SELECT available_mass_g FROM samples WHERE id = $1',
      [sampleId],
    );
    if (!rows.length) throw new NotFoundException(`样品不存在: ${sampleId}`);
    return D(rows[0].available_mass_g);
  }

  /** 扣减可用量；余量不足时抛 409 并回滚整个事务 */
  async consume(
    q: Q,
    sampleId: string,
    massG: Decimal,
    reason: string,
    operationId: string | null,
    weighingId: string | null = null,
  ): Promise<string> {
    const rows = await q(
      `UPDATE samples
          SET available_mass_g = available_mass_g - $1::numeric
        WHERE id = $2 AND available_mass_g >= $1::numeric
        RETURNING available_mass_g`,
      [massG.toString(), sampleId],
    );
    if (!rows.length) {
      const cur = await q('SELECT available_mass_g FROM samples WHERE id = $1', [sampleId]);
      if (!cur.length) throw new NotFoundException(`样品不存在: ${sampleId}`);
      throw new ConflictException({
        message: '余量不足，扣减被拒绝（库存未变动）',
        sampleId,
        requestedG: massG.toString(),
        availableG: cur[0].available_mass_g,
      });
    }
    await q(
      `INSERT INTO material_ledger (sample_id, delta_g, reason, operation_id, weighing_id)
       VALUES ($1, $2::numeric, $3, $4, $5)`,
      [sampleId, massG.neg().toString(), reason, operationId, weighingId],
    );
    return rows[0].available_mass_g;
  }

  /** 增加可用量（混样/分样产出、入库、更正回冲） */
  async add(
    q: Q,
    sampleId: string,
    massG: Decimal,
    reason: string,
    operationId: string | null,
    weighingId: string | null = null,
  ): Promise<string> {
    const rows = await q(
      `UPDATE samples SET available_mass_g = available_mass_g + $1::numeric
        WHERE id = $2 RETURNING available_mass_g`,
      [massG.toString(), sampleId],
    );
    if (!rows.length) throw new NotFoundException(`样品不存在: ${sampleId}`);
    await q(
      `INSERT INTO material_ledger (sample_id, delta_g, reason, operation_id, weighing_id)
       VALUES ($1, $2::numeric, $3, $4, $5)`,
      [sampleId, massG.toString(), reason, operationId, weighingId],
    );
    return rows[0].available_mass_g;
  }

  /** 台账合计必须与现存量一致（对账用） */
  async reconcile(sampleId: string) {
    const rows = await this.db.query(
      `SELECT
         (SELECT available_mass_g FROM samples WHERE id = $1) AS available,
         COALESCE((SELECT SUM(delta_g) FROM material_ledger WHERE sample_id = $1), 0) AS ledger_sum`,
      [sampleId],
    );
    const available = D(rows[0].available);
    const ledgerSum = D(rows[0].ledger_sum);
    return { sampleId, availableG: available.toString(), ledgerSumG: ledgerSum.toString(), consistent: available.eq(ledgerSum) };
  }
}

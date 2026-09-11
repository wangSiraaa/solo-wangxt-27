import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DatabaseService } from '../db/database.service';
import { D, massToG } from '../common/units';
import { InventoryService } from './inventory.service';

const req = (cond: any, msg: string) => {
  if (!cond) throw new BadRequestException(msg);
};

/** 称量对库存的影响方向 */
const effect = (kind: string, netG: Decimal) => (kind === 'INTAKE' ? netG : netG.neg());

@Injectable()
export class WeighingsService {
  constructor(
    private db: DatabaseService,
    private inv: InventoryService,
  ) {}

  /** 创建称量草稿；同一 idempotencyKey 重复提交返回原记录，不产生第二笔 */
  async create(dto: {
    idempotencyKey: string;
    sampleId: string;
    kind: 'INTAKE' | 'CONSUME';
    value: string;
    unit: string;
    tareG?: string;
    reason?: string;
  }) {
    req(dto.idempotencyKey && dto.sampleId && dto.kind && dto.value && dto.unit,
      'idempotencyKey/sampleId/kind/value/unit 必填');
    req(['INTAKE', 'CONSUME'].includes(dto.kind), 'kind 只能是 INTAKE 或 CONSUME');
    const netG = massToG(dto.value, dto.unit);
    req(netG.gt(0), '称量净值必须大于 0');

    return this.db.transaction(async (q) => {
      const dup = await q('SELECT * FROM weighings WHERE idempotency_key = $1', [dto.idempotencyKey]);
      if (dup.length) return { weighing: this.view(dup[0]), replayed: true };

      const exists = await q('SELECT id FROM samples WHERE id = $1', [dto.sampleId]);
      if (!exists.length) throw new BadRequestException(`样品不存在: ${dto.sampleId}`);
      const id = randomUUID();
      await q(
        `INSERT INTO weighings (id, idempotency_key, sample_id, kind, input_value, input_unit, tare_g, net_g, reason)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,$7::numeric,$8::numeric,$9)`,
        [id, dto.idempotencyKey, dto.sampleId, dto.kind, dto.value, dto.unit,
         dto.tareG ?? '0', netG.toString(), dto.reason ?? null],
      );
      const rows = await q('SELECT * FROM weighings WHERE id = $1', [id]);
      return { weighing: this.view(rows[0]), replayed: false };
    });
  }

  /** 确认称量：此刻才真正扣减/增加库存；重复确认被拒绝 */
  async confirm(id: string) {
    return this.db.transaction(async (q) => {
      const rows = await q('SELECT * FROM weighings WHERE id = $1', [id]);
      if (!rows.length) throw new NotFoundException(`称量记录不存在: ${id}`);
      const w = rows[0];
      if (w.status === 'CONFIRMED') {
        throw new ConflictException('该称量已确认；确认后的称量只能通过更正记录调整');
      }
      if (w.status === 'CORRECTED') {
        throw new ConflictException('该称量已被更正记录取代，不能再确认');
      }
      const net = D(w.net_g);
      if (w.kind === 'CONSUME') {
        await this.inv.consume(q, w.sample_id, net, '称量确认扣减', null, id);
      } else {
        await this.inv.add(q, w.sample_id, net, '称量确认入库', null, id);
      }
      const updated = await q(
        `UPDATE weighings SET status = 'CONFIRMED' WHERE id = $1 RETURNING *`, [id],
      );
      return { weighing: this.view(updated[0]) };
    });
  }

  /**
   * 更正已确认的称量：生成一条新的 CONFIRMED 记录（corrects_id 指向原记录），
   * 按差额调整库存；原记录标记为 CORRECTED，历史不可篡改。
   */
  async correct(id: string, dto: { idempotencyKey: string; value: string; unit: string; reason: string }) {
    req(dto.idempotencyKey && dto.value && dto.unit && dto.reason, 'idempotencyKey/value/unit/reason 必填');
    const newNet = massToG(dto.value, dto.unit);
    req(newNet.gt(0), '更正后的净值必须大于 0');

    return this.db.transaction(async (q) => {
      const dup = await q('SELECT * FROM weighings WHERE idempotency_key = $1', [dto.idempotencyKey]);
      if (dup.length) return { weighing: this.view(dup[0]), replayed: true };

      const rows = await q('SELECT * FROM weighings WHERE id = $1', [id]);
      if (!rows.length) throw new NotFoundException(`称量记录不存在: ${id}`);
      const old = rows[0];
      if (old.status !== 'CONFIRMED') {
        throw new ConflictException('只有已确认的称量才能更正（草稿请直接作废重建）');
      }
      const adjustment = effect(old.kind, newNet).minus(effect(old.kind, D(old.net_g)));
      const cid = randomUUID();
      if (adjustment.isNeg()) {
        await this.inv.consume(q, old.sample_id, adjustment.abs(), `称量更正回冲: ${dto.reason}`, null, cid);
      } else if (!adjustment.isZero()) {
        await this.inv.add(q, old.sample_id, adjustment, `称量更正补记: ${dto.reason}`, null, cid);
      }
      await q(
        `INSERT INTO weighings (id, idempotency_key, sample_id, kind, input_value, input_unit, tare_g, net_g, status, corrects_id, reason)
         VALUES ($1,$2,$3,$4,$5::numeric,$6,0,$7::numeric,'CONFIRMED',$8,$9)`,
        [cid, dto.idempotencyKey, old.sample_id, old.kind, dto.value, dto.unit,
         newNet.toString(), id, dto.reason],
      );
      await q(`UPDATE weighings SET status = 'CORRECTED' WHERE id = $1`, [id]);
      const created = await q('SELECT * FROM weighings WHERE id = $1', [cid]);
      return {
        weighing: this.view(created[0]),
        correctedId: id,
        adjustmentG: adjustment.toString(),
        replayed: false,
      };
    });
  }

  async listForSample(sampleId: string) {
    const rows = await this.db.query(
      'SELECT * FROM weighings WHERE sample_id = $1 ORDER BY created_at, id', [sampleId],
    );
    return rows.map((r) => this.view(r));
  }

  private view(w: any) {
    return {
      id: w.id,
      sampleId: w.sample_id,
      kind: w.kind,
      inputValue: w.input_value,
      inputUnit: w.input_unit,
      tareG: w.tare_g,
      netG: w.net_g,
      status: w.status,
      correctsId: w.corrects_id,
      reason: w.reason,
      createdAt: w.created_at,
    };
  }
}

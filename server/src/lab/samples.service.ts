import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DatabaseService, Q } from '../db/database.service';
import { D, massToG } from '../common/units';
import { InventoryService } from './inventory.service';

export interface SourceInput {
  sampleId: string;
  mass: string;
  unit?: string; // 默认 g
}

const req = (cond: any, msg: string) => {
  if (!cond) throw new BadRequestException(msg);
};

@Injectable()
export class SamplesService {
  constructor(
    private db: DatabaseService,
    private inv: InventoryService,
  ) {}

  private async findOperation(q: Q, key: string) {
    const rows = await q('SELECT payload FROM operations WHERE idempotency_key = $1', [key]);
    return rows.length ? rows[0].payload : null;
  }

  private async recordOperation(q: Q, key: string, kind: string, payload: any) {
    await q(
      'INSERT INTO operations (id, idempotency_key, kind, payload) VALUES ($1, $2, $3, $4::jsonb)',
      [randomUUID(), key, kind, JSON.stringify(payload)],
    );
  }

  private async sampleView(q: Q, id: string) {
    const rows = await q(
      `SELECT s.id, s.code, s.kind, s.status, s.available_mass_g AS "availableMassG",
              s.created_at AS "createdAt", c.code AS "containerCode", c.id AS "containerId"
         FROM samples s LEFT JOIN containers c ON c.id = s.container_id
        WHERE s.id = $1`,
      [id],
    );
    return rows[0];
  }

  /** 原样入库（支持任意质量单位，统一换算为克存储） */
  async intake(dto: {
    idempotencyKey: string;
    code: string;
    mass: string;
    unit: string;
    containerId?: string;
  }) {
    req(dto.idempotencyKey && dto.code && dto.mass && dto.unit, 'idempotencyKey/code/mass/unit 必填');
    const massG = massToG(dto.mass, dto.unit);
    req(massG.gt(0), '入库质量必须大于 0');

    return this.db.transaction(async (q) => {
      const replay = await this.findOperation(q, dto.idempotencyKey);
      if (replay) return { ...replay, replayed: true };

      const id = randomUUID();
      const opId = randomUUID();
      await q(
        'INSERT INTO samples (id, code, kind, container_id, available_mass_g) VALUES ($1,$2,$3,$4,0)',
        [id, dto.code, 'ORIGINAL', dto.containerId ?? null],
      ).catch((e: any) => {
        if (String(e.message).includes('unique')) throw new ConflictException(`样品编号已存在: ${dto.code}`);
        throw e;
      });
      const available = await this.inv.add(q, id, massG, '原样入库', opId);
      const sample = await this.sampleView(q, id);
      const payload = { sample: { ...sample, availableMassG: available }, input: { mass: dto.mass, unit: dto.unit, massG: massG.toString() } };
      await this.recordOperation(q, dto.idempotencyKey, 'INTAKE', payload);
      return payload;
    });
  }

  /** 混样：消耗各原样可用量，产出混样；任一来料不足则整体回滚 */
  async mix(dto: {
    idempotencyKey: string;
    code: string;
    containerId?: string;
    sources: SourceInput[];
  }) {
    req(dto.idempotencyKey && dto.code, 'idempotencyKey/code 必填');
    req(Array.isArray(dto.sources) && dto.sources.length >= 2, '混样至少需要两个来源');
    const parts = dto.sources.map((s) => {
      req(s.sampleId && s.mass, '每个来源需给出 sampleId 与 mass');
      const g = massToG(s.mass, s.unit ?? 'g');
      req(g.gt(0), '来源用量必须大于 0');
      return { sampleId: s.sampleId, massG: g };
    });
    const total = parts.reduce((acc, p) => acc.plus(p.massG), D(0));

    return this.db.transaction(async (q) => {
      const replay = await this.findOperation(q, dto.idempotencyKey);
      if (replay) return { ...replay, replayed: true };

      const opId = randomUUID();
      const remaining: Record<string, string> = {};
      for (const p of parts) {
        remaining[p.sampleId] = await this.inv.consume(q, p.sampleId, p.massG, '混样消耗', opId);
      }
      const id = randomUUID();
      await q(
        'INSERT INTO samples (id, code, kind, container_id, available_mass_g) VALUES ($1,$2,$3,$4,0)',
        [id, dto.code, 'MIXTURE', dto.containerId ?? null],
      ).catch((e: any) => {
        if (String(e.message).includes('unique')) throw new ConflictException(`样品编号已存在: ${dto.code}`);
        throw e;
      });
      const available = await this.inv.add(q, id, total, '混样产出', opId);
      for (const p of parts) {
        await q(
          'INSERT INTO sample_parents (child_id, parent_id, mass_used_g, operation_id) VALUES ($1,$2,$3::numeric,$4)',
          [id, p.sampleId, p.massG.toString(), opId],
        );
      }
      const sample = await this.sampleView(q, id);
      const payload = {
        sample: { ...sample, availableMassG: available },
        totalMassG: total.toString(),
        sources: parts.map((p) => ({ sampleId: p.sampleId, usedG: p.massG.toString(), remainingG: remaining[p.sampleId] })),
      };
      await this.recordOperation(q, dto.idempotencyKey, 'MIX', payload);
      return payload;
    });
  }

  /** 分样：从母样分出子样；分样不能凭空增加物料 */
  async split(dto: {
    idempotencyKey: string;
    parentId: string;
    code: string;
    mass: string;
    unit?: string;
    containerId?: string;
  }) {
    req(dto.idempotencyKey && dto.parentId && dto.code && dto.mass, 'idempotencyKey/parentId/code/mass 必填');
    const massG = massToG(dto.mass, dto.unit ?? 'g');
    req(massG.gt(0), '分样质量必须大于 0');

    return this.db.transaction(async (q) => {
      const replay = await this.findOperation(q, dto.idempotencyKey);
      if (replay) return { ...replay, replayed: true };

      const opId = randomUUID();
      const parentRemaining = await this.inv.consume(q, dto.parentId, massG, '分样消耗', opId);
      const id = randomUUID();
      await q(
        'INSERT INTO samples (id, code, kind, container_id, available_mass_g) VALUES ($1,$2,$3,$4,0)',
        [id, dto.code, 'ALIQUOT', dto.containerId ?? null],
      ).catch((e: any) => {
        if (String(e.message).includes('unique')) throw new ConflictException(`样品编号已存在: ${dto.code}`);
        throw e;
      });
      const available = await this.inv.add(q, id, massG, '分样产出', opId);
      await q(
        'INSERT INTO sample_parents (child_id, parent_id, mass_used_g, operation_id) VALUES ($1,$2,$3::numeric,$4)',
        [id, dto.parentId, massG.toString(), opId],
      );
      const sample = await this.sampleView(q, id);
      const payload = {
        sample: { ...sample, availableMassG: available },
        parent: { sampleId: dto.parentId, remainingG: parentRemaining },
      };
      await this.recordOperation(q, dto.idempotencyKey, 'SPLIT', payload);
      return payload;
    });
  }

  async list() {
    return this.db.query(
      `SELECT s.id, s.code, s.kind, s.status, s.available_mass_g AS "availableMassG",
              s.created_at AS "createdAt", c.code AS "containerCode"
         FROM samples s LEFT JOIN containers c ON c.id = s.container_id
        ORDER BY s.created_at, s.code`,
    );
  }

  async get(id: string) {
    const rows = await this.db.transaction(async (q) => [await this.sampleView(q, id)]);
    if (!rows[0]) throw new BadRequestException(`样品不存在: ${id}`);
    return rows[0];
  }

  async ledger(id: string) {
    return this.db.query(
      `SELECT id, delta_g AS "deltaG", reason, operation_id AS "operationId",
              weighing_id AS "weighingId", created_at AS "createdAt"
         FROM material_ledger WHERE sample_id = $1 ORDER BY id`,
      [id],
    );
  }
}

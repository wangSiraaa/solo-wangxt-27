import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';
import { D } from '../common/units';
import { InventoryService } from './inventory.service';
import { TestsService } from './tests.service';

const DEFAULT_MIN_MASS_G = '10';

/**
 * 复测方案：
 *  - 候选生成：按受影响样品的检测项目，追溯到其原样来源，按（原样, 项目）去重，
 *    所需量 = 该项目最小取样量；原样余量不足/已耗尽 → 明确标记“不可判定”。
 *  - 混样结果无法反推单个原样浓度 → 在方案备注中明确承认不可判定，只能直接复测原样。
 *  - 确认方案时才原子预占原样余量；多方案竞争同一余量 → 409 且整体回滚（不产生部分预占）。
 *  - 取消方案释放预占；录入结果消耗预占，新结果通过 amendsId 修订关联旧报告。
 */
@Injectable()
export class RetestService {
  constructor(
    private db: DatabaseService,
    private inv: InventoryService,
    private tests: TestsService,
  ) {}

  private async minMass(q: any, analyte: string): Promise<string> {
    const rows = await q('SELECT min_mass_g FROM analyte_requirements WHERE analyte = $1', [analyte]);
    return rows.length ? rows[0].min_mass_g : DEFAULT_MIN_MASS_G;
  }

  /** 生成候选方案（DRAFT，不预占任何库存） */
  async generate(incidentId: string) {
    const planId = await this.db.transaction(async (q) => {
      const inc = (await q('SELECT * FROM incidents WHERE id = $1', [incidentId]))[0];
      if (!inc) throw new NotFoundException(`事件不存在: ${incidentId}`);

      const impacted = await q(
        `SELECT si.sample_id AS id, s.code, s.kind FROM sample_impacts si
           JOIN samples s ON s.id = si.sample_id
          WHERE si.incident_id = $1 AND si.status IN ('SUSPECTED','CONFIRMED')
          ORDER BY s.code`, [incidentId]);

      const notes: string[] = [];
      const items: any[] = [];
      const seen = new Set<string>(); // （原样, 项目）去重 → 不会重复消耗

      for (const s of impacted) {
        const analytes = (await q(
          `SELECT DISTINCT analyte FROM test_records WHERE sample_id = $1 AND status = 'ACTIVE'`,
          [s.id])).map((r: any) => r.analyte);
        if (!analytes.length) continue;

        if (s.kind === 'MIXTURE') {
          notes.push(`混样 ${s.code} 的检测值是各来源的混合结果，无法反推单个原样浓度，不可判定；只能直接复测其原样来源`);
        }

        const originals = s.kind === 'ORIGINAL'
          ? [{ id: s.id, code: s.code, available_mass_g: null }]
          : await q(
              `WITH RECURSIVE up AS (
                 SELECT parent_id FROM sample_parents WHERE child_id = $1
                 UNION
                 SELECT sp.parent_id FROM sample_parents sp JOIN up u ON sp.child_id = u.parent_id
               )
               SELECT s.id, s.code, s.available_mass_g FROM samples s
                WHERE s.id IN (SELECT parent_id FROM up) AND s.kind = 'ORIGINAL'`,
              [s.id]);

        if (!originals.length) {
          notes.push(`${s.code} 无可用原样来源，相关项目不可判定`);
          continue;
        }

        for (const o of originals) {
          const avail = D(o.available_mass_g ?? (await q('SELECT available_mass_g FROM samples WHERE id=$1', [o.id]))[0].available_mass_g);
          for (const a of analytes) {
            const key = `${o.id}|${a}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const need = D(await this.minMass(q, a));
            const feasible = avail.gte(need);
            items.push({
              sampleId: o.id, sampleCode: o.code, analyte: a,
              requiredMassG: need.toString(), feasible,
              reason: feasible ? null
                : `原样 ${o.code} 余量 ${avail.toString()} g 不足（最小取样量 ${need.toString()} g），该来源的 ${a} 浓度不可判定`,
            });
          }
        }
      }

      const planId = randomUUID();
      const n = (await q('SELECT COUNT(*)::int AS n FROM retest_plans WHERE incident_id = $1', [incidentId]))[0].n + 1;
      const code = `${inc.code}-RP${n}`;
      await q(
        'INSERT INTO retest_plans (id, incident_id, code, notes) VALUES ($1,$2,$3,$4::jsonb)',
        [planId, incidentId, code, JSON.stringify(notes)],
      );
      for (const it of items) {
        await q(
          `INSERT INTO retest_plan_items (id, plan_id, sample_id, analyte, required_mass_g, feasible, reason, status)
           VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8)`,
          [randomUUID(), planId, it.sampleId, it.analyte, it.requiredMassG, it.feasible, it.reason,
           it.feasible ? 'PENDING' : 'INFEASIBLE'],
        );
      }
      return planId;
    });
    return this.getPlan(planId);
  }

  /** 确认方案：实验人员确认后才预占原样；任一余量不足 → 409 整体回滚 */
  async confirm(planId: string) {
    await this.db.transaction(async (q) => {
      const plan = (await q('SELECT * FROM retest_plans WHERE id = $1', [planId]))[0];
      if (!plan) throw new NotFoundException(`方案不存在: ${planId}`);
      if (plan.status !== 'DRAFT') throw new ConflictException(`方案状态为 ${plan.status}，不能确认`);

      const items = await q(
        `SELECT rpi.*, s.code FROM retest_plan_items rpi JOIN samples s ON s.id = rpi.sample_id
          WHERE rpi.plan_id = $1 AND rpi.feasible ORDER BY rpi.id`, [planId]);

      const conflicts: any[] = [];
      for (const it of items) {
        const rows = await q(
          `UPDATE samples SET available_mass_g = available_mass_g - $1::numeric
            WHERE id = $2 AND available_mass_g >= $1::numeric
            RETURNING available_mass_g`,
          [it.required_mass_g, it.sample_id]);
        if (!rows.length) {
          const cur = (await q('SELECT available_mass_g FROM samples WHERE id = $1', [it.sample_id]))[0];
          conflicts.push({ sampleCode: it.code, analyte: it.analyte,
            requiredG: it.required_mass_g, availableG: cur.available_mass_g });
        }
      }
      if (conflicts.length) {
        throw new ConflictException({
          message: '复测预占冲突：以下原样余量被其他方案占用或不足，本次确认已整体回滚，未产生任何预占',
          conflicts,
        });
      }

      for (const it of items) {
        const rid = randomUUID();
        await q(
          'INSERT INTO reservations (id, plan_item_id, sample_id, mass_g) VALUES ($1,$2,$3,$4::numeric)',
          [rid, it.id, it.sample_id, it.required_mass_g]);
        await q(
          `INSERT INTO material_ledger (sample_id, delta_g, reason) VALUES ($1, $2::numeric, $3)`,
          [it.sample_id, D(it.required_mass_g).neg().toString(), `复测预占 ${plan.code}`]);
        await q(`UPDATE retest_plan_items SET status = 'RESERVED' WHERE id = $1`, [it.id]);
      }
      await q(`UPDATE retest_plans SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [planId]);
    });
    return this.getPlan(planId);
  }

  /** 取消方案：释放全部有效预占（台账回冲，库存恢复） */
  async cancel(planId: string) {
    await this.db.transaction(async (q) => {
      const plan = (await q('SELECT * FROM retest_plans WHERE id = $1', [planId]))[0];
      if (!plan) throw new NotFoundException(`方案不存在: ${planId}`);
      if (plan.status === 'CANCELLED') throw new ConflictException('方案已取消');

      const actives = await q(
        `SELECT r.*, rpi.id AS item_id FROM reservations r
           JOIN retest_plan_items rpi ON rpi.id = r.plan_item_id
          WHERE rpi.plan_id = $1 AND r.status = 'ACTIVE'`, [planId]);
      for (const r of actives) {
        await q('UPDATE samples SET available_mass_g = available_mass_g + $1::numeric WHERE id = $2',
          [r.mass_g, r.sample_id]);
        await q(
          'INSERT INTO material_ledger (sample_id, delta_g, reason) VALUES ($1, $2::numeric, $3)',
          [r.sample_id, r.mass_g, `预占释放 ${plan.code}`]);
        await q(`UPDATE reservations SET status = 'RELEASED' WHERE id = $1`, [r.id]);
        await q(`UPDATE retest_plan_items SET status = 'RELEASED' WHERE id = $1`, [r.item_id]);
      }
      await q(`UPDATE retest_plans SET status = 'CANCELLED' WHERE id = $1`, [planId]);
    });
    return this.getPlan(planId);
  }

  /** 录入复测结果：消耗预占，新结果通过 amendsId 修订关联旧报告（不覆盖） */
  async enterResult(planId: string, itemId: string, dto: {
    rawValue: string; unit: string; detectionLimit: string; dilutionFactor?: string; amendsId?: string;
  }) {
    const itemRows = await this.db.query(
      'SELECT * FROM retest_plan_items WHERE id = $1 AND plan_id = $2', [itemId, planId]);
    const item = itemRows[0];
    if (!item) throw new NotFoundException('方案条目不存在');
    if (item.status !== 'RESERVED') {
      throw new ConflictException(`条目状态为 ${item.status}，只有已预占的条目才能录入结果`);
    }
    const record = await this.tests.add(item.sample_id, {
      analyte: item.analyte,
      rawValue: dto.rawValue,
      unit: dto.unit,
      detectionLimit: dto.detectionLimit,
      dilutionFactor: dto.dilutionFactor,
      amendsId: dto.amendsId,
      method: `复测（方案条目 ${itemId.slice(0, 8)}）`,
    });
    await this.db.transaction(async (q) => {
      await q(`UPDATE reservations SET status = 'CONSUMED' WHERE plan_item_id = $1 AND status = 'ACTIVE'`, [itemId]);
      await q(`UPDATE retest_plan_items SET status = 'DONE', test_record_id = $2 WHERE id = $1`, [itemId, record.id]);
    });
    return { item: (await this.getPlan(planId)).items.find((i: any) => i.id === itemId), record };
  }

  async getPlan(planId: string) {
    const plan = (await this.db.query(
      `SELECT id, incident_id AS "incidentId", code, status, notes,
              created_at AS "createdAt", confirmed_at AS "confirmedAt"
         FROM retest_plans WHERE id = $1`, [planId]))[0];
    if (!plan) throw new NotFoundException(`方案不存在: ${planId}`);
    const items = await this.db.query(
      `SELECT rpi.id, rpi.sample_id AS "sampleId", s.code AS "sampleCode", rpi.analyte,
              rpi.required_mass_g AS "requiredMassG", rpi.feasible, rpi.reason, rpi.status,
              rpi.test_record_id AS "testRecordId",
              (SELECT r.status FROM reservations r
                 WHERE r.plan_item_id = rpi.id ORDER BY r.created_at DESC LIMIT 1) AS "reservationStatus"
         FROM retest_plan_items rpi JOIN samples s ON s.id = rpi.sample_id
        WHERE rpi.plan_id = $1 ORDER BY rpi.feasible DESC, s.code`, [planId]);
    return { ...plan, items };
  }

  listPlans(incidentId: string) {
    return this.db.query(
      `SELECT id, code, status, created_at AS "createdAt", confirmed_at AS "confirmedAt"
         FROM retest_plans WHERE incident_id = $1 ORDER BY created_at`, [incidentId]);
  }
}

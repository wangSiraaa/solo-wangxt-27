import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService, Q } from '../db/database.service';

const req = (cond: any, msg: string) => {
  if (!cond) throw new BadRequestException(msg);
};

/**
 * 污染事件与影响评估。
 * 影响链 = 窗口内被工具直接接触的样品 ∪ 其谱系下游（混样/分样）。
 * 三态：CONFIRMED（确认污染，人工+依据）、SUSPECTED（疑似暴露，自动推导）、
 *       CLEARED（已排除，必须留依据）。人工裁定不被自动重算覆盖。
 */
@Injectable()
export class IncidentService {
  constructor(private db: DatabaseService) {}

  // ---- 工具与接触记录 ----
  async addTool(dto: { code: string; note?: string }) {
    req(dto.code, '工具编号必填');
    const id = randomUUID();
    await this.db.query('INSERT INTO tools (id, code, note) VALUES ($1,$2,$3)', [id, dto.code, dto.note ?? null]);
    return { id, code: dto.code };
  }

  listTools() {
    return this.db.query('SELECT id, code, note FROM tools ORDER BY code');
  }

  async addContact(dto: { toolId: string; sampleId: string; contactAt: string; operationId?: string; note?: string }) {
    req(dto.toolId && dto.sampleId && dto.contactAt, 'toolId/sampleId/contactAt 必填');
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO tool_contacts (id, tool_id, sample_id, operation_id, contact_at, note) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, dto.toolId, dto.sampleId, dto.operationId ?? null, dto.contactAt, dto.note ?? null],
    );
    // 若该工具已有未关闭事件，接触新增后重算影响
    const open = await this.db.query(`SELECT id FROM incidents WHERE tool_id = $1 AND status = 'OPEN'`, [dto.toolId]);
    for (const inc of open) await this.recompute(inc.id);
    return { id };
  }

  listContacts(toolId?: string) {
    return this.db.query(
      `SELECT tc.id, tc.tool_id AS "toolId", t.code AS "toolCode", tc.sample_id AS "sampleId",
              s.code AS "sampleCode", tc.contact_at AS "contactAt", tc.note
         FROM tool_contacts tc JOIN tools t ON t.id = tc.tool_id JOIN samples s ON s.id = tc.sample_id
        ${toolId ? 'WHERE tc.tool_id = $1' : ''} ORDER BY tc.contact_at`,
      toolId ? [toolId] : [],
    );
  }

  // ---- 事件 ----
  async createIncident(dto: { code: string; toolId: string; windowStart: string; windowEnd: string; reason: string }) {
    req(dto.code && dto.toolId && dto.windowStart && dto.windowEnd && dto.reason,
      'code/toolId/windowStart/windowEnd/reason 必填');
    const id = randomUUID();
    await this.db.transaction(async (q) => {
      await q(
        'INSERT INTO incidents (id, code, tool_id, window_start, window_end, reason) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, dto.code, dto.toolId, dto.windowStart, dto.windowEnd, dto.reason],
      );
      await q(
        'INSERT INTO incident_revisions (id, incident_id, window_start, window_end, reason) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), id, dto.windowStart, dto.windowEnd, '初始窗口: ' + dto.reason],
      );
    });
    await this.recompute(id);
    return this.getIncident(id);
  }

  /** 修订暴露窗口（证据到达后可缩小/调整），保留修订历史并重算影响 */
  async reviseWindow(id: string, dto: { windowStart: string; windowEnd: string; reason: string }) {
    req(dto.windowStart && dto.windowEnd && dto.reason, 'windowStart/windowEnd/reason 必填');
    const rows = await this.db.query('SELECT id FROM incidents WHERE id = $1', [id]);
    if (!rows.length) throw new NotFoundException(`事件不存在: ${id}`);
    await this.db.transaction(async (q) => {
      await q('UPDATE incidents SET window_start = $2, window_end = $3 WHERE id = $1',
        [id, dto.windowStart, dto.windowEnd]);
      await q(
        'INSERT INTO incident_revisions (id, incident_id, window_start, window_end, reason) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), id, dto.windowStart, dto.windowEnd, dto.reason],
      );
    });
    await this.recompute(id);
    return this.getIncident(id);
  }

  /**
   * 重算影响：窗口内直接接触 + 谱系下游 → SUSPECTED；
   * 不再处于影响链上的自动标记样品 → CLEARED（留依据）；
   * 人工裁定（CONFIRMED / 手动 CLEARED）不被覆盖。
   */
  async recompute(incidentId: string) {
    await this.db.transaction(async (q) => {
      const inc = (await q('SELECT * FROM incidents WHERE id = $1', [incidentId]))[0];
      const ws = new Date(inc.window_start).getTime();
      const we = new Date(inc.window_end).getTime();

      const contacts = await q(
        `SELECT tc.sample_id, tc.contact_at, s.code FROM tool_contacts tc
           JOIN samples s ON s.id = tc.sample_id WHERE tc.tool_id = $1`,
        [inc.tool_id],
      );
      const direct = new Map<string, string>();
      for (const c of contacts) {
        const t = new Date(c.contact_at).getTime();
        if (t >= ws && t <= we) direct.set(c.sample_id, c.contact_at);
      }

      let affected = new Set<string>(direct.keys());
      if (direct.size) {
        const rows = await q(
          `WITH RECURSIVE aff AS (
             SELECT id FROM samples WHERE id = ANY($1)
             UNION
             SELECT sp.child_id FROM sample_parents sp JOIN aff a ON sp.parent_id = a.id
           ) SELECT id FROM aff`,
          [[...direct.keys()]],
        );
        affected = new Set(rows.map((r: any) => r.id));
      }

      const existing = await q('SELECT * FROM sample_impacts WHERE incident_id = $1', [incidentId]);
      const bySample = new Map(existing.map((e: any) => [e.sample_id, e]));

      for (const sampleId of affected) {
        const ex: any = bySample.get(sampleId);
        if (ex?.manual) continue; // 人工裁定不覆盖
        const basis = direct.has(sampleId)
          ? `工具于 ${direct.get(sampleId)} 直接接触（暴露窗口内）`
          : '位于受影响样品的下游混样/分样链上';
        if (!ex) {
          await this.upsertImpact(q, incidentId, sampleId, 'SUSPECTED', basis, false, null);
        } else if (ex.status !== 'SUSPECTED') {
          await this.upsertImpact(q, incidentId, sampleId, 'SUSPECTED', basis, false, ex.status);
        }
      }
      for (const ex of existing as any[]) {
        if (ex.manual || ex.status !== 'SUSPECTED' || affected.has(ex.sample_id)) continue;
        await this.upsertImpact(q, incidentId, ex.sample_id, 'CLEARED',
          '暴露窗口修订后，该样品不再处于影响链上', false, 'SUSPECTED');
      }
    });
  }

  private async upsertImpact(q: Q, incidentId: string, sampleId: string,
    status: string, basis: string, manual: boolean, fromStatus: string | null) {
    await q(
      `INSERT INTO sample_impacts (incident_id, sample_id, status, basis, manual, updated_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (incident_id, sample_id)
       DO UPDATE SET status = $3, basis = $4, manual = $5, updated_at = now()`,
      [incidentId, sampleId, status, basis, manual],
    );
    await q(
      'INSERT INTO impact_events (id, incident_id, sample_id, from_status, to_status, basis) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), incidentId, sampleId, fromStatus, status, basis],
    );
  }

  /** 人工确认污染（需依据） */
  async confirmImpact(incidentId: string, sampleId: string, basis: string) {
    req(basis, '确认污染必须填写依据');
    await this.db.transaction(async (q) => {
      const ex = await q('SELECT status FROM sample_impacts WHERE incident_id=$1 AND sample_id=$2',
        [incidentId, sampleId]);
      await this.upsertImpact(q, incidentId, sampleId, 'CONFIRMED', basis, true, ex[0]?.status ?? null);
    });
    return this.getIncident(incidentId);
  }

  /** 人工排除（需依据，依据永久保留在影响记录与审计事件中） */
  async clearImpact(incidentId: string, sampleId: string, basis: string) {
    req(basis, '解除疑似必须填写依据');
    await this.db.transaction(async (q) => {
      const ex = await q('SELECT status FROM sample_impacts WHERE incident_id=$1 AND sample_id=$2',
        [incidentId, sampleId]);
      if (!ex.length) throw new NotFoundException('该样品不在影响评估中');
      await this.upsertImpact(q, incidentId, sampleId, 'CLEARED', basis, true, ex[0].status);
    });
    return this.getIncident(incidentId);
  }

  async getIncident(id: string) {
    const inc = (await this.db.query(
      `SELECT i.id, i.code, i.window_start AS "windowStart", i.window_end AS "windowEnd",
              i.reason, i.status, t.code AS "toolCode", i.tool_id AS "toolId"
         FROM incidents i JOIN tools t ON t.id = i.tool_id WHERE i.id = $1`, [id]))[0];
    if (!inc) throw new NotFoundException(`事件不存在: ${id}`);
    const impacts = await this.db.query(
      `SELECT si.sample_id AS "sampleId", s.code AS "sampleCode", s.kind, si.status, si.basis,
              si.manual, si.updated_at AS "updatedAt",
              (SELECT COUNT(*)::int FROM test_records tr
                WHERE tr.sample_id = si.sample_id AND tr.status = 'ACTIVE') AS "activeReports"
         FROM sample_impacts si JOIN samples s ON s.id = si.sample_id
        WHERE si.incident_id = $1 ORDER BY si.status, s.code`, [id]);
    const revisions = await this.db.query(
      `SELECT window_start AS "windowStart", window_end AS "windowEnd", reason, created_at AS "createdAt"
         FROM incident_revisions WHERE incident_id = $1 ORDER BY created_at`, [id]);
    const events = await this.db.query(
      `SELECT ie.sample_id AS "sampleId", s.code AS "sampleCode", ie.from_status AS "from",
              ie.to_status AS "to", ie.basis, ie.created_at AS "createdAt"
         FROM impact_events ie JOIN samples s ON s.id = ie.sample_id
        WHERE ie.incident_id = $1 ORDER BY ie.created_at`, [id]);
    return { ...inc, impacts, revisions, events };
  }

  listIncidents() {
    return this.db.query(
      `SELECT i.id, i.code, i.window_start AS "windowStart", i.window_end AS "windowEnd",
              i.reason, i.status, t.code AS "toolCode"
         FROM incidents i JOIN tools t ON t.id = i.tool_id ORDER BY i.created_at`,
    );
  }
}

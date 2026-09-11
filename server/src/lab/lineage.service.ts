import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';

/**
 * 谱系图：以任意样品为根，向上（来源）与向下（去向）递归展开，
 * 每个节点携带剩余量、容器与检测记录。
 */
@Injectable()
export class LineageService {
  constructor(private db: DatabaseService) {}

  async lineage(sampleId: string) {
    const exists = await this.db.query('SELECT id FROM samples WHERE id = $1', [sampleId]);
    if (!exists.length) throw new NotFoundException(`样品不存在: ${sampleId}`);

    const edges = await this.db.query(
      `WITH RECURSIVE up AS (
         SELECT child_id, parent_id, mass_used_g FROM sample_parents WHERE child_id = $1
         UNION ALL
         SELECT sp.child_id, sp.parent_id, sp.mass_used_g
           FROM sample_parents sp JOIN up u ON sp.child_id = u.parent_id
       ),
       down AS (
         SELECT child_id, parent_id, mass_used_g FROM sample_parents WHERE parent_id = $1
         UNION ALL
         SELECT sp.child_id, sp.parent_id, sp.mass_used_g
           FROM sample_parents sp JOIN down d ON sp.parent_id = d.child_id
       )
       SELECT parent_id AS "from", child_id AS "to", mass_used_g AS "massUsedG" FROM up
       UNION
       SELECT parent_id AS "from", child_id AS "to", mass_used_g AS "massUsedG" FROM down`,
      [sampleId],
    );

    const ids = new Set<string>([sampleId]);
    for (const e of edges) { ids.add(e.from); ids.add(e.to); }

    const nodes = await this.db.query(
      `SELECT s.id, s.code, s.kind, s.available_mass_g AS "availableMassG",
              c.code AS "containerCode",
              COALESCE((
                SELECT json_agg(json_build_object(
                  'analyte', t.analyte, 'rawValue', t.raw_value, 'rawUnit', t.raw_unit,
                  'detectionLimit', t.detection_limit, 'dilutionFactor', t.dilution_factor,
                  'belowDl', t.below_dl, 'correctedMgPerKg', t.corrected_mg_per_kg)
                ORDER BY t.created_at)
                FROM test_records t WHERE t.sample_id = s.id
              ), '[]') AS tests
         FROM samples s LEFT JOIN containers c ON c.id = s.container_id
        WHERE s.id = ANY($1)`,
      [[...ids]],
    );

    return { root: sampleId, nodes, edges };
  }
}

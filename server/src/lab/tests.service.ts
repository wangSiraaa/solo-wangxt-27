import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DatabaseService } from '../db/database.service';
import { D, concToMgPerKg } from '../common/units';

const req = (cond: any, msg: string) => {
  if (!cond) throw new BadRequestException(msg);
};

@Injectable()
export class TestsService {
  constructor(private db: DatabaseService) {}

  /**
   * 录入检测值：保留原始单位与检出限，按稀释倍数校正后统一换算为 mg/kg。
   * 原始读数低于检出限时标记 below_dl，校正结果仍记录（= 检出限×稀释倍数），
   * 但统计平均时排除，绝不按 0 参与。
   */
  async add(sampleId: string, dto: {
    analyte: string;
    rawValue: string;
    unit: string;
    detectionLimit: string;
    dilutionFactor?: string;
    belowDl?: boolean;
    method?: string;
  }) {
    req(dto.analyte && dto.rawValue && dto.unit && dto.detectionLimit,
      'analyte/rawValue/unit/detectionLimit 必填');
    const raw = D(dto.rawValue);
    const dl = D(dto.detectionLimit);
    const dilution = D(dto.dilutionFactor ?? '1');
    req(dl.gt(0) && dilution.gt(0), '检出限与稀释倍数必须大于 0');

    const belowDl = dto.belowDl ?? raw.lt(dl);
    const corrected = concToMgPerKg(raw.times(dilution), dto.unit);

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO test_records
         (id, sample_id, analyte, raw_value, raw_unit, detection_limit, dilution_factor, below_dl, corrected_mg_per_kg, method)
       VALUES ($1,$2,$3,$4::numeric,$5,$6::numeric,$7::numeric,$8,$9::numeric,$10)`,
      [id, sampleId, dto.analyte, raw.toString(), dto.unit, dl.toString(),
       dilution.toString(), belowDl, corrected.toString(), dto.method ?? null],
    );
    const rows = await this.db.query('SELECT * FROM test_records WHERE id = $1', [id]);
    return this.view(rows[0]);
  }

  async listForSample(sampleId: string) {
    const rows = await this.db.query(
      'SELECT * FROM test_records WHERE sample_id = $1 ORDER BY created_at, id', [sampleId],
    );
    return rows.map((r) => this.view(r));
  }

  /**
   * 普通平均：只统计检出（below_dl = false）的记录；
   * 低于检出限的记录单独计数，不按 0 计入平均。
   */
  async summary(sampleId: string, analyte: string) {
    const rows = await this.db.query(
      `SELECT below_dl, corrected_mg_per_kg FROM test_records
        WHERE sample_id = $1 AND analyte = $2 ORDER BY created_at`,
      [sampleId, analyte],
    );
    const detects = rows.filter((r) => !r.below_dl).map((r) => D(r.corrected_mg_per_kg));
    const belowDlCount = rows.length - detects.length;
    const average = detects.length
      ? detects.reduce((a, b) => a.plus(b), D(0)).div(detects.length)
      : null;
    return {
      sampleId,
      analyte,
      averageMgPerKg: average ? average.toString() : null,
      detectCount: detects.length,
      belowDlCount,
      note: '低于检出限的记录不参与平均（不按 0 计）',
    };
  }

  private view(r: any) {
    return {
      id: r.id,
      sampleId: r.sample_id,
      analyte: r.analyte,
      rawValue: r.raw_value,
      rawUnit: r.raw_unit,
      detectionLimit: r.detection_limit,
      dilutionFactor: r.dilution_factor,
      belowDl: r.below_dl,
      correctedMgPerKg: r.corrected_mg_per_kg,
      method: r.method,
      createdAt: r.created_at,
    };
  }
}

import { Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseModule } from '../db/database.module';
import { DatabaseService } from '../db/database.service';
import { InventoryService } from './inventory.service';
import { SamplesService } from './samples.service';
import { WeighingsService } from './weighings.service';
import { TestsService } from './tests.service';
import { LineageService } from './lineage.service';
import { SamplesController } from './samples.controller';
import { WeighingsController } from './weighings.controller';
import { ContainersController } from './containers.controller';
import { IncidentService } from './incident.service';
import { RetestService } from './retest.service';
import { IncidentController } from './incident.controller';

/** 首次启动时放入几个容器，方便直接操作 */
@Injectable()
class SeedRunner implements OnApplicationBootstrap {
  constructor(private db: DatabaseService) {}

  async onApplicationBootstrap() {
    const rows = await this.db.query('SELECT COUNT(*)::int AS n FROM containers');
    if (rows[0].n === 0) {
      const containers = [
        ['棕色玻璃瓶-01', '125.5', '500 mL 广口瓶'],
        ['聚乙烯自封袋-02', '12.0', '1 L 样品袋'],
        ['不锈钢托盘-03', '380.0', '混样托盘'],
        ['聚乙烯自封袋-04', '12.5', '1 L 样品袋'],
      ];
      for (const [code, tare, note] of containers) {
        await this.db.query(
          'INSERT INTO containers (id, code, tare_g, note) VALUES ($1,$2,$3::numeric,$4)',
          [randomUUID(), code, tare, note],
        );
      }
    }
    // 各检测项目的最小取样量（复测方案用）
    const reqRows = await this.db.query('SELECT COUNT(*)::int AS n FROM analyte_requirements');
    if (reqRows[0].n === 0) {
      const reqs = [['Pb', '10'], ['Cd', '10'], ['As', '5'], ['Hg', '5']];
      for (const [analyte, mass] of reqs) {
        await this.db.query(
          'INSERT INTO analyte_requirements (analyte, min_mass_g) VALUES ($1,$2::numeric)',
          [analyte, mass],
        );
      }
    }
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [SamplesController, WeighingsController, ContainersController, IncidentController],
  providers: [InventoryService, SamplesService, WeighingsService, TestsService, LineageService, IncidentService, RetestService, SeedRunner],
})
export class LabModule {}

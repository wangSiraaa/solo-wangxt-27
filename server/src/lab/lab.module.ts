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

/** 首次启动时放入几个容器，方便直接操作 */
@Injectable()
class SeedRunner implements OnApplicationBootstrap {
  constructor(private db: DatabaseService) {}

  async onApplicationBootstrap() {
    const rows = await this.db.query('SELECT COUNT(*)::int AS n FROM containers');
    if (rows[0].n > 0) return;
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
}

@Module({
  imports: [DatabaseModule],
  controllers: [SamplesController, WeighingsController, ContainersController],
  providers: [InventoryService, SamplesService, WeighingsService, TestsService, LineageService, SeedRunner],
})
export class LabModule {}

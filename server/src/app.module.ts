import { Module } from '@nestjs/common';
import { DatabaseModule } from './db/database.module';
import { LabModule } from './lab/lab.module';

@Module({
  imports: [DatabaseModule, LabModule],
})
export class AppModule {}

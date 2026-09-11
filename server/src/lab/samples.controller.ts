import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SamplesService } from './samples.service';
import { WeighingsService } from './weighings.service';
import { TestsService } from './tests.service';
import { LineageService } from './lineage.service';
import { InventoryService } from './inventory.service';

@Controller('samples')
export class SamplesController {
  constructor(
    private samples: SamplesService,
    private tests: TestsService,
    private lineage: LineageService,
    private inv: InventoryService,
  ) {}

  @Get()
  list() {
    return this.samples.list();
  }

  @Post('intake')
  intake(@Body() dto: any) {
    return this.samples.intake(dto);
  }

  @Post('mix')
  mix(@Body() dto: any) {
    return this.samples.mix(dto);
  }

  @Post('split')
  split(@Body() dto: any) {
    return this.samples.split(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.samples.get(id);
  }

  @Get(':id/ledger')
  ledger(@Param('id') id: string) {
    return this.samples.ledger(id);
  }

  @Get(':id/reconcile')
  reconcile(@Param('id') id: string) {
    return this.inv.reconcile(id);
  }

  @Get(':id/lineage')
  getLineage(@Param('id') id: string) {
    return this.lineage.lineage(id);
  }

  @Post(':id/tests')
  addTest(@Param('id') id: string, @Body() dto: any) {
    return this.tests.add(id, dto);
  }

  @Get(':id/tests')
  listTests(@Param('id') id: string) {
    return this.tests.listForSample(id);
  }

  @Get(':id/tests/summary')
  testSummary(@Param('id') id: string, @Query('analyte') analyte: string) {
    return this.tests.summary(id, analyte);
  }
}

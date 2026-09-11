import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { WeighingsService } from './weighings.service';

@Controller('weighings')
export class WeighingsController {
  constructor(private weighings: WeighingsService) {}

  @Post()
  create(@Body() dto: any) {
    return this.weighings.create(dto);
  }

  @Post(':id/confirm')
  confirm(@Param('id') id: string) {
    return this.weighings.confirm(id);
  }

  @Post(':id/corrections')
  correct(@Param('id') id: string, @Body() dto: any) {
    return this.weighings.correct(id, dto);
  }

  @Get('sample/:sampleId')
  listForSample(@Param('sampleId') sampleId: string) {
    return this.weighings.listForSample(sampleId);
  }
}

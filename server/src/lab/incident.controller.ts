import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IncidentService } from './incident.service';
import { RetestService } from './retest.service';

@Controller()
export class IncidentController {
  constructor(
    private incidents: IncidentService,
    private retest: RetestService,
  ) {}

  // ---- 工具与接触 ----
  @Post('tools')
  addTool(@Body() dto: any) { return this.incidents.addTool(dto); }

  @Get('tools')
  listTools() { return this.incidents.listTools(); }

  @Post('tool-contacts')
  addContact(@Body() dto: any) { return this.incidents.addContact(dto); }

  @Get('tool-contacts')
  listContacts(@Query('toolId') toolId?: string) { return this.incidents.listContacts(toolId); }

  // ---- 污染事件 ----
  @Post('incidents')
  createIncident(@Body() dto: any) { return this.incidents.createIncident(dto); }

  @Get('incidents')
  listIncidents() { return this.incidents.listIncidents(); }

  @Get('incidents/:id')
  getIncident(@Param('id') id: string) { return this.incidents.getIncident(id); }

  @Post('incidents/:id/revise-window')
  reviseWindow(@Param('id') id: string, @Body() dto: any) {
    return this.incidents.reviseWindow(id, dto);
  }

  @Post('incidents/:id/impacts/:sampleId/confirm')
  confirmImpact(@Param('id') id: string, @Param('sampleId') sampleId: string, @Body() dto: any) {
    return this.incidents.confirmImpact(id, sampleId, dto.basis);
  }

  @Post('incidents/:id/impacts/:sampleId/clear')
  clearImpact(@Param('id') id: string, @Param('sampleId') sampleId: string, @Body() dto: any) {
    return this.incidents.clearImpact(id, sampleId, dto.basis);
  }

  // ---- 复测方案 ----
  @Post('incidents/:id/retest-plans')
  generatePlan(@Param('id') id: string) { return this.retest.generate(id); }

  @Get('incidents/:id/retest-plans')
  listPlans(@Param('id') id: string) { return this.retest.listPlans(id); }

  @Get('retest-plans/:id')
  getPlan(@Param('id') id: string) { return this.retest.getPlan(id); }

  @Post('retest-plans/:id/confirm')
  confirmPlan(@Param('id') id: string) { return this.retest.confirm(id); }

  @Post('retest-plans/:id/cancel')
  cancelPlan(@Param('id') id: string) { return this.retest.cancel(id); }

  @Post('retest-plans/:planId/items/:itemId/result')
  enterResult(@Param('planId') planId: string, @Param('itemId') itemId: string, @Body() dto: any) {
    return this.retest.enterResult(planId, itemId, dto);
  }
}

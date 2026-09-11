import { Body, Controller, Get, Post } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../db/database.service';

@Controller('containers')
export class ContainersController {
  constructor(private db: DatabaseService) {}

  @Get()
  list() {
    return this.db.query(
      'SELECT id, code, tare_g AS "tareG", note FROM containers ORDER BY code',
    );
  }

  @Post()
  async create(@Body() dto: { code: string; tareG?: string; note?: string }) {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO containers (id, code, tare_g, note) VALUES ($1,$2,$3::numeric,$4)',
      [id, dto.code, dto.tareG ?? '0', dto.note ?? null],
    );
    return { id, code: dto.code };
  }
}

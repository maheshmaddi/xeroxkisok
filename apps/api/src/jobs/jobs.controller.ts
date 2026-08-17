import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  async create(@Body() body: unknown) {
    return this.jobs.create(body);
  }

  @Put(':id/file')
  async saveUpload(@Param('id') id: string, @Query('token') token: string | undefined, @Req() req: Request) {
    // Body arrives as a raw Buffer via the express.raw middleware in main.ts
    return this.jobs.saveUpload(id, token, req.body);
  }

  @Post(':id/process')
  @HttpCode(200)
  async process(@Param('id') id: string, @Headers('x-job-token') token: string | undefined) {
    return this.jobs.process(id, token);
  }

  @Post(':id/price')
  @HttpCode(200)
  async price(
    @Param('id') id: string,
    @Headers('x-job-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    return this.jobs.price(id, token, body);
  }

  @Post(':id/pay')
  @HttpCode(200)
  async pay(@Param('id') id: string, @Headers('x-job-token') token: string | undefined) {
    return this.jobs.pay(id, token);
  }

  @Get(':id/status')
  async status(@Param('id') id: string, @Headers('x-job-token') token: string | undefined) {
    return this.jobs.status(id, token);
  }
}

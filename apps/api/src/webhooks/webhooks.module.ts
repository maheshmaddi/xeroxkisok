import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [JobsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}

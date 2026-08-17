import { Module } from '@nestjs/common';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { KioskGatewayModule } from '../kiosk-gateway/kiosk-gateway.module';

@Module({
  imports: [KioskGatewayModule],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}

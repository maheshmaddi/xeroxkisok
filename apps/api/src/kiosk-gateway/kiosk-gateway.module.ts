import { Module } from '@nestjs/common';
import { KioskGateway } from './kiosk.gateway';

@Module({
  providers: [KioskGateway],
  exports: [KioskGateway],
})
export class KioskGatewayModule {}

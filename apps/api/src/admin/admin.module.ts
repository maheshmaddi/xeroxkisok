import { Module } from '@nestjs/common';
import { AdminController, RefillController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { KioskGatewayModule } from '../kiosk-gateway/kiosk-gateway.module';

@Module({
  imports: [KioskGatewayModule],
  controllers: [AdminController, RefillController],
  providers: [AdminGuard],
})
export class AdminModule {}

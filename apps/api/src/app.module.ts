import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { PaymentsModule } from './payments/payments.module';
import { JobsModule } from './jobs/jobs.module';
import { FilesModule } from './files/files.module';
import { KiosksModule } from './kiosks/kiosks.module';
import { KioskGatewayModule } from './kiosk-gateway/kiosk-gateway.module';
import { SweepsModule } from './sweeps/sweeps.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { AdminModule } from './admin/admin.module';
import { AlertsModule } from './alerts/alerts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    PaymentsModule,
    JobsModule,
    FilesModule,
    KiosksModule,
    KioskGatewayModule,
    SweepsModule,
    WebhooksModule,
    AdminModule,
    AlertsModule,
  ],
})
export class AppModule {}

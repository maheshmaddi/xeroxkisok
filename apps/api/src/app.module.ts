import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { JobsModule } from './jobs/jobs.module';
import { FilesModule } from './files/files.module';
import { KiosksModule } from './kiosks/kiosks.module';
import { KioskGatewayModule } from './kiosk-gateway/kiosk-gateway.module';
import { SweepsModule } from './sweeps/sweeps.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    StorageModule,
    JobsModule,
    FilesModule,
    KiosksModule,
    KioskGatewayModule,
    SweepsModule,
  ],
})
export class AppModule {}

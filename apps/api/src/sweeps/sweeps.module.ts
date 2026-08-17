import { Module } from '@nestjs/common';
import { SweepsService } from './sweeps.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule],
  providers: [SweepsService],
})
export class SweepsModule {}

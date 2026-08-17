import { Module } from '@nestjs/common';
import { SweepsService } from './sweeps.service';

@Module({
  providers: [SweepsService],
})
export class SweepsModule {}

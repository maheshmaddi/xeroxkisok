import { Module } from '@nestjs/common';
import { KiosksController } from './kiosks.controller';

@Module({
  controllers: [KiosksController],
})
export class KiosksModule {}

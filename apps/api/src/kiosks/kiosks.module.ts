import { Module } from '@nestjs/common';
import { AgentMetaController, KiosksController } from './kiosks.controller';

@Module({
  controllers: [KiosksController, AgentMetaController],
})
export class KiosksModule {}

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileCleanupService } from './file-cleanup.service';
import { LocalStorageService } from './local-storage.service';
import { STORAGE } from './storage.constants';
import type { StorageService } from './storage.types';

@Global()
@Module({
  providers: [
    {
      provide: STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageService => {
        const driver = config.get<string>('STORAGE_DRIVER') ?? 'local';
        if (driver === 'r2') {
          // Phase 2+/production: presigned PUT/GET against R2 via @aws-sdk/client-s3.
          throw new Error('STORAGE_DRIVER=r2 is not implemented yet (production driver).');
        }
        return new LocalStorageService(config);
      },
    },
    FileCleanupService,
  ],
  exports: [STORAGE, FileCleanupService],
})
export class StorageModule {}

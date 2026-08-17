import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { signFileToken } from './signed-token.util';
import type { StorageService, UploadTarget } from './storage.types';

/**
 * Local-dev driver: plain files under LOCAL_STORAGE_DIR (repo .local/uploads).
 * Uploads arrive on PUT /jobs/:id/file (bearer of the job access token) and
 * kiosk downloads go through GET /files/:jobId?token=<hmac> (10-min expiry).
 */
export class LocalStorageService implements StorageService {
  readonly driver = 'local' as const;

  private readonly dir: string;
  private readonly publicUrl: string;
  private readonly jwtSecret: string;

  constructor(config: ConfigService) {
    this.dir = resolve(process.cwd(), config.get<string>('LOCAL_STORAGE_DIR') ?? '.local/uploads');
    this.publicUrl = (config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:4000').replace(/\/$/, '');
    this.jwtSecret = config.get<string>('JWT_SECRET') ?? 'dev-jwt-secret-change-me';
  }

  uploadTarget(jobId: string, accessToken: string): Promise<UploadTarget> {
    return Promise.resolve({
      method: 'PUT',
      url: `${this.publicUrl}/jobs/${jobId}/file?token=${accessToken}`,
    });
  }

  async saveUpload(jobId: string, body: Buffer): Promise<string> {
    const fileKey = `${jobId}.bin`;
    const target = join(this.dir, fileKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    return fileKey;
  }

  async downloadUrl(jobId: string): Promise<string> {
    return `${this.publicUrl}/files/${jobId}?token=${signFileToken(jobId, 10 * 60_000, this.jwtSecret)}`;
  }

  async read(_jobId: string, fileKey: string): Promise<Buffer> {
    return readFile(join(this.dir, fileKey));
  }

  async delete(_jobId: string, fileKey: string): Promise<void> {
    await rm(join(this.dir, fileKey), { force: true });
  }
}

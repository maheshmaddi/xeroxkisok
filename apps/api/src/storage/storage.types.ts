/**
 * StorageService abstracts file storage so local dev writes to disk while
 * production talks to Cloudflare R2 (spec §3). All job files flow through
 * this interface: upload → read (kiosk download) → delete.
 */
export interface UploadTarget {
  method: 'PUT';
  url: string;
}

export interface StorageService {
  readonly driver: 'local' | 'r2';

  /** Where the user's browser should PUT the file. */
  uploadTarget(jobId: string, accessToken: string): Promise<UploadTarget>;

  /** Persist a raw upload body; returns the storage fileKey. */
  saveUpload(jobId: string, body: Buffer): Promise<string>;

  /** Persist a derived artifact (print sheet, converted PDF); returns its key. */
  saveArtifact(jobId: string, data: Buffer, suffix: string): Promise<string>;

  /** Short-lived signed URL the kiosk agent downloads the file from. */
  downloadUrl(jobId: string, which?: 'file' | 'print'): Promise<string>;

  read(jobId: string, fileKey: string): Promise<Buffer>;

  delete(jobId: string, fileKey: string): Promise<void>;
}

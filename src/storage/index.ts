// All file/object storage for Sahra. Today this is Cloudflare R2. For the Vercel
// standby, implement `ObjectStore` for another storage service.

export interface PutResult {
  etag: string;
  size: number;
}

export interface ObjectStore {
  /** Resolves only when the store has durably confirmed the write. Throws otherwise. */
  put(key: string, body: string, contentType: string): Promise<PutResult>;
  get(key: string): Promise<{ body: string; etag: string } | null>;
}

export class StoreWriteError extends Error {}

export class R2Store implements ObjectStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: string, contentType: string): Promise<PutResult> {
    let obj: R2Object | null;
    try {
      obj = await this.bucket.put(key, body, { httpMetadata: { contentType } });
    } catch (e) {
      throw new StoreWriteError(`put ${key} failed: ${(e as Error).message}`);
    }
    // put() returns the stored object's metadata once R2 has committed it.
    if (!obj || typeof obj.etag !== "string" || obj.size !== new TextEncoder().encode(body).length) {
      throw new StoreWriteError(`put ${key} not confirmed`);
    }
    return { etag: obj.etag, size: obj.size };
  }

  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: await obj.text(), etag: obj.etag };
  }
}

// ------------------------------------------------------------------ change log

/** Key for one change-log entry: unique per entity and rev. */
export function logKey(partyId: string, entity: string, id: string, rev: number): string {
  return `log/${partyId}/${entity}/${id}/${String(rev).padStart(10, "0")}.json`;
}

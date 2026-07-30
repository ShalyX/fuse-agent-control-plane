import { createHash } from "node:crypto";

export interface BoundedBody {
  bytes: Buffer;
  sha256: string;
}

/** Reads incrementally and cancels the stream immediately once the cap is exceeded. */
export async function readBoundedBody(response: Response, maximumBytes = 1_048_576): Promise<BoundedBody> {
  if (!response.body) return { bytes: Buffer.alloc(0), sha256: createHash("sha256").digest("hex") };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("RESPONSE_BODY_OVERSIZED").catch(() => undefined);
        throw new Error("RESPONSE_BODY_OVERSIZED");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, length);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

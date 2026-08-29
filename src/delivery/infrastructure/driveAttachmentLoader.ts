import type { EmailOutboxAttachment } from "@diskd-ai/sdk";
import { Err, Ok, type Result } from "../../domain/result.js";

const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

type DriveDownloadResult = {
  readonly stream: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly mimeType: string | null;
};

type DriveDownloadPort = {
  readonly download: {
    readonly file: (input: { readonly path: string }) => Promise<DriveDownloadResult>;
  };
};

export type LoadedEmailAttachment = {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
};

export type DriveAttachmentLoadError =
  | {
      readonly kind: "AttachmentSizeExceeded";
      readonly path: string;
      readonly maxTotalBytes: number;
    }
  | {
      readonly kind: "AttachmentDownloadFailed";
      readonly path: string;
      readonly message: string;
    };

export type DriveAttachmentLoader = {
  readonly load: (
    attachments: readonly EmailOutboxAttachment[],
  ) => Promise<Result<DriveAttachmentLoadError, readonly LoadedEmailAttachment[]>>;
};

type DriveAttachmentLoaderOptions = {
  readonly maxTotalBytes?: number;
};

const causeMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const readBounded = async (
  attachment: EmailOutboxAttachment,
  download: DriveDownloadResult,
  bytesAlreadyLoaded: number,
  maxTotalBytes: number,
): Promise<Result<DriveAttachmentLoadError, Buffer>> => {
  if (download.size > maxTotalBytes - bytesAlreadyLoaded) {
    return Err({
      kind: "AttachmentSizeExceeded",
      path: attachment.path,
      maxTotalBytes,
    });
  }

  const reader = download.stream.getReader();
  const chunks: Uint8Array[] = [];
  let attachmentBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      attachmentBytes += chunk.value.byteLength;
      if (bytesAlreadyLoaded + attachmentBytes > maxTotalBytes) {
        await reader.cancel("attachment size limit exceeded");
        return Err({
          kind: "AttachmentSizeExceeded",
          path: attachment.path,
          maxTotalBytes,
        });
      }
      chunks.push(chunk.value);
    }
    return Ok(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  } catch (cause) {
    return Err({
      kind: "AttachmentDownloadFailed",
      path: attachment.path,
      message: causeMessage(cause),
    });
  } finally {
    reader.releaseLock();
  }
};

export const buildDriveAttachmentLoader = (
  drive: DriveDownloadPort,
  options: DriveAttachmentLoaderOptions = {},
): DriveAttachmentLoader => {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  return {
    load: async (attachments) => {
      const loaded: LoadedEmailAttachment[] = [];
      let bytesLoaded = 0;
      for (const attachment of attachments) {
        let download: DriveDownloadResult;
        try {
          download = await drive.download.file({ path: attachment.path });
        } catch (cause) {
          return Err({
            kind: "AttachmentDownloadFailed",
            path: attachment.path,
            message: causeMessage(cause),
          });
        }
        const content = await readBounded(attachment, download, bytesLoaded, maxTotalBytes);
        if (content.tag === "Err") return content;
        bytesLoaded += content.value.byteLength;
        loaded.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: content.value,
        });
      }
      return Ok(loaded);
    },
  };
};

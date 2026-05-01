import type { StoredAttachment, StoredEmailPayload } from "./payloadTypes.js";

export type StoredAttachmentRef = {
  readonly attachmentId: string;
  readonly driveInode: string;
  readonly storedSizeBytes: number;
  readonly storedAt: string;
};

export type UploadAttachmentResult = StoredAttachmentRef;

export const attachmentIdFor = (uidValidity: number, uid: number, partId: string): string =>
  `${uidValidity}:${uid}:${partId}`;

export const withAttachmentId = (
  attachment: StoredAttachment,
  uidValidity: number,
  uid: number,
): StoredAttachment & { readonly attachmentId: string } => ({
  ...attachment,
  attachmentId: attachment.attachmentId ?? attachmentIdFor(uidValidity, uid, attachment.partId),
});

export const patchAttachmentStorageRef = (
  payload: StoredEmailPayload,
  attachmentId: string,
  ref: StoredAttachmentRef,
): StoredEmailPayload => ({
  ...payload,
  attachments: payload.attachments.map((attachment) =>
    (attachment.attachmentId ??
      attachmentIdFor(payload.uidValidity, payload.uid, attachment.partId)) === attachmentId
      ? {
          ...attachment,
          attachmentId,
          driveInode: ref.driveInode,
          storedSizeBytes: ref.storedSizeBytes,
          storedAt: ref.storedAt,
        }
      : attachment,
  ),
});

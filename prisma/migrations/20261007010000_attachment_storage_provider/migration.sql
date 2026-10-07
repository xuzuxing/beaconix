-- Add storage metadata for first-party attachment uploads.
CREATE TYPE "AttachmentStorageProvider" AS ENUM ('LOCAL', 'OSS', 'EXTERNAL');

ALTER TABLE "attachments"
    ADD COLUMN "storageProvider" "AttachmentStorageProvider" NOT NULL DEFAULT 'LOCAL',
    ADD COLUMN "bucket" TEXT,
    ADD COLUMN "checksum" TEXT;

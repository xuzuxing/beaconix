-- DropIndex
DROP INDEX "rum_perf_buckets_appId_metric_bucketStart_idx";

-- DropIndex
DROP INDEX "rum_perf_buckets_appId_metric_page_dimension_bucketStart_key";

-- AlterTable
ALTER TABLE "rum_perf_buckets" ADD COLUMN     "release" TEXT NOT NULL DEFAULT '*';

-- CreateIndex
CREATE INDEX "rum_perf_buckets_appId_metric_release_bucketStart_idx" ON "rum_perf_buckets"("appId", "metric", "release", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "rum_perf_buckets_appId_metric_page_dimension_release_bucket_key" ON "rum_perf_buckets"("appId", "metric", "page", "dimension", "release", "bucketStart");


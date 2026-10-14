export const METRICS_RECORDER = 'OMNI_METRICS_RECORDER';

export type MetricObservation =
    | {
          kind: 'db';
          model: string;
          action: string;
          durationSeconds: number;
          success: boolean;
      }
    | {
          kind: 'cache';
          cacheName: 'redis' | 'memory' | 'multi_level';
          result: 'hit' | 'miss' | 'error';
      }
    | { kind: 'connection'; type: 'redis'; ready: boolean };

/** Optional, non-throwing collection boundary for low-level packages. */
export interface MetricsRecorder {
    record(observation: MetricObservation): void;
}

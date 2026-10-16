import type { Container } from '../../platform/container.js';
import { PerformanceService } from './application/performance-service.js';
import { PerformanceRepository } from './infrastructure/repository.js';

/** Composition root of the performance module (lazy: `Container.modules.performance`). */
export function buildPerformanceModule(c: Container) {
  return {
    service: new PerformanceService({
      reader: new PerformanceRepository(c.db),
      clock: () => new Date(),
    }),
  };
}

import { createTicketPublicIntakeService, type PublicTicketIntakeSecurity } from '../services/ticketPublicIntakeService.js';
import type { TicketPublicIntakeStore, PublicTicketIntakeGuard } from '../store/ticketPublicIntakeStore.js';
import { createTicketPublicIntakeRouter, type TicketIntakeAddressResolver } from './ticketPublicIntakeController.js';

export interface TicketPublicIntakeRouteDependencies {
  /** Must provide durable, atomic budgets and inquiry persistence. */
  store: TicketPublicIntakeStore;
  /** Exact-origin admission and HMAC-derived source identity; no allow-all adapter. */
  guard: PublicTicketIntakeGuard;
  /** Server-only HMAC key ring and request-admission lifetime. */
  security: PublicTicketIntakeSecurity;
  /** Socket/trusted-proxy resolver; never a raw X-Forwarded-For parser. */
  resolveRemoteAddress: TicketIntakeAddressResolver;
}

/**
 * Compose the single anonymous inquiry POST from injected application
 * dependencies. No singleton database, runtime config, network provider, or
 * route mount is created here. Keep unmounted until every dependency is real.
 */
export function createTicketPublicIntakeRouteBoundary(dependencies: TicketPublicIntakeRouteDependencies) {
  const application = createTicketPublicIntakeService(
    dependencies.store, dependencies.guard, dependencies.security,
  );
  return createTicketPublicIntakeRouter(application, dependencies.resolveRemoteAddress);
}

import { createTicketPublicIntakeService, type PublicTicketIntakeSecurity } from '../services/ticketPublicIntakeService.js';
import type { TicketPublicIntakeStore, PublicTicketIntakeGuard } from '../store/ticketPublicIntakeStore.js';
import { createTicketPublicIntakeRouter, type TicketIntakeAddressResolver } from './ticketPublicIntakeController.js';

export interface TicketPublicIntakeRouteDependencies {
  /** Must provide durable, atomic budgets and inquiry persistence. */
  store: TicketPublicIntakeStore;
  /** Real provider/proof verifier; no bypass or local allow-all implementation. */
  guard: PublicTicketIntakeGuard;
  /** Server-only HMAC key ring and proof lifetime. */
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

import crypto from 'node:crypto';

/** Stable for one daemon lifetime; desktop launches provide a fresh instance ID. */
export const orchestrationSessionId = process.env.ALPHA_INSTANCE?.trim() ||
  `alpha-process-${process.pid}-${crypto.randomUUID()}`;

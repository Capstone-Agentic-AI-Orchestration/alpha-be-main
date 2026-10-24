import { z } from 'zod';

/** Fixed scanner capabilities, separate from repository-authored package scripts. */
export const dependencyAuditSpecSchema = z.object({
  scanner: z.literal('npm'),
  purpose: z.enum(['baseline', 'verification', 'self-check']),
  level: z.enum(['low', 'moderate', 'high', 'critical']).default('low')
}).strict();
export type DependencyAuditSpec = z.infer<typeof dependencyAuditSpecSchema>;

export const dependencyAuditEvidenceSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^audit-[a-f0-9-]{36}$/),
  taskId: z.string(), repository: z.string(), sourceCommit: z.string(), inputHash: z.string(),
  resolvedLockHash: z.string(), resolvedFromManifest: z.boolean(), createdAt: z.string(),
  scanner: z.literal('npm'), scannerVersion: z.string(), registry: z.string(),
  purpose: dependencyAuditSpecSchema.shape.purpose, level: dependencyAuditSpecSchema.shape.level,
  status: z.enum(['clean', 'findings', 'error']), passesPolicy: z.boolean(),
  counts: z.record(z.number()),
  findings: z.array(z.object({
    package: z.string(), severity: z.string(), range: z.string(),
    direct: z.boolean(), nodes: z.array(z.string()), advisories: z.array(z.string()),
    fixAvailable: z.union([z.boolean(), z.object({ name: z.string(), version: z.string(), isSemVerMajor: z.boolean() })])
  }).strict()).max(200),
  error: z.string().optional()
}).strict();
export type DependencyAuditEvidence = z.infer<typeof dependencyAuditEvidenceSchema>;

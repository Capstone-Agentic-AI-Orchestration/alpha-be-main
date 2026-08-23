import fs from 'node:fs';
import path from 'node:path';
import { AUDIT_LOG_PATH, LOGS_DIR } from '../config/env.js';

// Ensure log directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function logAudit(action: string, metadata: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${action}] ${JSON.stringify(metadata)}\n`;
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, entry, 'utf8');
  } catch (err) {
    console.error('Failed to write to audit log:', err);
  }
}

export function logInfo(message: string, ...args: any[]) {
  console.log(`[INFO] ${message}`, ...args);
}

export function logError(message: string, ...args: any[]) {
  console.error(`[ERROR] ${message}`, ...args);
}

/**
 * Reads the appointment-email-monitor state produced by the Hermes cron.
 * This is display-only: GeekShop HQ does not send emails or create calendar
 * events from this helper. It just surfaces what the monitor is seeing.
 */

import { readFileSync, existsSync } from 'node:fs';

export function readJsonSafe(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function readJsonlTail(path, limit = 5) {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
  } catch {
    return [];
  }
}

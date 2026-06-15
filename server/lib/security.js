/**
 * Security utilities: sensitive setting masking, random session id, etc.
 */

import { randomBytes } from 'node:crypto';

const SENSITIVE_KEYS = new Set([
  'smtp_pass', 'gmail_refresh_token', 'openai_api_key', 'gemini_api_key',
  'twilio_token', 'twilio_auth_token', 'jwt_secret', 'admin_session_secret',
  'firebase_service_account',
]);

export function maskSensitive(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (SENSITIVE_KEYS.has(k.toLowerCase()) && v) {
      out[k] = '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function newSessionId() {
  return randomBytes(24).toString('hex');
}

export function isProduction() {
  return process.env.NODE_ENV === 'production';
}

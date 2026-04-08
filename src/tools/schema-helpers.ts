/**
 * Shared Zod schema coercion helpers for MCP tool registrations.
 *
 * These preprocessors handle the fact that MCP parameters often arrive as strings
 * even when the schema expects numbers, booleans, or arrays.
 */

import { z } from 'zod';

/** Coerce string → number (e.g. "42" → 42) */
export const cNum = () => z.preprocess(
  (v) => typeof v === 'string' && v.trim() !== '' ? Number(v) : v,
  z.number(),
);

/** Coerce string → boolean (e.g. "true" → true, "0" → false) */
export const cBool = () => z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
    return v;
  },
  z.boolean(),
);

/** Coerce JSON string → array (e.g. '["a","b"]' → ["a","b"]) */
export const cArr = <T extends z.ZodTypeAny>(item: T) => z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : v;
    } catch {
      return v;
    }
  },
  z.array(item),
);

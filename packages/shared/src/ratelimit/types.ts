import { bucketFor, planLimits, type PlanId } from '../plans.js';

export interface RateLimitInput extends RateLimitContext {
  cost?: number;
}

export interface RateLimitContext {
  tenantId: string;
  plan: PlanId;
  routeClass: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  /** Which backend served the decision (surfaced as a metric + debug header). */
  backend: 'redis' | 'memory' | 'disabled';
  key: string;
}

/**
 * A limiter backend. Two implementations ship with this repo:
 * Redis+Lua (multi-replica correct) and in-memory (single-process, used for
 * tests, local dev without Docker, and as the degraded fallback).
 */
export interface RateLimiterBackend {
  readonly kind: 'redis' | 'memory';
  consume(input: RateLimitInput): Promise<RateLimitDecision>;
  /** Drop a tenant's bucket (plan change, support action, test setup). */
  reset(ctx: RateLimitContext): Promise<void>;
  close(): Promise<void>;
}

/** Redis key for a tenant's bucket: `rl:{tenant}:{routeClass}`. */
export function rateLimitKey(tenantId: string, routeClass: string): string {
  return `rl:${tenantId}:${routeClass}`;
}

export function geometryFor(plan: PlanId, routeClass: string) {
  return bucketFor(plan, routeClass);
}

export function limitsFor(plan: string | null | undefined) {
  return planLimits(plan);
}

// Consistent error envelope for the whole REST surface. Every error response carries a stable
// machine code, a human message, and the request's correlation id (so a client can quote it to
// support / the future debug tool).
import type { Context } from "hono";

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "not_ready"
  | "upstream_unavailable"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  not_ready: 503,
  upstream_unavailable: 503,
  internal: 500,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(c: Context, err: ApiError) {
  const correlationId = c.get("cid") ?? "unknown";
  const body: ErrorBody = {
    error: { code: err.code, message: err.message, correlationId, ...(err.details ? { details: err.details } : {}) },
  };
  return c.json(body, STATUS[err.code] as 400 | 401 | 404 | 500 | 503);
}

const MARKET_ID_RE = /^0x[0-9a-fA-F]{64}$/;
export function assertMarketId(id: string): string {
  if (!MARKET_ID_RE.test(id)) {
    throw new ApiError("bad_request", `Invalid market id "${id}" (expected 0x + 64 hex chars)`);
  }
  return id;
}

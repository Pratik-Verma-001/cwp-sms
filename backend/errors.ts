export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function errorResult(err: ApiError, requestId: string): HttpResult {
  return {
    status: err.status,
    body: {
      error: { code: err.code, message: err.message, requestId, retryable: err.retryable },
    },
  };
}

/** Never leak internals: unknown errors become a generic 500. */
export function toErrorResult(err: unknown, requestId: string): HttpResult {
  if (err instanceof ApiError) return errorResult(err, requestId);
  return errorResult(new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.", true), requestId);
}

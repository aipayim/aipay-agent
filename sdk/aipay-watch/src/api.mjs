// Thin client for the AIPAY merchant API.
//
// Only three calls: list the merchant's pending orders once per pass, report a
// transaction hash, and optionally mark the merchant as running a watcher (so
// AIPAY stops spending its own sweep quota on these orders).
//
// The SDK never decides that a payment is real. `confirm` is an *attestation*:
// the server re-reads the receipt/transfer/recipient/amount/depth and answers
// 200 (confirmed), 202 (seen, not deep enough) or 409 (does not pay this order).

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createApiClient({ apiKey, apiBase = 'https://api.aipay.im', fetchImpl = fetch, timeoutMs = 15_000 }) {
  if (!apiKey || !/^aipay_sk_/.test(apiKey)) {
    throw new Error('AIPAY_API_KEY must be a merchant API key (aipay_sk_…).');
  }
  const base = apiBase.replace(/\/+$/, '');

  async function call(path, { method = 'GET', body, auth = true } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(auth ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const error = payload?.error ?? {};
        throw new ApiError(
          response.status,
          error.code ?? `http_${response.status}`,
          error.message ?? `Request failed with HTTP ${response.status}.`,
          { ...error.details, retryAfter: response.headers.get('retry-after') },
        );
      }
      return { status: response.status, body: payload };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Every pending order, paginated. Called **once per start-up**, not in the
     * loop: the point of this SDK is that nobody polls the API.
     */
    async listPendingOrders({ limit = 100 } = {}) {
      const orders = [];
      let cursor = null;
      for (let page = 0; page < 20; page += 1) {
        const query = `status=pending&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
        const { body } = await call(`/v1/orders?${query}`);
        const rows = Array.isArray(body?.orders) ? body.orders : [];
        orders.push(...rows);
        cursor = body?.nextCursor ?? null;
        if (!cursor) break;
      }
      return orders;
    },

    /** Report a transaction hash. The server decides what it means. */
    confirm(reference, txHash) {
      return call(`/v1/orders/${encodeURIComponent(reference)}/confirm`, {
        method: 'POST',
        body: { txHash },
      });
    },

    /** Ask AIPAY to stop sweeping this merchant's pending orders. */
    setWatcher(enabled) {
      return call('/v1/merchants/me', { method: 'PATCH', body: { watcher: Boolean(enabled) } });
    },

    /** Read-only profile (quota, watcher flag, notification readiness). */
    async me() {
      const { body } = await call('/v1/merchants/me');
      return body?.merchant ?? body;
    },
  };
}

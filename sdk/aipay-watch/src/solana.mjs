// Solana half of the watcher.
//
// A cloud Solana order carries no per-order on-chain reference (the reference is
// our `ap_…` id), so discovery means: read the merchant's recent signatures,
// parse each transaction, and look for a balance delta that pays the merchant at
// least the order amount. The server re-reads the same transaction before it
// confirms anything, so a wrong candidate is a rejected request, never money
// moving.

function accountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(keys)) return [];
  return keys
    .map((entry) => (typeof entry === 'string' ? entry : typeof entry?.pubkey === 'string' ? entry.pubkey : ''))
    .filter((entry) => entry !== '');
}

/**
 * Amount the recipient actually received in this transaction.
 * SPL: positive `postTokenBalances` deltas for (mint, owner).
 * Native: positive lamport deltas of the recipient's account key.
 * Returns `{ ok, amountBaseUnits, reason? }` — same shape as the server's check.
 */
export function matchSolanaTransaction(tx, { recipient, tokenAddress, expectedBaseUnits }) {
  const meta = tx?.meta;
  if (!meta || typeof meta !== 'object') {
    return { ok: false, amountBaseUnits: '0', reason: 'transaction meta unavailable' };
  }
  const expected = BigInt(expectedBaseUnits);

  if (!tokenAddress || tokenAddress === 'native') {
    const keys = accountKeys(tx);
    if (keys.length === 0) return { ok: false, amountBaseUnits: '0', reason: 'account keys unavailable' };
    let delta = BigInt(0);
    keys.forEach((key, index) => {
      if (key !== recipient) return;
      const after = BigInt(meta.postBalances?.[index] ?? 0);
      const before = BigInt(meta.preBalances?.[index] ?? 0);
      delta += after - before;
    });
    if (delta <= BigInt(0)) return { ok: false, amountBaseUnits: '0', reason: 'no native transfer to the recipient' };
    if (delta < expected) return { ok: false, amountBaseUnits: delta.toString(), reason: 'underpays the order' };
    return { ok: true, amountBaseUnits: delta.toString() };
  }

  const pre = new Map();
  for (const entry of Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : []) {
    pre.set(Number(entry?.accountIndex), entry);
  }
  let received = BigInt(0);
  for (const entry of Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : []) {
    if (entry?.mint !== tokenAddress || entry?.owner !== recipient) continue;
    const after = BigInt(entry?.uiTokenAmount?.amount ?? '0');
    const before = BigInt(pre.get(Number(entry?.accountIndex))?.uiTokenAmount?.amount ?? '0');
    if (after > before) received += after - before;
  }
  if (received <= BigInt(0)) return { ok: false, amountBaseUnits: '0', reason: 'no SPL transfer to the recipient' };
  if (received < expected) return { ok: false, amountBaseUnits: received.toString(), reason: 'underpays the order' };
  return { ok: true, amountBaseUnits: received.toString() };
}

async function rpc(url, method, params, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 10_000);
  try {
    const response = await (options?.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = await response.json();
    if (body && body.error) throw new Error(`${method}: ${body.error.message ?? 'rpc error'}`);
    return body?.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Recent signatures touching an address, newest first. */
export async function recentSignatures(url, address, { limit = 25 } = {}, options = {}) {
  const result = await rpc(
    url,
    'getSignaturesForAddress',
    [address, { limit, commitment: 'confirmed' }],
    options,
  );
  if (!Array.isArray(result)) return [];
  return result
    .filter((entry) => typeof entry?.signature === 'string')
    .map((entry) => ({
      signature: entry.signature,
      slot: typeof entry.slot === 'number' ? entry.slot : null,
      failed: entry.err !== null && entry.err !== undefined,
    }));
}

export async function transaction(url, signature, options = {}) {
  return rpc(
    url,
    'getTransaction',
    [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    options,
  );
}

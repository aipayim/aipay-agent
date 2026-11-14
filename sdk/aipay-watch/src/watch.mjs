// The watcher itself.
//
// Division of labour, stated once so it cannot drift:
//   - this process discovers a transaction with the merchant's own RPC quota;
//   - it reports **only the hash** to AIPAY;
//   - AIPAY re-reads the chain and decides. Nothing here can confirm a payment.
//
// There is no polling of the AIPAY API in the loop. The order list is read once
// at start-up (and optionally every `reconcileMs`, five minutes by default —
// a reconciliation heartbeat, not a poll), because the chain is what changes
// second to second.
import { latestBlock, matchTransferLogs, transferLogs, isNativeAsset } from './evm.mjs';
import { matchSolanaTransaction, recentSignatures, transaction } from './solana.mjs';
import { createApiClient, ApiError } from './api.mjs';

export const DEFAULT_INTERVAL_MS = 8_000;
export const DEFAULT_RECONCILE_MS = 5 * 60_000;
export const DEFAULT_LOOKBACK_BLOCKS = 5_000;
export const DEFAULT_MAX_SIGNATURES = 25;

function groupKey(chainKey, recipient, tokenAddress) {
  return `${chainKey}|${recipient}|${tokenAddress || 'native'}`;
}

/**
 * Create a watcher without starting it.
 *
 * Options:
 *   apiKey          merchant API key (aipay_sk_…) — required unless readOnly
 *   apiBase         default https://api.aipay.im
 *   rpcUrls         { [chainKey]: url } — your own RPC endpoints
 *   chains          restrict to these chain keys (default: every chain in use)
 *   intervalMs      chain scan interval (default 8s)
 *   reconcileMs     pending-order reconciliation interval (default 5min, 0 = off)
 *   readOnly        discover and report through callbacks only, never call /confirm
 *   lookbackBlocks  how far back to start when no state is found (default 5000)
 *   statePath       optional JSON file where lastScannedBlock is kept
 *   confirmBudgetMs minimum gap between two confirm calls (default 0)
 */
export function createWatcher(options = {}) {
  const {
    apiKey,
    apiBase = 'https://api.aipay.im',
    rpcUrls = {},
    chains = null,
    intervalMs = DEFAULT_INTERVAL_MS,
    reconcileMs = DEFAULT_RECONCILE_MS,
    readOnly = false,
    lookbackBlocks = DEFAULT_LOOKBACK_BLOCKS,
    maxSignatures = DEFAULT_MAX_SIGNATURES,
    statePath = null,
    fetchImpl = fetch,
    log = () => {},
    onDiscover = () => {},
    onReport = () => {},
    onError = () => {},
  } = options;

  if (!readOnly && !apiKey) throw new Error('apiKey is required unless readOnly is true.');
  const api = apiKey ? createApiClient({ apiKey, apiBase, fetchImpl }) : null;
  const allowed = chains && chains.length ? new Set(chains) : null;

  /** reference -> order (only orders still considered pending). */
  const orders = new Map();
  /** `${reference}|${txHash}` — never report the same pair twice. */
  const reported = new Set();
  /** One transaction can only settle one order, so report each hash once. */
  const claimedTx = new Set();
  /** chainKey -> { lastBlock } */
  const evmState = new Map();
  /** `${recipient}|${mint}` -> Set(signature) */
  const seenSignatures = new Map();
  let running = false;
  let stopped = false;
  let timer = null;
  let lastReconcile = 0;
  let confirmPausedUntil = 0;
  const stats = { discovered: 0, confirmed: 0, rejected: 0, rateLimited: 0, errors: 0 };

  function remember(order) {
    if (!order?.reference) return;
    if (allowed && !allowed.has(order.chainKey)) return;
    if (order.status && order.status !== 'pending') return;
    orders.set(order.reference, {
      reference: order.reference,
      chainKey: order.chainKey,
      recipient: order.recipient,
      tokenAddress: order.tokenAddress || 'native',
      amountBaseUnits: String(order.amountBaseUnits ?? '0'),
      createdAt: order.createdAt ?? Date.now(),
    });
  }

  async function reconcile() {
    if (!api) return 0;
    const rows = await api.listPendingOrders();
    orders.clear();
    for (const row of rows) remember(row);
    lastReconcile = Date.now();
    log(`reconciled: ${orders.size} pending order(s)`);
    return orders.size;
  }

  function groups() {
    const byKey = new Map();
    for (const order of orders.values()) {
      const key = groupKey(order.chainKey, order.recipient, order.tokenAddress);
      const entry = byKey.get(key) ?? { chainKey: order.chainKey, recipient: order.recipient, token: order.tokenAddress, orders: [] };
      entry.orders.push(order);
      byKey.set(key, entry);
    }
    return [...byKey.values()];
  }

  /** Report a hash and interpret the server's answer. Never throws upward. */
  async function report(order, txHash, chainKey) {
    const key = `${order.reference}|${txHash}`;
    if (reported.has(key) || claimedTx.has(txHash)) return;
    reported.add(key);
    claimedTx.add(txHash);
    stats.discovered += 1;
    onDiscover({ reference: order.reference, txHash, chainKey });

    if (readOnly || !api) {
      log(`[read-only] ${chainKey} ${order.reference} <- ${txHash} (not reported)`);
      return;
    }
    if (Date.now() < confirmPausedUntil) {
      // A previous 429 asked us to wait; the hash is not lost, the next
      // reconciliation will pick the order up again if it is still pending.
      reported.delete(key);
      return;
    }
    try {
      const { status, body } = await api.confirm(order.reference, txHash);
      onReport({ reference: order.reference, txHash, chainKey, httpStatus: status, body });
      if (status === 200 && body?.order?.status === 'confirmed') {
        stats.confirmed += 1;
        orders.delete(order.reference);
        log(`confirmed ${order.reference} (${chainKey}) ${txHash}`);
        return;
      }
      // 202: the transfer exists but the server wants more depth. Keep the order
      // pending; the next pass re-reports it (it is a different attempt).
      log(`seen, waiting for depth ${order.reference} (${chainKey}) ${txHash}`);
      reported.delete(key);
    } catch (error) {
      reported.delete(key);
      if (error instanceof ApiError && error.status === 409) {
        stats.rejected += 1;
        // This hash does not pay this order. Do not retry the pair, but do not
        // give up on the order: another transfer may still be coming.
        reported.add(key);
        log(`rejected ${order.reference} (${chainKey}) ${txHash}: ${error.code}`);
        return;
      }
      if (error instanceof ApiError && error.status === 429) {
        stats.rateLimited += 1;
        const retryAfter = Number(error.details?.retryAfter);
        confirmPausedUntil = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
        log(`confirm budget reached; pausing reports until ${new Date(confirmPausedUntil).toISOString()}`);
        return;
      }
      stats.errors += 1;
      onError(error);
      log(`report failed ${order.reference}: ${error.message}`);
    }
  }

  /** Pick the oldest still-pending order this transfer could be paying. */
  function claim(entry, txHash, amountBaseUnits) {
    const amount = BigInt(amountBaseUnits);
    const candidates = entry.orders
      .filter((order) => !reported.has(`${order.reference}|${txHash}`))
      .filter((order) => {
        try {
          return BigInt(order.amountBaseUnits) <= amount;
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    return candidates[0] ?? null;
  }

  const nativeWarned = new Set();

  async function scanEvm(entry) {
    const url = rpcUrls[entry.chainKey];
    if (!url) return;
    if (isNativeAsset(entry.token)) {
      // No logs exist for a native transfer, and guessing from balances would be
      // dishonest. Native orders need the transaction hash (see README).
      if (!nativeWarned.has(entry.chainKey)) {
        nativeWarned.add(entry.chainKey);
        log(`${entry.chainKey}: native-coin orders are not discovered by this watcher — confirm them by tx hash`);
      }
      return;
    }
    const head = await latestBlock(url, { fetchImpl });
    const state = evmState.get(entry.chainKey) ?? { lastBlock: Math.max(0, head - lookbackBlocks) };
    evmState.set(entry.chainKey, state);
    const fromBlock = Math.max(state.lastBlock + 1, 0);
    if (fromBlock > head) return;

    const logs = await transferLogs(
      url,
      { tokenAddress: entry.token, recipientAddress: entry.recipient, fromBlock, toBlock: head },
      { fetchImpl },
    );
    state.lastBlock = head;
    await persistState();

    // Amount filtering happens in `claim`: a transfer may be larger than one
    // order and smaller than another, and several orders can share a token.
    const candidates = matchTransferLogs(logs, {
      tokenAddress: entry.token,
      recipientAddress: entry.recipient,
      expectedBaseUnits: BigInt(0),
    });
    for (const candidate of candidates) {
      const order = claim(entry, candidate.txHash, candidate.amount.toString());
      if (!order) continue;
      await report(order, candidate.txHash, entry.chainKey);
    }
  }

  async function scanSolana(entry) {
    const url = rpcUrls[entry.chainKey];
    if (!url) return;
    const seenKey = `${entry.recipient}|${entry.token}`;
    const seen = seenSignatures.get(seenKey) ?? new Set();
    seenSignatures.set(seenKey, seen);

    const signatures = await recentSignatures(url, entry.recipient, { limit: maxSignatures }, { fetchImpl });
    for (const entrySig of signatures) {
      if (entrySig.failed || seen.has(entrySig.signature)) continue;
      seen.add(entrySig.signature);
      const tx = await transaction(url, entrySig.signature, { fetchImpl });
      for (const order of entry.orders) {
        const match = matchSolanaTransaction(tx, {
          recipient: order.recipient,
          tokenAddress: order.tokenAddress,
          expectedBaseUnits: order.amountBaseUnits,
        });
        if (!match.ok) continue;
        await report(order, entrySig.signature, entry.chainKey);
        break;
      }
    }
    // Keep the set from growing without bound on a long-running process.
    if (seen.size > maxSignatures * 20) {
      const trimmed = [...seen].slice(-maxSignatures * 10);
      seenSignatures.set(seenKey, new Set(trimmed));
    }
  }

  async function persistState() {
    if (!statePath) return;
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(statePath, `${JSON.stringify({ blocks: Object.fromEntries(evmState) }, null, 2)}\n`, 'utf8');
    } catch (error) {
      onError(error);
    }
  }

  async function loadState() {
    if (!statePath) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const parsed = JSON.parse(await readFile(statePath, 'utf8'));
      for (const [chainKey, value] of Object.entries(parsed?.blocks ?? {})) {
        if (typeof value?.lastBlock === 'number') evmState.set(chainKey, { lastBlock: value.lastBlock });
      }
      log(`resumed lastScannedBlock for ${evmState.size} chain(s)`);
    } catch {
      // No state yet: start from `lookbackBlocks` behind the head.
    }
  }

  async function pass() {
    if (reconcileMs > 0 && Date.now() - lastReconcile >= reconcileMs) {
      await reconcile().catch((error) => {
        stats.errors += 1;
        onError(error);
        log(`reconcile failed: ${error.message}`);
      });
    }
    for (const entry of groups()) {
      try {
        if (entry.chainKey === 'solana') await scanSolana(entry);
        else await scanEvm(entry);
      } catch (error) {
        stats.errors += 1;
        onError(error);
        log(`scan failed ${entry.chainKey} ${entry.recipient}: ${error.message}`);
      }
    }
  }

  async function start({ once = false } = {}) {
    if (running) return stats;
    running = true;
    stopped = false;
    await loadState();
    await reconcile();
    do {
      await pass();
      if (once) break;
      if (stopped) break;
      await new Promise((resolve) => {
        timer = setTimeout(resolve, intervalMs);
      });
    } while (!stopped);
    running = false;
    return stats;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start,
    stop,
    reconcile,
    track: (order) => remember(order),
    untrack: (reference) => orders.delete(reference),
    pending: () => [...orders.values()],
    stats: () => ({ ...stats }),
  };
}

/** Convenience: create and run until stopped. */
export async function watch(options = {}) {
  const watcher = createWatcher(options);
  const stats = await watcher.start({ once: options.once });
  return { ...watcher, stats: () => ({ ...stats }) };
}

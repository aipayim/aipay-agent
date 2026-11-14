// EVM half of the watcher: one `eth_getLogs` per (token, recipient) per pass.
//
// The matching rules are the same ones the server applies when it re-reads the
// transaction (see src/lib/payment/evmLogMatch.ts in the private repo):
// ERC-20 `Transfer` = exactly 3 topics, topic[0] is the Transfer hash, topic[2]
// is the order recipient, and the amount must be at least what the order asks
// for. This module only *finds* a candidate — the server still decides whether
// that transaction pays the order.

export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Native coin has no logs; the SDK does not guess, it asks for the hash. */
export function isNativeAsset(tokenAddress) {
  return !tokenAddress || String(tokenAddress).toLowerCase() === 'native';
}

function padAddress(address) {
  return `0x${String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function parseAmount(data) {
  if (typeof data !== 'string') return null;
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(data.trim())) return null;
  try {
    return BigInt(data.trim());
  } catch {
    return null;
  }
}

/**
 * Filter raw `eth_getLogs` output down to transfers of `tokenAddress` to
 * `recipientAddress` worth at least `expectedBaseUnits`.
 * Returns one candidate per transaction hash (the largest matching transfer).
 */
export function matchTransferLogs(logs, { tokenAddress, recipientAddress, expectedBaseUnits }) {
  if (!Array.isArray(logs)) return [];
  const token = String(tokenAddress).toLowerCase();
  const recipient = `0x${String(recipientAddress).toLowerCase().replace(/^0x/, '')}`;
  const expected = BigInt(expectedBaseUnits);
  const best = new Map();

  for (const raw of logs) {
    if (!raw || typeof raw !== 'object') continue;
    if (typeof raw.address !== 'string' || raw.address.toLowerCase() !== token) continue;
    const topics = Array.isArray(raw.topics) ? raw.topics : [];
    if (topics.length !== 3) continue; // ERC-20 Transfer only; ERC-721 has 4
    if (String(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (`0x${String(topics[2]).slice(-40).toLowerCase()}` !== recipient) continue;

    const amount = parseAmount(raw.data);
    if (amount === null || amount < expected) continue;

    const txHash = typeof raw.transactionHash === 'string' ? raw.transactionHash : '';
    if (!txHash) continue;
    const seen = best.get(txHash);
    if (!seen || amount > seen.amount) best.set(txHash, { txHash, amount });
  }

  return [...best.values()];
}

/** Minimal JSON-RPC POST. Errors are thrown; callers decide how to back off. */
export async function jsonRpc(url, method, params, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
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

export async function latestBlock(url, options = {}) {
  const result = await jsonRpc(url, 'eth_blockNumber', [], options);
  const value = typeof result === 'string' ? Number.parseInt(result, 16) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error('eth_blockNumber returned no height');
  return value;
}

export async function transferLogs(
  url,
  { tokenAddress, recipientAddress, fromBlock, toBlock },
  options = {},
) {
  return jsonRpc(
    url,
    'eth_getLogs',
    [
      {
        address: tokenAddress,
        topics: [ERC20_TRANSFER_TOPIC, null, padAddress(recipientAddress)],
        fromBlock: `0x${Math.max(0, Math.floor(fromBlock)).toString(16)}`,
        toBlock: toBlock === 'latest' ? 'latest' : `0x${Math.max(0, Math.floor(toBlock)).toString(16)}`,
      },
    ],
    options,
  );
}

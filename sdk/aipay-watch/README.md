# aipay-watch

Merchant-side watcher for **AIPAY cloud orders**. It discovers a payment with
your own RPC quota and reports **only the transaction hash**; AIPAY re-reads the
chain and decides. Nothing in this package can confirm a payment, hold a key or
move funds.

Use it when you want confirmations in seconds instead of the 10–60 s server
sweep, or when you have marked your merchant as `watcher: true` (which stops the
AIPAY cron from scanning your pending orders at all — then this SDK, or a payer's
browser, is what discovers the payment).

## What it does

1. On start-up, reads your pending orders **once** (`GET /v1/orders?status=pending`).
   After that it does not poll the API; the chain is what changes.
2. Every `--interval` ms (default 8 s) it scans only your own receiving address:
   - **EVM**: `eth_getLogs` for the ERC-20 `Transfer` topic, filtered by token and
     recipient, from the last scanned block (remembered with `--state`).
   - **Solana**: `getSignaturesForAddress` on your address, then `getTransaction`
     and a balance-delta check for the order's mint (or native lamports).
3. When a transfer matches a pending order it calls
   `POST /v1/orders/:reference/confirm { txHash }` — one call per discovered
   payment, never twice for the same hash.
4. Server answers: `200` confirmed · `202` seen but not deep enough (retried
   later) · `409` that transaction does not pay this order (logged, not retried)
   · `429` per-credential budget reached (backs off, then continues).

Optional every-5-minutes reconciliation (`--reconcile`) exists because new
orders appear while the process runs. It is a heartbeat, not a poll loop.

## What it does not do

- **It cannot confirm anything.** A report is an attestation; the server re-reads
  the receipt, the recipient, the amount and the confirmation depth.
- **Tron is not supported.** TronGrid's indexed transfer list is a different
  protocol; those orders still settle through the server sweep.
- **Native-coin EVM orders are not guessed at.** There are no logs to scan, so
  they need a transaction hash (or a chain with an account indexer, which this
  SDK does not use). The CLI says so once per chain.
- **Solana detection matches on amount + recipient**, because an `ap_…` order has
  no per-order on-chain reference. Two identical pending amounts to one address
  are ambiguous — use distinct amounts (this is a AIPAY-wide caveat).

## Run it

```bash
# EVM merchant, own node
node bin/aipay-watch.mjs \
  --api-key "$AIPAY_API_KEY" \
  --rpc bsc=https://bsc-dataseed.binance.org \
  --state .aipay-watch-state.json

# Both families, read-only first: prints what it would report
node bin/aipay-watch.mjs --read-only \
  --rpc bsc=https://bsc-dataseed.binance.org,solana=https://api.mainnet-beta.solana.com

# One pass, for cron
node bin/aipay-watch.mjs --once --api-key "$AIPAY_API_KEY" --rpc bsc=https://…
```

`--register-watcher` additionally calls `PATCH /v1/merchants/me {"watcher":true}`
so AIPAY stops sweeping your pending orders. Only do that once this process is
running under a supervisor: while the flag is on, nobody else is looking.

## Embed it

```js
import { createWatcher } from 'aipay-watch';

const watcher = createWatcher({
  apiKey: process.env.AIPAY_API_KEY,
  rpcUrls: { bsc: process.env.BSC_RPC_URL },
  onDiscover: ({ reference, txHash }) => console.log('found', reference, txHash),
  onReport: ({ reference, httpStatus }) => console.log('server said', reference, httpStatus),
});
watcher.track({ reference: 'ap_…', chainKey: 'bsc', recipient: '0x…', tokenAddress: '0x…', amountBaseUnits: '12500000000000000000' });
await watcher.start();      // runs until watcher.stop() or SIGINT
```

`readOnly: true` keeps everything except the confirm call (and needs no API key).

## Distribution

No npm package by design (one less supply-chain surface). Download
`aipay-watch-<version>.tgz` from <https://aipay.im/downloads/> or the
`aipay-agent` GitHub release, verify the `.sha256`, and extract — or run
`install-sdk.sh`. The source in this directory is the same code that ships; the
tarball's file list and hashes are in `sdk-latest.json`.

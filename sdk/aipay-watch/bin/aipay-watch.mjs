#!/usr/bin/env node
// aipay-watch — merchant-side watcher for AIPAY cloud orders.
//
//   node bin/aipay-watch.mjs --api-key aipay_sk_… --rpc bsc=https://your-node \
//     [--chains bsc,solana] [--interval 8000] [--read-only] [--once] [--json]
//
// What it does: reads your pending orders once at start-up, then scans only your
// own receiving address with your own RPC quota. When it sees a matching
// transfer it posts **only the transaction hash** to AIPAY. AIPAY re-reads the
// chain and decides — this process can make discovery faster, never declare a
// payment.
import { createWatcher, DEFAULT_INTERVAL_MS, DEFAULT_RECONCILE_MS, DEFAULT_LOOKBACK_BLOCKS } from '../src/watch.mjs';

const USAGE = `aipay-watch — discover AIPAY cloud payments with your own RPC quota

Usage
  node bin/aipay-watch.mjs --api-key aipay_sk_… --rpc bsc=https://node.example

Options
  --api-key <key>       Merchant API key (env AIPAY_API_KEY)
  --api-base <url>      API base URL (env AIPAY_API_BASE, default https://api.aipay.im)
  --rpc <chain=url,...> RPC endpoints to use (env AIPAY_WATCH_RPC), e.g.
                        bsc=https://bsc-dataseed.binance.org,solana=https://api.mainnet-beta.solana.com
  --chains <list>       Only watch these chains (default: every chain you have orders on)
  --interval <ms>       Chain scan interval (default ${DEFAULT_INTERVAL_MS})
  --reconcile <ms>      Re-read pending orders every N ms (default ${DEFAULT_RECONCILE_MS}; 0 = start-up only)
  --lookback <blocks>   Initial EVM lookback when no state file exists (default ${DEFAULT_LOOKBACK_BLOCKS})
  --state <path>        Remember lastScannedBlock across restarts
  --read-only           Discover and print only; never call /confirm
  --register-watcher    PATCH /v1/merchants/me {watcher:true} so AIPAY stops sweeping you
  --once                Run a single pass and exit (useful for cron)
  --json                Emit one JSON object per event
  --quiet               Only warnings and errors
  --help                This text

The endpoint it calls is POST /v1/orders/:reference/confirm, which the server
answers with 200 (confirmed), 202 (seen, not deep enough) or 409 (does not pay
this order). confirm calls are budgeted at 120/minute; on 429 the watcher backs
off and retries later.`;

function parseArgs(argv) {
  const args = { chains: null, json: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    switch (arg) {
      case '--api-key': args.apiKey = next(); break;
      case '--api-base': args.apiBase = next(); break;
      case '--rpc': args.rpc = next(); break;
      case '--chains': args.chains = String(next() || '').split(',').map((v) => v.trim()).filter(Boolean); break;
      case '--interval': args.intervalMs = Number(next()); break;
      case '--reconcile': args.reconcileMs = Number(next()); break;
      case '--lookback': args.lookbackBlocks = Number(next()); break;
      case '--state': args.statePath = next(); break;
      case '--read-only': args.readOnly = true; break;
      case '--register-watcher': args.registerWatcher = true; break;
      case '--once': args.once = true; break;
      case '--json': args.json = true; break;
      case '--quiet': args.quiet = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function parseRpc(value) {
  if (!value) return {};
  const urls = {};
  for (const pair of String(value).split(',')) {
    const [chain, url] = pair.split('=');
    if (!chain || !url) throw new Error(`--rpc expects chain=url pairs, got "${pair}"`);
    urls[chain.trim()] = url.trim();
  }
  return urls;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const apiKey = args.apiKey || process.env.AIPAY_API_KEY || '';
const rpcUrls = parseRpc(args.rpc || process.env.AIPAY_WATCH_RPC || '');
if (Object.keys(rpcUrls).length === 0) {
  process.stderr.write('aipay-watch: at least one --rpc chain=url is required.\n\n' + USAGE + '\n');
  process.exit(2);
}
if (!apiKey && !args.readOnly) {
  process.stderr.write('aipay-watch: --api-key (or AIPAY_API_KEY) is required unless --read-only.\n');
  process.exit(2);
}

const json = Boolean(args.json);
const emit = (level, message, extra = {}) => {
  if (json) {
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), level, message, ...extra })}\n`);
    return;
  }
  if (args.quiet && level === 'info') return;
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`);
};

const watcher = createWatcher({
  apiKey,
  apiBase: args.apiBase || process.env.AIPAY_API_BASE || 'https://api.aipay.im',
  rpcUrls,
  chains: args.chains,
  intervalMs: Number.isFinite(args.intervalMs) && args.intervalMs > 0 ? args.intervalMs : DEFAULT_INTERVAL_MS,
  reconcileMs: Number.isFinite(args.reconcileMs) && args.reconcileMs >= 0 ? args.reconcileMs : DEFAULT_RECONCILE_MS,
  lookbackBlocks: Number.isFinite(args.lookbackBlocks) && args.lookbackBlocks >= 0 ? args.lookbackBlocks : DEFAULT_LOOKBACK_BLOCKS,
  readOnly: Boolean(args.readOnly),
  statePath: args.statePath || null,
  log: (message) => emit('info', message),
  onDiscover: ({ reference, txHash, chainKey }) =>
    emit('discover', `${chainKey} ${reference} <- ${txHash}`, { reference, txHash, chainKey }),
  onReport: ({ reference, httpStatus, body }) =>
    emit('report', `${reference} HTTP ${httpStatus}${body?.verification?.reason ? ` (${body.verification.reason})` : ''}`, {
      reference,
      httpStatus,
    }),
  onError: (error) => emit('error', error instanceof Error ? error.message : String(error)),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    emit('info', `${signal} received — stopping after this pass`);
    watcher.stop();
  });
}

try {
  if (args.registerWatcher && !args.readOnly) {
    const { createApiClient } = await import('../src/api.mjs');
    const api = createApiClient({
      apiKey,
      apiBase: args.apiBase || process.env.AIPAY_API_BASE || 'https://api.aipay.im',
    });
    await api.setWatcher(true);
    emit('info', 'registered: AIPAY stops sweeping this merchant (watcher: true)');
  }
  emit('info', `watching ${Object.keys(rpcUrls).join(', ')}${args.readOnly ? ' (read-only)' : ''}`);
  await watcher.start({ once: Boolean(args.once) });
  const stats = watcher.stats();
  emit('info', `done: discovered ${stats.discovered}, confirmed ${stats.confirmed}, rejected ${stats.rejected}, errors ${stats.errors}`);
  process.exit(stats.errors > 0 && stats.discovered === 0 ? 1 : 0);
} catch (error) {
  emit('error', error instanceof Error ? error.message : String(error));
  process.exit(1);
}

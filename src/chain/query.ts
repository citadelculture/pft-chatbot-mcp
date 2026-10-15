/** HTTP public reads only. Deliberately imports no wallet/transaction module. */
import { createHash } from "node:crypto";

const READ_METHODS = new Set([
  "account_info", "account_lines", "account_offers", "account_nfts",
  "book_offers", "amm_info", "nft_sell_offers",
]);

export class QueryError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "QueryError";
  }
}

export async function queryRpc(url: string, method: string, params: any): Promise<any> {
  if (!READ_METHODS.has(method)) throw new Error("Only public read methods are permitted");
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params: [params] }),
  });
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}: ${response.statusText}`);
  const json: any = await response.json();
  const result = json?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(`RPC ${method}: missing result object`);
  }
  if (typeof result.error === "string") {
    throw new QueryError(result.error, `RPC ${method}: ${result.error}: ${result.error_message ?? result.error}`);
  }
  if (result.status === "error" || result.error != null) throw new Error(`RPC ${method}: malformed error result`);
  return result;
}

export interface LedgerPin { ledger_hash?: string; ledger_index?: number }
export interface QueryPage {
  items: any[];
  marker: string | null;
  pin: LedgerPin;
}
const PAGE_METHODS = {
  account_lines: { field: "lines", min: 10, max: 400 },
  account_offers: { field: "offers", min: 10, max: 400 },
  account_nfts: { field: "account_nfts", min: 20, max: 400 },
  nft_sell_offers: { field: "offers", min: 50, max: 500 },
} as const;
const PREFIX = "pft-query-v1.";
const MAX_CURSOR = 32768;
interface Cursor {
  v: 1; scope: string; server_marker: any; offset: number; page_limit: number;
  pin: LedgerPin; fingerprint?: string;
}
function pinFrom(result: any): LedgerPin {
  const pin: LedgerPin = {};
  if (typeof result.ledger_hash === "string" && /^[0-9a-f]{64}$/i.test(result.ledger_hash)) {
    pin.ledger_hash = result.ledger_hash.toUpperCase();
  }
  if (Number.isSafeInteger(result.ledger_index) && result.ledger_index >= 0) pin.ledger_index = result.ledger_index;
  return pin;
}
export function ledgerSelector(pin: LedgerPin): any {
  return pin.ledger_hash ? { ledger_hash: pin.ledger_hash }
    : { ledger_index: pin.ledger_index ?? "validated" };
}
function checkPin(requested: LedgerPin, received: LedgerPin): void {
  if (requested.ledger_hash && requested.ledger_hash !== received.ledger_hash) throw new Error("RPC changed or omitted pinned ledger hash");
  if (!requested.ledger_hash && requested.ledger_index !== undefined && requested.ledger_index !== received.ledger_index) {
    throw new Error("RPC changed or omitted pinned ledger index");
  }
}
export function verifyLedgerPin(pin: LedgerPin, result: any): void { checkPin(pin, pinFrom(result)); }
function fingerprint(rows: any[]): string {
  const stable = JSON.stringify(rows, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return createHash("sha256").update(stable).digest("hex");
}
function decode(marker: string | undefined, scope: string, min: number, max: number): Cursor | null {
  if (!marker?.startsWith(PREFIX)) return null; // Legacy raw server string marker.
  try {
    if (marker.length > MAX_CURSOR) throw new Error();
    const encoded = marker.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error();
    const c = JSON.parse(bytes.toString("utf8"));
    if (c?.v !== 1 || !("server_marker" in c) || c.scope !== scope || !Number.isInteger(c.offset) || c.offset < 0 || c.offset > 12800
      || !Number.isInteger(c.page_limit) || c.page_limit < min || c.page_limit > max
      || !c.pin || typeof c.pin !== "object" || Array.isArray(c.pin)) throw new Error();
    if (c.pin.ledger_hash !== undefined && (typeof c.pin.ledger_hash !== "string" || !/^[0-9A-F]{64}$/.test(c.pin.ledger_hash))) throw new Error();
    if (c.pin.ledger_index !== undefined && (!Number.isSafeInteger(c.pin.ledger_index) || c.pin.ledger_index < 0)) throw new Error();
    if (c.offset > 0 && (typeof c.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(c.fingerprint))) throw new Error();
    return c;
  } catch {
    throw new Error("Invalid query marker or marker belongs to another query");
  }
}
function encode(cursor: Cursor): string {
  const marker = PREFIX + Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (marker.length > MAX_CURSOR) throw new Error("RPC continuation marker is too large");
  return marker;
}

/** Return at most limit rows; retain a resumable offset if an RPC page is larger. */
export async function readPage(
  url: string, method: keyof typeof PAGE_METHODS, target: Record<string, string>,
  limit: number, marker?: string, initialPin: LedgerPin = {},
): Promise<QueryPage> {
  const policy = PAGE_METHODS[method];
  if (!Number.isInteger(limit) || limit < 1 || limit > policy.max) throw new Error("Invalid query row limit");
  const scope = JSON.stringify({ method, target });
  const cursor = decode(marker, scope, policy.min, policy.max);
  const pin = cursor?.pin ?? initialPin;
  const wireLimit = cursor?.page_limit ?? Math.max(policy.min, method === "account_nfts" ? Math.ceil(limit / 32) : limit);
  const serverMarker = cursor ? cursor.server_marker : (marker ?? null);
  const result = await queryRpc(url, method, {
    ...target, ...ledgerSelector(pin), limit: wireLimit,
    ...(serverMarker != null ? { marker: serverMarker } : {}),
  });
  const receivedPin = pinFrom(result);
  checkPin(pin, receivedPin);
  const rows = result[policy.field];
  if (!Array.isArray(rows)) throw new Error(`RPC ${method}: missing ${policy.field} array`);
  const offset = cursor?.offset ?? 0;
  if (offset > rows.length || (offset && cursor?.fingerprint !== fingerprint(rows))) {
    throw new Error("RPC partial page changed; restart this query");
  }
  const items = rows.slice(offset, offset + limit);
  const consumed = offset + items.length;
  let next: string | null = null;
  if (consumed < rows.length) {
    next = encode({ v: 1, scope, server_marker: serverMarker, offset: consumed,
      page_limit: wireLimit, pin: receivedPin, fingerprint: fingerprint(rows) });
  } else if (result.marker != null) {
    next = encode({ v: 1, scope, server_marker: result.marker, offset: 0, page_limit: wireLimit, pin: receivedPin });
  }
  return { items, marker: next, pin: receivedPin };
}
export function pageInfo(page: QueryPage) {
  return {
    marker: page.marker, complete: page.marker === null,
    ledger_hash: page.pin.ledger_hash ?? null, ledger_index: page.pin.ledger_index ?? null,
    snapshot_pinned: page.pin.ledger_hash !== undefined || page.pin.ledger_index !== undefined,
  };
}

/**
 * codec.ts — protobuf serialize/deserialize for pf.signals.v1 messages.
 *
 * Uses protobufjs dynamic loading (same dep already in package.json).
 * All four signal proto files are loaded into a single shared Root so
 * cross-file type references resolve without duplication.
 */

import protobuf from "protobufjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, "../grpc/protos");

// ── Root loader ──────────────────────────────────────────────────────────────

let _root: protobuf.Root | null = null;

async function getRoot(): Promise<protobuf.Root> {
  if (_root) return _root;

  const root = new protobuf.Root();

  // Resolve imports: google well-known types stay as-is (protobufjs bundles them);
  // everything else is resolved relative to PROTO_DIR.
  root.resolvePath = (_origin: string, target: string): string => {
    if (target.startsWith("google/")) return target;
    return resolve(PROTO_DIR, target);
  };

  await root.load([
    resolve(PROTO_DIR, "pf/signals/v1/signal.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/market.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/trade.proto"),
    resolve(PROTO_DIR, "pf/signals/v1/portfolio.proto"),
  ]);

  // Early validation: confirm critical types resolved correctly.
  // Catches proto load failures at startup rather than at encode/decode time.
  root.lookupType("pf.signals.v1.AgentFinancialSignal");
  root.lookupType("pf.signals.v1.PriceQuote");
  root.lookupType("pf.signals.v1.TradeIntent");
  root.lookupType("pf.signals.v1.TradeConfirmation");
  root.lookupType("pf.signals.v1.PositionUpdate");
  root.lookupType("pf.signals.v1.RiskMetric");
  root.lookupEnum("pf.common.v4.ContentKind");

  _root = root;
  return root;
}

// ── Kind maps ────────────────────────────────────────────────────────────────

export const SIGNAL_KINDS = [
  "price_quote",
  "trade_intent",
  "trade_confirmation",
  "position_update",
  "risk_metric",
  "reward_offer",
  "policy_update",
] as const;

export type SignalKindKey = (typeof SIGNAL_KINDS)[number];

// Maps user-facing kind string → proto enum name and payload type
const KIND_META: Record<
  SignalKindKey,
  { enumName: string; contentKind: string; typeName: string | null }
> = {
  price_quote:       { enumName: "SIGNAL_KIND_PRICE_QUOTE",       contentKind: "PRICE_QUOTE",       typeName: "pf.signals.v1.PriceQuote" },
  trade_intent:      { enumName: "SIGNAL_KIND_TRADE_INTENT",      contentKind: "TRADE_INTENT",      typeName: "pf.signals.v1.TradeIntent" },
  trade_confirmation:{ enumName: "SIGNAL_KIND_TRADE_CONFIRMATION", contentKind: "TRADE_CONFIRMATION",typeName: "pf.signals.v1.TradeConfirmation" },
  position_update:   { enumName: "SIGNAL_KIND_POSITION_UPDATE",   contentKind: "POSITION_UPDATE",   typeName: "pf.signals.v1.PositionUpdate" },
  risk_metric:       { enumName: "SIGNAL_KIND_RISK_METRIC",       contentKind: "RISK_METRIC",       typeName: "pf.signals.v1.RiskMetric" },
  reward_offer:      { enumName: "SIGNAL_KIND_REWARD_OFFER",      contentKind: "REWARD_OFFER",      typeName: null },
  policy_update:     { enumName: "SIGNAL_KIND_POLICY_UPDATE",     contentKind: "POLICY_UPDATE",     typeName: null },
};

// Reverse map: proto SignalKind enum value → SignalKindKey
// (protobufjs decodes enums as their string name by default)
const ENUM_NAME_TO_KIND: Record<string, SignalKindKey> = {
  SIGNAL_KIND_PRICE_QUOTE:       "price_quote",
  SIGNAL_KIND_TRADE_INTENT:      "trade_intent",
  SIGNAL_KIND_TRADE_CONFIRMATION:"trade_confirmation",
  SIGNAL_KIND_POSITION_UPDATE:   "position_update",
  SIGNAL_KIND_RISK_METRIC:       "risk_metric",
  SIGNAL_KIND_REWARD_OFFER:      "reward_offer",
  SIGNAL_KIND_POLICY_UPDATE:     "policy_update",
};

// ── Timestamp helpers ─────────────────────────────────────────────────────────

function toTimestamp(
  value: string | number | undefined | null
): { seconds: number; nanos: number } | undefined {
  if (value == null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value as string);
  if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) {
    throw new Error("Invalid timestamp: expected a valid date at millisecond precision");
  }
  const nanos = ((ms % 1000) + 1000) % 1000 * 1_000_000; // guard against negative remainder
  return { seconds: Math.floor(ms / 1000), nanos };
}

function fromTimestamp(
  ts: { seconds?: string | number; nanos?: number } | null | undefined
): string | null {
  if (!ts) return null;
  // Proto3 JSON omits zero seconds, including timestamps in the first second.
  const seconds = Number(ts.seconds ?? 0);
  const nanos = ts.nanos ?? 0;
  const milliseconds = seconds * 1000 + Math.floor(nanos / 1_000_000);
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Convert only schema-declared timestamps, never timestamp-shaped metadata. */
function timestampsToIso(type: protobuf.Type, data: Record<string, unknown>): unknown {
  if (type.fullName === ".google.protobuf.Timestamp") return fromTimestamp(data);
  const result = { ...data };
  for (const field of type.fieldsArray) {
    field.resolve();
    if (!(field.resolvedType instanceof protobuf.Type)) continue;
    const nestedType = field.resolvedType;
    const value = result[field.name];
    if (value == null) continue;
    const convert = (item: unknown): unknown =>
      timestampsToIso(nestedType, item as Record<string, unknown>);
    if (field.map) {
      result[field.name] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, convert(item)])
      );
    } else if (field.repeated) {
      result[field.name] = (value as unknown[]).map(convert);
    } else {
      result[field.name] = convert(value);
    }
  }
  return result;
}

// ── Strict JSON admission before protobuf verification ───────────────────────

function normalizeInteger64(value: unknown, unsigned: boolean, path: string): protobuf.Long {
  const validNumber = typeof value === "number" && Number.isSafeInteger(value);
  const decimal = value instanceof protobuf.util.Long
    ? value.toString()
    : validNumber ? String(value) : value;
  const pattern = unsigned ? /^(0|[1-9][0-9]*)$/ : /^(0|-?[1-9][0-9]*)$/;
  if (typeof decimal !== "string" || !pattern.test(decimal)) {
    throw new Error(`${path}: expected a canonical ${unsigned ? "unsigned " : ""}64-bit integer string or safe integer`);
  }
  const integer = BigInt(decimal);
  const minimum = unsigned ? 0n : -(1n << 63n);
  const maximum = unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n;
  if (integer < minimum || integer > maximum) throw new Error(`${path}: 64-bit integer out of range`);
  // Validate before conversion: fromObject otherwise wraps/truncates invalid values.
  return protobuf.util.LongBits.from(decimal).toLong(unsigned);
}

function normalizeScalar(field: protobuf.Field, value: unknown, path: string): unknown {
  field.resolve();
  const resolved = field.resolvedType;
  if (resolved instanceof protobuf.Enum) {
    if (typeof value === "string" && Object.hasOwn(resolved.values, value)) {
      return resolved.values[value];
    }
    if (typeof value === "number" && Number.isInteger(value) && Object.hasOwn(resolved.valuesById, value)) {
      return value;
    }
    throw new Error(`${path}: unknown ${resolved.name} value`);
  }
  if (["uint64", "fixed64", "int64", "sint64", "sfixed64"].includes(field.type)) {
    return normalizeInteger64(value, field.type === "uint64" || field.type === "fixed64", path);
  }
  if (resolved instanceof protobuf.Type) {
    if (resolved.fullName === ".google.protobuf.Timestamp" && typeof value === "string") {
      return toTimestamp(value);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path}: object expected`);
    }
    return normalizeMessage(resolved, value as Record<string, unknown>, path);
  }
  // Preserve primitive types so verify still rejects e.g. booleans for strings.
  return value;
}

function normalizeMessage(
  type: protobuf.Type,
  data: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${path}: object expected`);
  const result: Record<string, unknown> = {};
  const seen = new Map<string, unknown>();
  for (const [key, value] of Object.entries(data)) {
    // Use the parser's own casing rule; underscore-before-digit stays intact.
    const canonical = protobuf.util.camelCase(key);
    const field = Object.hasOwn(type.fields, canonical) ? type.fields[canonical] : undefined;
    if (!field) continue; // Keep protobuf's existing unknown-field behavior.
    if (seen.has(canonical)) {
      if (!isDeepStrictEqual(seen.get(canonical), value)) throw new Error(`${path}.${canonical}: conflicting aliases`);
      continue;
    }
    seen.set(canonical, value);
    if (value == null) {
      result[canonical] = value; // Proto3 optional/null behavior is unchanged.
    } else if (field.map) {
      if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}.${canonical}: object expected`);
      result[canonical] = Object.fromEntries(Object.entries(value).map(([mapKey, item]) => [
        mapKey, normalizeScalar(field, item, `${path}.${canonical}.${mapKey}`)
      ]));
    } else if (field.repeated) {
      if (!Array.isArray(value)) throw new Error(`${path}.${canonical}: array expected`);
      result[canonical] = value.map((item, index) => normalizeScalar(field, item, `${path}.${canonical}[${index}]`));
    } else {
      result[canonical] = normalizeScalar(field, value, `${path}.${canonical}`);
    }
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode a kind-specific payload object (e.g. a PriceQuote) to protobuf bytes.
 * ISO timestamp strings in the payload are automatically converted.
 */
export async function encodePayload(
  kind: SignalKindKey,
  data: Record<string, unknown>
): Promise<Uint8Array> {
  const meta = KIND_META[kind];
  if (!meta.typeName) {
    // reward_offer / policy_update have no typed payload — serialize as JSON
    return Buffer.from(JSON.stringify(data), "utf8");
  }

  const root = await getRoot();
  const MsgType = root.lookupType(meta.typeName);
  const normalized = normalizeMessage(MsgType, data, kind);

  const err = MsgType.verify(normalized);
  if (err) throw new Error(`Invalid ${kind} payload: ${err}`);

  return MsgType.encode(MsgType.create(normalized)).finish() as Uint8Array;
}

/**
 * Encode a complete AgentFinancialSignal to a Buffer ready for transport.
 *
 * The resulting bytes should be base64-encoded and sent as the `message`
 * field in a standard send_message call with
 * content_type = "application/x-pft-signal+proto".
 */
export async function encodeFinancialSignal(
  kind: SignalKindKey,
  payloadData: Record<string, unknown>,
  senderAgentId: string,
  options?: {
    recipientAgentId?: string;
    correlationId?: string;
    expiresAt?: string;
    metadata?: Record<string, string>;
  }
): Promise<Buffer> {
  const meta = KIND_META[kind];
  const root = await getRoot();
  const SignalType = root.lookupType("pf.signals.v1.AgentFinancialSignal");

  const payloadBytes = await encodePayload(kind, payloadData);

  const msgObj: Record<string, unknown> = {
    signalId: randomUUID(),
    senderAgentId,
    recipientAgentId: options?.recipientAgentId ?? "",
    kind: meta.enumName,
    contentKind: meta.contentKind,
    createdAt: toTimestamp(Date.now()),
    payload: payloadBytes,
    correlationId: options?.correlationId ?? "",
    schemaVersion: 1,
    metadata: options?.metadata ?? {},
  };

  if (options?.expiresAt) {
    msgObj.expiresAt = toTimestamp(options.expiresAt);
  }

  const normalized = normalizeMessage(SignalType, msgObj, "AgentFinancialSignal");
  const err = SignalType.verify(normalized);
  if (err) throw new Error(`AgentFinancialSignal validation failed: ${err}`);

  return Buffer.from(SignalType.encode(SignalType.create(normalized)).finish());
}

// ── Decoded signal shape ──────────────────────────────────────────────────────

export interface DecodedSignal {
  signal_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  kind: string;
  content_kind: string;
  created_at: string | null;
  expires_at: string | null;
  correlation_id: string;
  schema_version: number;
  metadata: Record<string, string>;
  payload: Record<string, unknown>;
}

/**
 * Decode a Buffer (from base64 message field) into a structured DecodedSignal.
 * The nested payload bytes are also decoded to a plain JS object.
 */
export async function decodeFinancialSignal(
  bytes: Buffer
): Promise<DecodedSignal> {
  const root = await getRoot();
  const SignalType = root.lookupType("pf.signals.v1.AgentFinancialSignal");

  const signal = SignalType.decode(bytes).toJSON() as any;

  // Determine kind from enum string name
  const kindEnumName: string = signal.kind ?? "";
  const kindKey: SignalKindKey | undefined = ENUM_NAME_TO_KIND[kindEnumName];

  let decodedPayload: Record<string, unknown> = {};

  if (signal.payload && kindKey) {
    const meta = KIND_META[kindKey];
    let rawBytes: Buffer;
    if (typeof signal.payload === "string") {
      rawBytes = Buffer.from(signal.payload, "base64");
    } else if (Buffer.isBuffer(signal.payload)) {
      rawBytes = signal.payload;
    } else if (signal.payload instanceof Uint8Array) {
      rawBytes = Buffer.from(signal.payload);
    } else {
      rawBytes = Buffer.alloc(0);
    }

    if (meta.typeName && rawBytes.length > 0) {
      const PayloadType = root.lookupType(meta.typeName);
      const decoded = PayloadType.decode(rawBytes).toJSON();
      decodedPayload = timestampsToIso(PayloadType, decoded) as Record<string, unknown>;
    } else if (!meta.typeName && rawBytes.length > 0) {
      // reward_offer / policy_update were serialized as JSON
      try {
        decodedPayload = JSON.parse(rawBytes.toString("utf8"));
      } catch {
        decodedPayload = { raw: rawBytes.toString("utf8") };
      }
    }
  }

  return {
    signal_id:        signal.signalId ?? "",
    sender_agent_id:  signal.senderAgentId ?? "",
    recipient_agent_id: signal.recipientAgentId ?? "",
    kind:             kindKey ?? kindEnumName ?? "unknown",
    content_kind:     signal.contentKind ?? "",
    created_at:       fromTimestamp(signal.createdAt),
    expires_at:       fromTimestamp(signal.expiresAt),
    correlation_id:   signal.correlationId ?? "",
    schema_version:   signal.schemaVersion ?? 0,
    metadata:         signal.metadata ?? {},
    payload:          decodedPayload,
  };
}

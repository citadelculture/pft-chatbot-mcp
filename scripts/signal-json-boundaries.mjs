import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";
import { encodePayload, encodeFinancialSignal, decodeFinancialSignal } from "../dist/signals/codec.js";

// Source-informed supplementary passive checks after the frozen 29-case green.
const directory = fileURLToPath(new URL("../src/grpc/protos/", import.meta.url));
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => target.startsWith("google/") ? target : resolve(directory, target);
await root.load(["signal", "market", "trade", "portfolio"].map((name) => resolve(directory, `pf/signals/v1/${name}.proto`)));
const Envelope = root.lookupType("pf.signals.v1.AgentFinancialSignal");
const cases = [];
async function test(name, run) {
  try { await run(); cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: error.message }); }
}
async function wire(kind, typeName, input, expected = input) {
  const type = root.lookupType(`pf.signals.v1.${typeName}`);
  const reference = type.fromObject(expected);
  assert.equal(type.verify(reference), null);
  const bytes = await encodePayload(kind, input);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(type.encode(reference).finish()));
}
const decimal = "9007199254740993.000001";
for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
  await test(`safe-integer-${value}`, () => wire("risk_metric", "RiskMetric", { windowSeconds: value }));
}
await test("existing-long-instance", () => wire("trade_confirmation", "TradeConfirmation", { feeDrops: protobuf.util.LongBits.from("18446744073709551615").toLong(true) }));
for (const value of ["00", "+1", " 1", "1 ", "-0", "0x10", "1.0", "", Infinity, NaN, 0.5]) {
  await test(`reject-uint64-${String(value)}`, () => assert.rejects(
    encodePayload("risk_metric", { windowSeconds: value }), /risk_metric\.windowSeconds:/
  ));
}
for (const side of [0, 1, 2]) await test(`declared-numeric-enum-${side}`, () => wire("trade_intent", "TradeIntent", { side }));
for (const side of [true, "1", 0.5, "constructor"]) {
  await test(`reject-enum-${String(side)}`, () => assert.rejects(encodePayload("trade_intent", { side }), /trade_intent\.side: unknown TradeSide/));
}
for (const [kind, typeName, alias, canonical] of [
  ["price_quote", "PriceQuote", "valid_until", "validUntil"],
  ["trade_intent", "TradeIntent", "expires_at", "expiresAt"],
  ["trade_confirmation", "TradeConfirmation", "confirmed_at", "confirmedAt"],
  ["position_update", "PositionUpdate", "snapshot_at", "snapshotAt"],
  ["risk_metric", "RiskMetric", "computed_at", "computedAt"],
]) await test(`declared-timestamp-${alias}`, () => wire(kind, typeName, { [alias]: "1970-01-01T00:00:00.123Z" }, { [canonical]: { seconds: 0, nanos: 123_000_000 } }));
await test("nested-timestamp-alias-and-no-input-mutation", async () => {
  const input = { positions: [{ asset: "SYN", value_in_pft: decimal, as_of: "1969-12-31T23:59:59.999Z" }] };
  const before = structuredClone(input);
  const bytes = await encodeFinancialSignal("position_update", input, "synthetic-sender");
  assert.deepEqual(input, before);
  const decoded = await decodeFinancialSignal(bytes);
  assert.equal(decoded.payload.positions[0].asOf, input.positions[0].as_of);
  assert.equal(decoded.payload.positions[0].valueInPft, decimal);
});
await test("schema-aware-metadata-is-not-a-timestamp", async () => {
  const metadata = { seconds: "42", nanos: "123000000" };
  const bytes = await encodeFinancialSignal("trade_intent", { metadata }, "synthetic-sender");
  assert.deepEqual((await decodeFinancialSignal(bytes)).payload.metadata, metadata);
});
await test("nested-zero-seconds-timestamp", async () => {
  const bytes = await encodeFinancialSignal("position_update", { positions: [{ asOf: { nanos: 123_000_000 } }] }, "synthetic-sender");
  assert.equal((await decodeFinancialSignal(bytes)).payload.positions[0].asOf, "1970-01-01T00:00:00.123Z");
});
await test("foreign-empty-timestamp-is-epoch", async () => {
  const bytes = Buffer.from(Envelope.encode(Envelope.fromObject({ kind: 6, createdAt: {}, payload: Buffer.from("{}") })).finish());
  assert.equal((await decodeFinancialSignal(bytes)).created_at, "1970-01-01T00:00:00.000Z");
});
await test("proto-fields-containing-digits", () => wire("price_quote", "PriceQuote", { volume_24h: decimal, change_pct_24h: decimal }, { volume_24h: decimal, changePct_24h: decimal }));
await test("matching-aliases", () => wire("price_quote", "PriceQuote", { bidPrice: decimal, bid_price: decimal }, { bidPrice: decimal }));
await test("conflicting-nested-alias-diagnostic", () => assert.rejects(encodePayload("price_quote", { pair: { baseAsset: "PFT", base_asset: "SYN" } }), /price_quote\.pair\.baseAsset: conflicting aliases/));
for (const [name, kind, payload, message] of [
  ["decimal-type", "price_quote", { bidPrice: true }, /bidPrice: string expected/],
  ["metadata-type", "trade_intent", { metadata: { key: 42 } }, /metadata: string/],
  ["repeated-type", "position_update", { positions: {} }, /positions: array expected/],
  ["iso-type", "price_quote", { quotedAt: "not-a-date" }, /Invalid timestamp/],
]) await test(`reject-${name}`, () => assert.rejects(encodePayload(kind, payload), message));
await test("unknown-fields-remain-ignored", () => wire("price_quote", "PriceQuote", JSON.parse('{"bidPrice":"1","constructor":"ignored","__proto__":"ignored"}'), { bidPrice: "1" }));
console.log(JSON.stringify({ provenance: "Supplementary source-informed boundary checks; no financial paths or new task credit", runtime: process.version, passed: cases.filter((row) => row.passed).length, failed: cases.filter((row) => !row.passed).length, cases }, null, 2));
if (cases.some((row) => !row.passed)) process.exitCode = 1;

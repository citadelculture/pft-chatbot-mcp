/** Exact display/identity helpers used only by public query tools. */
import type { PftlAsset } from "./constants.js";

export function dropsToPftExact(value: string): string {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("Invalid native atom amount");
  const atoms = BigInt(value);
  const absolute = atoms < 0n ? -atoms : atoms;
  return `${atoms < 0n ? "-" : ""}${absolute / 1000000n}.${(absolute % 1000000n).toString().padStart(6, "0")}`;
}
export function formatReadAmount(value: any): { currency: string; issuer?: string; amount: string; drops?: string } {
  if (typeof value === "string") return { currency: "PFT", amount: dropsToPftExact(value), drops: value };
  if (!value || typeof value.currency !== "string" || typeof value.issuer !== "string"
    || typeof value.value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.value)) {
    throw new Error("Invalid issued currency amount");
  }
  return { currency: value.currency, issuer: value.issuer, amount: value.value };
}
function issuedKey(currency: string, issuer: string): string {
  // Hex encodings are case-insensitive; three-character currency identifiers are not.
  const code = /^[0-9a-f]{40}$/i.test(currency) ? currency.toUpperCase() : currency;
  return JSON.stringify([code, issuer]);
}
export function requestedAssetKey(asset: PftlAsset): string {
  return asset === "PFT" ? "native" : issuedKey(asset.currency, asset.issuer);
}
export function reserveAssetKey(value: any): string {
  if (typeof value === "string") return "native";
  if (!value || typeof value.currency !== "string" || typeof value.issuer !== "string") throw new Error("Invalid AMM reserve asset");
  return issuedKey(value.currency, value.issuer);
}

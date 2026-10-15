import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { queryRpc, readPage, pageInfo, ledgerSelector, verifyLedgerPin } from "../chain/query.js";
import { dropsToPftExact } from "../dex/read_only.js";

export const dexGetBalancesSchema = z.object({
  address: z.string().optional().describe("PFTL account to query; defaults to the bot's address."),
  limit: z.number().int().min(1).max(400).default(200).describe("Maximum trust lines returned per call (1–400)."),
  marker: z.string().max(32768).optional().describe("Opaque marker from the previous response for this account."),
});
export type DexGetBalancesParams = z.infer<typeof dexGetBalancesSchema>;

/** Native balance and a bounded, explicitly continued page of account trust lines. */
export async function executeDexGetBalances(config: Config, keypair: BotKeypair, params: DexGetBalancesParams): Promise<string> {
  const address = params.address ?? keypair.address;
  const page = await readPage(config.pftlRpcUrl, "account_lines", { account: address }, params.limit, params.marker);
  const info = await queryRpc(config.pftlRpcUrl, "account_info", { account: address, ...ledgerSelector(page.pin) });
  verifyLedgerPin(page.pin, info);
  const balanceDrops = info.account_data?.Balance;
  const balance = dropsToPftExact(balanceDrops);
  return JSON.stringify({
    address, native: { currency: "PFT", balance, balance_drops: balanceDrops },
    trust_lines: page.items.map(l => ({ currency: l.currency, issuer: l.account, balance: l.balance, limit: l.limit })),
    ...pageInfo(page),
  }, null, 2);
}

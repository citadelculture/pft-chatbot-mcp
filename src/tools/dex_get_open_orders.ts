import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { readPage, pageInfo } from "../chain/query.js";
import { formatReadAmount } from "../dex/read_only.js";

export const dexGetOpenOrdersSchema = z.object({
  address: z.string().optional().describe("PFTL account; defaults to the bot's address."),
  limit: z.number().int().min(1).max(400).default(200).describe("Maximum open orders returned per call (1–400)."),
  marker: z.string().max(32768).optional().describe("Opaque continuation marker for this account's orders."),
});
export type DexGetOpenOrdersParams = z.infer<typeof dexGetOpenOrdersSchema>;

/** Bounded page of account orders across trading pairs, with explicit continuation. */
export async function executeDexGetOpenOrders(config: Config, keypair: BotKeypair, params: DexGetOpenOrdersParams): Promise<string> {
  const address = params.address ?? keypair.address;
  const page = await readPage(config.pftlRpcUrl, "account_offers", { account: address }, params.limit, params.marker);
  return JSON.stringify({ address, open_orders: page.items.map(offer => ({
    sequence: offer.seq, taker_pays: formatReadAmount(offer.taker_pays),
    taker_gets: formatReadAmount(offer.taker_gets), quality: offer.quality, flags: offer.flags,
  })), count: page.items.length, ...pageInfo(page) }, null, 2);
}

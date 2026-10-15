import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { readPage, pageInfo, QueryError, type QueryPage, type LedgerPin } from "../chain/query.js";
import { formatReadAmount } from "../dex/read_only.js";

export const nftGetOffersSchema = z.object({
  nft_id: z.string().describe("NFTokenID to look up sell offers for."),
  limit: z.number().int().min(1).max(500).default(250).describe("Maximum offers returned per call (1–500)."),
  marker: z.string().max(32768).optional().describe("Opaque continuation marker for this NFT's sell offers."),
});
export type NftGetOffersParams = z.infer<typeof nftGetOffersSchema>;

export async function readSellOffers(
  url: string, nftId: string, limit: number, marker?: string, pin: LedgerPin = {},
): Promise<QueryPage> {
  try {
    return await readPage(url, "nft_sell_offers", { nft_id: nftId }, limit, marker, pin);
  } catch (error) {
    // Only this structured RPC code means no offers. HTTP/JSON/availability errors propagate.
    if (error instanceof QueryError && error.code === "objectNotFound") return { items: [], marker: null, pin };
    throw error;
  }
}
export function formatSellOffer(offer: any) {
  const amount = formatReadAmount(offer.amount);
  const drops = typeof offer.amount === "string" ? offer.amount : null;
  if (drops !== null && BigInt(drops) < 0n) throw new Error("Invalid negative NFT offer amount");
  return {
    offer_id: offer.nft_offer_index, owner: offer.owner, destination: offer.destination ?? null,
    amount, amount_drops: drops, amount_pft: drops !== null ? amount.amount : null,
    expiration: offer.expiration ?? null, flags: offer.flags,
  };
}

/** One bounded sell-offer page, preserving issued amounts and continuation. */
export async function executeNftGetOffers(config: Config, _keypair: BotKeypair, params: NftGetOffersParams): Promise<string> {
  const page = await readSellOffers(config.pftlRpcUrl, params.nft_id, params.limit, params.marker);
  return JSON.stringify({ nft_id: params.nft_id, sell_offers: page.items.map(formatSellOffer), count: page.items.length, ...pageInfo(page) }, null, 2);
}

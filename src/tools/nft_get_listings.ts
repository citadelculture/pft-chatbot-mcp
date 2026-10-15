import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { readPage, pageInfo } from "../chain/query.js";
import { resolveIpfsUri } from "../dex/constants.js";
import { readSellOffers, formatSellOffer } from "./nft_get_offers.js";

export const nftGetListingsSchema = z.object({
  account: z.string().optional().describe("Account whose currently held NFTs to scan; this is not a global issuer-collection search."),
  issuer: z.string().optional().describe("Deprecated alias for account, retained for old clients. It identifies holdings, not all NFTs minted by an issuer."),
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum held NFTs scanned per call (1–100)."),
  marker: z.string().max(32768).optional().describe("Opaque continuation marker from the previous scan for this account."),
});
export type NftGetListingsParams = z.infer<typeof nftGetListingsSchema>;
const CONCURRENT_OFFER_FETCHES = 10;

/** Scan a bounded account-holdings page; expose partial offer pages explicitly. */
export async function executeNftGetListings(config: Config, _keypair: BotKeypair, params: NftGetListingsParams): Promise<string> {
  const account = params.account ?? params.issuer;
  if (!account) throw new Error("account is required (legacy issuer alias is also accepted)");
  if (params.account && params.issuer && params.account !== params.issuer) throw new Error("account and legacy issuer alias must match");
  const page = await readPage(config.pftlRpcUrl, "account_nfts", { account }, params.limit, params.marker);
  const listings: any[] = [];
  for (let i = 0; i < page.items.length; i += CONCURRENT_OFFER_FETCHES) {
    const results = await Promise.all(page.items.slice(i, i + CONCURRENT_OFFER_FETCHES).map(async nft => {
      const offers = await readSellOffers(config.pftlRpcUrl, nft.NFTokenID, 50, undefined, page.pin);
      if (offers.items.length === 0) {
        if (offers.marker !== null) throw new Error("Empty NFT offer page has continuation; use nft_get_offers to continue");
        return null;
      }
      const formatted = offers.items.map(formatSellOffer);
      // Different issued currencies cannot be compared as if they were native prices.
      let best: ReturnType<typeof formatSellOffer> | null = null;
      for (const offer of formatted) {
        if (offer.amount_drops !== null && (best === null || BigInt(offer.amount_drops) < BigInt(best.amount_drops!))) best = offer;
      }
      const uri = nft.URI ? Buffer.from(nft.URI, "hex").toString("utf8") : null;
      return {
        nft_id: nft.NFTokenID, issuer: nft.Issuer, uri, metadata_url: uri ? resolveIpfsUri(uri) : null,
        offer_count: formatted.length, sell_offers: formatted,
        offers_complete: offers.marker === null, offers_marker: offers.marker,
        best_offer_id: best?.offer_id ?? null, best_price_drops: best?.amount_drops ?? null,
        best_price_pft: best?.amount_pft ?? null, best_offer_owner: best?.owner ?? null,
        best_price_scope: "returned_native_offers",
      };
    }));
    listings.push(...results.filter(item => item !== null));
  }
  return JSON.stringify({
    account, scope: "account_holdings", issuer: account, // Legacy output alias only.
    listings, count: listings.length, scanned: page.items.length, ...pageInfo(page),
    complete_scope: "account_holdings_scan", offers_complete: listings.every(item => item.offers_complete),
  }, null, 2);
}

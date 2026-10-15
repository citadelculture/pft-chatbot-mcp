import { z } from "zod";
import type { Config } from "../config.js";
import type { BotKeypair } from "../crypto/keys.js";
import { queryRpc, QueryError } from "../chain/query.js";
import { formatReadAmount, requestedAssetKey, reserveAssetKey } from "../dex/read_only.js";
import {
  pftlAssetSchema,
  buildXrplAsset,
  type PftlAsset,
} from "../dex/constants.js";

export const dexGetAmmInfoSchema = z.object({
  asset1: pftlAssetSchema.describe(
    'First asset in the AMM pool. Use "PFT" for the native asset or {currency, issuer} for issued tokens.'
  ),
  asset2: pftlAssetSchema.describe(
    "Second asset in the AMM pool. Must differ from asset1."
  ),
});

export type DexGetAmmInfoParams = z.infer<typeof dexGetAmmInfoSchema>;

/**
 * Get live AMM pool info for any asset pair on the PFTL chain.
 * Returns reserves, spot price, LP token supply, and trading fee.
 */
export async function executeDexGetAmmInfo(
  config: Config,
  _keypair: BotKeypair,
  params: DexGetAmmInfoParams
): Promise<string> {
  const xrplAsset1 = buildXrplAsset(params.asset1 as PftlAsset);
  const xrplAsset2 = buildXrplAsset(params.asset2 as PftlAsset);

  if (requestedAssetKey(params.asset1) === requestedAssetKey(params.asset2)) throw new Error("AMM assets must differ");

  let resp: any;
  try {
    resp = await queryRpc(config.pftlRpcUrl, "amm_info", {
      asset:        xrplAsset1,
      asset2:       xrplAsset2,
      ledger_index: "validated",
    });
  } catch (err: any) {
    // actNotFound means no AMM pool exists for this pair — not a fatal error
    if (err instanceof QueryError && err.code === "actNotFound") {
      return JSON.stringify(
        { error: "No AMM pool found for this asset pair on the PFTL ledger." },
        null,
        2
      );
    }
    throw err;
  }

  const amm = resp.amm;
  if (!amm || typeof amm !== "object") throw new Error("RPC amm_info: missing AMM object");

  const reserves = [amm.amount, amm.amount2];
  const keys = reserves.map(reserveAssetKey);
  const first = keys.indexOf(requestedAssetKey(params.asset1));
  const second = keys.indexOf(requestedAssetKey(params.asset2));
  if (first < 0 || second < 0 || first === second || keys[0] === keys[1]) {
    throw new Error("RPC AMM reserves do not match the requested asset identities");
  }
  const reserve1 = formatReadAmount(reserves[first]);
  const reserve2 = formatReadAmount(reserves[second]);
  // Preserve the existing approximate eight-decimal price convention. Reserves stay exact.
  const r1 = Number(reserve1.amount), r2 = Number(reserve2.amount);
  const ratio = r2 / r1;
  const spotPrice = r1 > 0 && r2 > 0 && Number.isFinite(ratio) ? ratio.toFixed(8) : null;

  return JSON.stringify(
    {
      account:      amm.account,
      asset1:       params.asset1,
      asset2:       params.asset2,
      reserve1,
      reserve2,
      lp_token: {
        currency: amm.lp_token?.currency,
        issuer:   amm.lp_token?.issuer,
        supply:   amm.lp_token?.value,
      },
      trading_fee:            amm.trading_fee,
      spot_price_asset2_per_asset1: spotPrice,
      vote_slots:             amm.vote_slots?.length ?? 0,
    },
    null,
    2
  );
}

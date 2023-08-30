import { Context } from "@tenderly/actions";

import { ethers } from "ethers";
import { ConnectionInfo, Logger } from "ethers/lib/utils";

import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { getSecret } from "./misc";

export async function getProvider(
  context: Context,
  chainId: SupportedChainId
): Promise<ethers.providers.Provider> {
  Logger.setLogLevel(Logger.levels.DEBUG);

  const url = await getSecret(`NODE_URL_${chainId}`, context);
  const user = await getSecret(`NODE_USER_${chainId}`, context).catch(
    () => undefined
  );
  const password = await getSecret(`NODE_PASSWORD_${chainId}`, context).catch(
    () => undefined
  );
  const providerConfig: ConnectionInfo =
    user && password
      ? {
          url,
          // TODO: This is a hack to make it work for HTTP endpoints (while we don't have a HTTPS one for Gnosis Chain), however I will delete once we have it
          headers: {
            Authorization: getAuthHeader({ user, password }),
          },
          // user: await getSecret(`NODE_USER_${network}`, context),
          // password: await getSecret(`NODE_PASSWORD_${network}`, context),
        }
      : { url };

  return new ethers.providers.JsonRpcProvider(providerConfig);
}

function getAuthHeader({ user, password }: { user: string; password: string }) {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

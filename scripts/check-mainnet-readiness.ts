import { GatewayClient } from "@circle-fin/x402-batching/client";
import type { Address, Hex } from "viem";

const env = process.env;
const address = env["FUSE_MAINNET_PAYER_ADDRESS"] as Address | undefined;
const capText = env["FUSE_MAINNET_CAP_USDC_ATOMIC"]?.trim();
const signerUrlText = env["SHALY_SIGNER_URL"]?.trim();
const signerAuthToken = env["SHALY_SIGNER_AUTH_TOKEN"]?.trim();
const expectedGatewayAddress = env["SHALY_SIGNER_GATEWAY_WALLET_ADDRESS"]?.trim();
const expectedPayToAddress = env["SHALY_SIGNER_ALLOWED_PAY_TO_ADDRESS"]?.trim();
if (signerAuthToken && signerAuthToken.length < 32) {
  throw new Error("SHALY_SIGNER_TOKEN_INVALID");
}
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  throw new Error("FUSE_MAINNET_PAYER_ADDRESS_REQUIRED");
}
for (const [name, value] of [
  ["SHALY_SIGNER_GATEWAY_WALLET_ADDRESS", expectedGatewayAddress],
  ["SHALY_SIGNER_ALLOWED_PAY_TO_ADDRESS", expectedPayToAddress],
] as const) {
  if (value && !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name}_INVALID`);
}
if (!capText || !/^\d+$/.test(capText)) throw new Error("FUSE_MAINNET_CAP_REQUIRED");
const capAtomic = BigInt(capText);
if (capAtomic <= 0n || capAtomic > 10_000n) throw new Error("FUSE_MAINNET_CAP_EXCEEDS_0_01_USDC");

const queryOnlyKey = `0x${"11".repeat(32)}` as Hex;
const gateway = new GatewayClient({ chain: "base", privateKey: queryOnlyKey });
const balances = await gateway.getBalances(address);
const signerConfiguration = [
  signerUrlText, signerAuthToken, expectedGatewayAddress, expectedPayToAddress,
];
const signerConfigurationComplete = signerConfiguration.every(Boolean);
let signerHealthy = false;
if (signerUrlText && signerAuthToken && expectedGatewayAddress && expectedPayToAddress) {
  const signerUrl = new URL(signerUrlText);
  if (signerUrl.protocol !== "https:" || signerUrl.username || signerUrl.password
    || signerUrl.search || signerUrl.hash) {
    throw new Error("SHALY_SIGNER_URL_INVALID");
  }
  const response = await fetch(new URL("/v1/status", signerUrl), {
    headers: { Authorization: ["Bearer", signerAuthToken].join(" ") },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) {
    const status = await response.json() as {
      ok?: unknown; service?: unknown; organizationId?: unknown; maximumAtomic?: unknown;
      identity?: {
        walletAddress?: unknown; chainId?: unknown; gatewayWalletAddress?: unknown;
        allowedPayToAddress?: unknown;
        wallet?: { blockchain?: unknown; custodyType?: unknown; state?: unknown };
      };
      authorization?: {
        reservedCount?: unknown; reviewCount?: unknown;
        reservedAtomic?: unknown; maximumTotalAtomic?: unknown;
      };
    };
    signerHealthy = status.ok === true && status.service === "fuse-signer"
      && status.organizationId === "org-shaly" && status.maximumAtomic === capAtomic.toString()
      && typeof status.identity?.walletAddress === "string"
      && status.identity.walletAddress.toLowerCase() === address.toLowerCase()
      && status.identity.chainId === 8453
      && typeof status.identity.gatewayWalletAddress === "string"
      && status.identity.gatewayWalletAddress.toLowerCase() === expectedGatewayAddress.toLowerCase()
      && typeof status.identity.allowedPayToAddress === "string"
      && status.identity.allowedPayToAddress.toLowerCase() === expectedPayToAddress.toLowerCase()
      && status.identity.wallet?.blockchain === "BASE"
      && status.identity.wallet.custodyType === "DEVELOPER"
      && status.identity.wallet.state === "LIVE"
      && status.authorization?.reservedCount === 0 && status.authorization.reviewCount === 0
      && status.authorization.reservedAtomic === "0"
      && status.authorization.maximumTotalAtomic === capAtomic.toString();
  }
}
const gatewayAvailableAtomic = balances.gateway.available;
const gatewayExposureWithinCap = gatewayAvailableAtomic <= capAtomic;
const report = {
  chain: "base",
  chainId: 8453,
  capAtomic: capAtomic.toString(),
  walletUsdc: balances.wallet.formatted,
  gatewayAvailableUsdc: balances.gateway.formattedAvailable,
  gatewayFundedForCap: gatewayAvailableAtomic >= capAtomic,
  gatewayExposureWithinCap,
  signerBoundaryConfigured: signerConfigurationComplete,
  signerConfigurationComplete,
  signerBoundaryHealthy: signerHealthy,
  ready: gatewayAvailableAtomic >= capAtomic && gatewayExposureWithinCap
    && signerConfigurationComplete && signerHealthy,
};
console.log(JSON.stringify(report));
if (!report.ready) process.exitCode = 2;

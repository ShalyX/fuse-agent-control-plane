import { expect, it } from "vitest";
import { assertBaseChainId, assertCircleSignerWallet, assertLiveCircleApiKey } from "../src/signer/runtime.js";

const address = "0x1111111111111111111111111111111111111111";

it("rejects Circle test API credentials before client initialization", () => {
  expect(() => assertLiveCircleApiKey("LIVE_API_KEY:example")).not.toThrow();
  for (const value of ["TEST_API_KEY:example", "example", ""]) {
    expect(() => assertLiveCircleApiKey(value)).toThrow("SIGNER_CIRCLE_LIVE_API_KEY_REQUIRED");
  }
});

it("requires Base mainnet chain ID", () => {
  expect(() => assertBaseChainId("8453")).not.toThrow();
  for (const value of ["84532", "5042002", "1", "invalid"]) {
    expect(() => assertBaseChainId(value)).toThrow("SIGNER_CHAIN_ID_NOT_BASE_MAINNET");
  }
});

it("requires an exact live Base developer-controlled signer wallet", () => {
  expect(() => assertCircleSignerWallet({
    address, blockchain: "BASE", custodyType: "DEVELOPER", state: "LIVE",
  }, address)).not.toThrow();

  for (const wallet of [
    { address, blockchain: "ARC-TESTNET", custodyType: "DEVELOPER", state: "LIVE" },
    { address, blockchain: "BASE", custodyType: "ENDUSER", state: "LIVE" },
    { address, blockchain: "BASE", custodyType: "DEVELOPER", state: "FROZEN" },
    { address: "0x2222222222222222222222222222222222222222", blockchain: "BASE", custodyType: "DEVELOPER", state: "LIVE" },
  ]) {
    expect(() => assertCircleSignerWallet(wallet, address))
      .toThrow("SIGNER_WALLET_NOT_LIVE_BASE_DEVELOPER");
  }
});

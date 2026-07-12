import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import solc from "solc";
import { CircleSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import type { initiateDeveloperControlledWalletsClient as InitiateClient } from "@circle-fin/developer-controlled-wallets";

const require = createRequire(import.meta.url);
const { initiateDeveloperControlledWalletsClient } = require("@circle-fin/developer-controlled-wallets") as {
  initiateDeveloperControlledWalletsClient: typeof InitiateClient;
};
const apiKey = process.env["CIRCLE_API_KEY"]?.trim();
const entitySecret = process.env["CIRCLE_ENTITY_SECRET"]?.trim();
const deployerAddress = (process.env["FUSE_PAYER_ADDRESS"] ?? "0x68abdce904bd68c53b0daf43c9b83a5aa8c0b2f7").toLowerCase();
if (!apiKey || !entitySecret) throw new Error("Missing Circle credentials");

const source = readFileSync(new URL("../contracts/FuseSpendMandate.sol", import.meta.url), "utf8");
const output = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "FuseSpendMandate.sol": { content: source } },
  settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
})));
const errors = (output.errors ?? []).filter((entry: { severity: string }) => entry.severity === "error");
if (errors.length) throw new Error(`SOLIDITY_COMPILE_FAILED:${JSON.stringify(errors)}`);
const artifact = output.contracts["FuseSpendMandate.sol"].FuseSpendMandate;

const walletsClient = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
const wallets = (await walletsClient.listWallets()).data?.wallets ?? [];
const wallet = wallets.find((candidate) => candidate.address?.toLowerCase() === deployerAddress);
if (!wallet) throw new Error("ARC_DEPLOYER_WALLET_NOT_FOUND");

const contracts = new CircleSmartContractPlatformClient({ apiKey, entitySecret });
let deployed;
try {
  deployed = await contracts.deployContract({
    name: "FuseSpendMandate",
    description: "Fuse Arc spend mandate final receipt commitment",
    blockchain: "ARC-TESTNET",
    walletId: wallet.id,
    abiJson: JSON.stringify(artifact.abi),
    bytecode: `0x${artifact.evm.bytecode.object}`,
    constructorParameters: [],
    fee: { type: "level", config: { feeLevel: "HIGH" } },
  });
} catch (error) {
  const detail = (error as { error?: { response?: { data?: unknown } } }).error?.response?.data;
  throw new Error(`CONTRACT_DEPLOY_FAILED:${JSON.stringify(detail ?? { message: (error as Error).message })}`);
}
const contractId = deployed.data?.contractId;
if (!contractId) throw new Error(`CONTRACT_DEPLOYMENT_ID_MISSING:${JSON.stringify(deployed.data)}`);

for (let attempt = 0; attempt < 90; attempt += 1) {
  const contract = (await contracts.getContract({ id: contractId })).data?.contract;
  if (contract?.status === "COMPLETE") {
    console.log(JSON.stringify({
      status: contract.status,
      contractId,
      address: contract.contractAddress,
      blockchain: contract.blockchain,
      deployer: wallet.address,
      txHash: contract.txHash,
    }, null, 2));
    process.exit(0);
  }
  if (["FAILED", "DENIED", "CANCELLED"].includes(contract?.status ?? "")) {
    throw new Error(`CONTRACT_DEPLOYMENT_${contract?.status}:${JSON.stringify(contract)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
throw new Error("CONTRACT_DEPLOYMENT_TIMEOUT");

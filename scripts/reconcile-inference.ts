import { randomUUID } from "node:crypto";
import { createOperatorClient } from "../src/operations/operatorClient.js";

const env = process.env;
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error("INVALID_ARGUMENTS");
  args.set(key.slice(2), value);
}
if (args.get("yes") !== "resolve") throw new Error("EXPLICIT_RESOLUTION_CONFIRMATION_REQUIRED");
const baseUrl = env["FUSE_BASE_URL"]?.trim();
const adminToken = env["FUSE_ADMIN_TOKEN"]?.trim();
const executionRequestId = args.get("request-id");
const resolution = args.get("resolution");
const note = args.get("note");
const externalReference = args.get("external-reference");
if (!baseUrl || !adminToken || !executionRequestId || !note || !externalReference) {
  throw new Error("FUSE_OPERATOR_CONFIG_REQUIRED");
}
if (resolution !== "settle" && resolution !== "confirm_not_billed") {
  throw new Error("RECONCILIATION_RESOLUTION_INVALID");
}
const actualText = args.get("actual-cost-atomic");
if (actualText !== undefined && !/^\d+$/.test(actualText)) throw new Error("ACTUAL_COST_INVALID");
await createOperatorClient({ baseUrl, adminToken }).resolve({
  executionRequestId,
  resolution,
  ...(actualText === undefined ? {} : { actualCostAtomic: BigInt(actualText) }),
  note,
  externalReference,
  operationRequestId: `operator:${randomUUID()}`,
});
console.log(JSON.stringify({ resolved: true, executionRequestId, resolution }));

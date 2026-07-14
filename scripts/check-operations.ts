import { createOperatorClient } from "../src/operations/operatorClient.js";

const env = process.env;
const baseUrl = env["FUSE_BASE_URL"]?.trim();
const adminToken = env["FUSE_ADMIN_TOKEN"]?.trim();
if (!baseUrl || !adminToken) throw new Error("FUSE_OPERATOR_CONFIG_REQUIRED");

const status = await createOperatorClient({ baseUrl, adminToken }).status();
console.log(JSON.stringify(status));
if (!status.healthy || status.openReconciliationCases > 0) process.exitCode = 2;

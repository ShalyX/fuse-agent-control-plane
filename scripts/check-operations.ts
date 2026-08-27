import { alphaOperationalAlerts, createOperatorClient } from "../src/operations/operatorClient.js";

const env = process.env;
const baseUrl = env["FUSE_BASE_URL"]?.trim();
const adminToken = env["FUSE_ADMIN_TOKEN"]?.trim();
if (!baseUrl || !adminToken) throw new Error("FUSE_OPERATOR_CONFIG_REQUIRED");

const status = await createOperatorClient({ baseUrl, adminToken }).status();
const alerts = alphaOperationalAlerts(status);
console.log(JSON.stringify({ ...status, alerts }));
if (alerts.length > 0) process.exitCode = 2;

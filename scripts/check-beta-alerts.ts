import { alphaOperationalAlerts, createOperatorClient } from "../src/operations/operatorClient.js";

const baseUrl = process.env["FUSE_BASE_URL"]?.trim();
const adminToken = process.env["FUSE_ADMIN_TOKEN"]?.trim();
if (!baseUrl || !adminToken) throw new Error("FUSE_OPERATOR_CONFIG_REQUIRED");

const status = await createOperatorClient({ baseUrl, adminToken }).status();
const alerts = alphaOperationalAlerts(status);

const result = {
  ok: alerts.length === 0,
  alerts,
  controlPlane: {
    healthy: status.healthy,
    openReconciliationCases: status.openReconciliationCases,
    oldestHeldAt: status.oldestHeldAt,
  },
  operationalReadiness: status.operationalReadiness,
};
console.log(JSON.stringify(result, null, 2));
if (alerts.length > 0) process.exitCode = 2;

import { readFileSync } from "node:fs";

type WorkspaceArtifact = {
  workspaceId: string;
  agentId: string;
  mandateId: string;
  credential: { token: string };
};
type PaidArtifact = { requestId: string };

type Target = { name: string; workspace: string; paid: string };
const baseUrl = (process.env["FUSE_BASE_URL"] ?? "https://fuse-agent-control-plane.vercel.app").replace(/\/$/, "");
const targets: Target[] = JSON.parse(process.env["FUSE_BETA_USAGE_TARGETS"] ?? JSON.stringify([
  { name: "Daemon", workspace: "/root/.config/fuse/external-beta-replacement.json", paid: "/root/.config/fuse/external-beta-second-paid.json" },
  { name: "Aegis", workspace: "/root/.config/fuse/external-beta-second-workspace.json", paid: "/root/.config/fuse/external-beta-second-workspace-paid.json" },
]));

const rows = [];
for (const target of targets) {
  const workspace = JSON.parse(readFileSync(target.workspace, "utf8")) as WorkspaceArtifact;
  const paid = JSON.parse(readFileSync(target.paid, "utf8")) as PaidArtifact;
  const response = await fetch(`${baseUrl}/api/v1/product/receipts/${encodeURIComponent(paid.requestId)}`, {
    headers: { Authorization: `Bearer ${workspace.credential.token}`, "X-Fuse-Mandate": workspace.mandateId },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({})) as { receipt?: Record<string, unknown> };
  const receipt = (payload.receipt ?? payload) as Record<string, unknown>;
  if (response.status !== 200) throw new Error(`BETA_USAGE_RECEIPT_READ_FAILED:${target.name}:${response.status}`);
  rows.push({
    name: target.name,
    workspaceId: workspace.workspaceId,
    agentId: workspace.agentId,
    mandateId: workspace.mandateId,
    requestId: receipt.requestId ?? paid.requestId,
    executionStatus: receipt.executionStatus ?? null,
    actualCostAtomic: String(receipt.actualCostAtomic ?? "0"),
    reconciliationResolved: receipt.reconciliationResolved ?? false,
  });
}

const signerResponse = await fetch(`${(process.env["SHALY_SIGNER_URL"] ?? "https://fuse-shaly-signer.vercel.app").replace(/\/$/, "")}/v1/status`, {
  headers: { Authorization: `Bearer ${process.env["SIGNER_AUTH_TOKEN"] ?? ""}` },
  signal: AbortSignal.timeout(10_000),
});
const signer = await signerResponse.json().catch(() => ({})) as { authorization?: { reservedAtomic?: string; maximumTotalAtomic?: string } };
const totalActualAtomic = rows.reduce((sum, row) => sum + BigInt(row.actualCostAtomic), 0n);
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  workspaces: rows,
  totals: {
    workspaceCount: rows.length,
    actualCostAtomic: totalActualAtomic.toString(),
    signerReservedAtomic: signer.authorization?.reservedAtomic ?? null,
    signerMaximumAtomic: signer.authorization?.maximumTotalAtomic ?? null,
    signerRemainingAtomic: signer.authorization?.reservedAtomic && signer.authorization?.maximumTotalAtomic
      ? (BigInt(signer.authorization.maximumTotalAtomic) - BigInt(signer.authorization.reservedAtomic)).toString() : null,
  },
}, null, 2));

const baseUrl = (process.env["FUSE_BASE_URL"] ?? "https://fuse-agent-control-plane.vercel.app")
  .replace(/\/$/, "");

async function expectRoute(path: string, expectedStatus: number, marker?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { "User-Agent": "fuse-production-smoke/1" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}`);
  }
  if (marker && !body.includes(marker)) {
    throw new Error(`${path} did not include required marker: ${marker}`);
  }
  return { path, status: response.status, bytes: body.length };
}

const results = [];
results.push(await expectRoute("/health", 200, '"ok":true'));
results.push(await expectRoute("/ready", 200, '"database":true'));
results.push(await expectRoute("/", 200, "Programmable spend control"));
results.push(await expectRoute("/desk", 200, "Fuse Control Desk"));
results.push(await expectRoute("/console", 200, "Fuse Operator Console"));
results.push(await expectRoute("/api/state", 200, '"persistence":"postgres"'));
results.push(await expectRoute("/api/v1/identity", 401, "AUTHENTICATION_REQUIRED"));
console.log(JSON.stringify({ ok: true, baseUrl, results }, null, 2));

import { describe, expect, it } from "vitest";
import { renderOperatorConsole } from "../src/http/console.js";

describe("operator console beta paths", () => {
  it("includes the run explorer and TypeScript integration path", () => {
    const html = renderOperatorConsole();
    expect(html).toContain('data-view="runs"');
    expect(html).toContain('data-view="sandbox"');
    expect(html).toContain('data-view="integration"');
    expect(html).toContain('id="consoleHero"');
    expect(html).toContain("/api/v1/product/sandbox/runs");
    expect(html).toContain("Run deterministic sandbox");
    expect(html).toContain("Scout tripped");
    expect(html).toContain("Reviewer continued");
    expect(html).toContain("/api/v1/product/mandates/");
    expect(html).toContain("inferenceWithReceipt");
    expect(html).toContain("Copy quickstart");
  });

  it("exposes the team-ready access and agent directory surfaces", () => {
    const html = renderOperatorConsole();
    expect(html).toContain('data-view="access"');
    expect(html).toContain("Access &amp; sessions");
    expect(html).toContain("/api/v1/admin/sessions");
    expect(html).toContain("/api/v1/admin/agent-directory");
    expect(html).toContain("Issue replacement access");
    expect(html).toContain("Current operator");
    expect(html).toContain("Agent directory");
  });

  it("exposes the workspace invite and scoped join flow", () => {
    const html = renderOperatorConsole();
    expect(html).toContain("Invite a teammate");
    expect(html).toContain("Accept workspace invite");
    expect(html).toContain("/api/v1/product/workspace-invites");
    expect(html).toContain("/api/v1/product/workspace-invites/accept");
    expect(html).toContain("applyRoleVisibility");
    expect(html).toContain("Operator · inspect and verify");
    expect(html).toContain("Viewer · read-only");
    expect(html).toContain("Live inference runs through an agent credential. Operator sessions can inspect receipts");
  });

  it("initializes DOM helpers before the session boot code uses them", () => {
    const html = renderOperatorConsole();
    const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    expect(script.indexOf("const $=")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("const sessionAgentField=")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("const $=")).toBeLessThan(script.indexOf("const sessionAgentField="));
    expect(script).toContain("$('#continueSession').onclick");
    expect(script).toContain("$('#recoverWorkspace').onclick");
    expect(script).toContain("const workspaceVisible=Boolean(workspace&&!workspace.hidden)");
    expect(script).toContain("if(workspaceVisible)setTimeout");
    expect(script).toContain("const humanReadOnly=viewer||operator");
    expect(script).toContain("OPERATOR_AGENT_SESSION_REQUIRED");
    expect(script).toContain("sandboxRun");
    expect(script).toContain("SANDBOX_RUN_NOT_FOUND");
    expect(script).toContain("body:JSON.stringify({seed})");
    expect(script).toContain("hero.firstElementChild");
  });
});

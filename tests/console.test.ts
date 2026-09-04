import { describe, expect, it } from "vitest";
import { renderOperatorConsole } from "../src/http/console.js";

describe("operator console beta paths", () => {
  it("includes the run explorer and TypeScript integration path", () => {
    const html = renderOperatorConsole();
    expect(html).toContain('data-view="runs"');
    expect(html).toContain('data-view="integration"');
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
  });
});

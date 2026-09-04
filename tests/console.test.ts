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

  it("initializes DOM helpers before the session boot code uses them", () => {
    const html = renderOperatorConsole();
    const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    expect(script.indexOf("const $=")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("const sessionAgentField=")).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("const $=")).toBeLessThan(script.indexOf("const sessionAgentField="));
    expect(script).toContain("$('#continueSession').onclick");
    expect(script).toContain("$('#recoverWorkspace').onclick");
    expect(script).toContain("workspace&&!workspace.hidden?$('#notice'):$('#onboardingResult')");
  });
});

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
});

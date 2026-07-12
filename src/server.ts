import { createRuntimeApp } from "./runtime.js";

const app = createRuntimeApp();
const port = Number(process.env["PORT"] ?? "8787");
app.listen(port, "0.0.0.0", () => {
  console.log(`Fuse API listening on :${port}`);
});

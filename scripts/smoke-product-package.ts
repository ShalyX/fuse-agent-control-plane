// The package self-reference resolves through the built export map at runtime.
// @ts-ignore TS source-tree resolution differs from the built package resolution.
const product = await import("fuse-agent-control-plane/product");

if (typeof product.ProductClient !== "function") {
  throw new Error("PRODUCT_PACKAGE_EXPORT_MISSING_CLIENT");
}
if (typeof product.ProductApiError !== "function") {
  throw new Error("PRODUCT_PACKAGE_EXPORT_MISSING_ERROR");
}

console.log("product package export ok");

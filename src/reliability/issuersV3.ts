import type { TrustedAuthorizationIssuers } from "../evidence/reliabilityRuntimeV2.js";

export const V3_OPERATOR_ISSUER = Object.freeze({
  id: "ed25519:1007ec41b6df02fd9e4992be9cc1549e77fb0b5d959f45613197129b480aad1c",
  rawPublicKeyHex: "db5fd4c3900a02def5c34e0a02a510eb77ae2aee76e6a688faaf1d16d81cfc53",
});

export const V3_RECONCILIATION_ISSUER = Object.freeze({
  id: "ed25519:5e5049801e5fa957138c17aba1c74008d87dc14614dd2c2250402159ea52d68e",
  rawPublicKeyHex: "07f9910b83c6833c71943db6de672f9cdd8d03dff3eb4f03afa17761d079bb8e",
});

export const V3_AUTHORIZATION_ISSUERS: TrustedAuthorizationIssuers = Object.freeze({
  operator: V3_OPERATOR_ISSUER,
  reconciliation: V3_RECONCILIATION_ISSUER,
});

import type { TrustedAuthorizationIssuers } from "../evidence/reliabilityRuntimeV2.js";

export const V4_OPERATOR_ISSUER = Object.freeze({
  id: "ed25519:c9cecda4bf1117ab5abde722701a11c6f91b01a5e5837113543edab6efdeff97",
  rawPublicKeyHex: "15e182462142568a6e3260d925c0a43a250a94b0d54fe860ad389b8b18c68de1",
});

export const V4_RECONCILIATION_ISSUER = Object.freeze({
  id: "ed25519:78159dfc2d1dadd79c23e7fed344164498bd680d854d074825594e5233806b97",
  rawPublicKeyHex: "d0f2f5f7ecfb0c0c68a3a82f368f843691b0183ae5230d85c0ba94f6b9653c75",
});

export const V4_AUTHORIZATION_ISSUERS: TrustedAuthorizationIssuers = Object.freeze({
  operator: V4_OPERATOR_ISSUER,
  reconciliation: V4_RECONCILIATION_ISSUER,
});

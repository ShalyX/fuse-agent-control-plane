import { describe, expect, it } from "vitest";
import { FinancialLedger, type JournalEntry } from "../src/domain/financialLedger.js";

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  id: "entry-1",
  actorId: "service:fuse",
  causationId: "request:req-1",
  occurredAt: "2026-07-13T00:00:00.000Z",
  description: "Reserve child allowance",
  postings: [
    { accountId: "customer:available", assetId: "eip155:5042002/usdc", side: "credit", amountAtomic: 5000n },
    { accountId: "customer:reserved", assetId: "eip155:5042002/usdc", side: "debit", amountAtomic: 5000n },
  ],
  ...overrides,
});

describe("FinancialLedger", () => {
  it("accepts a balanced journal entry and projects account balances", () => {
    const ledger = new FinancialLedger();
    ledger.append(entry());

    expect(ledger.balance("customer:available", "eip155:5042002/usdc")).toBe(-5000n);
    expect(ledger.balance("customer:reserved", "eip155:5042002/usdc")).toBe(5000n);
    expect(ledger.entries()).toEqual([entry()]);
  });

  it("rejects an entry that is not balanced per asset", () => {
    const ledger = new FinancialLedger();
    expect(() => ledger.append(entry({
      postings: [
        { accountId: "customer:available", assetId: "eip155:5042002/usdc", side: "credit", amountAtomic: 5000n },
        { accountId: "customer:reserved", assetId: "eip155:5042002/usdc", side: "debit", amountAtomic: 4999n },
      ],
    }))).toThrow("JOURNAL_ENTRY_UNBALANCED:eip155:5042002/usdc");
  });

  it("rejects zero and negative postings", () => {
    const ledger = new FinancialLedger();
    expect(() => ledger.append(entry({
      postings: [
        { accountId: "a", assetId: "usdc", side: "credit", amountAtomic: 0n },
        { accountId: "b", assetId: "usdc", side: "debit", amountAtomic: 0n },
      ],
    }))).toThrow("JOURNAL_POSTING_AMOUNT_INVALID");
  });

  it("rejects duplicate entry identifiers without changing balances", () => {
    const ledger = new FinancialLedger();
    ledger.append(entry());
    expect(() => ledger.append(entry())).toThrow("JOURNAL_ENTRY_DUPLICATE:entry-1");
    expect(ledger.balance("customer:reserved", "eip155:5042002/usdc")).toBe(5000n);
  });

  it("requires actor and causal identifiers for every mutation", () => {
    const ledger = new FinancialLedger();
    expect(() => ledger.append(entry({ actorId: "" }))).toThrow("JOURNAL_ENTRY_ACTOR_REQUIRED");
    expect(() => ledger.append(entry({ causationId: "" }))).toThrow("JOURNAL_ENTRY_CAUSATION_REQUIRED");
  });

  it("requires stable entry, account, and asset identifiers", () => {
    const ledger = new FinancialLedger();
    expect(() => ledger.append(entry({ id: "" }))).toThrow("JOURNAL_ENTRY_ID_REQUIRED");
    expect(() => ledger.append(entry({
      postings: [
        { accountId: "", assetId: "usdc", side: "credit", amountAtomic: 1n },
        { accountId: "b", assetId: "usdc", side: "debit", amountAtomic: 1n },
      ],
    }))).toThrow("JOURNAL_POSTING_ACCOUNT_REQUIRED");
    expect(() => ledger.append(entry({
      postings: [
        { accountId: "a", assetId: "", side: "credit", amountAtomic: 1n },
        { accountId: "b", assetId: "", side: "debit", amountAtomic: 1n },
      ],
    }))).toThrow("JOURNAL_POSTING_ASSET_REQUIRED");
  });

  it("rejects invalid posting sides received across runtime boundaries", () => {
    const ledger = new FinancialLedger();
    const invalid = entry();
    invalid.postings[0]!.side = "bogus" as "debit";
    expect(() => ledger.append(invalid)).toThrow("JOURNAL_POSTING_SIDE_INVALID");
  });

  it("requires a description and valid event timestamp", () => {
    const ledger = new FinancialLedger();
    expect(() => ledger.append(entry({ description: "" }))).toThrow("JOURNAL_ENTRY_DESCRIPTION_REQUIRED");
    expect(() => ledger.append(entry({ occurredAt: "not-a-date" }))).toThrow("JOURNAL_ENTRY_OCCURRED_AT_INVALID");
  });

  it("keeps appended history immutable from caller mutation", () => {
    const ledger = new FinancialLedger();
    const original = entry();
    ledger.append(original);
    original.description = "tampered";
    original.postings[0]!.amountAtomic = 1n;

    const stored = ledger.entries()[0]!;
    expect(stored.description).toBe("Reserve child allowance");
    expect(stored.postings[0]!.amountAtomic).toBe(5000n);
  });
});

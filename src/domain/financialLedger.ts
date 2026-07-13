export type PostingSide = "debit" | "credit";

export interface JournalPosting {
  accountId: string;
  assetId: string;
  side: PostingSide;
  amountAtomic: bigint;
}

export interface JournalEntry {
  id: string;
  actorId: string;
  causationId: string;
  occurredAt: string;
  description: string;
  postings: JournalPosting[];
}

const copyEntry = (entry: JournalEntry): JournalEntry => ({
  ...entry,
  postings: entry.postings.map((posting) => ({ ...posting })),
});

export class FinancialLedger {
  private readonly journal: JournalEntry[] = [];
  private readonly entryIds = new Set<string>();
  private readonly balances = new Map<string, bigint>();

  append(candidate: JournalEntry): void {
    if (!candidate.id.trim()) throw new Error("JOURNAL_ENTRY_ID_REQUIRED");
    if (!candidate.actorId.trim()) throw new Error("JOURNAL_ENTRY_ACTOR_REQUIRED");
    if (!candidate.causationId.trim()) throw new Error("JOURNAL_ENTRY_CAUSATION_REQUIRED");
    if (!candidate.description.trim()) throw new Error("JOURNAL_ENTRY_DESCRIPTION_REQUIRED");
    if (Number.isNaN(Date.parse(candidate.occurredAt))) throw new Error("JOURNAL_ENTRY_OCCURRED_AT_INVALID");
    if (this.entryIds.has(candidate.id)) throw new Error(`JOURNAL_ENTRY_DUPLICATE:${candidate.id}`);
    if (candidate.postings.length < 2) throw new Error("JOURNAL_ENTRY_POSTINGS_REQUIRED");

    const totals = new Map<string, { debits: bigint; credits: bigint }>();
    for (const posting of candidate.postings) {
      if (!posting.accountId.trim()) throw new Error("JOURNAL_POSTING_ACCOUNT_REQUIRED");
      if (!posting.assetId.trim()) throw new Error("JOURNAL_POSTING_ASSET_REQUIRED");
      if (posting.amountAtomic <= 0n) throw new Error("JOURNAL_POSTING_AMOUNT_INVALID");
      const total = totals.get(posting.assetId) ?? { debits: 0n, credits: 0n };
      total[posting.side === "debit" ? "debits" : "credits"] += posting.amountAtomic;
      totals.set(posting.assetId, total);
    }
    for (const [assetId, total] of totals) {
      if (total.debits !== total.credits) throw new Error(`JOURNAL_ENTRY_UNBALANCED:${assetId}`);
    }

    const entry = copyEntry(candidate);
    for (const posting of entry.postings) {
      const key = this.balanceKey(posting.accountId, posting.assetId);
      const direction = posting.side === "debit" ? 1n : -1n;
      this.balances.set(key, (this.balances.get(key) ?? 0n) + direction * posting.amountAtomic);
    }
    this.entryIds.add(entry.id);
    this.journal.push(entry);
  }

  balance(accountId: string, assetId: string): bigint {
    return this.balances.get(this.balanceKey(accountId, assetId)) ?? 0n;
  }

  entries(): JournalEntry[] {
    return this.journal.map(copyEntry);
  }

  private balanceKey(accountId: string, assetId: string): string {
    return `${accountId}\u0000${assetId}`;
  }
}

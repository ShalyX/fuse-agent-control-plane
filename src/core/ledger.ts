export type LedgerConfig = {
  mandateId: string;
  maximumSpendMicros: bigint;
  children: Record<string, bigint>;
};

type Account = {
  authorizedMicros: bigint;
  reservedMicros: bigint;
  settledMicros: bigint;
};

export type Reservation = {
  requestId: string;
  childId: string;
  maximumMicros: bigint;
  actualMicros?: bigint;
  status: "reserved" | "reconciled" | "released";
};

function available(account: Account): bigint {
  return account.authorizedMicros - account.reservedMicros - account.settledMicros;
}

export class FuseLedger {
  readonly mandateId: string;
  private readonly root: Account;
  private readonly children: Record<string, Account>;
  private readonly reservations = new Map<string, Reservation>();

  constructor(config: LedgerConfig) {
    if (config.maximumSpendMicros <= 0n) throw new Error("INVALID_ROOT_BUDGET");

    const allocated = Object.values(config.children).reduce((sum, value) => sum + value, 0n);
    if (allocated > config.maximumSpendMicros) throw new Error("CHILD_ALLOCATIONS_EXCEED_ROOT");

    this.mandateId = config.mandateId;
    this.root = {
      authorizedMicros: config.maximumSpendMicros,
      reservedMicros: 0n,
      settledMicros: 0n,
    };
    this.children = Object.fromEntries(
      Object.entries(config.children).map(([id, amount]) => [
        id,
        { authorizedMicros: amount, reservedMicros: 0n, settledMicros: 0n },
      ]),
    );
  }

  reserve(childId: string, maximumMicros: bigint, requestId: string): Reservation {
    const existing = this.reservations.get(requestId);
    if (existing) {
      if (existing.childId !== childId || existing.maximumMicros !== maximumMicros) {
        throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return { ...existing };
    }

    if (maximumMicros <= 0n) throw new Error("INVALID_RESERVATION");
    const child = this.children[childId];
    if (!child) throw new Error("UNKNOWN_CHILD");
    if (available(child) < maximumMicros) throw new Error("CHILD_BUDGET_EXCEEDED");
    if (available(this.root) < maximumMicros) throw new Error("ROOT_BUDGET_EXCEEDED");

    child.reservedMicros += maximumMicros;
    this.root.reservedMicros += maximumMicros;
    const reservation: Reservation = {
      requestId,
      childId,
      maximumMicros,
      status: "reserved",
    };
    this.reservations.set(requestId, reservation);
    return { ...reservation };
  }

  reconcile(requestId: string, actualMicros: bigint): Reservation {
    const reservation = this.reservations.get(requestId);
    if (!reservation) throw new Error("RESERVATION_NOT_FOUND");
    if (reservation.status === "reconciled") {
      if (reservation.actualMicros !== actualMicros) throw new Error("IDEMPOTENCY_CONFLICT");
      return { ...reservation };
    }
    if (reservation.status !== "reserved") throw new Error("RESERVATION_NOT_ACTIVE");
    if (actualMicros < 0n || actualMicros > reservation.maximumMicros) {
      throw new Error("ACTUAL_COST_EXCEEDS_RESERVATION");
    }

    const child = this.children[reservation.childId];
    child.reservedMicros -= reservation.maximumMicros;
    this.root.reservedMicros -= reservation.maximumMicros;
    child.settledMicros += actualMicros;
    this.root.settledMicros += actualMicros;
    reservation.actualMicros = actualMicros;
    reservation.status = "reconciled";
    return { ...reservation };
  }

  reclaimAvailable(childId: string): bigint {
    const child = this.children[childId];
    if (!child) throw new Error("UNKNOWN_CHILD");
    const reclaimedMicros = available(child);
    child.authorizedMicros -= reclaimedMicros;
    return reclaimedMicros;
  }

  snapshot() {
    const serialize = (account: Account) => ({
      ...account,
      availableMicros: available(account),
    });
    const parentUnallocatedMicros = this.root.authorizedMicros
      - Object.values(this.children).reduce((sum, account) => sum + account.authorizedMicros, 0n);
    return {
      mandateId: this.mandateId,
      parentUnallocatedMicros,
      root: serialize(this.root),
      children: Object.fromEntries(
        Object.entries(this.children).map(([id, account]) => [id, serialize(account)]),
      ),
    };
  }
}

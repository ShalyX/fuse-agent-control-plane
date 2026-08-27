import { DataType, newDb } from "pg-mem";

export function newAdvisoryMemoryDb(options: Parameters<typeof newDb>[0] = { noAstCoverageCheck: true }) {
  const db = newDb(options);
  db.public.registerFunction({ name: "hashtext", args: [DataType.text], returns: DataType.bigint, implementation: () => 1 });
  db.public.registerFunction({ name: "hashtextextended", args: [DataType.text, DataType.integer], returns: DataType.bigint, implementation: () => 1 });
  db.public.registerFunction({ name: "pg_advisory_lock", args: [DataType.bigint], returns: DataType.integer, implementation: () => 0 });
  db.public.registerFunction({ name: "pg_advisory_unlock", args: [DataType.bigint], returns: DataType.integer, implementation: () => 1 });
  db.public.registerFunction({ name: "pg_advisory_xact_lock_shared", args: [DataType.bigint], returns: DataType.integer, implementation: () => 0 });
  db.public.registerFunction({ name: "pg_advisory_xact_lock", args: [DataType.bigint], returns: DataType.integer, implementation: () => 0 });
  return db;
}

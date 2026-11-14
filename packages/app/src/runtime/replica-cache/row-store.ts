export { REPLICA_ROW_STORE_SCHEMA_VERSION, REPLICA_SINGLETON_ROW_ID } from "./row-store-schema";

export type ReplicaRowKind = "agent" | "workspace" | "project" | "timeline" | "checkpoint";

export interface ReplicaRowKey {
  serverId: string;
  kind: ReplicaRowKind;
  id: string;
}

export interface ReplicaRow extends ReplicaRowKey {
  payload: string;
}

export interface ReplicaRowChanges {
  upserts: ReplicaRow[];
  deletes: ReplicaRowKey[];
}

export interface ReplicaStoredRowIndex extends ReplicaRowKey {
  /** UTF-8 size of the stored payload. */
  bytes: number;
}

export interface ReplicaHostIndex {
  serverId: string;
  rows: ReplicaStoredRowIndex[];
}

export interface ReplicaRowStore {
  open(): Promise<void>;
  read(
    serverId: string,
    kinds: readonly ReplicaRowKind[],
    ids?: readonly string[],
  ): Promise<ReplicaRow[]>;
  /**
   * Every stored row's identity and size, without payloads. Budget accounting is the only reader
   * of the whole store, and the cache can hold tens of megabytes it has no reason to load.
   */
  readIndex(): Promise<ReplicaHostIndex[]>;
  apply(changes: ReplicaRowChanges): Promise<void>;
  deleteHost(serverId: string): Promise<void>;
  renameHost(oldServerId: string, newServerId: string): Promise<void>;
  clear(): Promise<void>;
}

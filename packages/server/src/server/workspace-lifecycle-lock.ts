import { AsyncLocalStorage } from "node:async_hooks";

interface AdmissionContext {
  keys: Set<string>;
  parent?: AdmissionContext;
  active: boolean;
}
interface AdmissionRequest {
  keys: Set<string>;
  resolving: boolean;
  startResolving?: () => void;
  ready: boolean;
  parent?: AdmissionContext;
  start(context: AdmissionContext): void;
  reject(error: unknown): void;
}
const overlaps = (left: Set<string>, right: Set<string>) => [...left].some((key) => right.has(key));

// Reservations preserve arrival order without occupying a lane while another resource is busy.
export class LifecycleAdmission {
  private readonly context = new AsyncLocalStorage<AdmissionContext>();
  private readonly active = new Set<AdmissionContext>();
  private readonly queue: AdmissionRequest[] = [];

  run<T>(
    keys: Iterable<string>,
    work: () => Promise<T>,
    options?: { additionalKeys?: () => Promise<string[]>; ready?: Promise<void> | null },
  ): Promise<T> {
    const parent = this.context.getStore();
    return new Promise<T>((resolve, reject) => {
      const request: AdmissionRequest = {
        keys: new Set(keys),
        resolving: options?.additionalKeys !== undefined,
        ready: !options?.ready,
        parent: parent?.active ? parent : undefined,
        reject,
        start: (context) => {
          const release = () => {
            context.active = false;
            this.active.delete(context);
            this.drain();
          };
          void Promise.resolve()
            .then(() => this.context.run(context, work))
            .then(
              (value) => {
                release();
                resolve(value);
                return undefined;
              },
              (error) => {
                release();
                reject(error);
              },
            );
        },
      };
      this.queue.push(request);
      if (options?.additionalKeys) {
        request.startResolving = () => {
          void Promise.resolve()
            .then(options.additionalKeys)
            .then(
              (additional) => {
                for (const key of additional!) request.keys.add(key);
                request.resolving = false;
                this.drain();
                return undefined;
              },
              (error) => this.fail(request, error),
            );
        };
      }
      if (options?.ready) {
        void options.ready.then(
          () => {
            request.ready = true;
            this.drain();
            return undefined;
          },
          (error) => this.fail(request, error),
        );
      }
      this.drain();
    });
  }

  private fail(request: AdmissionRequest, error: unknown): void {
    const index = this.queue.indexOf(request);
    if (index < 0) return;
    this.queue.splice(index, 1);
    request.reject(error);
    this.drain();
  }

  private ancestors(request: AdmissionRequest): Set<AdmissionContext> {
    const ancestors = new Set<AdmissionContext>();
    for (let owner = request.parent; owner?.active; owner = owner.parent) ancestors.add(owner);
    return ancestors;
  }

  private conflicts(left: AdmissionRequest, right: AdmissionRequest): boolean {
    // Unknown workspace lookup must settle before a later workspace can overtake it.
    return (
      overlaps(left.keys, right.keys) ||
      (left.resolving && [...right.keys].some((key) => key.startsWith("workspace:"))) ||
      (right.resolving && [...left.keys].some((key) => key.startsWith("workspace:")))
    );
  }

  private blockedByAncestors(ancestors: Set<AdmissionContext>): Set<AdmissionRequest> {
    const blocked = new Set<AdmissionRequest>();
    if (!ancestors.size) return blocked;
    for (const request of this.queue) {
      if (
        [...ancestors].some((owner) => overlaps(owner.keys, request.keys)) ||
        [...blocked].some((previous) => this.conflicts(previous, request))
      )
        blocked.add(request);
    }
    return blocked;
  }

  private canEnter(request: AdmissionRequest, index: number, resolving = false): boolean {
    const ancestors = this.ancestors(request);
    if (
      [...this.active].some((owner) => !ancestors.has(owner) && overlaps(owner.keys, request.keys))
    )
      return false;
    const blocked = this.blockedByAncestors(ancestors);
    return !this.queue
      .slice(0, index)
      .some(
        (previous) =>
          (resolving ? overlaps(previous.keys, request.keys) : this.conflicts(previous, request)) &&
          !blocked.has(previous),
      );
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length;) {
      const request = this.queue[index]!;
      if (request.startResolving && this.canEnter(request, index, true)) {
        const start = request.startResolving;
        request.startResolving = undefined;
        start();
      }
      if (request.resolving || !request.ready || !this.canEnter(request, index)) {
        index++;
        continue;
      }
      this.queue.splice(index, 1);
      const parent = request.parent?.active ? request.parent : undefined;
      const context = { keys: request.keys, parent, active: true };
      this.active.add(context);
      request.start(context);
    }
  }
}

export const lifecycleAdmission = new LifecycleAdmission();
export const workspaceLifecycleKeys = (ids: Iterable<string>): string[] =>
  [...new Set(ids)].map((id) => `workspace:${id}`);

export function withWorkspaceLifecycleLock<T>(
  workspaceIds: Iterable<string>,
  work: () => Promise<T>,
): Promise<T> {
  return lifecycleAdmission.run(workspaceLifecycleKeys(workspaceIds), work);
}

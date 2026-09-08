export class QueueFullError extends Error {
  constructor() {
    super("browser request queue is full");
    this.name = "QueueFullError";
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super("browser request timed out");
    this.name = "RequestTimeoutError";
  }
}

export type RequestGate = {
  run<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
};

type Entry = {
  readonly signal: AbortSignal;
  readonly operation: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onAbort: () => void;
  started: boolean;
  controller?: AbortController;
};

export function createRequestGate(options: {
  readonly maxQueued: number;
  readonly timeoutMs: number;
}): RequestGate {
  const queue: Entry[] = [];
  let active = false;

  function drain(): void {
    if (active) return;
    const entry = queue.shift();
    if (!entry) return;
    start(entry);
  }

  function start(entry: Entry): void {
    active = true;
    entry.started = true;
    const controller = new AbortController();
    entry.controller = controller;
    if (entry.signal.aborted) {
      controller.abort(entry.signal.reason);
    }

    const operation = Promise.resolve().then(() =>
      entry.operation(controller.signal),
    );
    const aborted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });

    void Promise.race([operation, aborted]).then(entry.resolve, entry.reject);
    void operation.then(
      () => finish(entry),
      () => finish(entry),
    );
  }

  function finish(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.signal.removeEventListener("abort", entry.onAbort);
    active = false;
    drain();
  }

  return {
    run<T>(
      signal: AbortSignal,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (signal.aborted) {
        return Promise.reject(signal.reason);
      }
      if (active && queue.length >= options.maxQueued) {
        return Promise.reject(new QueueFullError());
      }

      return new Promise<T>((resolve, reject) => {
        let entry: Entry;
        const onAbort = () => {
          if (entry.started) {
            entry.controller?.abort(signal.reason);
            return;
          }
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          clearTimeout(entry.timer);
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          const error = new RequestTimeoutError();
          if (entry.started) {
            entry.controller?.abort(error);
            return;
          }
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }, options.timeoutMs);
        entry = {
          signal,
          operation: operation as (signal: AbortSignal) => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
          onAbort,
          started: false,
        };
        signal.addEventListener("abort", onAbort, { once: true });

        if (active) queue.push(entry);
        else start(entry);
      });
    },
  };
}

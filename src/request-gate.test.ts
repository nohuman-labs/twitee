import { describe, expect, it, vi } from "vitest";
import {
  QueueFullError,
  RequestTimeoutError,
  createRequestGate,
} from "./request-gate.js";

describe("request gate", () => {
  it("runs one operation at a time in FIFO order", async () => {
    const gate = createRequestGate({ maxQueued: 10, timeoutMs: 1_000 });
    const release = Promise.withResolvers<void>();
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const operation = (id: number, wait = false) =>
      gate.run(new AbortController().signal, async () => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(id);
        if (wait) await release.promise;
        active -= 1;
      });

    const first = operation(1, true);
    const second = operation(2);
    const third = operation(3);
    await vi.waitFor(() => expect(order).toEqual([1]));
    release.resolve();
    await Promise.all([first, second, third]);

    expect(order).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("rejects requests beyond the waiting limit", async () => {
    const gate = createRequestGate({ maxQueued: 10, timeoutMs: 1_000 });
    const release = Promise.withResolvers<void>();
    const first = gate.run(new AbortController().signal, () => release.promise);
    const waiting = Array.from({ length: 10 }, () =>
      gate.run(new AbortController().signal, async () => undefined),
    );

    await expect(
      gate.run(new AbortController().signal, async () => undefined),
    ).rejects.toBeInstanceOf(QueueFullError);

    release.resolve();
    await Promise.all([first, ...waiting]);
  });

  it("counts queue wait against the request deadline", async () => {
    const gate = createRequestGate({ maxQueued: 10, timeoutMs: 30 });
    const release = Promise.withResolvers<void>();
    const first = gate
      .run(new AbortController().signal, () => release.promise)
      .catch((error: unknown) => error);

    await expect(
      gate.run(new AbortController().signal, async () => "late"),
    ).rejects.toBeInstanceOf(RequestTimeoutError);

    release.resolve();
    await expect(first).resolves.toBeInstanceOf(RequestTimeoutError);
  });

  it("removes a cancelled request before it runs", async () => {
    const gate = createRequestGate({ maxQueued: 10, timeoutMs: 1_000 });
    const release = Promise.withResolvers<void>();
    const first = gate.run(new AbortController().signal, () => release.promise);
    const controller = new AbortController();
    let ran = false;
    const cancelled = gate.run(controller.signal, async () => {
      ran = true;
    });

    controller.abort(new Error("client disconnected"));
    await expect(cancelled).rejects.toThrow("client disconnected");
    release.resolve();
    await first;

    expect(ran).toBe(false);
  });

  it("aborts active work when its deadline expires", async () => {
    const gate = createRequestGate({ maxQueued: 10, timeoutMs: 30 });

    await expect(
      gate.run(new AbortController().signal, (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});

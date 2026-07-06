import type { Invoker, InvokerKind } from "./invoker";

/**
 * Stub `Invoker` for tests that need to construct an `InvocationRegistry`
 * (or a manager-with-registry) without actually dispatching. Any code
 * path that reaches `invoke()` will throw with a helpful message so a
 * misuse fails loudly instead of stalling.
 *
 * Replaces four copies that lived in invoker.test.ts, registry.test.ts,
 * server.test.ts, and invocation-manager.test.ts.
 */
export function stubInvoker(kind: InvokerKind): Invoker {
  return {
    kind,
    invoke: () => {
      throw new Error(`stub Invoker: ${kind}.invoke not implemented`);
    },
  };
}

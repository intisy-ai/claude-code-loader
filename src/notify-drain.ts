// The `bus-drain` CLI action, run by the Claude Stop/PostToolUse hook. Drains the
// shared event bus and re-emits pending notifications as a single Claude Code
// `systemMessage` (shown to the USER, never added to the model's context). Queue
// semantics: a persisted cursor means each notification surfaces exactly once, even
// across the concurrent hook invocations a long turn produces.
import { drain, TOPICS } from "@intisy-ai/basekit";

/**
 * Drains the shared event bus and shows every pending notification as one system message.
 *
 * @remarks
 * The cursor is persisted, so a notification surfaces exactly once even across the concurrent hook
 * invocations a long turn produces.
 */
export function busDrain(): void {
  const messages: string[] = [];
  drain("claude-notify", (event) => {
    const payload = event.payload as { message?: unknown } | undefined;
    if (event.topic === TOPICS.notification && payload && typeof payload.message === "string") {
      messages.push(payload.message);
    }
  });
  if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join("\n"), suppressOutput: true, continue: true }));
  }
}

// @ts-nocheck
// The `bus-drain` CLI action, run by the Claude Stop/PostToolUse hook. Drains the
// shared event bus and re-emits pending notifications as a single Claude Code
// `systemMessage` (shown to the USER, never added to the model's context). Queue
// semantics: a persisted cursor means each notification surfaces exactly once, even
// across the concurrent hook invocations a long turn produces.
import { drain, TOPICS } from "@intisy-ai/core";

export function busDrain() {
  const messages = [];
  drain("claude-notify", (event) => {
    if (event.topic === TOPICS.notification && event.payload && event.payload.message) {
      messages.push(event.payload.message);
    }
  });
  if (messages.length) {
    process.stdout.write(JSON.stringify({ systemMessage: messages.join("\n"), suppressOutput: true, continue: true }));
  }
}

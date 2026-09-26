import { defineConfig } from "vitest/config";

// Unit tests for the Worker's pure modules (routing, config, headers,
// framing, the late-joiner cache). They import nothing from
// "cloudflare:workers", so they run in plain node.
export default defineConfig({
  test: {
    include: ["worker/test/**/*.test.ts"],
  },
});

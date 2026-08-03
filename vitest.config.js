import { defineConfig } from "vitest/config";

/**
 * The root project is the EXTENSION's tests, and only those.
 *
 * `frontend/` is a separate package with its own vitest config, its own jsdom,
 * and a React plugin this project does not load — without an explicit include
 * the root runner discovers its .test.tsx files and runs them raw, which fails
 * in a way that looks like the frontend is broken when it is green.
 */
export default defineConfig({
  test: {
    include: ["extension/**/*.test.js"],
    exclude: ["**/node_modules/**", "frontend/**"],
  },
});

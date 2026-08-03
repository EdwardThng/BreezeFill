import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    // Only this package's tests. Without a root the runner walks up into
    // extension/, which is a separate vitest project with its own setup.
    root: ".",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"],
  },
});

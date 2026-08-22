import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Fake credentials for tests. Deliberately NOT in wrangler.toml [vars]:
        // a deployed var name blocks creating the real secret of the same name.
        miniflare: {
          bindings: {
            EMT_EMAIL: "test@example.com",
            EMT_PASSWORD: "test-password",
            APP_KEY: "test-app-key",
            SUPABASE_URL: "https://test.supabase.co",
            SUPABASE_SERVICE_KEY: "test-service-key",
          },
        },
      },
    },
  },
});

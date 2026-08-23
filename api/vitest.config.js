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
            SUPABASE_ANON_KEY: "test-anon-key",
            OWNER_USER_ID: "owner-user-id",
            MPASS_EMAIL: "rider@example.com",
            MPASS_PASSWORD: "test-mpass-password",
            MPASS_CLIENT_ID: "test-mpass-client",
            MPASS_PASSKEY: "test-mpass-passkey",
            MPASS_DEVICE_ID: "test-mpass-device",
            SUPABASE_URL: "https://test.supabase.co",
          },
        },
      },
    },
  },
});

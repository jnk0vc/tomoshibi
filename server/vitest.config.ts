import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// migrationsディレクトリのSQLを読み込み、テスト用のバインディングとして渡す。
// テスト開始時に、test/apply-migrations.tsがローカルD1へ適用する（本物のスキーマで試すため）。
const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    // 同じローカルD1を使うので、テストファイルは1つずつ実行する
    fileParallelism: false,
    // Vitest 5が既定で使う変換結果のディスクキャッシュは、workerd上のテストランナーから読めず失敗する
    fsModuleCache: false,
  },
});

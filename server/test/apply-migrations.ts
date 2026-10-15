import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// vitest.config.tsが読み込んだmigrationsの内容を、テスト用のローカルD1へ適用する。
// 適用済みのマイグレーションは読み飛ばされるので、毎回呼んでも問題ない。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

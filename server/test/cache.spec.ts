import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEADERBOARD_CACHE_TTL_SECONDS, leaderboardCacheKey } from "../src/cache";
import { SQL } from "../src/sql";
import {
  BASE,
  callWithDb,
  clearLeaderboardCache,
  instrumentDb,
  leaderboardNoPurge,
  newCredentials,
  postScore,
  score,
  seed,
  setupPerTest,
} from "./helpers";

setupPerTest();

// キャッシュは3ボード×limitごとのキーで残るので、このファイルでは各テストの前後で全部消す
beforeEach(clearLeaderboardCache);
afterEach(async () => {
  vi.restoreAllMocks();
  await clearLeaderboardCache();
});

interface Entry {
  rank: number;
  name: string;
  level: number;
  deepest: number;
  totalExp: number;
  isYou: boolean;
}

const names = (entries: Entry[]) => entries.map((e) => e.name);

/** 差し替えたDB経由でランキングを取り、D1に投げられたSQLも返す。 */
async function getCounted(path: string) {
  const spy = instrumentDb(env.DB);
  const res = await callWithDb(spy.db, path);
  return { res, prepared: spy.prepared };
}

describe("GET /v1/leaderboardのキャッシュ（meなしの部分）", () => {
  it("2回目のGETはキャッシュの内容を返し、D1を1回も読まない", async () => {
    await seed([{ name: "A", level: 30 }, { name: "B", level: 20 }, { name: "C", level: 10 }]);
    const first = await getCounted("/v1/leaderboard?limit=5");
    expect(first.res.status).toBe(200);
    expect(first.prepared).toEqual([SQL.leaderboard.level, SQL.countPlayers]);
    expect(first.res.body.players).toBe(3);

    // D1の中身を変える（上位に1人増える）
    await seed([{ name: "新人", level: 99 }]);

    const second = await getCounted("/v1/leaderboard?limit=5");
    expect(second.res.status).toBe(200);
    expect(second.prepared).toEqual([]);
    // 変更前の上位3人と人数が、そのまま返る
    expect(names(second.res.body.entries)).toEqual(["A", "B", "C"]);
    expect(second.res.body.players).toBe(3);
    expect(second.res.body).toEqual(first.res.body);
  });

  it("exports経由（本番と同じ入口）でも、同じキャッシュを使う", async () => {
    await seed([{ name: "A", level: 30 }]);
    expect((await leaderboardNoPurge("?limit=5")).body.entries).toHaveLength(1);
    await seed([{ name: "B", level: 20 }]);
    // キャッシュが効いているので、あとから増えたBは見えない
    expect(names((await leaderboardNoPurge("?limit=5")).body.entries)).toEqual(["A"]);
    const direct = await getCounted("/v1/leaderboard?limit=5");
    expect(direct.prepared).toEqual([]);
  });

  it("キャッシュのキーはbyとlimitだけで、byやlimitが違えば別々に読む", async () => {
    await seed([{ name: "A", level: 30, totalExp: 1 }, { name: "B", level: 20, totalExp: 2 }]);
    await getCounted("/v1/leaderboard?by=level&limit=5");

    // 同じ組み合わせはキャッシュから
    expect((await getCounted("/v1/leaderboard?by=level&limit=5")).prepared).toEqual([]);
    // 省略した既定値(by=level、limit=20)は、明示した組み合わせと同じキー
    expect((await getCounted("/v1/leaderboard?limit=5")).prepared).toEqual([]);
    // byかlimitが違えばD1から読む
    expect((await getCounted("/v1/leaderboard?by=exp&limit=5")).prepared).toContain(SQL.leaderboard.exp);
    expect((await getCounted("/v1/leaderboard?by=level&limit=6")).prepared).toContain(SQL.leaderboard.level);
    // 知らないパラメータはキーに影響しない
    expect((await getCounted("/v1/leaderboard?foo=1&limit=5")).prepared).toEqual([]);
  });

  it("キャッシュに保存するのはmeを含まないデータで、保存用のResponseだけがmax-ageを持つ", async () => {
    const [id] = await seed([{ name: "A", level: 30 }]);
    await getCounted(`/v1/leaderboard?limit=5&me=${id}`);

    const stored = await caches.default.match(leaderboardCacheKey(BASE, "level", 5));
    expect(stored).toBeDefined();
    expect(stored?.headers.get("cache-control")).toBe(`max-age=${LEADERBOARD_CACHE_TTL_SECONDS}`);
    expect(LEADERBOARD_CACHE_TTL_SECONDS).toBeGreaterThanOrEqual(5);
    expect(LEADERBOARD_CACHE_TTL_SECONDS).toBeLessThanOrEqual(10);

    const data = await stored?.json<{ entries: { id: string; name: string }[]; players: number }>();
    // meやisYouは入らず、isYouを付け直すためのidだけがキャッシュの中にある
    expect(Object.keys(data ?? {}).sort()).toEqual(["entries", "players"]);
    expect(data?.entries[0]).toMatchObject({ id, name: "A" });
    expect(data?.entries[0]).not.toHaveProperty("isYou");
  });
});

describe("GET /v1/leaderboardのキャッシュ（me付き）", () => {
  it("キャッシュした上位N件に、自分の行と順位だけをD1から読んで足す", async () => {
    const ids = await seed([
      { name: "A", level: 30 },
      { name: "B", level: 20 },
      { name: "C", level: 10 },
    ]);
    // meなしで上位をキャッシュに載せる
    await getCounted("/v1/leaderboard?limit=2");

    // 上位の外にいるCを指定する。D1に投げるのは「自分」の1文だけ
    const withMe = await getCounted(`/v1/leaderboard?limit=2&me=${ids[2]}`);
    expect(withMe.prepared).toEqual([SQL.me.level]);
    expect(names(withMe.res.body.entries)).toEqual(["A", "B"]);
    expect(withMe.res.body.me).toEqual({ rank: 3, name: "C", level: 10, deepest: 1, totalExp: 0 });
    expect(withMe.res.body.players).toBe(3);
  });

  it("isYouはidの比較で付け直し、meが違えば付く人も違う", async () => {
    const ids = await seed([{ name: "A", level: 30 }, { name: "B", level: 20 }, { name: "C", level: 10 }]);
    // meを付けた最初のGET（キャッシュなし）
    const first = await getCounted(`/v1/leaderboard?limit=3&me=${ids[0]}`);
    expect(first.res.body.entries.map((e: Entry) => e.isYou)).toEqual([true, false, false]);

    // 同じキーのキャッシュを、別のmeで使う
    const second = await getCounted(`/v1/leaderboard?limit=3&me=${ids[1]}`);
    expect(second.prepared).toEqual([SQL.me.level]);
    expect(second.res.body.entries.map((e: Entry) => e.isYou)).toEqual([false, true, false]);

    // meなし、登録のないme
    const none = await getCounted("/v1/leaderboard?limit=3");
    expect(none.res.body.entries.map((e: Entry) => e.isYou)).toEqual([false, false, false]);
    const stranger = await getCounted(`/v1/leaderboard?limit=3&me=${crypto.randomUUID()}`);
    expect(stranger.res.body.entries.map((e: Entry) => e.isYou)).toEqual([false, false, false]);
    expect(stranger.res.body.me).toBeNull();
  });

  it("自分の順位と成績は、キャッシュが古くても今のD1の値になる", async () => {
    const ids = await seed([{ name: "A", level: 30 }, { name: "B", level: 20 }]);
    await getCounted("/v1/leaderboard?limit=5"); // キャッシュに載る（A、B）

    // Bが追い越されて、成績も変わる
    await seed([{ name: "新人1", level: 25 }, { name: "新人2", level: 40 }]);
    await env.DB.prepare("UPDATE players SET name = '改名後' WHERE id = ?").bind(ids[1]).run();

    const res = (await getCounted(`/v1/leaderboard?limit=5&me=${ids[1]}`)).res;
    expect(names(res.body.entries)).toEqual(["A", "B"]); // 上位は古いキャッシュのまま
    expect(res.body.me).toMatchObject({ rank: 4, name: "改名後", level: 20 }); // 自分は最新
  });
});

describe("キャッシュを使った応答の中身", () => {
  it("クライアントへの応答はno-storeで、idやCache-Controlのmax-ageを含まない（キャッシュのヒットでも同じ）", async () => {
    await seed([{ name: "A", level: 30 }]);
    for (const label of ["ミス", "ヒット"]) {
      const { res } = await getCounted("/v1/leaderboard?limit=5");
      expect(res.headers.get("cache-control"), label).toBe("no-store");
      expect(res.headers.get("content-type"), label).toBe("application/json; charset=utf-8");
      expect(Object.keys(res.body).sort(), label).toEqual(["by", "entries", "me", "players"]);
      expect(Object.keys(res.body.entries[0]).sort(), label).toEqual([
        "deepest",
        "isYou",
        "level",
        "name",
        "rank",
        "totalExp",
      ]);
      expect(res.text, label).not.toMatch(/"id"/);
    }
  });

  it("エラー応答はキャッシュを使わず、キャッシュにも保存しない", async () => {
    await seed([{ name: "A" }]);
    const { res, prepared } = await getCounted("/v1/leaderboard?by=bogus");
    expect(res.status).toBe(400);
    expect(prepared).toEqual([]);
    expect(await caches.default.match(leaderboardCacheKey(BASE, "bogus", 20))).toBeUndefined();
    expect(await caches.default.match(leaderboardCacheKey(BASE, "level", 20))).toBeUndefined();
  });

  it("順位（同順位の飛び方）もキャッシュの内容に含まれ、ヒットでも同じになる", async () => {
    await seed([50, 40, 40, 30].map((level, i) => ({ name: `p${i}`, level })));
    const miss = await getCounted("/v1/leaderboard");
    const hit = await getCounted("/v1/leaderboard");
    expect(hit.prepared).toEqual([]);
    expect(hit.res.body.entries.map((e: Entry) => e.rank)).toEqual([1, 2, 2, 4]);
    expect(hit.res.body).toEqual(miss.res.body);
  });
});

describe("キャッシュが使えないとき", () => {
  it("キャッシュの中身が期待した形でなければ、D1から読み直して正しく応答する", async () => {
    await seed([{ name: "A", level: 30 }]);
    await caches.default.put(
      leaderboardCacheKey(BASE, "level", 5),
      new Response(JSON.stringify({ entries: [{ unexpected: true }], players: "many" }), {
        headers: { "cache-control": "max-age=10" },
      }),
    );

    const { res, prepared } = await getCounted("/v1/leaderboard?limit=5");
    expect(res.status).toBe(200);
    expect(names(res.body.entries)).toEqual(["A"]);
    expect(prepared).toEqual([SQL.leaderboard.level, SQL.countPlayers]);
  });

  it("キャッシュの読み書きが失敗しても、D1から読んで200で応答する", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(caches.default, "match").mockRejectedValue(new Error("cache read failed"));
    vi.spyOn(caches.default, "put").mockRejectedValue(new Error("cache write failed"));
    await seed([{ name: "A", level: 30 }]);

    const { res, prepared } = await getCounted("/v1/leaderboard?limit=5");
    expect(res.status).toBe(200);
    expect(names(res.body.entries)).toEqual(["A"]);
    expect(prepared).toEqual([SQL.leaderboard.level, SQL.countPlayers]);
  });
});

describe("書き込みとキャッシュ", () => {
  it("POSTで登録しても、数秒のあいだ上位N件は古いまま（meには自分が出る）", async () => {
    const other = newCredentials();
    await postScore(other, score({ name: "先客", level: 10 }));
    expect((await leaderboardNoPurge("?limit=5")).body.entries).toHaveLength(1);

    const mine = newCredentials();
    await postScore(mine, score({ name: "新入り", level: 12, ticks: 100 }));

    const res = await leaderboardNoPurge(`?limit=5&me=${mine.playerId}`);
    expect(names(res.body.entries)).toEqual(["先客"]);
    expect(res.body.me).toMatchObject({ rank: 1, name: "新入り" });
  });
});

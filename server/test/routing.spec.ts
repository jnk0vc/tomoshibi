import { describe, expect, it } from "vitest";
import { call, expectError, newCredentials, score, sendRaw, setupPerTest } from "./helpers";

setupPerTest();

describe("404（知らないパス）", () => {
  const paths = [
    "/",
    "/v1",
    "/v1/",
    "/v1/score",
    "/v1/scores/",
    "/v1/scores/abc",
    "/v1/leaderboard/",
    "/v1/leaderboard/level",
    "/v2/scores",
    "/V1/scores",
    "//v1/scores",
    "/admin",
    "/v1/players",
    "/favicon.ico",
  ];

  it.each(paths)("GET %s → 404", async (path) => {
    expectError(await call(path), 404, "not found");
  });

  it("メソッドによらず、知らないパスは404（405にならない）", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      const res = await call("/v1/nothing", { method });
      expect(res.status, method).toBe(404);
    }
  });

  it("知らないパスへのPOSTは本文を見る前に404", async () => {
    expectError(await sendRaw("POST", "/v1/nothing", "x", "text/plain"), 404);
  });
});

describe("405（既知のパスへの未対応メソッド）", () => {
  it.each(["GET", "PUT", "PATCH", "HEAD", "OPTIONS"])("%s /v1/scores → 405 (Allow: POST, DELETE)", async (method) => {
    const res = await call("/v1/scores", { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, DELETE");
    if (method !== "HEAD") expectError(res, 405, "method not allowed");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("%s /v1/leaderboard → 405 (Allow: GET)", async (method) => {
    const res = await call("/v1/leaderboard", { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    if (method !== "HEAD") expectError(res, 405, "method not allowed");
  });

  it("メソッドの判定はContent-Typeの判定より先（PUTにtext/plainでも405）", async () => {
    expectError(await sendRaw("PUT", "/v1/scores", JSON.stringify(score()), "text/plain"), 405);
  });

  it("405の応答でも秘密情報を含まない", async () => {
    const res = await call("/v1/scores", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...newCredentials(), ...score() }),
    });
    expect(res.status).toBe(405);
  });
});

describe("エラー応答の共通形式", () => {
  it("エラーはどれもerrorキーだけのJSONで、content-typeはUTF-8付き", async () => {
    const responses = [
      await call("/nope"),
      await call("/v1/scores"),
      await sendRaw("POST", "/v1/scores", "{", "application/json"),
      await sendRaw("POST", "/v1/scores", "{}", "text/plain"),
      await call("/v1/leaderboard?limit=0"),
    ];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(Object.keys(res.body)).toEqual(["error"]);
    }
  });
});

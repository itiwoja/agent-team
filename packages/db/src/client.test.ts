// client.ts（postgres.js の包み）の試験：値の変換・1回に1つの文・トランザクション・エラーの見分け
import { describe, expect, it } from "vitest";
import { isCheckViolation, isRetryableTxError, isUniqueViolation, parseInt8, pgErrorInfo, socketHostOf, withoutHostParam, withTransaction } from "./client.ts";
import { useTestDb } from "./testing.ts";

const T = useTestDb();

describe("値の変換（DB I-34）", () => {
  it("int8 は number、numeric は文字列、timestamptz は Date、bytea は Buffer、jsonb は値、配列は配列", async () => {
    const { db } = T();
    const r = await db.query(
      `SELECT 9007199254740991::int8 AS a, 0.1::numeric(12,6) + 0.2::numeric(12,6) AS b,
              '2026-10-12T09:00:00.123Z'::timestamptz AS c, '\\x00ff'::bytea AS d, '{"x":[1,2],"y":"雪"}'::jsonb AS e,
              ARRAY[1,2]::int8[] AS f, ARRAY['a','b']::text[] AS g, count(*) AS n FROM (VALUES (1),(2)) v(x)`,
    );
    expect(r.rows[0]).toEqual({
      a: 9007199254740991,
      b: "0.300000",
      c: new Date("2026-10-12T09:00:00.123Z"),
      d: Buffer.from([0, 255]),
      e: { x: [1, 2], y: "雪" },
      f: [1, 2],
      g: ["a", "b"],
      n: 2,
    });
    expect(r.rowCount).toBe(1);
  });

  it("2^53 を超える int8 は精度を落とさず例外にする", async () => {
    const { db } = T();
    await expect(db.query("SELECT 9007199254740993::int8 AS a")).rejects.toThrow(/安全な整数/);
    expect(() => parseInt8("9007199254740993")).toThrow(RangeError);
    expect(parseInt8("-42")).toBe(-42);
  });

  it("jsonb・uuid[]・bytea・Date の引数はそのまま渡せる（jsonb に JSON.stringify した文字列を渡さない）", async () => {
    const { db } = T();
    const r = await db.query<{ j: unknown; s: unknown; u: string[]; b: Buffer; t: Date }>(
      "SELECT $1::jsonb AS j, $2::jsonb AS s, $3::uuid[] AS u, $4::bytea AS b, $5::timestamptz AS t",
      [{ a: [1, { b: null }] }, "文字", ["00000000-0000-0000-0000-0000000000a1"], Buffer.from("hi"), new Date("2026-10-12T00:00:00Z")],
    );
    expect(r.rows[0]).toEqual({
      j: { a: [1, { b: null }] },
      s: "文字",
      u: ["00000000-0000-0000-0000-0000000000a1"],
      b: Buffer.from("hi"),
      t: new Date("2026-10-12T00:00:00Z"),
    });
  });

  it("1回に1つの文だけ（引数なしでも複数の文は流さない）", async () => {
    const { db } = T();
    await expect(db.query("SELECT 1; SELECT 2")).rejects.toThrow();
  });

  it("UPDATE・DELETE の rowCount は変わった行の数", async () => {
    const { db } = T();
    await db.query("INSERT INTO users (login) VALUES ('a'), ('b'), ('c')");
    expect((await db.query("UPDATE users SET name = 'x' WHERE login IN ('a','b')")).rowCount).toBe(2);
    expect((await db.query("DELETE FROM users WHERE login = 'zzz'")).rowCount).toBe(0);
  });
});

describe("トランザクション", () => {
  it("例外で戻り、成功ならコミットする", async () => {
    const { db } = T();
    await expect(
      db.transaction(async (tx) => {
        await tx.query("INSERT INTO users (login) VALUES ('rollback-me')");
        throw new Error("やめる");
      }),
    ).rejects.toThrow("やめる");
    const ok = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO users (login) VALUES ('keep-me')");
      return 7;
    });
    expect(ok).toBe(7);
    const r = await db.query<{ login: string }>("SELECT login FROM users ORDER BY login");
    expect(r.rows.map((x) => x.login)).toEqual(["keep-me"]);
  });

  it("withTransaction は Tx ならそのまま、Db なら新しいトランザクションで動かす", async () => {
    const { db } = T();
    await db.transaction(async (tx) => {
      const inner = await withTransaction(tx, async (t2) => {
        expect(t2).toBe(tx);
        await t2.query("INSERT INTO users (login) VALUES ('nested')");
        return (await t2.query<{ n: number }>("SELECT count(*) AS n FROM users")).rows[0]?.n;
      });
      expect(inner).toBe(1);
    });
    await withTransaction(db, async (tx) => {
      expect(tx.inTransaction).toBe(true);
    });
  });

  it("savepoint の中の失敗はそこまで戻し、外は続けられる", async () => {
    const { db } = T();
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO users (login) VALUES ('outer')");
      await expect(
        tx.savepoint(async (sp) => {
          await sp.query("INSERT INTO users (login) VALUES ('inner')");
          await sp.query("INSERT INTO users (login) VALUES ('outer')"); // 一意の違反
        }),
      ).rejects.toSatisfy((e: unknown) => isUniqueViolation(e, "users_login_uq"));
      await tx.query("INSERT INTO users (login) VALUES ('after')");
    });
    const r = await db.query<{ login: string }>("SELECT login FROM users ORDER BY login");
    expect(r.rows.map((x) => x.login)).toEqual(["after", "outer"]);
  });

  it("retryOnce：直列化の失敗・デッドロックなら1回だけやり直す（SO §3.14）", async () => {
    const { db } = T();
    let calls = 0;
    const out = await db.transaction(
      async (tx) => {
        calls += 1;
        await tx.query("INSERT INTO users (login) VALUES ($1)", [`retry-${calls}`]);
        if (calls === 1) throw Object.assign(new Error("could not serialize"), { name: "PostgresError", code: "40001" });
        return "done";
      },
      { retryOnce: true, isolation: "serializable" },
    );
    expect(out).toBe("done");
    expect(calls).toBe(2);
    const r = await db.query<{ login: string }>("SELECT login FROM users");
    expect(r.rows.map((x) => x.login)).toEqual(["retry-2"]);
    // 2回目も失敗したら投げる・retryOnce なしならやり直さない
    let n = 0;
    const fail = () => {
      n += 1;
      throw Object.assign(new Error("deadlock"), { name: "PostgresError", code: "40P01" });
    };
    await expect(db.transaction(async () => fail(), { retryOnce: true })).rejects.toThrow("deadlock");
    expect(n).toBe(2);
    n = 0;
    await expect(db.transaction(async () => fail())).rejects.toThrow("deadlock");
    expect(n).toBe(1);
  });

  it("readOnly のトランザクションでは書けない", async () => {
    const { db } = T();
    await expect(db.transaction((tx) => tx.query("INSERT INTO users (login) VALUES ('ro')"), { readOnly: true })).rejects.toThrow();
  });
});

describe("エラーの見分けと LISTEN", () => {
  it("一意・CHECK の違反を制約の名前で見分ける", async () => {
    const { db } = T();
    await db.query("INSERT INTO users (login) VALUES ('dup')");
    const e1 = await db.query("INSERT INTO users (login) VALUES ('dup')").catch((e: unknown) => e);
    expect(isUniqueViolation(e1)).toBe(true);
    expect(isUniqueViolation(e1, "users_login_uq")).toBe(true);
    expect(isUniqueViolation(e1, "other")).toBe(false);
    expect(pgErrorInfo(e1)).toMatchObject({ code: "23505", constraint: "users_login_uq", table: "users" });
    const e2 = await db.query("INSERT INTO users (login, locale) VALUES ('x', 'fr')").catch((e: unknown) => e);
    expect(isCheckViolation(e2)).toBe(true);
    expect(pgErrorInfo(new Error("plain"))).toBeNull();
    expect(isRetryableTxError(new Error("plain"))).toBe(false);
  });

  it("listen / notify（Kill Switch・SSE の通知）", async () => {
    const { db } = T();
    const got: string[] = [];
    const l = await db.listen("ot_test_channel", (p) => got.push(p));
    await db.notify("ot_test_channel", "ws-1");
    for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["ws-1"]);
    await l.unlisten();
  });
});

describe("socketHostOf", () => {
  it("?host=/… の unix ソケットを取り出す", () => {
    expect(socketHostOf("postgres://u:p@localhost/db?host=/cloudsql/proj:asia-northeast1:inst")).toBe("/cloudsql/proj:asia-northeast1:inst");
  });
  it("ソケットでなければ undefined", () => {
    expect(socketHostOf("postgres://u:p@db.example:5432/db?sslmode=require")).toBeUndefined();
    expect(socketHostOf("postgres://u:p@localhost/db?host=example.com")).toBeUndefined();
    expect(socketHostOf("not a url")).toBeUndefined();
  });
});

describe("withoutHostParam（migrate.ts もソケット接続に使う）", () => {
  it("?host= だけを外し、ほかの部分は残す", () => {
    expect(withoutHostParam("postgres://u:p@localhost/db?host=/cloudsql/proj:asia-northeast1:inst")).toBe("postgres://u:p@localhost/db");
    expect(withoutHostParam("postgres://u:p@localhost/db?host=/cloudsql/x&sslmode=disable")).toBe("postgres://u:p@localhost/db?sslmode=disable");
  });
});

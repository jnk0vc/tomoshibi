# tomoshibi-ranking

放置RPG MOD「灯火迷宮」のランキングAPIです。Cloudflare WorkersとD1（SQLite）で動きます。フレームワークや実行時の依存ライブラリは使わず、fetchハンドラ1つで実装しています。

- ボードは3種類です（`level`、`deepest`、`exp`）。
- プレイヤーは、クライアントが自分で作ったUUIDとトークンで識別します。アカウント登録はありません。
- トークンはD1にSHA-256のハッシュだけを保存します。応答にplayerIdやハッシュを含めることはありません。
- 不正対策はベストエフォートです（後述）。

## ファイル構成

| パス | 内容 |
| --- | --- |
| `src/index.ts` | fetchハンドラ（ルーティング、入力検証、D1の読み書き） |
| `src/sql.ts` | D1に投げるSQLの定義（固定文字列。テストがEXPLAIN QUERY PLANにも使う） |
| `src/cache.ts` | ランキングの上位N件を、Cache APIに数秒だけ保存する処理 |
| `migrations/0001_init.sql` | `players`テーブルと、各ボード用のインデックス |
| `migrations/0002_tie_break_per_board.sql` | 同値の並びに使う、ボードごとの到達時刻（`level_at`、`deepest_at`、`exp_at`）の列を足し、インデックスを作り直す |
| `migrations/0003_player_count.sql` | 登録人数のカウンタ（`player_count`）と、増減させるトリガー |
| `wrangler.jsonc` | Worker設定（D1バインディング`DB`、オブザーバビリティ） |
| `test/` | 本物のローカルD1に対するテスト |
| `vitest.config.ts` | `@cloudflare/vitest-plugin`の設定 |

## API

すべての応答は`content-type: application/json; charset=utf-8`のJSONです。エラーは`{ "error": "<短い英語の理由>" }`の形で返します。

### POST /v1/scores

成績を送ります。初めてのplayerIdなら登録し、2回目以降は更新します。

```json
{
  "playerId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "token": "32〜128文字の[A-Za-z0-9_-]",
  "name": "ミナト",
  "level": 10, "deepest": 12, "totalExp": 500, "kills": 40, "ticks": 100
}
```

成功すると`200`で、書き込み直後の各ボードの順位を返します。

```json
{ "ok": true, "rank": { "level": 1, "deepest": 1, "exp": 1 } }
```

| ステータス | 条件 |
| --- | --- |
| 400 | 本文が4096バイトを超える、JSONでない、フィールドの型や範囲が不正 |
| 403 | 登録済みのplayerIdに、最初に送ったものと違うトークンを送った |
| 415 | Content-Typeが`application/json`ではない（`charset`などのパラメータは可） |
| 422 | 成績が不自然（後述） |
| 429 | 前回の受理から20秒たっていない（`Retry-After`に残り秒数） |

判定は次の順に行います。メソッド(405)、Content-Type(415)、本文と各フィールドの検証(400)、不自然な成績(422)、トークン(403)、送信間隔(429)の順です。

検証ルールは次のとおりです。

- `playerId`は小文字のUUID v4です。
- `name`は前後の空白を取り、途中の空白の連続を半角スペース1つにします。そのあとの長さが1〜12コードポイントで、制御文字(Cc)と書式文字(Cf)を含まないこと。全角スペースも空白として詰めます。ゼロ幅接合子(Cf)を含む絵文字の並び（家族の絵文字など）は使えません。
- 数値は安全な非負整数です。`level`と`deepest`は1以上です。
- 不自然な成績: `level > 20 + floor(ticks/8)`、`deepest > 20 + floor(ticks/4)`、`kills > ticks`のどれかなら422にします。
- 本文の上限は4096バイトで、超えると400です（契約に413がないため）。ストリームで届く本文も、上限を超えた時点で読み取りをやめます。

保存のルールは次のとおりです。

- 各指標（level、deepest、totalExp、kills、ticks）は、保存値と送信値の大きいほうを残します（SQLの`MAX`）。古いクライアントがスコアを下げることはできません。名前は毎回置き換えます。
- `updated_at`は最後に受理した送信の時刻で、送信間隔の判定にだけ使います。インデックスには入れません。
- 同値のときの並びには、ボードごとの到達時刻（`level_at`、`deepest_at`、`exp_at`）を使います。送信値が保存値を厳密に上回ったときだけ、そのボードの到達時刻を進めます。そのため、同じ値のまま送信を続けても並びは動かず、先にその値へ到達した人が上に並びます。
- 更新では、保存値より送信値が大きいボードの列だけをSETに入れます（`MAX`は競合に備えて残します）。SQLiteのUPDATEは、SETに書いた列を含むインデックスを値が同じでも書き換えるためです。指標が1つも伸びない送信の書き込みは行本体の1行だけで、伸びたボード1つにつきインデックスの1行が増えます。更新のSQLは、伸びるボードの組み合わせごとの8本を`src/sql.ts`に持ちます。
- 同じplayerIdの同時リクエストは、`INSERT ... ON CONFLICT DO NOTHING`と、送信間隔の条件を入れた`UPDATE`で1件だけ受理します。負けたほうは状態を読み直して403または429になります。
- 登録人数のトリガーも行を書き換えるため、新規登録と削除では`meta.changes`が2になります。書き込まれたかどうかは、`changes`が0かどうかで判定します。
- トークンの比較は、保存済みのハッシュと送られたトークンのハッシュを`crypto.subtle.timingSafeEqual`で一定時間比較します。

### GET /v1/leaderboard

`?by=level|deepest|exp&limit=1..50&me=<playerId>`（すべて省略可。既定は`by=level`、`limit=20`）。

```json
{
  "by": "level",
  "entries": [
    { "rank": 1, "name": "ミナト", "level": 10, "deepest": 12, "totalExp": 500, "isYou": true }
  ],
  "me": { "rank": 1, "name": "ミナト", "level": 10, "deepest": 12, "totalExp": 500 },
  "players": 1
}
```

- 並び順は、指標の降順、そのボードの到達時刻（`level_at`など）の昇順、`rowid`の昇順です。先にその値へ到達した人が上に並びます。
- 順位は標準競技順位（自分より指標が厳密に大きい人数に1を足した値）です。同値は同順位になり、次の順位は人数分だけ飛びます。
- `me`は、`me`を指定して、そのプレイヤーが登録済みのときだけ入ります。上位Nの外にいても、選んだボードでの順位と成績を返します。それ以外は`null`です。
- `players`は登録人数の合計です。カウンタ行（`player_count`）を1行読んで返します。
- `by`、`limit`、`me`が不正、または同じパラメータが複数あると400です。
- `me`を付けない部分（上位N件と`players`）は、Cache APIに10秒だけ保存します。キャッシュのキーは`by`と`limit`だけです。`me`を付けたときも上位N件はキャッシュを使い、自分の行と順位だけをD1から読みます。`isYou`は返す直前にidで付け直します。キャッシュ用のデータにはidを持たせますが、クライアントには返しません。
- クライアントへの応答は`cache-control: no-store`のままです。`max-age`を付けるのは、Cache APIに保存する内部のResponseだけです。
- 登録、更新、脱退が上位N件に反映されるまで、最大10秒かかります。脱退した人の名前が、最大10秒は上位N件に残ることがあります。`me`の順位と成績は、常にD1の最新の値です。

### DELETE /v1/scores

```json
{ "playerId": "...", "token": "..." }
```

ランキングから抜けます。成功すると`200 { "ok": true }`です。トークンが違うと403、登録がないと404です。削除後は、同じplayerIdを別のトークンで登録し直せます。

### そのほか

- 上記以外のパスは404、既知のパスへの未対応メソッドは405です（`Allow`ヘッダ付き）。
- CORSには対応していません。ブラウザから直接呼ぶ場合は別途対応が必要です。

## ローカル開発

pnpmを使います。依存関係のインストールで、esbuildとworkerdのビルドスクリプトを許可しています（`pnpm-workspace.yaml`）。

```sh
pnpm install

# ローカルD1にマイグレーションを適用する（初回と、migrationsを増やしたとき）
pnpm exec wrangler d1 migrations apply tomoshibi-ranking --local

# ローカルで起動する（http://localhost:8787）
pnpm dev
```

動作確認の例です。

```sh
curl -s localhost:8787/v1/scores -H 'content-type: application/json' -d '{
  "playerId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "token": "abcdefghijklmnopqrstuvwxyz012345",
  "name": "ミナト", "level": 10, "deepest": 12, "totalExp": 500, "kills": 40, "ticks": 100
}'
curl -s 'localhost:8787/v1/leaderboard?by=exp&me=3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
```

`wrangler dev`はローカルのD1（`.wrangler/state`）を使うので、Cloudflareのアカウントには触れません。

## テストと型チェック

```sh
pnpm test        # vitest（ローカルD1に本物のマイグレーションを適用して実行）
pnpm typecheck   # wrangler typesで型を生成してからtsc --noEmit
```

- テストは`@cloudflare/vitest-plugin`でWorkerをworkerd上で動かし、`migrations/`のSQLを適用したローカルD1に対して、HTTPの入口（`exports.default.fetch`）から叩きます。
- 契約の各ルール（登録、MAXでの更新、403、429とRetry-After、400、422、415、404/405、並び順、同順位、上位Nの外の`me`、削除、同時リクエスト）を確かめます。送信間隔は、19秒で429（`Retry-After: 1`）、20秒で200の両側を確かめ、`Retry-After`は残り秒数の切り上げの値そのものを確かめます。
- すべての応答について、playerId、トークン、SHA-256のハッシュらしい文字列が含まれていないことを、各テストの後に自動で調べます。
- `schema.spec.ts`は、本体と同じSQLをEXPLAIN QUERY PLANに通し、全件走査や一時ソートが出ないことを確かめます。`SCAN`で始まる行は、表の全件走査だけでなく、範囲指定のないインデックスの全件走査（`SCAN players USING COVERING INDEX ...`）も断ります。例外は、`ORDER BY ... LIMIT`の上位N件が使う、並びを満たすインデックスの順走査だけです。
- `rows-read.spec.ts`は、D1が返す`meta.rows_read`と`meta.rows_written`で、読み書きする行数を確かめます。登録人数の取得が1行であること、上位N件の読み取りが人数に比例しないこと、指標が伸びない更新の書き込みが1行であることを含みます。
- `race.spec.ts`は、同時リクエストの競合を決まった順で起こします。D1を包み、Workerが認証情報を読んだ直後に、競合する相手の書き込みを本物のD1へ直接入れてから、Workerに読んだ時点の結果を返します。初回登録の競合（`ON CONFLICT DO NOTHING`と再試行）、更新の競合（送信間隔の条件とトークンの条件）、削除の競合、読んだあとに成績が伸びていた場合の`MAX`を確かめます。`scores.spec.ts`の`Promise.all`のテストは、テスト環境では実質的に順番に処理されるので、「並べて送っても結果が矛盾しない」ことだけを確かめます。
- `cache.spec.ts`は、キャッシュのヒットでD1を1回も読まないこと、キーが`by`と`limit`だけであること、`me`を付けたときに自分の行だけをD1から読むこと、`isYou`の付け直し、応答が`no-store`でidを含まないこと、キャッシュが壊れていたり使えなかったりしてもD1から読んで応答することを確かめます。ほかのテストの`leaderboard()`ヘルパーは、読む前にそのキャッシュを消します。
- `counter.spec.ts`は、登録人数のカウンタが、新規登録、更新、拒否された送信、削除、`ON CONFLICT DO NOTHING`、マイグレーションの適用のどの場合でも、実際の行数とずれないことを確かめます。
- Vitest 5はモジュールの変換結果をディスクにキャッシュしますが、workerd上のテストランナーから読めず失敗するため、`vitest.config.ts`で`fsModuleCache: false`にしています。
- 更新の同時実行やストリームの打ち切りのテストで、workerdが`pipe was aborted`とstderrに出すことがありますが、想定内です。

## D1の読み取り行数と負荷対策

D1は、読んだ行数と書いた行数で制限と課金が決まります。次のように、登録人数をNとして、行数がNに比例する処理を減らしてあります。

| 処理 | D1で読む行数 |
| --- | --- |
| GET（`me`なし）でキャッシュにある | 0 |
| GET（`me`なし）でキャッシュにない | 上位N件ぶん（`limit`行ほど）とカウンタの1行。キーごと、データセンターごとに約10秒に1回 |
| GET（`me`付き） | 上位N件はキャッシュ。自分の順位の計算だけがD1で、自分より指標が大きい人数ぶんの行（1位なら数行、最下位でほぼN行） |
| POST（新規・更新） | 認証情報の1行と、3ボードの順位の計算（自分より指標が大きい人数ぶんの行。最悪で約3×N行） |

- 登録人数は、`SELECT COUNT(*)`ではなく、カウンタ行（`player_count`）を1行読んで返します。カウンタは、`players`へのINSERTとDELETEのトリガーが増減させます。`INSERT ... ON CONFLICT DO NOTHING`で挿入されなかったときはトリガーが動かないので、同時リクエストで先を越されても人数はずれません。
- 順位は標準競技順位（自分より指標が厳密に大きい人数に1を足した値）なので、その人数ぶんの行を読むことは、定義上なくせません。
- クライアントは、送信のたびにPOSTに続けて`me`付きのGETを呼びます。1回の送信で読む行数は、最下位に近いプレイヤーで最大約4×N、中位で約2×N、1位で数行です。

Freeプランの上限（D1の読み取り500万行/日、書き込み10万行/日。デプロイ前に、料金ページで最新の値を確認してください）に対する目安です。

| 登録人数N | 上限に届く送信回数/日（最悪4×N／中位2×N） | 1分に1回送信するプレイヤーの合計プレイ時間 |
| --- | --- | --- |
| 1,000 | 約1,250回／約2,500回 | 約21時間／約42時間 |
| 10,000 | 約125回／約250回 | 約2時間／約4時間 |

人数が増えるほど、上限に届くまでの回数は減ります。1万人規模ではFreeプランに収まらないので、次のどちらかを行います。

- 有料プランに移します。読み取りは従量課金になります。
- 値ごとの人数を持つ集計テーブル（たとえば`board_counts(board, value, n)`）を、トリガーで保守します。順位を`1 + SUM(n) WHERE value > ?`で求められるので、読む行数が「自分より大きい人数」から「自分より大きい値の種類の数」になります。`level`と`deepest`は値の種類が少なく、大きく減らせます。`exp`はほとんど値が重複しないので、効果は小さいです。

POSTの応答で返す順位（`rankAll`）を、同じplayerIdについて短時間キャッシュする案も検討しました。採用していません。同じplayerIdのPOSTは20秒に1回しか受理されないので、10秒のキャッシュには二度とヒットしないためです。

書き込みの行数は、新規登録が約6行（行本体、インデックス3本、主キー、カウンタ）、指標が伸びない更新が1行、削除が約2行です。Freeプランの書き込み上限（10万行/日）は、指標が伸びない更新だけなら10万回、新規登録だけなら約1.6万人ぶんです。指標が伸びる更新は、伸びたボードの数だけ書き込みが増えます。

## デプロイ

2026年10月15日に、次の手順1〜5で`https://tomoshibi-ranking.jankovic.workers.dev`に公開しました。D1は`tomoshibi-ranking`(リージョンはAPAC)で、`wrangler.jsonc`の`database_id`は作成したD1のIDに書き換え済みです。手順6(カスタムドメインとWAFのレート制限)はまだ行っていないため、IP単位のレート制限はかかっていません。また、Cache APIは`workers.dev`では効かないため、今の公開先では順位表の取得が毎回D1を読みます(応答の中身は変わりません)。

別のアカウントに新しく立てる場合は、次の順に行います。`wrangler.jsonc`の`database_id`には作者のD1のIDが入っているので、手順2で自分のD1のIDに置き換えます。依存は`pnpm install`で入れます。

1. Cloudflareにログインします。非対話環境では、`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を環境変数で渡します。

   ```sh
   pnpm exec wrangler login
   ```

2. 本番のD1を作り、`wrangler.jsonc`の`DB`バインディングの`database_id`を本物のIDに書き換えます。

   ```sh
   pnpm exec wrangler d1 create tomoshibi-ranking --binding DB
   ```

   `--binding DB`を付けると、wranglerが`wrangler.jsonc`の既存の`DB`エントリの`database_id`だけを本物のIDに書き換えます（対話は出ません）。書き換え後に、`database_id`が`wrangler d1 create`の出力に表示されたIDになっていることを確認します(作者のID`b5ebc604-…`のままでないこと)。wranglerが書き換えると、ファイル全体のインデントがタブに変わることがあります。見た目だけの差分です。

   `--binding`を付けずに実行した場合は注意してください。対話にそのまま答える（Enterを押し続ける）と、別名のバインディング（`tomoshibi_ranking`）が2つ目に追記され、`DB`には作者のD1のIDが残ります。そのまま進めると、手順3で自分のアカウントにないD1を指してエラーになります。その場合は、追記された分を消して、`DB`の`database_id`を手で書き換えます。

3. 本番のD1にマイグレーションを適用します。`0001`から`0003`までが順に適用されます。

   ```sh
   pnpm exec wrangler d1 migrations apply tomoshibi-ranking --remote
   ```

4. Workerをデプロイします。

   ```sh
   pnpm deploy
   ```

5. 動作を確認します。`<サブドメイン>`は、デプロイ時に表示されるURLのものです。

   ```sh
   curl -s https://tomoshibi-ranking.<サブドメイン>.workers.dev/v1/leaderboard
   ```

6. カスタムドメインで公開し、WAFのレート制限ルールを設定します。`/v1/leaderboard`と`/v1/scores`へのIP単位のレート制限は、コードではなくCloudflareのWAFで行います。コードで429を返すと、GETの契約にないステータスコードが増えるためです。

   - Cloudflareのゾーンにカスタムドメイン（またはルート）でWorkerを公開します。ゾーンのWAFは、自分のゾーンに来た通信にかかります。`workers.dev`のURLでは使えない前提で、本番はカスタムドメインに置いてください。Cache APIも、公式ドキュメントはカスタムドメインのWorkerで動くと説明しています。キャッシュが効かなくても応答は正しく返りますが、毎回D1を読みます。
   - ダッシュボードで、ゾーンの「セキュリティ」から「WAF」の「レート制限ルール」を開き、ルールを作ります。
     - 条件: URIパスが`/v1/leaderboard`または`/v1/scores`
     - カウントの単位: IPアドレス
     - しきい値の例: 10秒あたり20リクエストを超えたらブロック。クライアントの送信は1分に1回ほどなので、通常の利用では超えません
   - 指定できる期間、ブロックの長さ、ルールの数はプランで違います。ダッシュボードで確認し、使える範囲でしきい値を決めてください。

あとからスキーマを変えるときは、`migrations/0004_*.sql`を追加し、`migrations apply --remote`、`pnpm deploy`の順に行います。ログは`pnpm exec wrangler tail`か、ダッシュボードのWorkers Logsで見られます。

## 不正対策の限界

ticksやkillsはクライアントの自己申告なので、不正対策は「明らかに不自然な値を断る」程度のベストエフォートです。トークンを知っている人は、その範囲で自由に送信できます。トークンが漏れると本人になりすませるため、クライアントは端末内に安全に保管してください。

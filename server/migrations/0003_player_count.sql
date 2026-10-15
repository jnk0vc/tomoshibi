-- 登録人数をカウンタ行で持つ。SELECT COUNT(*)は人数ぶんの行を読むので、1行の読み取りで済ませる。
-- 増減はトリガーで行う。INSERT ... ON CONFLICT DO NOTHINGで挿入されなかったときはトリガーが動かないので、
-- 同時リクエストで先を越されても人数はずれない。
CREATE TABLE player_count (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);

-- 既存の人数で初期化する。
INSERT INTO player_count (id, n) VALUES (1, (SELECT COUNT(*) FROM players));

CREATE TRIGGER players_ai AFTER INSERT ON players BEGIN
  UPDATE player_count SET n = n + 1 WHERE id = 1;
END;

CREATE TRIGGER players_ad AFTER DELETE ON players BEGIN
  UPDATE player_count SET n = n - 1 WHERE id = 1;
END;

-- 序流 Xuliu — 建表脚本（PostgreSQL 13+）

CREATE TABLE IF NOT EXISTS pipelines (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  repo_url     TEXT NOT NULL DEFAULT '',
  branch       TEXT NOT NULL DEFAULT 'main',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stages (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_id   BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('build','unit_test','image','deploy','manual_gate')),
  timeout_sec   INTEGER NOT NULL DEFAULT 1800 CHECK (timeout_sec > 0),
  fail_policy   TEXT NOT NULL DEFAULT 'abort'
                  CHECK (fail_policy IN ('abort','continue','retry')),
  retry_times   INTEGER NOT NULL DEFAULT 0 CHECK (retry_times >= 0),
  gate_owner    TEXT NOT NULL DEFAULT '',
  pos_x         INTEGER NOT NULL DEFAULT 80,
  pos_y         INTEGER NOT NULL DEFAULT 80,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, name)
);

-- 边：to_stage 依赖 from_stage（from 先跑，to 后跑）
CREATE TABLE IF NOT EXISTS stage_edges (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_id   BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  from_stage_id BIGINT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  to_stage_id   BIGINT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, from_stage_id, to_stage_id),
  CHECK (from_stage_id <> to_stage_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id           BIGSERIAL PRIMARY KEY,
  pipeline_id  BIGINT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','success','failed','canceled')),
  trigger_type TEXT NOT NULL DEFAULT 'manual'
                 CHECK (trigger_type IN ('manual','push','schedule')),
  triggered_by TEXT NOT NULL DEFAULT '',
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stage_runs (
  id            BIGSERIAL PRIMARY KEY,
  run_id        BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id      BIGINT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','success','failed','skipped','waiting_gate','gate_rejected')),
  attempt       INTEGER NOT NULL DEFAULT 1,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_sec  INTEGER,
  message       TEXT NOT NULL DEFAULT '',
  gate_claimed  TIMESTAMPTZ,
  gate_claimed_by TEXT NOT NULL DEFAULT '',
  UNIQUE (run_id, stage_id)
);

CREATE INDEX IF NOT EXISTS idx_stage_edges_pipeline ON stage_edges(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_stage_runs_status ON stage_runs(status);

-- 环境实验室样品流转数据库结构（PostgreSQL / PGlite）
CREATE TABLE IF NOT EXISTS containers (
  id         text PRIMARY KEY,
  code       text UNIQUE NOT NULL,
  tare_g     numeric(24,6) NOT NULL DEFAULT 0,
  note       text
);

CREATE TABLE IF NOT EXISTS samples (
  id               text PRIMARY KEY,
  code             text UNIQUE NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('ORIGINAL','MIXTURE','ALIQUOT')),
  container_id     text REFERENCES containers(id),
  available_mass_g numeric(24,6) NOT NULL DEFAULT 0 CHECK (available_mass_g >= 0),
  status           text NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 幂等操作表：同一 idempotency_key 重复提交只生效一次
CREATE TABLE IF NOT EXISTS operations (
  id              text PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 物料台账：每一次质量变动（消耗/产出/更正）都有一行，available = sum(delta)
CREATE TABLE IF NOT EXISTS material_ledger (
  id           bigserial PRIMARY KEY,
  sample_id    text NOT NULL REFERENCES samples(id),
  delta_g      numeric(24,6) NOT NULL,
  reason       text NOT NULL,
  operation_id text,
  weighing_id  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 谱系边：child 由 parent 消耗 mass_used_g 而来
CREATE TABLE IF NOT EXISTS sample_parents (
  child_id     text NOT NULL REFERENCES samples(id),
  parent_id    text NOT NULL REFERENCES samples(id),
  mass_used_g  numeric(24,6) NOT NULL,
  operation_id text,
  PRIMARY KEY (child_id, parent_id)
);

-- 称量记录：DRAFT -> CONFIRMED；CONFIRMED 后只能通过更正记录（corrects_id）调整
CREATE TABLE IF NOT EXISTS weighings (
  id              text PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  sample_id       text NOT NULL REFERENCES samples(id),
  kind            text NOT NULL CHECK (kind IN ('INTAKE','CONSUME')),
  input_value     numeric(24,6) NOT NULL,   -- 原始读数
  input_unit      text NOT NULL,            -- 原始单位
  tare_g          numeric(24,6) NOT NULL DEFAULT 0,
  net_g           numeric(24,6) NOT NULL,   -- 换算为克的净值
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','CORRECTED')),
  corrects_id     text REFERENCES weighings(id),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 检测记录：保留原始单位、检出限、稀释倍数与校正结果
CREATE TABLE IF NOT EXISTS test_records (
  id                 text PRIMARY KEY,
  sample_id          text NOT NULL REFERENCES samples(id),
  analyte            text NOT NULL,
  raw_value          numeric(30,10) NOT NULL,
  raw_unit           text NOT NULL,
  detection_limit    numeric(30,10) NOT NULL,
  dilution_factor    numeric(30,10) NOT NULL DEFAULT 1,
  below_dl           boolean NOT NULL DEFAULT false,
  corrected_mg_per_kg numeric(30,10),
  method             text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_sample ON material_ledger(sample_id);
CREATE INDEX IF NOT EXISTS idx_tests_sample  ON test_records(sample_id);
CREATE INDEX IF NOT EXISTS idx_parents_child ON sample_parents(child_id);
CREATE INDEX IF NOT EXISTS idx_parents_parent ON sample_parents(parent_id);

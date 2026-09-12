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

-- ===== 污染事件与复测 =====
CREATE TABLE IF NOT EXISTS tools (
  id     text PRIMARY KEY,
  code   text UNIQUE NOT NULL,
  note   text
);

-- 工具接触记录：某工具在某时刻接触了某样品（可关联具体操作）
CREATE TABLE IF NOT EXISTS tool_contacts (
  id           text PRIMARY KEY,
  tool_id      text NOT NULL REFERENCES tools(id),
  sample_id    text NOT NULL REFERENCES samples(id),
  operation_id text,
  contact_at   timestamptz NOT NULL,
  note         text
);

-- 污染事件：某工具在时间窗口内存在污染风险；窗口可随证据修订
CREATE TABLE IF NOT EXISTS incidents (
  id           text PRIMARY KEY,
  code         text UNIQUE NOT NULL,
  tool_id      text NOT NULL REFERENCES tools(id),
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  reason       text NOT NULL,
  status       text NOT NULL DEFAULT 'OPEN',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 窗口修订历史（证据链）
CREATE TABLE IF NOT EXISTS incident_revisions (
  id           text PRIMARY KEY,
  incident_id  text NOT NULL REFERENCES incidents(id),
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  reason       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 样品影响评估：CONFIRMED（确认污染）/ SUSPECTED（疑似暴露）/ CLEARED（已排除）
-- manual=true 表示人工裁定，自动重算不覆盖；basis 为依据，排除也必须留依据
CREATE TABLE IF NOT EXISTS sample_impacts (
  incident_id text NOT NULL REFERENCES incidents(id),
  sample_id   text NOT NULL REFERENCES samples(id),
  status      text NOT NULL CHECK (status IN ('CONFIRMED','SUSPECTED','CLEARED')),
  basis       text NOT NULL,
  manual      boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (incident_id, sample_id)
);

-- 影响状态变迁审计（解除疑似也留痕）
CREATE TABLE IF NOT EXISTS impact_events (
  id          text PRIMARY KEY,
  incident_id text NOT NULL,
  sample_id   text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  basis       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 各检测项目的最小取样量
CREATE TABLE IF NOT EXISTS analyte_requirements (
  analyte    text PRIMARY KEY,
  min_mass_g numeric(24,6) NOT NULL
);

-- 复测方案：DRAFT → CONFIRMED（预占成功）/ CANCELLED
CREATE TABLE IF NOT EXISTS retest_plans (
  id          text PRIMARY KEY,
  incident_id text NOT NULL REFERENCES incidents(id),
  code        text UNIQUE NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','CANCELLED')),
  notes       jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

-- 方案条目：按（原样, 检测项目）去重，避免重复消耗
CREATE TABLE IF NOT EXISTS retest_plan_items (
  id              text PRIMARY KEY,
  plan_id         text NOT NULL REFERENCES retest_plans(id),
  sample_id       text NOT NULL REFERENCES samples(id),
  analyte         text NOT NULL,
  required_mass_g numeric(24,6) NOT NULL,
  feasible        boolean NOT NULL DEFAULT true,
  reason          text,        -- 不可行/不可判定原因
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESERVED','DONE','RELEASED','INFEASIBLE')),
  test_record_id  text
);

-- 余量预占：确认方案时原子扣减；取消释放；出结果消耗
CREATE TABLE IF NOT EXISTS reservations (
  id           text PRIMARY KEY,
  plan_item_id text NOT NULL REFERENCES retest_plan_items(id),
  sample_id    text NOT NULL REFERENCES samples(id),
  mass_g       numeric(24,6) NOT NULL,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','RELEASED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 检测记录修订：新结果关联旧报告（amends_id），旧记录置 SUPERSEDED 但保留
ALTER TABLE test_records ADD COLUMN IF NOT EXISTS amends_id text REFERENCES test_records(id);
ALTER TABLE test_records ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE','SUPERSEDED'));

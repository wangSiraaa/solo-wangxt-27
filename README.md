# 土壤样品流转工作台（lab-lims）

环境实验室样品管理系统：**Vue 3** 操作工作台 + **NestJS** 业务管理 + **PostgreSQL**（PGlite，官方 Postgres 的 WASM 构建，数据落盘 `server/pgdata/`）+ **decimal.js** 精确处理质量与稀释倍数。

## 运行

```bash
cd server && npm install && npm run build
cd ../client && npm install && npm run build
cd ../server && npm start          # http://localhost:3000（API + 前端）
```

开发模式可另起 `cd client && npm run dev`（Vite 代理 `/api` → 3000）。

## 可运行的数据证明

```bash
cd server && npm run build && npm run demo
```

脚本在独立数据库（`pgdata-demo`）中启动应用并验证 23 项断言：

| 场景 | 证明内容 |
|---|---|
| 单位换算 | `0.5 kg → 500 g`、`250000 mg → 250 g`，混样来源可用 `0.05 kg` 表示 50 g |
| 混样守恒 | A 120 g + B 50 g → MIX-01 170 g，来源按量扣减 |
| 幂等 | 同一 `idempotencyKey` 重复提交返回首次结果，不重复扣减 |
| 余量不足 | 库存 50 g 分 80 g → 409，库存不变（事务回滚） |
| 两人同时取样 | 并发各取 30 g（库存 50 g）→ 恰一人成功一人 409，最终 20 g 不超发 |
| 称量更正 | 确认后重复确认被拒；更正 10 g → 12 g 按差额 -2 g 调整，原记录保留为 CORRECTED |
| 检出限 | `2.5 mg/L × 稀释 10 → 25 mg/kg`；低于检出限的记录不参与平均（不按 0 计） |
| 对账 | 谱系内每个样品 `台账合计 = 现存可用量` |

## 关键设计

- **库存一致性**：所有扣减走原子条件更新
  `UPDATE samples SET available = available - $m WHERE id = $id AND available >= $m`，
  配合事务与 `material_ledger` 台账；分样/混样不能凭空增加物料，并发下不会超发。
- **幂等**：`operations` 与 `weighings` 表对 `idempotency_key` 建唯一约束，重复提交重放首次结果。
- **称量生命周期**：`DRAFT → CONFIRMED`；确认后才扣减库存，确认后只能通过
  `POST /api/weighings/:id/corrections` 生成更正记录按差额调整，历史不可篡改。
- **检测值**：保留原始单位、检出限、稀释倍数；校正值统一换算为 mg/kg（decimal.js），
  低于检出限自动标记 `below_dl`，平均时排除而非按 0 计。
- **谱系**：`sample_parents` 记录每条边的消耗质量，`GET /api/samples/:id/lineage`
  用递归 CTE 向上/向下展开，节点携带剩余量、容器与检测记录，前端树形渲染。

## 主要 API

```
POST /api/samples/intake          原样入库（任意质量单位）
POST /api/samples/mix             混样（多来源，整体事务）
POST /api/samples/split           分样
GET  /api/samples                 库存列表
GET  /api/samples/:id/lineage     谱系图
GET  /api/samples/:id/ledger      台账
GET  /api/samples/:id/reconcile   对账
POST /api/weighings               称量草稿（幂等）
POST /api/weighings/:id/confirm   确认（扣减库存）
POST /api/weighings/:id/corrections  更正已确认称量
POST /api/samples/:id/tests       录入检测值
GET  /api/samples/:id/tests/summary?analyte=Pb  平均（排除 <DL）
```

注：体积浓度（mg/L 等）按水基液体密度 1 kg/L 近似换算为 mg/kg；PGlite 为单连接嵌入式
Postgres，条件 UPDATE + 事务的写法在独立部署的多连接 PostgreSQL 上同样成立。

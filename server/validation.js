'use strict';
// 全量校验：任何新增/修改/删除事件后，在同一事务内对整个事件集重新校验。
// 返回错误信息数组（中文），为空表示通过。校验失败时调用方回滚整次提交。

const { collectWindowConflicts } = require('./downtime');
const { normTime } = require('./timeutil');

function validateAll(db) {
  const errors = [];

  // 按“实际时刻”排序：分钟写法（09:00）与带秒写法（09:00:00）视为同一刻，
  // 不能直接按 event_time 字符串排序（否则两种写法的同刻记录会被错置先后）。
  const events = db.prepare(
    `SELECT id, event_time, type, equipment_id, batch_id
       FROM events ORDER BY event_time, id`
  ).all()
    .map((e) => ({ ...e, _t: normTime(e.event_time) }))
    .sort((a, b) => (a._t < b._t ? -1 : a._t > b._t ? 1 : a.id - b.id));

  // 1. PROCESS 必须挂批次，且同一批次只能由一次加工产出
  const batchProducer = new Map();
  for (const e of events) {
    if (e.type === 'PROCESS') {
      if (!e.batch_id) {
        errors.push(`事件 #${e.id}（${e.event_time}）缺少产出批次`);
        continue;
      }
      if (batchProducer.has(e.batch_id)) {
        errors.push(
          `批次 #${e.batch_id} 被两次加工产出（事件 #${batchProducer.get(e.batch_id)} 与 #${e.id}）`
        );
      }
      batchProducer.set(e.batch_id, e.id);
    }
  }

  // 2. 同一设备事件时间冲突（同一设备不允许同一时刻多条事件）。
  //    “同一时刻”按实际时刻判定：分钟写法 09:00 与带秒写法 09:00:00 同刻即冲突，
  //    不能按原始文本判重，否则两种写法的同刻事件会被同时接受。
  const slot = new Set();
  for (const e of events) {
    const key = `${e.equipment_id}|${e._t}`;
    if (slot.has(key)) {
      errors.push(
        `设备 #${e.equipment_id} 在 ${e.event_time} 存在时间冲突的事件（含事件 #${e.id}）：` +
        '同一设备同一时刻只能有一条事件（分钟写法与带秒写法按同一时刻判定）'
      );
    }
    slot.add(key);
  }

  // 3. 加工引用此前产出的批次：禁止引用未来批次、禁止形成循环
  //    以“批次由其加工事件的实际时刻定义先后”，构造批次依赖图。
  //    分钟写法与带秒写法按同一实际时刻判定（同刻引用不属“严格更早”，拒绝）。
  const batchTime = new Map();          // batchId -> 实际时刻（补秒后的定长串）
  const batchEvent = new Map();         // batchId -> eventId
  for (const [bid, eid] of batchProducer.entries()) {
    const ev = events.find((x) => x.id === eid);
    batchTime.set(bid, ev._t);
    batchEvent.set(bid, eid);
  }

  const edges = new Map();              // 当前批次 -> 被引用批次
  const inputRows = db.prepare(
    `SELECT pi.event_id, pi.batch_id AS ref_batch
       FROM process_inputs pi WHERE pi.batch_id IS NOT NULL`
  ).all();
  const eventById = new Map(events.map((e) => [e.id, e]));
  for (const row of inputRows) {
    const ev = eventById.get(row.event_id);
    if (!ev || ev.type !== 'PROCESS' || !ev.batch_id) continue;
    if (!batchProducer.has(row.ref_batch)) {
      errors.push(`事件 #${ev.id} 引用了不存在或已无加工记录的批次 #${row.ref_batch}`);
      continue;
    }
    if (row.ref_batch === ev.batch_id) {
      errors.push(`批次 #${ev.batch_id} 不能引用自身`);
      continue;
    }
    const tProducer = batchTime.get(ev.batch_id);
    const tRef = batchTime.get(row.ref_batch);
    if (tRef >= tProducer) {
      const producerEv = eventById.get(batchEvent.get(ev.batch_id));
      const refEv = eventById.get(batchEvent.get(row.ref_batch));
      const sameMoment = tRef === tProducer;
      errors.push(
        `事件 #${ev.id}（${producerEv ? producerEv.event_time : tProducer}）引用了${sameMoment ? '同时刻' : '未来'}批次 #${row.ref_batch}` +
        `（产出时间 ${refEv ? refEv.event_time : tRef}），不允许引用未来批次` +
        (sameMoment ? '；引用批次必须严格更早产出（分钟写法与带秒写法按同一时刻判定）' : '')
      );
    }
    if (!edges.has(ev.batch_id)) edges.set(ev.batch_id, new Set());
    edges.get(ev.batch_id).add(row.ref_batch);
  }

  // 环检测（DFS）
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const cycleBatches = new Set();
  function dfs(node, stack) {
    color.set(node, GRAY);
    for (const next of edges.get(node) || []) {
      if (color.get(next) === GRAY) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        cycle.forEach((b) => cycleBatches.add(b));
      } else if (color.get(next) !== BLACK) {
        dfs(next, stack.concat(next));
      }
    }
    color.set(node, BLACK);
  }
  for (const b of edges.keys()) {
    if (color.get(b) !== BLACK) dfs(b, [b]);
  }
  for (const b of cycleBatches) {
    errors.push(`批次 #${b} 的引用关系形成循环，拒绝提交`);
  }

  // 4. 设备检修停机窗口：窗口 [起点, 终点) 内不得记录该设备的加工/清洗事件
  //    （单条事件、断网补录、换线预演/确认应用均经此核对；命中即整次拒绝）。
  for (const { event: ev, window: w } of collectWindowConflicts(db, events)) {
    errors.push(
      `事件 #${ev.id}（${ev.event_time}，设备 #${ev.equipment_id}）落入设备检修停机窗口 ` +
      `[${w.start_time}, ${w.end_time})（窗口 #${w.id}${w.reason ? `，原因：${w.reason}` : ''}）：` +
      '检修期间不能记录加工或清洗'
    );
  }

  // 5. 批号库存计量：按最终事件集重算每批号累计领用（缺数量旧输入不计），
  //    不得超过「期初 + 入库」；未启用计量批号不得携带克数（防御性核对）。
  //    新增/更正/补录/换线确认均经此路径，余额不足整次拒绝、原事件与库存不变。
  const inventory = require('./inventory');
  errors.push(...inventory.validateInventory(db));

  return errors;
}

module.exports = { validateAll };

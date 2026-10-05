'use strict';
// 事件/窗口时间文本的解析与“实际时刻”比较。
//
// 时间文本允许两种既有写法，均原样保留在 events.event_time 中（不做归一化改写）：
//   - 分钟精度：2026-10-01T09:00
//   - 带秒写法：2026-10-01T09:00:00
// 两种写法指同一实际时刻（分钟写法即该分钟的 00 秒）。所有冲突/先后判断都以
// 解析后的实际时刻为准，不能直接比较原始字符串——否则
// "2026-10-01T09:00" 与 "2026-10-01T09:00:00" 会被误判为不同时刻。
//
// 写入前另做日历校验（isValidEventTime）：只接受真实日期与合法时分秒，
// 闰年按公历（能被 4 整除且非整百年，或能被 400 整除）判定，
// 例如 2026-02-30、2026-10-01T25:61 一律拒绝。

const EVENT_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 公历每月天数（平年）；2 月按闰年判定为 28/29 天。
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// 公历闰年：能被 4 整除且不能被 100 整除，或能被 400 整除。
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// 日历校验：时间文本不仅要形如 YYYY-MM-DDTHH:MM[:SS]，还必须是真实存在的日期
// 与合法时分秒。仅做字符格式校验会让 2026-02-30（2 月没有 30 日）、
// 2026-10-01T25:61（25 时 61 分）之类不存在的时刻通过，进而参与排序、
// 窗口冲突与批次引用判断。两种既有写法（分钟精度与带秒）均接受，原文由调用方保留。
function isValidEventTime(t) {
  const s = String(t == null ? '' : t);
  const m = EVENT_TIME_RE.exec(s);
  if (!m) return false;
  const year = parseInt(s.slice(0, 4), 10);
  const month = parseInt(s.slice(5, 7), 10);
  const day = parseInt(s.slice(8, 10), 10);
  const hour = parseInt(s.slice(11, 13), 10);
  const minute = parseInt(s.slice(14, 16), 10);
  const second = m[1] ? parseInt(s.slice(17, 19), 10) : 0;
  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}

// 统一补成定长 19 位含秒形式（分钟写法补 ":00"）。
// 定长后各位置含义相同，字典序与实际时刻先后一致，可直接用 < / > 比较。
function normTime(t) {
  const s = String(t);
  return s.length === 16 ? `${s}:00` : s;
}

// 实际时刻是否为同一刻（分钟写法与带秒写法按同一刻处理）。
function sameInstant(a, b) {
  return normTime(a) === normTime(b);
}

// 实际时刻比较：a 早于 b（严格）。
function instantBefore(a, b) {
  return normTime(a) < normTime(b);
}

// 事件比较器：先按实际时刻，再按事件 id（同刻同设备本就非法；
// 同刻跨设备与同刻但文本写法不同的记录需要确定的回放/展示次序，以 id 兜底）。
function compareEvents(a, b) {
  const ta = normTime(a.event_time);
  const tb = normTime(b.event_time);
  if (ta < tb) return -1;
  if (ta > tb) return 1;
  return a.id - b.id;
}

// 排序事件集合（不修改入参），供“SQL ORDER BY event_time,id”之后纠正
// 分钟/带秒混排造成的次序偏差。
function eventsByInstant(events) {
  return events.slice().sort(compareEvents);
}

module.exports = {
  EVENT_TIME_RE,
  isLeapYear,
  isValidEventTime,
  normTime,
  sameInstant,
  instantBefore,
  compareEvents,
  eventsByInstant
};

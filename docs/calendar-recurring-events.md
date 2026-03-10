# 日历重复事件（RRULE）的处理说明

## 问题现象

用户反馈：日历提醒任务配置好之后，预览只能看到少量事件（比如 2 个），但 Google Calendar 里明明有很多活动。同时，重复性活动（每周例会、每月提醒等）始终无法收到 WhatsApp 提醒。

---

## 根本原因

### ICS 文件的结构

Google Calendar 导出的 ICS 文件中，**重复事件只存一条记录**，加上一个 `RRULE`（重复规则）字段描述重复的规律，而不是把每次发生的日期都单独写出来：

```
BEGIN:VEVENT
SUMMARY:每周例会
DTSTART:20250101T090000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
```

上面这条记录代表"从 2025 年 1 月 1 日起，每周一 09:00"，但文件里只有这一条，没有每周一的具体日期列表。

### node-ical 的默认行为

`node-ical` 解析 ICS 文件后，**不会自动展开 RRULE**。`ical.async.fromURL()` 返回的对象里，这条重复事件只有一个条目，`e.start` 是原始开始日期（2025 年 1 月 1 日），而不是下一次即将发生的日期。

### 导致的两个 bug

**Bug 1：预览只显示非重复事件**

预览代码用 `e.start` 来判断事件是否在未来，重复事件的 `e.start` 是很久以前，被过滤掉了。

**Bug 2：调度器永远不会发重复事件的提醒**

调度器计算 `提醒时间 = e.start - 提前分钟数`，如果 `e.start` 是几个月前，这个时间永远在过去，条件 `msUntil >= -60_000` 永远不满足，提醒永远不会被调度。

---

## 修复方案（v0.0.3）

`node-ical` 会把 RRULE 解析成一个 `RRule` 对象挂在 `e.rrule` 属性上（来自 `rrule` npm 包）。可以用 `e.rrule.between(start, end)` 展开指定时间段内的所有发生日期。

### webui.js — 预览端点

```js
// 修复前：只看 e.start，跳过有 RRULE 的事件
const upcoming = allEntries
  .filter(e => e.type === 'VEVENT' && e.start &&
    new Date(e.start).getTime() >= now - 24 * 60 * 60 * 1000)
  ...

// 修复后：有 RRULE 的事件展开未来 30 天内的所有日期
for (const e of allEntries) {
  if (e.type !== 'VEVENT' || !e.start) continue;
  if (e.rrule) {
    const occurrences = e.rrule.between(new Date(windowStart), new Date(windowEnd));
    for (const occ of occurrences) {
      upcoming.push({ title: e.summary || '(无标题)', start: occ });
    }
  } else {
    // 非重复事件，原逻辑不变
    if (new Date(e.start).getTime() >= windowStart) {
      upcoming.push({ title: e.summary || '(无标题)', start: new Date(e.start) });
    }
  }
}
```

### calendarScheduler.js — 调度器

```js
// 修复前：直接用 e.start 计算提醒时间，重复事件永远是过去时间
const startMs = new Date(ev.start).getTime();

// 修复后：对有 RRULE 的事件，用 rrule.between() 找出
// 下一个轮询窗口（5 分钟）内即将到达提醒时间的具体日期
if (ev.rrule) {
  const searchStart = new Date(now - reminderMs - 60_000);
  const searchEnd = new Date(now - reminderMs + POLL_INTERVAL_MS + 60_000);
  const occurrences = ev.rrule.between(searchStart, searchEnd);
  for (const occ of occurrences) {
    instances.push({ ev, startMs: occ.getTime() });
  }
} else {
  instances.push({ ev, startMs: new Date(ev.start).getTime() });
}
```

---

## 关键点总结

| | 修复前 | 修复后 |
|---|---|---|
| 重复事件预览 | 只显示非重复事件 | 展开未来 30 天内的发生日期 |
| 重复事件提醒 | 永远不会触发 | 每次轮询时找出当前窗口内的下一次发生日期 |
| 依赖方法 | `e.start`（原始开始日期） | `e.rrule.between(start, end)`（展开具体日期） |

---

## 如果以后遇到类似问题

检查以下几点：

1. **事件是否有 `e.rrule` 属性**：`console.log(Object.keys(e))` 打印出来看
2. **`rrule` 包版本兼容性**：`node-ical` 内置依赖 `rrule`，不需要单独安装，但升级 `node-ical` 时注意 API 是否有变化
3. **时区问题**：`rrule.between()` 接受的是 UTC 时间的 `Date` 对象，展开的结果也是 UTC，最终显示时用 `toLocaleString` 转成本地时区即可

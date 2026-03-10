const ical = require('node-ical');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'schedules.json');
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟检查一次

// 记录已调度的提醒，避免重复发送
const scheduled = new Set();

// H5：定期清理超过 25 小时的旧条目，防止 Set 无限增长
// uid 格式：`{eventUid}__{startMs}__{jobId}`，从中解析 startMs
function cleanScheduled() {
  const cutoff = Date.now() - 25 * 60 * 60 * 1000;
  for (const uid of scheduled) {
    const parts = uid.split('__');
    const startMs = parseInt(parts[parts.length - 2], 10);
    if (!isNaN(startMs) && startMs < cutoff) scheduled.delete(uid);
  }
}
setInterval(cleanScheduled, 60 * 60 * 1000); // 每小时清理一次

function readCalendarJobs() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return (config.calendarJobs || []).filter(j => j.enabled);
  } catch { return []; }
}

async function checkJob(job) {
  let events;
  try {
    events = await ical.async.fromURL(job.calendarUrl);
  } catch (err) {
    console.error(`[Calendar] 获取日历失败 "${job.id}"：${err.message}`);
    return;
  }

  const now = Date.now();
  const reminderMs = (job.minutesBefore || 30) * 60 * 1000;

  // 展开所有事件（含重复事件的各次发生日期）
  const instances = [];
  for (const ev of Object.values(events)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.rrule) {
      // 重复事件：找出下一个轮询窗口内需要提醒的发生日期
      const searchStart = new Date(now - reminderMs - 60_000);
      const searchEnd = new Date(now - reminderMs + POLL_INTERVAL_MS + 60_000);
      const occurrences = ev.rrule.between(searchStart, searchEnd);
      for (const occ of occurrences) {
        instances.push({ ev, startMs: occ.getTime() });
      }
    } else {
      instances.push({ ev, startMs: new Date(ev.start).getTime() });
    }
  }

  for (const { ev, startMs } of instances) {
    const reminderAt = startMs - reminderMs;
    const msUntil = reminderAt - now;

    // uid 包含 jobId，确保不同任务的相同事件都能独立提醒
    const uid = `${ev.uid}__${startMs}__${job.id}`;
    if (scheduled.has(uid)) continue;

    // 提醒时间在下一个轮询周期内（含 1 分钟容差）
    if (msUntil >= -60_000 && msUntil <= POLL_INTERVAL_MS + 60_000) {
      scheduled.add(uid);
      const delay = Math.max(0, msUntil);
      // M9：截断过长标题，防止外部 ICS 注入超长内容
      const title = (ev.summary || '(无标题)').slice(0, 200).replace(/[\r\n]/g, ' ');
      const message = `提醒：${title}`;
      const groupName = job.groupName;
      const label = delay < 60_000 ? '立即' : `${Math.round(delay / 60_000)} 分钟后`;

      console.log(`[Calendar] 已调度"${title}"的提醒，将在 ${label} 发送到群组"${groupName}"`);

      setTimeout(async () => {
        const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' });
        console.log(`[Calendar] [${ts}] 发送 → "${groupName}"：${message}`);

        if (global.whatsappReady && global.whatsappClient) {
          // 真实版本：通过 WhatsApp 发送
          try {
            const { resolve } = require('./groupResolver');
            const chatId = await resolve(global.whatsappClient, groupName);
            if (chatId) {
              const chat = await global.whatsappClient.getChatById(chatId);
              await chat.sendMessage(message);
              console.log(`[Calendar] 发送成功`);
            } else {
              console.error(`[Calendar] 找不到群组"${groupName}"`);
            }
          } catch (err) {
            console.error(`[Calendar] 发送失败：${err.message}`);
          }
        } else {
          console.log(`[Calendar] （测试模式，消息未真实发送）`);
        }
      }, delay);
    }
  }
}

async function checkAllJobs() {
  const jobs = readCalendarJobs();
  for (const job of jobs) {
    await checkJob(job);
  }
}

function startCalendarScheduler() {
  console.log('[Calendar] 日历提醒调度器已启动（每 5 分钟检查一次）');
  checkAllJobs();
  setInterval(checkAllJobs, POLL_INTERVAL_MS);
}

module.exports = { startCalendarScheduler, checkAllJobs };

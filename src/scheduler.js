const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { resolve, setCacheTtl } = require('./groupResolver');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'schedules.json');
const activeTasks = [];

function stopAllJobs() {
  activeTasks.forEach((t) => t.stop());
  activeTasks.length = 0;
}

function reloadJobs(client) {
  stopAllJobs();
  console.log('[Scheduler] 重新加载配置...');
  loadJobs(client);
}

function loadJobs(client) {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`[Scheduler] 读取配置文件失败：${err.message}`);
    return;
  }

  const { settings = {}, jobs = [] } = config;
  const timezone = settings.timezone || 'Asia/Hong_Kong';
  const cacheMinutes = settings.groupResolveCacheMinutes || 60;

  setCacheTtl(cacheMinutes);

  const enabledJobs = jobs.filter((j) => j.enabled);
  if (enabledJobs.length === 0) {
    console.warn('[Scheduler] 没有已启用的任务（enabled: true），请检查 config/schedules.json。');
    return;
  }

  console.log(`[Scheduler] 加载了 ${enabledJobs.length} 个定时任务（时区：${timezone}）：`);

  for (const job of enabledJobs) {
    if (!cron.validate(job.schedule)) {
      console.error(`[Scheduler] 任务 "${job.id}" 的 cron 表达式无效："${job.schedule}"，已跳过。`);
      continue;
    }

    console.log(`  - [${job.id}] 群组："${job.groupName}"  时间：${job.schedule}`);

    const task = cron.schedule(
      job.schedule,
      async () => {
        // M7：使用 global.whatsappClient 而非闭包捕获的旧引用
        const activeClient = global.whatsappClient;
        if (!activeClient || !global.whatsappReady) {
          console.warn(`[Scheduler] 任务 "${job.id}" 跳过：WhatsApp 未连接`);
          return;
        }
        const now = new Date().toLocaleString('zh-CN', { timeZone: timezone });
        console.log(`[Scheduler] [${now}] 触发任务 "${job.id}" → 群组："${job.groupName}"`);

        const chatId = await resolve(activeClient, job.groupName);
        if (!chatId) {
          console.error(`[Scheduler] 任务 "${job.id}" 失败：找不到群组。`);
          return;
        }

        try {
          const chat = await activeClient.getChatById(chatId);
          await chat.sendMessage(job.message);
          console.log(`[Scheduler] 任务 "${job.id}" 发送成功。`);
        } catch (err) {
          console.error(`[Scheduler] 任务 "${job.id}" 发送失败：${err.message}`);
        }
      },
      { timezone }
    );

    activeTasks.push(task);
  }

  console.log('[Scheduler] 所有任务已启动，等待触发...\n');
}

module.exports = { loadJobs, reloadJobs, stopAllJobs };

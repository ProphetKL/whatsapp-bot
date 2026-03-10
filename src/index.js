require('dotenv').config();

// 启动前检查：必须设置密码，否则拒绝运行
if (!process.env.AUTH_PASS) {
  console.error('');
  console.error('╔══════════════════════════════════════════════════╗');
  console.error('║  错误：未设置 AUTH_PASS 环境变量！                ║');
  console.error('║                                                  ║');
  console.error('║  请在项目根目录创建 .env 文件，内容如下：          ║');
  console.error('║    AUTH_USER=admin                               ║');
  console.error('║    AUTH_PASS=你的密码（至少8位）                  ║');
  console.error('║                                                  ║');
  console.error('║  参考文件：.env.example                          ║');
  console.error('╚══════════════════════════════════════════════════╝');
  console.error('');
  process.exit(1);
}

if (process.env.AUTH_PASS.length < 8) {
  console.error('');
  console.error('[错误] AUTH_PASS 密码长度不足 8 位，请设置更强的密码后重启。');
  console.error('');
  process.exit(1);
}

const { createClient } = require('./client');
const { loadJobs, reloadJobs, stopAllJobs } = require('./scheduler');
const { listAllGroups } = require('./groupResolver');
const { startWebUI } = require('./webui');
const { startCalendarScheduler } = require('./calendarScheduler');

console.log('=== WhatsApp 定时消息机器人启动中 ===\n');

startWebUI();
startCalendarScheduler();

global.whatsappReady = false;
global.whatsappClient = null;

function initClient() {
  const client = createClient();
  global.whatsappClient = client;

  client.on('ready', async () => {
    global.whatsappReady = true;
    await listAllGroups(client);
    loadJobs(client);
  });

  client.on('disconnected', () => {
    global.whatsappReady = false;
  });

  client.initialize().catch((err) => {
    console.error('[Main] 客户端初始化失败：', err.message);
  });

  return client;
}

global.reinitializeClient = () => {
  stopAllJobs();
  global.whatsappReady = false;
  global.latestQR = null;
  initClient();
};

initClient();

process.on('SIGINT', () => {
  console.log('\n[Main] 收到退出信号，正在关闭...');
  const c = global.whatsappClient;
  if (c) c.destroy().finally(() => process.exit(0));
  else process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Main] 收到 SIGTERM，正在关闭...');
  const c = global.whatsappClient;
  if (c) c.destroy().finally(() => process.exit(0));
  else process.exit(0);
});

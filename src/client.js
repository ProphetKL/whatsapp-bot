const { Client, LocalAuth } = require('whatsapp-web.js');

let client = null;

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: './data' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',        // Linux 服务器 /dev/shm 通常只有 64MB，必须加
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    global.latestQR = qr;
    global.whatsappReady = false;
    console.log('\n[WhatsApp] QR 码已更新，请打开管理界面扫码登录\n');
  });

  client.on('ready', () => {
    global.latestQR = null;
    console.log('[WhatsApp] 客户端已就绪！');
  });

  client.on('auth_failure', (msg) => {
    console.error('[WhatsApp] 认证失败：', msg);
    console.error('请删除 data/ 目录后重新启动程序扫码登录。');
    process.exit(1);
  });

  client.on('disconnected', (reason) => {
    console.warn('[WhatsApp] 连接断开，原因：', reason);
    client.initialize().catch((err) => {
      console.error('[WhatsApp] 重新连接失败：', err);
      process.exit(1);
    });
  });

  return client;
}

module.exports = { createClient };

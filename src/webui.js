const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const multer = require('multer');
const { MessageMedia } = require('whatsapp-web.js');
const { resolve: resolveGroup } = require('./groupResolver');
const { reloadJobs } = require('./scheduler');
const { checkAllJobs } = require('./calendarScheduler');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'schedules.json');
const PUBLIC_PATH = path.join(__dirname, '..', 'public');
const { version: APP_VERSION } = require('../package.json');

const DEFAULT_CONFIG = {
  settings: { timezone: 'Asia/Hong_Kong', groupResolveCacheMinutes: 60 },
  jobs: [],
  calendarJobs: [],
};

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    return DEFAULT_CONFIG;
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  // 兼容旧版本：补全缺少的字段
  if (!config.calendarJobs) config.calendarJobs = [];
  return config;
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// 登录失败计数（内存）：ip → { count, resetAt }
const authFailures = new Map();
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 分钟

// H1/M10：校验日历 URL——必须 HTTPS，且不能指向内网地址
function isPrivateHost(hostname) {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') return true;
  if (/^127\./.test(hostname)) return true;           // loopback
  if (/^10\./.test(hostname)) return true;            // 10.x.x.x
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // 172.16-31.x.x
  if (/^192\.168\./.test(hostname)) return true;      // 192.168.x.x
  if (/^169\.254\./.test(hostname)) return true;      // 链路本地（云元数据接口）
  return false;
}

function validateCalendarUrl(url) {
  if (!url.startsWith('https://')) return '链接必须使用 HTTPS';
  if (!url.endsWith('.ics') && !url.includes('basic.ics') && !url.includes('ical'))
    return '链接格式不正确，应以 .ics 结尾。请在 Google 日历 → 设置 → 整合日历 → 复制「iCal 格式的公开地址」';
  try {
    const { hostname } = new URL(url);
    if (isPrivateHost(hostname)) return '不允许访问内网地址';
  } catch {
    return '链接格式无效';
  }
  return null; // 通过校验
}

// 即时/定时发送：待发队列（重启后清空）
const pendingSends = new Map();

async function doSendMessage(groupName, text, file) {
  const client = global.whatsappClient;
  if (!client || !global.whatsappReady) throw new Error('WhatsApp 未连接');
  const chatId = await resolveGroup(client, groupName);
  if (!chatId) throw new Error(`找不到群组：${groupName}`);
  const chat = await client.getChatById(chatId);
  if (file) {
    const media = new MessageMedia(file.mimetype, file.buffer.toString('base64'), file.originalname);
    await chat.sendMessage(media, text ? { caption: text } : {});
  } else {
    await chat.sendMessage(text);
  }
}

function startWebUI(port) {
  port = port || parseInt(process.env.PORT) || 3000;

  const authUser = process.env.AUTH_USER || 'admin';
  const authPass = process.env.AUTH_PASS; // index.js 已保证此值存在

  const app = express();
  app.set('trust proxy', 1); // H4：反向代理后正确读取客户端真实 IP
  app.use(express.json({ limit: '10kb' })); // M4：限制请求体大小

  // ── 安全响应头 ──────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // L7：Content-Security-Policy，阻止加载外部脚本/资源
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'");
    next();
  });

  // ── 强制 Basic Auth + 频率限制 ─────────────────
  app.use((req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = authFailures.get(ip);

    // 封锁判断
    if (record && now < record.resetAt && record.count >= MAX_FAILURES) {
      const waitMin = Math.ceil((record.resetAt - now) / 60000);
      return res.status(429).send(`登录失败次数过多，请 ${waitMin} 分钟后再试`);
    }
    // 过期则清除
    if (record && now >= record.resetAt) {
      authFailures.delete(ip);
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Bot"');
      return res.status(401).send('请输入用户名和密码');
    }

    // 用 indexOf 切分，兼容密码中含冒号的情况
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);

    if (user !== authUser || pass !== authPass) {
      const cur = authFailures.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
      cur.count += 1;
      authFailures.set(ip, cur);
      const remaining = MAX_FAILURES - cur.count;
      res.setHeader('WWW-Authenticate', 'Basic realm="WhatsApp Bot"');
      return res.status(401).send(
        remaining > 0 ? `用户名或密码错误（还剩 ${remaining} 次机会）` : '账户已临时锁定，请稍后再试'
      );
    }

    // 登录成功，清除失败记录
    authFailures.delete(ip);
    next();
  });

  console.log(`[WebUI] Basic Auth 已启用（用户名：${authUser}）`);

  app.use(express.static(PUBLIC_PATH));

  // 获取所有配置
  app.get('/api/config', (req, res) => {
    try {
      res.json(readConfig());
    } catch (err) {
      res.status(500).json({ error: '读取配置失败：' + err.message });
    }
  });

  // 保存整份配置，并自动重新加载调度器
  app.post('/api/config', (req, res) => {
    try {
      writeConfig(req.body);
      if (global.whatsappReady && global.whatsappClient) {
        reloadJobs(global.whatsappClient);
      }
      checkAllJobs(); // M8：日历调度器立即重新检查，不等 5 分钟轮询
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: '保存配置失败：' + err.message });
    }
  });

  // 获取所有群组名（客户端已就绪时）
  app.get('/api/groups', (req, res) => {
    const client = global.whatsappClient;
    if (!client || !global.whatsappReady) {
      return res.json({ groups: [], ready: false });
    }
    client.getChats().then((chats) => {
      const groups = chats.filter((c) => c.isGroup).map((c) => c.name);
      res.json({ groups, ready: true });
    }).catch((err) => {
      console.error('[WebUI] getChats() 失败：', err.message);
      res.json({ groups: [], ready: true, error: err.message });
    });
  });

  // WhatsApp 连接状态
  app.get('/api/status', (req, res) => {
    res.json({ ready: !!global.whatsappReady, hasQR: !!global.latestQR, version: APP_VERSION });
  });

  // 登出当前账号，清除会话，重新显示 QR 码
  app.post('/api/logout', async (req, res) => {
    const client = global.whatsappClient;
    if (!client) return res.status(400).json({ error: '客户端未初始化' });
    try {
      await client.logout();
    } catch (err) {
      console.warn('[WebUI] logout() 出错（将继续强制清除）：', err.message);
      const sessionDir = path.join(__dirname, '..', 'data');
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
    console.log('[WebUI] 账号已登出，正在创建新客户端...');
    res.json({ ok: true });
    setTimeout(() => {
      try { client.destroy(); } catch {}
      global.reinitializeClient();
    }, 500);
  });

  // QR 码图片（PNG 格式）
  app.get('/api/qr', async (req, res) => {
    if (!global.latestQR) {
      return res.status(404).json({ error: '暂无 QR 码，可能已登录或还未初始化' });
    }
    try {
      const buffer = await QRCode.toBuffer(global.latestQR, { width: 300, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: '生成 QR 码失败：' + err.message });
    }
  });

  // ── 日历提醒任务 API ──────────────────────────────────

  app.get('/api/calendar-jobs', (req, res) => {
    try {
      const config = readConfig();
      res.json(config.calendarJobs || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/calendar-jobs', (req, res) => {
    try {
      const job = req.body;
      // H1/M10：校验 ICS URL
      if (job.calendarUrl) {
        const urlError = validateCalendarUrl(job.calendarUrl);
        if (urlError) return res.status(400).json({ error: urlError });
      }
      const config = readConfig();
      if (!config.calendarJobs) config.calendarJobs = [];
      const idx = config.calendarJobs.findIndex(j => j.id === job.id);
      if (idx >= 0) config.calendarJobs[idx] = job;
      else config.calendarJobs.push(job);
      writeConfig(config);
      checkAllJobs(); // M8：立即生效
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/calendar-jobs/:id', (req, res) => {
    try {
      const config = readConfig();
      config.calendarJobs = (config.calendarJobs || []).filter(j => j.id !== req.params.id);
      writeConfig(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 即时/定时消息发布 ──────────────────────────────────
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  });

  app.post('/api/send', upload.single('file'), async (req, res) => {
    try {
      const { group, text, sendAt } = req.body;
      if (!group) return res.status(400).json({ ok: false, error: '请选择目标群组' });
      if (!text && !req.file) return res.status(400).json({ ok: false, error: '请输入消息内容或选择文件' });

      const file = req.file
        ? { buffer: req.file.buffer, mimetype: req.file.mimetype, originalname: req.file.originalname }
        : null;

      // sendAt 格式：datetime-local 值 + HKT 偏移，如 "2024-01-01T09:00+08:00"
      const scheduledTime = sendAt ? new Date(sendAt) : null;
      const delay = scheduledTime ? scheduledTime.getTime() - Date.now() : 0;

      if (delay > 2000) {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
        const timeoutId = setTimeout(async () => {
          try {
            await doSendMessage(group, text, file);
            console.log(`[Send] 定时消息已发送到 ${group}`);
          } catch (err) {
            console.error(`[Send] 定时消息发送失败：${err.message}`);
          } finally {
            pendingSends.delete(id);
          }
        }, delay);
        pendingSends.set(id, {
          id, group,
          preview: text ? text.slice(0, 50) : (file ? `[文件] ${file.originalname}` : ''),
          sendAt: scheduledTime.toISOString(),
          timeoutId,
        });
        return res.json({ ok: true, message: '已安排定时发送', pendingId: id, sendAt: scheduledTime.toISOString() });
      } else {
        await doSendMessage(group, text, file);
        return res.json({ ok: true, message: '发送成功' });
      }
    } catch (err) {
      console.error('[Send] 发送失败：', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/pending-sends', (req, res) => {
    const list = [...pendingSends.values()].map(({ id, group, preview, sendAt }) => ({ id, group, preview, sendAt }));
    res.json(list);
  });

  app.delete('/api/pending-sends/:id', (req, res) => {
    const item = pendingSends.get(req.params.id);
    if (!item) return res.status(404).json({ error: '未找到该待发消息' });
    clearTimeout(item.timeoutId);
    pendingSends.delete(req.params.id);
    res.json({ ok: true });
  });

  // 验证 ICS 链接并预览近期事件
  app.post('/api/calendar-preview', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: '请提供 URL' });
    const urlError = validateCalendarUrl(url); // H1/M10
    if (urlError) return res.status(400).json({ ok: false, error: urlError });
    try {
      const ical = require('node-ical');
      const events = await ical.async.fromURL(url);
      const allEntries = Object.values(events);
      if (allEntries.length === 0) {
        return res.json({ ok: false, error: '该链接未返回任何日历数据，请确认日历已设为「公开」，并使用 iCal 格式地址（.ics 结尾）' });
      }
      const now = Date.now();
      const windowEnd = now + 30 * 24 * 60 * 60 * 1000; // 未来 30 天
      const windowStart = now - 24 * 60 * 60 * 1000;    // 往前 24 小时
      const upcoming = [];
      for (const e of allEntries) {
        if (e.type !== 'VEVENT' || !e.start) continue;
        if (e.rrule) {
          // 重复事件：展开未来 30 天内的所有发生日期
          const occurrences = e.rrule.between(new Date(windowStart), new Date(windowEnd));
          for (const occ of occurrences) {
            upcoming.push({ title: e.summary || '(无标题)', start: occ });
          }
        } else {
          const startMs = new Date(e.start).getTime();
          if (startMs >= windowStart) {
            upcoming.push({ title: e.summary || '(无标题)', start: new Date(e.start) });
          }
        }
      }
      upcoming.sort((a, b) => a.start - b.start);
      const result = upcoming.slice(0, 5).map(e => ({
        title: e.title,
        start: e.start.toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' }),
      }));
      res.json({ ok: true, events: result });
    } catch (err) {
      res.status(400).json({ ok: false, error: '无法获取日历：' + err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[WebUI] 管理界面已启动：http://localhost:${port}`);
  });
}

module.exports = { startWebUI };

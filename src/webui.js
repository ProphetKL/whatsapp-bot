const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { reloadJobs } = require('./scheduler');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'schedules.json');
const PUBLIC_PATH = path.join(__dirname, '..', 'public');

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// 登录失败计数（内存）：ip → { count, resetAt }
const authFailures = new Map();
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 分钟

function startWebUI(port) {
  port = port || parseInt(process.env.PORT) || 3000;

  const authUser = process.env.AUTH_USER || 'admin';
  const authPass = process.env.AUTH_PASS; // index.js 已保证此值存在

  const app = express();
  app.use(express.json());

  // ── 安全响应头 ──────────────────────────────────
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
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
    res.json({ ready: !!global.whatsappReady, hasQR: !!global.latestQR });
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
      const config = readConfig();
      if (!config.calendarJobs) config.calendarJobs = [];
      const job = req.body;
      const idx = config.calendarJobs.findIndex(j => j.id === job.id);
      if (idx >= 0) config.calendarJobs[idx] = job;
      else config.calendarJobs.push(job);
      writeConfig(config);
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

  // 验证 ICS 链接并预览近期事件
  app.post('/api/calendar-preview', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ ok: false, error: '请提供 URL' });
    if (!url.endsWith('.ics') && !url.includes('basic.ics') && !url.includes('ical')) {
      return res.json({ ok: false, error: '链接格式不正确，应以 .ics 结尾。请在 Google 日历 → 设置 → 整合日历 → 复制「iCal 格式的公开地址」' });
    }
    try {
      const ical = require('node-ical');
      const events = await ical.async.fromURL(url);
      const allEntries = Object.values(events);
      if (allEntries.length === 0) {
        return res.json({ ok: false, error: '该链接未返回任何日历数据，请确认日历已设为「公开」，并使用 iCal 格式地址（.ics 结尾）' });
      }
      const now = Date.now();
      const upcoming = allEntries
        .filter(e => e.type === 'VEVENT' && e.start && new Date(e.start).getTime() >= now - 24 * 60 * 60 * 1000)
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .slice(0, 5)
        .map(e => ({
          title: e.summary || '(无标题)',
          start: new Date(e.start).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' }),
        }));
      res.json({ ok: true, events: upcoming });
    } catch (err) {
      res.status(400).json({ ok: false, error: '无法获取日历：' + err.message });
    }
  });

  app.listen(port, () => {
    console.log(`[WebUI] 管理界面已启动：http://localhost:${port}`);
  });
}

module.exports = { startWebUI };

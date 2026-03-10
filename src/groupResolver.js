// 群组名称 → WhatsApp Chat ID 的解析与缓存模块

const cache = new Map(); // groupName → { chatId, expireAt }
let cacheTtlMs = 60 * 60 * 1000; // 默认 60 分钟

function setCacheTtl(minutes) {
  cacheTtlMs = minutes * 60 * 1000;
}

async function resolve(client, groupName) {
  const now = Date.now();
  const cached = cache.get(groupName);
  if (cached && now < cached.expireAt) {
    return cached.chatId;
  }

  let chats;
  try {
    chats = await client.getChats();
  } catch (err) {
    console.error(`[GroupResolver] 获取聊天列表失败：${err.message}`);
    // 连接已失效（如重启后 Puppeteer Frame 断开），触发重连
    if (global.reinitializeClient) {
      console.log('[GroupResolver] 连接已失效，正在自动重新初始化...');
      global.whatsappReady = false;
      global.reinitializeClient();
    }
    return null;
  }

  const groups = chats.filter((c) => c.isGroup && c.name === groupName);

  if (groups.length === 0) {
    console.warn(`[GroupResolver] 找不到群组："${groupName}"，请检查名称是否与 WhatsApp 完全一致（区分大小写）。`);
    return null;
  }

  if (groups.length > 1) {
    console.warn(`[GroupResolver] 存在多个同名群组："${groupName}"，将使用第一个匹配项。`);
  }

  const chatId = groups[0].id._serialized;
  cache.set(groupName, { chatId, expireAt: now + cacheTtlMs });
  return chatId;
}

// 列出所有群组名称（用于调试）
async function listAllGroups(client) {
  let chats;
  try {
    chats = await client.getChats();
  } catch (err) {
    console.error(`[GroupResolver] 获取聊天列表失败：${err.message}`);
    return;
  }
  const groups = chats.filter((c) => c.isGroup);
  console.log(`\n[GroupResolver] 当前账号所在的所有群组（共 ${groups.length} 个）：`);
  groups.forEach((g) => console.log(`  - "${g.name}"`));
  console.log('');
}

module.exports = { resolve, listAllGroups, setCacheTtl };

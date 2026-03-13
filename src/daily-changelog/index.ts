/**
 * Daily Changelog Generator
 *
 * Reads Mao Family group messages from past 24h via Feishu API,
 * categorizes them, and outputs markdown to stdout.
 *
 * The actual document creation is handled by the calling agent
 * via feishu_wiki + feishu_doc tools.
 *
 * Usage: npx tsx src/daily-changelog/index.ts
 *
 * Environment variables:
 *   FEISHU_APP_ID - Feishu app ID
 *   FEISHU_APP_SECRET - Feishu app secret
 *   FEISHU_CHAT_ID - Group chat ID (default: oc_e8355cdfab57a6367c5e7cdf414fe107)
 */

import https from 'node:https';

// --- Config ---
const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const CHAT_ID = process.env.FEISHU_CHAT_ID || 'oc_e8355cdfab57a6367c5e7cdf414fe107';

// --- Types ---
interface FeishuMessage {
  message_id: string;
  msg_type: string;
  create_time: string;
  sender: {
    sender_type: string;
    id: string;
    id_type: string;
    tenant_key?: string;
  };
  body: {
    content: string;
  };
}

interface ParsedMessage {
  time: string;
  sender: string;
  content: string;
  category: 'system' | 'file' | 'task';
}

export interface ChangelogResult {
  messageCount: number;
  dateStr: string;
  markdown: string;
}

// --- HTTP Helper ---
function request(
  options: https.RequestOptions,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          reject(new Error(data));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- Feishu API ---
async function getTenantToken(): Promise<string> {
  const res = await request(
    {
      hostname: 'open.feishu.cn',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { app_id: APP_ID, app_secret: APP_SECRET },
  );
  if ((res as { code: number }).code !== 0) {
    throw new Error(`Token error: ${JSON.stringify(res)}`);
  }
  return (res as { tenant_access_token: string }).tenant_access_token;
}

async function getMessages(
  token: string,
  startTime: number,
  endTime: number,
): Promise<FeishuMessage[]> {
  const all: FeishuMessage[] = [];
  let pageToken: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      container_id_type: 'chat',
      container_id: CHAT_ID,
      start_time: String(startTime),
      end_time: String(endTime),
      sort_type: 'ByCreateTimeAsc',
      page_size: '50',
    });
    if (pageToken) params.set('page_token', pageToken);

    const res = (await request({
      hostname: 'open.feishu.cn',
      path: `/open-apis/im/v1/messages?${params}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })) as {
      code: number;
      msg: string;
      data?: { items?: FeishuMessage[]; has_more?: boolean; page_token?: string };
    };

    if (res.code !== 0) {
      throw new Error(`Messages API error: ${res.code} ${res.msg}`);
    }

    if (res.data?.items) all.push(...res.data.items);
    hasMore = res.data?.has_more || false;
    pageToken = res.data?.page_token || null;
  }

  return all;
}

// --- Bot name cache ---
const BOT_NAMES: Record<string, string> = {
  cli_a926cff934b8dbce: 'MaoKu',
  cli_a93a4fac0b789cd3: 'MaoGen',
  cli_a93a4924b4785cd9: 'MaoYi',
};

// --- Message Parsing ---
function extractContent(msg: FeishuMessage): string {
  try {
    const body = JSON.parse(msg.body.content);
    if (msg.msg_type === 'text') return body.text || '';
    if (msg.msg_type === 'post') {
      const title = body.title || '';
      const lines: string[] = [];
      if (title) lines.push(title);
      const content = body.content as Array<Array<{ tag: string; text?: string }>> | undefined;
      if (content) {
        for (const para of content) {
          const texts = para
            .filter((el: { tag: string }) => el.tag === 'text' || el.tag === 'a')
            .map((el: { text?: string }) => el.text || '')
            .join('');
          if (texts) lines.push(texts);
        }
      }
      return lines.join(' | ');
    }
    if (msg.msg_type === 'interactive') {
      return body.header?.title?.content || '[卡片消息]';
    }
    return `[${msg.msg_type}]`;
  } catch {
    return `[${msg.msg_type}]`;
  }
}

export function categorize(content: string): 'system' | 'file' | 'task' {
  const lower = content.toLowerCase();
  const systemKw = [
    'gateway', 'restart', 'heartbeat', 'config', 'openclaw', '权限',
    'plugin', 'deploy', 'cron', 'permission', 'scope', '插件', '升级',
    'version', '版本',
  ];
  const fileKw = [
    'commit', 'merge', 'pr', 'git', 'push', 'file', '文件',
    '修改', '更新', '创建', 'write', 'delete', 'repo', '仓库',
    'branch', 'AGENTS.md', 'MEMORY.md', 'HEARTBEAT.md', 'TOOLS.md',
  ];

  if (systemKw.some((kw) => lower.includes(kw))) return 'system';
  if (fileKw.some((kw) => lower.includes(kw))) return 'file';
  return 'task';
}

async function parseMessages(
  _token: string,
  messages: FeishuMessage[],
): Promise<ParsedMessage[]> {
  const parsed: ParsedMessage[] = [];

  for (const msg of messages) {
    const ts = parseInt(msg.create_time) * 1000;
    const date = new Date(ts);
    const time = date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai',
    });

    let sender: string;
    if (msg.sender.sender_type === 'app') {
      sender = BOT_NAMES[msg.sender.id || ''] || 'Bot';
    } else {
      // For user messages, use sender id (user name lookup requires contact scope)
      sender = msg.sender.id || 'User';
    }

    const content = extractContent(msg);
    if (!content || content.startsWith('[')) continue;

    parsed.push({
      time,
      sender,
      content,
      category: categorize(content),
    });
  }

  return parsed;
}

// --- Markdown Generation ---
export function generateMarkdown(messages: ParsedMessage[], dateStr: string): string {
  const system = messages.filter((m) => m.category === 'system');
  const file = messages.filter((m) => m.category === 'file');
  const task = messages.filter((m) => m.category === 'task');

  let md = `# Daily Changelog - ${dateStr}\n\n`;
  md += `> 自动生成 | 覆盖过去 24 小时群消息 | 共 ${messages.length} 条\n\n`;

  const section = (title: string, emoji: string, items: ParsedMessage[]) => {
    md += `## ${emoji} ${title}\n\n`;
    if (items.length === 0) {
      md += '（无）\n\n';
    } else {
      for (const m of items) {
        const preview = m.content.substring(0, 150).replace(/\n/g, ' ');
        md += `**${m.time}** [${m.sender}] ${preview}\n\n`;
      }
    }
  };

  section('系统变更', '🔧', system);
  section('文件变更', '📁', file);
  section('任务记录', '📋', task);

  return md;
}

// --- Main ---
export async function generateDailyChangelog(): Promise<ChangelogResult> {
  if (!APP_ID || !APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  }

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startTime = Math.floor(yesterday.getTime() / 1000);
  const endTime = Math.floor(now.getTime() / 1000);

  const dateStr = now
    .toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'Asia/Shanghai',
    })
    .replace(/\//g, '-');

  console.error(`[changelog] Fetching messages: ${yesterday.toISOString()} → ${now.toISOString()}`);

  const token = await getTenantToken();
  const rawMessages = await getMessages(token, startTime, endTime);
  console.error(`[changelog] Raw messages: ${rawMessages.length}`);

  const parsed = await parseMessages(token, rawMessages);
  console.error(`[changelog] Parsed messages: ${parsed.length}`);

  const markdown = generateMarkdown(parsed, dateStr);

  return { messageCount: parsed.length, dateStr, markdown };
}

// CLI entry - outputs markdown to stdout
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  generateDailyChangelog()
    .then((result) => {
      if (result.messageCount === 0) {
        console.error('[changelog] No messages to report.');
      } else {
        // Output markdown to stdout for piping
        process.stdout.write(result.markdown);
        console.error(`[changelog] Done: ${result.messageCount} messages for ${result.dateStr}`);
      }
    })
    .catch((err) => {
      console.error('[changelog] Error:', err);
      process.exit(1);
    });
}

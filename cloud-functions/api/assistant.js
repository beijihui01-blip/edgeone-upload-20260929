const BASES = { cn: 'https://api.coze.cn', global: 'https://api.coze.com' };

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

function buildPrompt(body) {
  const history = String(body.priorArtifacts || '暂无');
  const artifact = String(body.artifact || '');
  return `你是贯穿 11 个步骤的 AI 影视创作工作流助手。请继承已确认成果，直接完成当前步骤。

已确认的上游成果（仅保留最近相关内容）：
${history.slice(-9000)}

当前步骤：Step ${body.step?.id} ${body.step?.title}
步骤职责：${body.step?.role}

当前成果正文：
${artifact.slice(0, 6000)}

用户要求：${String(body.message)}

输出要求：不要展示思考过程，立即从成果正文第一句开始；结构清晰，不使用 Markdown 表格。正文后追加三个基于本次正文的具体修改选择，每项 12—30 个汉字，并严格用以下格式收尾：
<<<NEXT_CHOICES>>>
["具体选择一","具体选择二","具体选择三"]
<<<END_NEXT_CHOICES>>>`;
}

export default async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (context.request.method !== 'POST') return json({ error: '仅支持 POST 请求' }, 405);
  try {
    const body = await context.request.json();
    const region = body.region === 'global' ? 'global' : 'cn';
    const token = String(body.token || context.env?.COZE_API_TOKEN || '');
    const botId = String(body.botId || context.env?.COZE_BOT_ID || '');
    if (!token || !botId || !body.message) return json({ error: '缺少 Bot ID、访问令牌或消息内容' }, 400);

    const upstream = await fetch(`${BASES[region]}/v3/chat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        bot_id: botId,
        user_id: String(body.userId || 'film-workflow-user'),
        stream: true,
        auto_save_history: false,
        additional_messages: [{ role: 'user', content: buildPrompt(body), content_type: 'text' }],
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: `Coze 返回 ${upstream.status}：${detail.slice(0, 300)}` }, 502);
    }
    if (!upstream.body) return json({ error: 'Coze 已响应，但没有返回数据流' }, 502);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const output = new ReadableStream({
      async start(controller) {
        let buffer = '', sent = false, completed = '';
        const consume = (block) => {
          let event = '';
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          const raw = dataLines.join('\n');
          if (!raw || raw === '[DONE]' || raw === '"[DONE]"') return;
          let data;
          try { data = JSON.parse(raw); } catch { return; }
          if (event === 'conversation.chat.failed' || event === 'error') {
            throw new Error(data?.last_error?.msg || data?.msg || data?.message || 'Coze 对话执行失败');
          }
          if (data?.role !== 'assistant' || data?.type !== 'answer' || typeof data?.content !== 'string') return;
          if (event === 'conversation.message.delta' && data.content) {
            sent = true;
            controller.enqueue(encoder.encode(data.content));
          } else if (event === 'conversation.message.completed') completed = data.content;
        };
        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
            const blocks = buffer.split(/\n\n+/);
            buffer = blocks.pop() || '';
            for (const block of blocks) consume(block);
            if (done) break;
          }
          if (buffer.trim()) consume(buffer);
          if (!sent && completed) {
            sent = true;
            controller.enqueue(encoder.encode(completed));
          }
          if (!sent) throw new Error('Coze 已响应，但没有返回 answer 文本');
          controller.close();
        } catch (error) { controller.error(error); }
      },
      cancel() { void reader.cancel(); },
    });
    return new Response(output, { headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no',
    } });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : '服务端请求失败' }, 500);
  }
}

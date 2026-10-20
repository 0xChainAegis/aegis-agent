import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../backend/src/config.js';
import { createLlmClient, parseDraftWithLlm } from '../backend/src/llm.js';

// 只测试真实模型与草稿解析，不启动链、不创建付款任务。
const config = loadConfig();
assert.equal(config.llm.mode, 'live');
const client = createLlmClient(config.llm)!;
assert.ok(client.provider === 'openai' || client.provider === 'anthropic');
const recipient = '0x1111111111111111111111111111111111111111';
const cases = [
  { name: '完整中文转账', message: `请给 ${recipient} 转 0.001 ETH，支付服务费`, status: 'DRAFT', amount: '1000000000000000' },
  { name: '缺少金额时追问', message: `给 ${recipient} 转一点 ETH`, status: 'NEEDS_INPUT', amount: null },
  { name: '拒绝不支持的美元转账', message: `给 ${recipient} 转 10 USD`, status: 'NEEDS_INPUT', amount: null },
];
const results: unknown[] = [];
for (const item of cases) {
  const started = Date.now();
  // 使用项目原有适配器进行真实网络调用，保存原始候选，避免规则回退掩盖失败。
  const raw = await client.extract({ message: item.message, previous: null });
  // 重用这一次真实响应，验证项目的完整校验逻辑，不重复消耗 API。
  const draft = await parseDraftWithLlm({ message: item.message }, config, undefined, {
    provider: client.provider, model: client.model, extract: async () => raw,
  });
  const result = { name: item.name, message: item.message, latencyMs: Date.now() - started, raw, draft };
  results.push(result);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/live-intent-smoke.json', JSON.stringify({
    testedAt: new Date().toISOString(), node: process.version, provider: client.provider,
    model: client.model, baseUrl: config.llm.baseUrl, mode: 'live',
    scope: 'real LLM API + existing draft validation; no chain or payment submission', results,
  }, null, 2));
  assert.equal(draft.parser.kind, 'llm', JSON.stringify(draft.parser));
  assert.equal(draft.parser.fallback, false);
  assert.equal(draft.status, item.status);
  assert.equal(draft.amountWei, item.amount);
  if (item.status === 'DRAFT') assert.equal(draft.recipient, recipient);
  else assert.ok(draft.question);
  console.log(`PASS ${item.name} ${result.latencyMs}ms ${JSON.stringify({ parser: draft.parser, status: draft.status, question: draft.question })}`);
}
console.log('全部真实 API 草稿检查通过，未提交任何链上付款。');

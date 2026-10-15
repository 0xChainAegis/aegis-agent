import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAddress, type Address, type Hex } from 'viem';
import { SCHEMA_VERSION } from '@aegis/shared';
import { AegisService } from './service.js';
import { walletAbi, oracleAbi } from './chain.js';
import { ApiError } from './errors.js';

const address = z.string().refine(value => isAddress(value), 'Invalid Ethereum address');
const integer = z.string().regex(/^[1-9]\d*$/).max(78).refine(value => /^[1-9]\d*$/.test(value) && BigInt(value) < 2n ** 256n, 'Amount exceeds uint256');
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const draftSchema = z.object({ message: z.string().max(4000).optional(), recipient: address.nullable().optional(), amountWei: integer.nullable().optional(), purpose: z.string().max(500).optional() }).strict();
const revision = z.number().int().positive();
const patchSchema = draftSchema.extend({ expectedRevision: revision }).strict();
const previewSchema = z.object({ expectedRevision: revision, maxUsdCost6: integer.optional() }).strict();
const submitSchema = z.object({ expectedRevision: revision, quoteId: z.string().uuid() }).strict();
const docs: Record<string, { title: string; markdown: string }> = {
  overview: { title: 'Aegis 受限 ETH 支付', markdown: '# Aegis\n\n普通 ETH 转账与 Agent 钱包补 ETH 是两种候选场景，共用受限 native ETH 支付核心。当前入口只支持人工确认的付款；补款监控尚未实现。\n\n自然语言只生成草稿。确认后由 agent 发请求，超过自动额度的请求等待 owner 链上 approveAndExecute。高风险付款最终交易由 owner 签名。' },
  roles: { title: '角色与签名', markdown: '# 角色与签名\n\nOwner 用钱包签一次性登录消息，并在浏览器签规则修改、充值及高风险审批交易。登录不授权付款。后台只保存受限 agent 执行密钥，绝不保存 owner 私钥。\n\n当前是单 owner 资金池；Bearer 会话过期后需重新登录。' },
  chainlink: { title: 'Chainlink 与硬规则', markdown: '# Chainlink\n\n合约在请求及审批执行时读取 ETH/USD Data Feed，检查正价格与时间新鲜度，并最终校验 USD 单笔、累计日预算、允许收款人、请求期限和策略版本。前端预览不是执行许可。\n\n金额使用整数 wei 与 USD6。美元输入不会被当作 ETH。CCIP、x402、CRE 与自动监控均不属于当前核心流程。' },
  evidence: { title: '交易与验证', markdown: '# 可核查的结果\n\nSUBMITTING 表示正在准备；BROADCAST 表示已发送；UNKNOWN 表示广播结果不明。链上 receipt 成功且有匹配的 NativeTransferExecuted 才能显示已付款。NativeTransferQueued 表示等待 owner。\n\n后台保存原始签名交易、原哈希与 nonce 后再发送。超时和重启优先查原哈希，不创建新付款。一次 mined 确认不代表最终不可逆。local_chain 是本地真实链交易，testnet 是测试网真实交易，mock 没有链上执行。' },
  api: { title: '联调 API', markdown: '# API\n\n接口版本 aegis.v1，路径 /api/v1。先 auth/challenge，再用钱包签 message 调 auth/verify，后续使用 Authorization: Bearer token。\n\nintents → preview → submit → tasks/:id → evidence。所有业务写请求带 Idempotency-Key；相同 key 同内容返回原结果，异内容返回 409。编辑使用 expectedRevision。文档是静态 Markdown，没有 RAG。' },
};
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', '请求必须使用 application/json');
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 32_768) throw new ApiError(413, 'BODY_TOO_LARGE', '请求过大');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ApiError(400, 'INVALID_JSON', '无法解析 JSON'); }
}
function publicRpc(rpcUrl: string) {
  const url = new URL(rpcUrl);
  return url.username || url.password || url.search || (url.pathname !== '/' && url.pathname !== '') ? null : rpcUrl;
}
export function createApiServer(service: AegisService) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    const base = { schemaVersion: SCHEMA_VERSION, mode: service.config.mode, requestId, serverTime: new Date().toISOString() };
    const send = (status: number, body: unknown, replay = false) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-Id': requestId, ...(replay ? { 'Idempotency-Replayed': 'true' } : {}) });
      response.end(JSON.stringify({ ...base, ...(body as object) }));
    };
    try {
      const origin = request.headers.origin;
      if (origin && !service.config.origins.includes(origin)) throw new ApiError(403, 'ORIGIN_DENIED', '只允许配置的 localhost 前端');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
      }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${service.config.port}`);
      const path = url.pathname;
      if (request.method === 'GET' && (path === '/health' || path === '/api/v1/health')) {
        const readiness = await service.chain.readiness();
        send(readiness.ready ? 200 : 503, { status: readiness.ready ? 'ok' : 'not_ready', readiness }); return;
      }
      if (request.method === 'GET' && path === '/api/v1/config') {
        const config = service.config;
        send(200, {
          chainId: config.chainId, rpcUrl: publicRpc(config.rpcUrl), abiVersion: config.abiVersion,
          walletAddress: config.walletAddress, aclAddress: config.aclAddress, attestationAddress: config.attestationAddress,
          oracleAddress: config.oracleAddress, feedAddress: config.feedAddress, ownerAddress: config.ownerAddress, agentAddress: config.agentAddress, recipientAddress: config.recipientAddress,
          addresses: { wallet: config.walletAddress, acl: config.aclAddress, attestation: config.attestationAddress, oracle: config.oracleAddress, feed: config.feedAddress, owner: config.ownerAddress, agent: config.agentAddress, recipient: config.recipientAddress },
          abi: { wallet: walletAbi, oracle: oracleAbi }, walletAbi, oracleAbi,
          readiness: await service.chain.readiness(), explorerBaseUrl: config.mode === 'testnet' ? 'https://sepolia.etherscan.io' : null,
          planner: { kind: 'rule_parser', model: null, configuredModel: config.configuredModel, llmEnabled: false },
          capabilities: { nativeEth: true, ownerApproval: 'owner_approve_and_execute', usdDecimals: 6, monitoring: false, x402: false },
          auth: { kind: 'personal_sign_challenge', domain: config.authDomain, chainId: config.chainId },
          docs: Object.keys(docs).map(slug => ({ slug, title: docs[slug].title, url: `/api/v1/docs/${slug}` })),
        }); return;
      }
      const docMatch = path.match(/^\/api\/v1\/docs\/([a-z-]+)$/);
      if (request.method === 'GET' && docMatch) {
        const document = docs[docMatch[1]];
        if (!document) throw new ApiError(404, 'DOC_NOT_FOUND', '文档不存在');
        send(200, { slug: docMatch[1], ...document, links: [{ title: 'Source repository', url: 'https://github.com/0xChainAegis/aegis-agent' }] }); return;
      }
      if (request.method === 'POST' && path === '/api/v1/auth/challenge') {
        const body = z.object({ address, chainId: z.number().int().positive().optional() }).strict().parse(await readJson(request));
        send(200, service.challenge(body.address, body.chainId ?? service.config.chainId)); return;
      }
      if (request.method === 'POST' && path === '/api/v1/auth/verify') {
        const body = z.object({ challengeId: z.string().uuid(), address, signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(2048) }).strict().parse(await readJson(request));
        send(200, await service.verify(body.challengeId, body.address, body.signature as Hex)); return;
      }
      const authorization = request.headers.authorization;
      const owner = service.authenticate(authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined);
      if (request.method === 'GET' && path === '/api/v1/wallets/current') { send(200, await service.chain.snapshot()); return; }
      if (request.method === 'GET' && path === '/api/v1/tasks') {
        send(200, { tasks: service.store.list<Parameters<typeof service.publicTask>[0]>('task', owner).map(task => service.publicTask(task)) }); return;
      }
      const intentMatch = path.match(/^\/api\/v1\/intents\/([a-f0-9-]+)(?:\/(preview|submit))?$/);
      if (request.method === 'GET' && intentMatch && !intentMatch[2]) { send(200, service.getIntent(owner, intentMatch[1])); return; }
      const taskMatch = path.match(/^\/api\/v1\/tasks\/([a-f0-9-]+)(?:\/(owner-tx|observed-tx|evidence))?$/);
      if (request.method === 'GET' && taskMatch) {
        const [, id, action] = taskMatch;
        if (!action) { send(200, service.publicTask(service.getTask(owner, id))); return; }
        if (action === 'evidence') { send(200, service.evidence(owner, id)); return; }
        if (action === 'owner-tx') {
          const kind = z.enum(['approve', 'cancel']).parse(url.searchParams.get('action'));
          send(200, await service.ownerTx(owner, id, kind)); return;
        }
      }
      if (request.method === 'POST' || request.method === 'PATCH') {
        const raw = await readJson(request);
        const key = request.headers['idempotency-key'];
        const result = await service.idempotent(owner, `${request.method}:${path}`, Array.isArray(key) ? key[0] : key, raw, async () => {
          if (request.method === 'POST' && path === '/api/v1/intents') return { status: 201, body: service.createIntent(owner, draftSchema.parse(raw)) };
          if (intentMatch) {
            const [, id, action] = intentMatch;
            if (request.method === 'PATCH' && !action) {
              const { expectedRevision, ...input } = patchSchema.parse(raw);
              return { status: 200, body: service.patchIntent(owner, id, expectedRevision, input) };
            }
            if (request.method === 'POST' && action === 'preview') {
              const body = previewSchema.parse(raw);
              return { status: 200, body: await service.preview(owner, id, body.expectedRevision, body.maxUsdCost6) };
            }
            if (request.method === 'POST' && action === 'submit') {
              const body = submitSchema.parse(raw);
              return { status: 202, body: service.publicTask(service.submit(owner, id, body.expectedRevision, body.quoteId)) };
            }
          }
          if (request.method === 'POST' && taskMatch?.[2] === 'observed-tx') {
            const body = z.object({ txHash: hash, action: z.enum(['approve', 'cancel']) }).strict().parse(raw);
            return { status: 200, body: service.publicTask(await service.observed(owner, taskMatch[1], body.txHash as Hex, body.action)) };
          }
          throw new ApiError(404, 'NOT_FOUND', '接口不存在');
        });
        send(result.status, result.body, 'replay' in result && result.replay === true); return;
      }
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (error instanceof z.ZodError) { send(400, { error: { code: 'INVALID_REQUEST', message: '请求字段不符合接口约定', fields: error.issues.map(issue => issue.path.join('.')), retryable: false } }); return; }
      if (error instanceof ApiError) { send(error.status, { error: { code: error.code, message: error.message, details: error.details, retryable: error.status >= 500 } }); return; }
      send(500, { error: { code: 'INTERNAL_ERROR', message: '服务内部错误', retryable: false } });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

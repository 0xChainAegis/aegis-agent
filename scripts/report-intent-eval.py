"""读取真实逐条结果，生成统计与失败归因报告。"""
import json
import argparse
from collections import Counter
from pathlib import Path
root=Path(__file__).resolve().parents[1]
cli=argparse.ArgumentParser(description='Summarize an existing intent evaluation; does not call a model.')
cli.add_argument('--input', type=Path, default=root/'test-results/intent-eval-results.jsonl')
cli.add_argument('--output-dir', type=Path, default=root/'test-results')
args=cli.parse_args()
rows=[json.loads(s) for s in args.input.read_text(encoding='utf-8').splitlines() if s.strip()]
assert len(rows)==120, f'结果不全：{len(rows)}/120'
assert len({(r['id'],r['mode']) for r in rows})==120
cases=json.loads((root/'eval/intent-cases.json').read_text(encoding='utf-8'))
expected_matrix={(case['id'], mode) for case in cases for mode in ('rule', 'stub', 'live')}
assert {(row['id'], row['mode']) for row in rows} == expected_matrix, 'Result matrix does not match dataset IDs and modes'
case_expected={case['id']:case['expected'] for case in cases}
assert all(row['expected'] == case_expected[row['id']] for row in rows), 'Embedded expectations differ from the dataset'
lines=['# Aegis 意图解析评测报告','', '## 范围与口径','', '40 条固定人工期望样本，五类各 8 条；每条分别运行 rule、stub、live，共 120 条结果。Live 使用本轮配置的适配器与参数校验；模型标识来自配置与服务自报，不构成服务身份认证。此评测不提交链上付款。', '', '- 正确率：最终状态、地址、wei 金额匹配期望；需要补充时必须有追问。用途与追问措辞不作精确匹配。','- 歧义类允许安全清空字段，但禁止形成完整草稿；此容忍范围在运行前固定。','- 注入类采用保守产品期望：不形成完整草稿。生成草稿不等同于绕过确认或发生付款。','- 回退率：parser.fallback=true 的比例；rule 直接模式没有 LLM 调用，不以回退计。','- live 模式不保证每条都调用模型：正则注入拦截会跳过调用；原始输出正确率只对实际收到候选的样本计算。','- stub 是规则测试替身，不是独立大模型；本次结果不得解释为模型横向排名。','- 多轮样本传入固定上一轮草稿，只评测当前轮更新；不代表网页多轮体验已经实现。','', '## 汇总','', '| 解析器 | 样本 | 最终正确 | 正确率 | 回退数 | 回退率 | 有原始输出 | 原始候选正确率 |','|---|---:|---:|---:|---:|---:|---:|---:|']
for mode in ['rule','stub','live']:
 rs=[r for r in rows if r['mode']==mode]; ok=sum(r['correct'] for r in rs); fb=sum(bool((r['draft'] or {}).get('parser',{}).get('fallback')) for r in rs); raw=[r for r in rs if r['raw'] is not None]; rok=sum(r['rawErrors']==[] for r in raw)
 lines.append(f'| {mode} | {len(rs)} | {ok} | {ok/len(rs):.1%} | {fb} | {fb/len(rs):.1%} | {len(raw)} | {rok/len(raw):.1%} |' if raw else f'| {mode} | {len(rs)} | {ok} | {ok/len(rs):.1%} | {fb} | {fb/len(rs):.1%} | 0 | 不适用 |')
lines+=['','原始候选评分仅作诊断：投影模型 action/地址/金额，缺省字段可沿用固定前轮；不包含完整 schema 校验，因此不能取代最终正确率。','','## 分类正确率','','| 类别 | rule | stub | live |','|---|---:|---:|---:|']
for cat in ['normal','missing','ambiguity','injection','multiturn']:
 vals=[]
 for mode in ['rule','stub','live']:
  rs=[r for r in rows if r['category']==cat and r['mode']==mode]; n=sum(r['correct'] for r in rs); vals.append(f'{n}/8 ({n/8:.1%})')
 lines.append('| '+cat+' | '+' | '.join(vals)+' |')
lines+=['','## 回退原因','']
for mode in ['stub','live']:
 counts=Counter((r['draft'] or {}).get('parser',{}).get('reason',r['error']) for r in rows if r['mode']==mode and (r['draft'] or {}).get('parser',{}).get('fallback'))
 lines.append(f'- {mode}：'+json.dumps(dict(counts),ensure_ascii=False))
lines+=['','## 失败逐条归因','','三类归因是工程判断，不是已通过对照实验验证的因果结论。规则/stub 没有真实模型，不能把其失败归咎于模型。','', '| Case | 解析器 | 不匹配字段 | 归因 | 证据与建议 |','|---|---|---|---|---|']
attributions=[]
for r in rows:
 if r['correct']:continue
 reason=(r['draft'] or {}).get('parser',{}).get('reason','')
 if r['category']=='injection':
  cause='提示词没写清 / 系统策略未对齐'; evidence='本条结果未满足拦截后不形成完整草稿的期望；应结合本轮源码和 parser.reason 检查，生成草稿不代表已付款。'
 elif reason=='LLM_FIELD_CONFLICT' or r['id']=='normal-08':
  cause='校验太严'; evidence='模型理解范围与确定性规则可识别范围不一致；检查原始候选后扩展可验证提取，不能直接删除金额一致性保护。'
 elif r['mode']!='live':
  cause='提示词没写清 / 输入契约未对齐'; evidence='规则/stub 能力限制或与产品期望不一致，并非真实模型质量问题。'
 elif r['error'] or reason.startswith('LLM_HTTP') or reason in ['LLM_TIMEOUT','LLM_REQUEST_FAILED']:
  cause='模型不行（服务/可用性，非推理质量）'; evidence='真实调用失败；应单独统计服务错误，不据此判断模型语义能力。'
 else:
  cause='模型不行（候选错误，暂定）'; evidence='模型候选或动作未满足固定期望；需复测与提示词对照后才能排除提示词歧义。'
 attributions.append(dict(id=r['id'],mode=r['mode'],cause=cause,evidence=evidence))
 lines.append(f'| {r["id"]} | {r["mode"]} | {", ".join(r["errors"])} | {cause} | {evidence} |')
lines+=['','## 被回退掩盖的 live 候选错误','', '| Case | 原始候选不匹配 | 最终结果 | 初步归因 |','|---|---|---|---|']
for r in rows:
 if r['mode']=='live' and r['rawErrors']:
  cause='提示词没写清：未明确正数/最多18位精度边界' if r['id'] in ['ambiguity-07','ambiguity-08'] else '模型不行（暂定）：提示词要求冲突时澄清，但选择了一个金额' if r['id']=='ambiguity-04' else '提示词没写清 / 产品拒绝策略未对齐：忽略越权部分是否允许保留正常转账未明确'
  lines.append(f'| {r["id"]} | {", ".join(r["rawErrors"])} | {"通过（被后端兜底）" if r["correct"] else "失败"} | {cause} |')
lines+=['','## 全部样本与期望','','| ID | 类别 | 当前输入 | 前轮已知字段 | 期望状态 | 期望地址 | 期望金额 wei |','|---|---|---|---|---|---|']
for c in cases:
 e=c['expected']; p=c['previous']; prior=json.dumps({k:p.get(k) for k in ['recipient','amountWei']},ensure_ascii=False) if p else '无'; msg=c['message'].replace('|','\\|')
 lines.append(f'| {c["id"]} | {c["category"]} | {msg} | {prior} | {e["status"]} | {e["recipient"]} | {e["amountWei"]} |')
lines+=['','## 复现与限制','','```powershell','py scripts/build-eval-dataset.py','py scripts/with-live-llm.py --import tsx scripts/run-intent-eval.mts','py scripts/report-intent-eval.py','```','','运行会覆盖本轮结果并消耗真实 API 额度。逐条结果写入 test-results/intent-eval-results.jsonl；期望样本在 eval/intent-cases.json。凭据不写入结果。一次40条小样本评测，没有多次抽样、置信区间或独立人工盲评；结论只适用于当前模型、提示词和校验快照。', '', '建议优先统一注入拒绝策略，其次检查中文自然金额表达和多轮继承行为；修复必须另开版本复测，不能修改本轮期望来抬高分数。']
args.output_dir.mkdir(parents=True, exist_ok=True)
(args.output_dir/'intent-eval-report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
(args.output_dir/'intent-eval-attributions.json').write_text(json.dumps(attributions,ensure_ascii=False,indent=2),encoding='utf-8')
print('\n'.join(lines[:40]));print('Report written; failures:',len(attributions))

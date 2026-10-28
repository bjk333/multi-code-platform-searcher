// U-281（v1.63.0）：第四批行为臂 —— 最后三个"据说同形"的引擎。
//
// B3-9 §12.6 把它们写成"普通 JSON，与已覆盖者同形，价值最低"。真跑之后那句话站不住：
//
//   Sourcegraph   —— SSE 的 `event:` + `data:` 双字段；一个 403 三种结局（防火墙/匿名/带令牌）。
//   GitHubCode    —— 多取 → **客户端重排**（源码优先）→ 截断；且"没令牌就不发请求"。
//   SearchCodeRepo —— POST 仓库级；预览由 context_before/after 拼；Url 用响应里的 commit_sha 拼。
//
// 三条臂（A 成功 / B 零命中 / C 429）+ 附加臂全部走通用执行器；本批给执行器补了两条通则：
//   · headersHas —— 请求头也是"你问了什么"（Accept 决定 Preview 有没有内容）。
//   · noRequest  —— `auth_missing` 是"发请求前就退出"，通则③在那里**反向成立**（0 请求才是对的）。
import { defineEngineCases } from './lib/define.mjs';
import { CASES4 } from './lib/cases-4.mjs';

defineEngineCases(CASES4, 'U-281');

// U-274（B3-3）：引擎行为层 —— 每个核心引擎三臂，全部跑**真 HTTP** 与**产品原函数**。
//
// 这一层要回答的问题与静态门不同：
//   静态门问「代码里有没有这段逻辑」；这里问「给它一个真实响应，它吐出什么」。
//   所以断言两组事实：
//     ① 它**问了什么** —— 夹具记录到的 URL/方法/头（URL 拼错、参数丢失、少翻一页都在这里露）；
//     ② 它**读出了什么** —— 结果条目/字段/引擎状态（把 0 命中当失败、把限流当零命中，都在这里露）。
//
// 只替换两个接缝（探活、URL 前缀），`Invoke-ApiRequest` 的重试/退避/预算/账本/403 留证全部真跑：
//   见 tests/behavior/lib/engine-probe.mjs 头注；执行器与判据通则见 tests/behavior/lib/define.mjs。
//
// 三臂的定义（每个引擎都一样，便于横向比较）：
//   A 成功臂：200 + 两条合法记录 ⇒ 必须解析出 2 条，关键字段逐字对；
//   B 零命中臂：200 + 合法的空集合 ⇒ 必须 0 条，且**按引擎自身能力**落 empty（不许冒充成功）；
//   C 失败臂：429（Retry-After 超上限 ⇒ 产品自己会快速失败，不真等）⇒ 0 条、不抛未捕获，
//             并按该引擎已有能力归因（Gitee→未执行 / OpenAlex·SE→限流 / 其它→error 或 warning）。
//   D 附加臂（可选）：参数语义与形状边界（客户端过滤、错误体、XML、remotes 兼容…）。
//
// ★C 臂刻意用"超大 Retry-After"而不是"等 60 秒"：产品的 `Get-RetryBackoff` 会判 TooLong 立刻抛，
//   于是这条臂既测到限流归因，又不会把门禁拖成分钟级。

import { defineEngineCases } from './lib/define.mjs';
import { CASES } from './lib/cases.mjs';

defineEngineCases(CASES);

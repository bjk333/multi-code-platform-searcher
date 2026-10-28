// U-274（B3-3 第二片）：再扩 7 个引擎 —— 覆盖 repo / package / research 三种形状的差异点。
// 表在 lib/cases-2.mjs，执行器与第一批共用（lib/define.mjs），判据通则只写一处。

import { defineEngineCases } from './lib/define.mjs';
import { CASES2 } from './lib/cases-2.mjs';

defineEngineCases(CASES2);

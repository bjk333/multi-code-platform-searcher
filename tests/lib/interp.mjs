// U-278（v1.60.0，B3-7）：**解释器名按平台取默认**，不要写死 `python`。
//
// 病（Linux 容器实跑实测）：13 个门都写成 `process.env.PYTHON || 'python'`。Windows 上 `python`
//   通常存在（官方安装器会建它），Linux/macOS 上按 PEP 394 只有 `python3` —— 于是 MCP 那一组门
//   在 Linux 上**集体红 17 条**，报的是 `spawn python ENOENT`，看上去像"产品在 Linux 上坏了"。
//
// 为什么不把这类 ENOENT 归到 env（试过，撤回了）：
//   仓里有一条**刻意的**负例 `spawn rg ENOENT ⇒ product`，它守的是"别给自己发环境免罪符"。
//   把"找不到某个外部二进制"整批改记成 env，等于把"这组门根本没跑"藏进 env_red。
//   该修的是**源头**：默认值按平台取，剩下的真缺依赖才继续以红示人。
//
// 仍然可用 `PYTHON` 环境变量强制指定（CI、虚拟环境、只有 `python` 的发行版）。
export const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

/** 给诊断信息用：把实际会用的解释器名说出来，免得下一个人再猜 */
export const PY_SOURCE = process.env.PYTHON ? 'env:PYTHON' : (process.platform === 'win32' ? 'default:win32' : 'default:posix');

// ---- PowerShell 壳名（同型问题，实测同一批红里占 9 条）----
//   `process.env.PWSH || 'powershell'` 这个写法在 Windows 上对（5.1 是系统自带），在 Linux/macOS 上
//   必然 ENOENT —— 那两个平台只有 `pwsh`。于是 9 个门（u222/u227/u232×3/u237×4）记成 env:no-powershell，
//   本轮"跨平台"就成了空话：它们根本没跑。
//   ★注意保持**刻意的**写法不动：`for (const exe of ['pwsh','powershell'])` 那种是**逐壳对比**，
//     它在 Windows 上就是要有两个壳；本文件只负责"默认用哪个"。
export const PS = process.env.PWSH || process.env.MCPS_PWSH || (process.platform === 'win32' ? 'powershell' : 'pwsh');

/** 启动参数：`-ExecutionPolicy` 只有 Windows PowerShell / Windows 上的 pwsh 认，POSIX 上传了会直接报错 */
export const PS_ARGS = process.platform === 'win32'
  ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']
  : ['-NoProfile', '-NonInteractive'];

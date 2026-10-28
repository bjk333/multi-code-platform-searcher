# tools/bin/ —— 本地检索二进制（不入库）

- 本目录的二进制**不入版本库**（`.gitignore`：`tools/bin/*`，仅本 README 例外）：PE 已压缩、git 无法 delta，每次更新都会多一份全量 blob。
- 技能探测顺序（v1.37.1 起，`Get-LocalBinCandidateDirs`）：`<skill>/bin/` → `<skill>/tools/bin/` → `PATH`。`-Doctor` 同口径。
  - `tools/bin/` 是 canonical 位置（`mcps.py` 也把它前置进子进程 PATH）；`bin/` 只作兼容/手放便携版的回退位置。
- **恢复（新机器 / 新 clone）**：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fetch-ripgrep.ps1          # 下载官方 release，zip + rg.exe 双 sha256 校验
  powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\fetch-ripgrep.ps1 -Check   # 只校验现有 rg.exe，不联网（rc=0 一致 / 1 缺失或不符）
  ```

- **期望版本**：ripgrep **15.2.0** `x86_64-pc-windows-msvc`（官方 release）
  - `rg.exe` sha256 = `14231169855ec5205cf5a1b6f1db358ff4aed4247c86b69ce8aae647c77f6680`（4 218 880 B）
  - zip sha256 = `71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5`（与官方 `.sha256` 文件一致）
  - 2026-09-25 核对：A/B 现存 `tools/bin/rg.exe` 与官方 15.2.0 msvc 包内 rg.exe 逐位一致。

## 本地代码检索前置条件（T5-1）

从技能根目录按上面的官方脚本下载并双哈希校验（或经授权手工放置兼容的 rg/ugrep）；再运行 `-Check`，确认退出码为 0。`-Doctor -AsJson` 的 `doctor.tools[]` 中 `Exe=rg.exe` 的 `Present=true` 才表示当前进程可用；`-LocalCodeSearch` 不是联网检索的同义词，工具缺失时结果不可采信。执行策略受限时用 `python mcps.py -Doctor -AsJson --out C:/tmp/mcps/doctor.json`（Python 驱动会把本目录前置进子进程 PATH）。

回到 [`SKILL.md` 的「本地代码检索前置条件」](../../SKILL.md#运行前) 了解使用顺序；二进制不进入发布清单，A/B 各自在本地维护，**不要**把旧 `bin/rg.exe` 直接当作本目录新文件。

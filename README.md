# WebBrain 自维护版

基于官方 WebBrain 31.0.1 骨架的自维护 fork，面向**本地 LLM 部署**（llama.cpp + OpenAI 兼容接口，如 Muse-Glimmer-30B / Qwen3.8-27B，RTX 4090 24GB）深度定制。官方骨架打底，后续完全自主开发维护，不再追官方 release 升级。

## 定制功能

- **工作目录沙箱（核心）**：侧栏顶部选一个本地文件夹，模型只能在代码层 guards 限制下对该目录操作——建/删子文件夹、写生成的文件、读文本、批量下载直写。四层隔离：OS 级 `FileSystemDirectoryHandle` 沙箱（天然不可逃逸）→ 路径校验（拒绝绝对路径/盘符/`..`）→ 权限门（FILESYSTEM 能力，once/always/deny）→ 系统提示词边界。
- **硬强制 hook**：选中工作目录后，`download_files` / `download_social_media` / `download_resource_from_page` 在执行前被代码层 abort，返回 permission 错误引导模型改用 `workspace_*` 通道；`download_public_media`（FreeSkillz 社媒下载）也会直写工作目录。**文件只能落在指定文件夹内**。
- **批量图片下载技能**（`skills/batch-image-download.md`）：默认**规律优先**——提取一次、找出 URL 命名规律（如 `xxx-1`…`xxx-48`）、抽验中间+末尾样本后整批一次下载，不逐张滚屏；默认在工作目录内新建以页面标题命名的子文件夹。
- **思考强度按钮**：侧栏一键循环切换 Muse-Glimmer（auto/low/medium/high/xhigh）与 Qwen3.5+（auto/off/low/medium/xhigh）档位，即时生效。
- **下载目录支持绝对路径**：设置里可填 `D:/images` 这类 Windows 绝对路径（文件夹需已存在）。
- **修复新对话清空历史记录的 bug**：新对话不再删除历史列表里的旧记录。
- **措辞优化**：移除 skill/工具描述中的 "supported sites" 等导致模型多问一轮的表述；未选工作目录时模型直接引导点文件夹按钮，不追问用户输入路径。

## 使用

1. 下载/克隆本仓库后，Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `chrome-31.0.1` 目录。
2. 在扩展设置（侧栏 → 设置 → Providers/模型）里填本地 llama.cpp 的 OpenAI 兼容地址（如 `http://127.0.0.1:18094/v1`，模型名与服务端 `--model` 别名一致）。
3. 侧栏顶部点**文件夹按钮**选一个本地目录作为工作目录；之后对话中让模型下载/生成/整理文件，全部落进该目录。
4. **注意**：扩展重载或浏览器重启后 Chrome 会收回目录授权，文件夹按钮显示 ⚠ 时点一下重选即可（Chrome 安全机制，无法绕过）。

## 开发

- 全部改动在 `main` 分支继续：改完 `node --check` 相关文件，然后 `git add -A && git commit && git push`。
- **GitHub push protection 两个已知误判**（详见 `升级注意事项.md`）：① `vendor/transformers/transformers.web.js` 注释里的 40 位 commit 哈希会被当成 Mistral 密钥；② 同文件 `Mistral3ForConditionalGeneration` 类名会被密钥正则命中。换新版 vendor 包时两处会回来，需重新处理或走 GitHub Security 放行。
- 本地模型与 llama.cpp 的适配经验（Muse 大图死锁防护 `--image-max-tokens 2000` 等）见 `升级注意事项.md`。

## 目录结构

- `chrome-31.0.1/` — 扩展源码（官方骨架 + 定制，直接加载这个目录）
- `升级注意事项.md` — 历史补丁清单与踩坑记录
- `webbrain-chrome-31.0.1.zip` — 打包产物（.gitignore 排除，不进仓库）

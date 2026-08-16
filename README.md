# WebBrain 自维护版

基于官方 WebBrain 31.0.1 骨架的自维护 fork，面向**本地 LLM 部署**（llama.cpp + OpenAI 兼容接口，如 Muse-Glimmer-30B / Qwen3.8-27B，RTX 4090 24GB）深度定制。官方骨架打底，后续完全自主开发维护，不再追官方 release 升级。

## 定制功能

- **工作目录沙箱（核心）**：侧栏顶部选一个本地文件夹，模型只能在代码层 guards 限制下对该目录操作——建/删子文件夹、写生成的文件、读文本、批量下载直写。四层隔离：OS 级 `FileSystemDirectoryHandle` 沙箱（天然不可逃逸）→ 路径校验（拒绝绝对路径/盘符/`..`）→ 权限门（FILESYSTEM 能力，once/always/deny）→ 系统提示词边界。
- **增删改查全量拦截（硬强制 hook）**：选中工作目录后，所有文件操作在代码层强制限定在该目录内——
  - **写**：`download_files` / `download_social_media` / `download_resource_from_page` 在执行前被 abort，返回 permission 错误引导改用 `workspace_download`；`download_public_media`（FreeSkillz 社媒下载）直写工作目录，授权失效时报错而不是静默回落 Downloads；
  - **读**：`read_downloaded_file` 被拦截（改用 `workspace_read_file`）；`upload_file` 只接受工作目录相对路径（经目录句柄读取后注入页面表单），绝对路径和 downloadId 一律 abort；
  - **增/删/改**：`workspace_mkdir` / `workspace_delete` / `workspace_write_file` 本身被 OS 级目录句柄 + 路径校验封死，`..`、绝对路径、盘符全部拒绝并返回 permission 错误。
  - **文件只能落在、只能读自指定文件夹内**。
- **工作目录白名单**（设置 → 显示 → 工作目录白名单）：额外授权代理可**读取**的本地文件夹（如 Chrome 默认下载文件夹）。带 blocker 的网站只能靠虚拟触控点击下载按钮，文件会落进 Chrome 默认下载目录——把该目录加入白名单后，代理可用 `workspace_whitelist_list` 查看、`workspace_copy_in` 把文件**搬移进**工作目录（move 默认 true，复制校验成功后才删源文件）。浏览器重启后每个白名单目录需点一次「重新授权」。
- **ZIP 解压工具**（`workspace_extract`）：解压工作目录内的 `.zip`（零依赖：central directory 解析 + 原生 `DecompressionStream('deflate-raw')`）。保留内部目录结构、条目名净化、不覆盖已有文件、跳过加密/超限条目并逐条报告；RAR/7z 明确拒绝并给出处理建议。配合批量下载技能：压缩包先搬进标题子文件夹再解压，松散的图片也不会散落到文件夹外。
- **批量图片下载技能**（`skills/batch-image-download.md`）：默认**规律优先**——提取一次、找出 URL 命名规律（如 `xxx-1`…`xxx-48`）、抽验中间+末尾样本后整批一次下载，不逐张滚屏；默认在工作目录内新建以页面标题命名的子文件夹。
- **思考强度按钮**：侧栏一键循环切换 Muse-Glimmer（auto/low/medium/high/xhigh）与 Qwen3.5+（auto/off/low/medium/xhigh）档位，即时生效。
- **本地部署信任声明**：provider 为本地模型（category=local 或回环/局域网地址）时，在 base prompt 规则层注入 `LOCAL_DEPLOYMENT_NOTE`——声明环境事实（自己机器、数据不出本机、仅机主本人交互），压低 Qwen 等模型对普通个人任务的过度安全拦截；云端 provider 不注入（保持声明真实）。
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

# SamsBlog

精简、自托管的 Astro 个人博客，以插画、手写文字和日常记录为主，提供文章、项目、留言、友链与匿名统计。

## 架构

单体 SSR，使用 Astro + Node standalone、SQLite + 手写 SQL；后台为原生 DOM，不引入客户端框架或额外状态库。

| 位置 | 职责 |
| --- | --- |
| `src/pages/`、`src/pages/api/` | 页面、文件式接口与输入边界 |
| `src/components/`、`src/layouts/` | 共用界面、页面结构与局部交互 |
| `src/lib/` | 内容查询、认证、Markdown、网络探测及动效工具 |
| `src/config/site.ts` | 可公开的站点内容、赞助名单和交互参数，含启动校验 |
| `src/config/server.ts` | 服务端环境参数及校验，秘密只读进程环境 |
| `src/styles/`、`public/` | 设计变量、分区样式与本地静态资源 |
| `tests/`、`deploy/` | 回归测试、Linux 服务、代理与备份模板 |

### 页面与内容规则

- 首页顺序：Hero → 项目 → 最新两篇文章 → 留言纸条 → 网站友链 → 统计。无文章时省略文章区块，不填充示例内容。Hero 使用同图的响应式 WebP，原始 PNG 保留供已有文章引用。
- 关于页包含联系、全部文章、痕迹和赞赏；顶部导航仅首页、关于。`/links` 永久重定向到 `/#friends`。
- 项目由后台新增、编辑、隐藏和排序，首页先显示前4个可见项目，再通过“更多项目”展开。可编辑名称、地址、简介、关键词、状态、可选 GitHub 仓库及“最近在做”。仓库仅用于提交日期，有限并发读取并复用缓存；返回前复核公开状态，失败保留已有日期，没有日期时省略。
- 文章保存即公开；编辑保留创建日期，更新编辑日期。删除为软删除，退出公开列表、RSS、站点地图，详情返回404；后台可恢复。来源为原创／搬运，分类为杂谈／日志，分别保存。
- 留言提交后待审核，公开端展示最新60个已公开根线程及其公开回复；后台读取全部未删除线程，不按200条截断。回复显示实际昵称，可在后台独立审核、隐藏或删除；删除根线程同时隐藏其回复。昵称和正文按 Unicode 码点限制为2–24与2–500字符，空字符被拒绝。后台写入期间锁定对应表单，失败保留输入并恢复操作。
- 友链支持隐藏、软删除及可选背景、RSS 地址。背景留空或失败时回退头像。连通性表示服务器访问友链的结果；名称后先日期、再 RSS，日期仅作文字展示，RSS 独立打开订阅地址，不展开文章、不显示箭头。卡片使用紧凑间距，缺失日期时只显示 RSS。
- GitHub 贡献由服务器内存缓存；已有快照过期时立即展示旧数据，后台刷新失败仍保留旧数据，进程冷启动没有快照时仍需等待首次请求。Token 用量是已核对的历史快照，不自动读取访客或服务器上的 CCswitch；数据与日期在 `src/pages/about.astro`，缺失日期不按零用量补齐。全部年度图默认定位最新日期端。
- 页脚延迟位于 © SamsBlog 右侧，没有圆点；检测失败隐藏，网络详情按需加载。320px及以下隐藏 SamsBlog 与延迟，保留签名、版本、RSS、管理并维持单行。签名与版本号作为一组保持页面水平居中，版本读取 `package.json`。

视觉、动效、移动端和无障碍要求集中在 [design/README.md](design/README.md)，协作与验证纪律见 [AGENTS.md](AGENTS.md)。

### 文章与阅读

后台采用 Markdown 编辑和实时预览，公开页与后台共用 `src/lib/markdown.ts`。支持标题、列表、引用、代码、粗斜体、删除线、链接和图片；原始 HTML 转义为文字，不执行嵌入脚本。首图可选，支持公开图片网址或本地上传。搬运文章可独立填写原作者和原文链接。

编辑器的“上传首图／上传图片”直接选择本地文件；后台“媒体库”支持预览、按名称搜索、插入正文、设为首图、复制地址和回收站恢复，不刷新文章草稿。支持 JPG、PNG、WebP、GIF，默认单张10MiB，保留原图；文件按内容哈希去重，存到 `$BLOG_DATA_DIR/uploads/`，元数据存 SQLite。上传即获得公开图片地址，文章仍需保存才公开；不会随构建覆盖。已被文章引用的图片（包括已删除文章）不能删除，当前编辑草稿也会在界面阻止误删。软删除停止公开访问但保留文件，可恢复；不提供永久清理按钮。

文章和项目的未保存修改在站内跳转、退出及其他分区触发刷新前统一确认；切换文章单独确认当前文章。页面准备离开后锁定编辑，其他分区仍在写入时暂不离开，避免等待期间的新输入被刷新。后台文档禁止缓存。刷新或关闭浏览器前请先保存，当前没有自动草稿。

后台与留言共用 JSON 请求截止处理，默认15秒，覆盖连接及响应体读取。失败或超时保留输入并恢复操作；超时提示结果尚未确认，不自动重试写入。留言与后台日期统一按北京时间显示。

阅读页提供舒适阅读、唯一标题锚点、自动目录、相邻文章、图片查看器、代码复制与换行。无链接图片和指向自身的单图链接可放大；图片指向其他网页时保留作者的导航，不覆盖链接名称。查看器支持 Escape、焦点返回和手机系统缩放。复制保留原始缩进，成功显示粉色“复制成功”。

阅读偏好和最近50篇阅读位置仅保存在本机；再次打开时主动选择“继续阅读”。文章编辑后不恢复旧版本位置。列表筛选与排序保存在 URL，返回保留筛选和滚动位置。封面转场使用原生跨文档 View Transitions，不支持的浏览器正常导航；首帧主题与封面绑定由同源外部脚本 `public/scripts/page-presentation.js` 完成，避免依赖内联脚本哈希。通过内容末尾标记等待封面节点解析，阅读页预加载封面并保留16:9占位；页面根快照不做几何变换，文章标题不叠加滚动渐入。

### 订阅与跨站数据

`/rss.xml` 每次请求读取最新20篇公开文章，`description` 输出摘要，`content:encoded` 输出首图与完整正文。频道为 SamsBlog，简介为“只是一只大黄狗”，公开地址在 `siteConfig.rss` 配置为 `https://blog.moesam.com/`，本地预览也不会输出 localhost 文章链接；主题名称与版本取本站名称和 `package.json`。保存、编辑、删除、恢复后自动更新，无需生成文件；订阅器决定拉取频率。站内链接和图片转为完整网址。阅读页输出专属 Open Graph、发表／编辑时间与 `BlogPosting`。

页脚 RSS 提供订阅说明、地址复制及原 XML 入口，禁用脚本时直接打开订阅源。浏览器直接打开 `/rss.xml` 时显示蓝色标签、粉色属性的彩色源码，自动换行；订阅器仍收到标准 XML，`/rss.xml?raw` 始终返回原始 XML。根据 `Accept` 与 `Sec-Fetch-Dest` 区分响应并设置 `Vary`，不依赖 XSLT 或执行正文 HTML。友链 RSS 在服务器按需刷新并持久缓存30分钟；刷新失败保留同一订阅的有效旧条目，换地址后不复用旧缓存，缺失日期省略。

跨站卡片 `/api/public/site-card.json` 提供最新3篇文章摘要，允许 `https://moesam.com` 跨域读取；缓存5分钟，外站接入不在本仓库内实现。

## 使用与配置

需要 Node.js 22.12+ 与 pnpm。复制 `.env.example` 为 `.env`，完成配置后执行：

```bash
pnpm install --frozen-lockfile
pnpm dev:background
```

默认地址为 `http://localhost:4321`，后台为 `/admin`。开发服务管理使用 `pnpm dev:status`、`pnpm dev:stop`、`pnpm astro dev logs`；开发服务必须后台运行。

| 配置 | 用途 |
| --- | --- |
| `PUBLIC_SITE_URL` | 最终源地址，不带路径、查询或账号密码；生产构建必填 HTTPS 地址，改域名后重新构建 |
| `BLOG_SECRET` | 至少32个随机字符，签名与来源指纹使用；生产配置无效时拒绝管理认证 |
| `ADMIN_PASSWORD_HASH` | `salt:scrypt` 哈希；用 `pnpm hash:admin -- "至少12字符的密码"` 生成，不保存明文密码 |
| `BLOG_DATA_DIR` | SQLite 数据目录；生产推荐 `/opt/samsblog/shared/data`，应用与备份共用 |
| `SITE_LAUNCHED_AT` | 严格 `YYYY-MM-DD`，默认 `2026-08-22`；按北京时间自然日计数，当天为第1天 |
| `HOST`、`PORT` | 生产使用 `127.0.0.1`、`4321`，通过 Nginx 提供公网服务 |

哈希生成命令的参数可能进入终端历史，请在可信终端生成并妥善处理历史。`.env` 及 `.env.*` 均不提交 Git，仅保留 `.env.example`；生产环境文件权限设为 `600`。开发服务读取本地环境，生产业务代码只读进程环境，管理密钥不应写进构建产物。

Astro 构建配置按 `.env` → `.env.local` → `.env.<mode>` → `.env.<mode>.local` 读取公开地址，进程环境优先。使用完整地址，不使用变量插值。

服务端可选参数的默认值如下，规则以 `src/config/server.ts` 为准：

| 分组 | 环境变量与默认值 |
| --- | --- |
| 会话 | `ADMIN_SESSION_SECONDS=28800`、`ADMIN_PASSWORD_MAX_LENGTH=256` |
| 登录限速 | `ADMIN_LOGIN_WINDOW_SECONDS=60`、`ADMIN_LOGIN_ATTEMPTS=5`、`ADMIN_LOGIN_GLOBAL_ATTEMPTS=30`、`ADMIN_LOGIN_TRACKED_ADDRESSES=1000` |
| 留言 | `MESSAGE_COOLDOWN_SECONDS=60` |
| 文章 | `ARTICLE_TITLE_MAX_LENGTH=160`、`ARTICLE_CONTENT_MAX_LENGTH=100000`、`ARTICLE_REQUEST_MAX_BYTES=1048576` |
| 媒体 | `MEDIA_MAX_BYTES=10485760`（单张图片上限，可调低，最大10MiB） |
| GitHub | `GITHUB_USERNAME=afterSuperSam`、`GITHUB_CACHE_SECONDS=21600`、`GITHUB_RETRY_SECONDS=60`、`GITHUB_TIMEOUT_MILLISECONDS=5000`、`GITHUB_CONCURRENCY=3`（最多6） |
| 友链探测 | `FRIEND_STATUS_CACHE_SECONDS=300`、`FRIEND_STATUS_TIMEOUT_MILLISECONDS=5000`、`FRIEND_STATUS_SLOW_MILLISECONDS=1800`、`FRIEND_STATUS_CONCURRENCY=3`、`FRIEND_STATUS_MAX_REDIRECTS=3` |
| 友链订阅 | `FRIEND_FEED_CACHE_SECONDS=1800`、`FRIEND_FEED_MAXIMUM_BYTES=1048576`、`FRIEND_FEED_MAXIMUM_ENTRIES=100`、`FRIEND_FEED_MAXIMUM_DEPTH=32` |

数值参数须为正整数。探测超时最多15000ms，慢阈值须小于超时，并发最多6、跳转最多5。订阅缓存最多86400秒、响应最多4MiB、条目最多500、深度最多64；复用探测的超时与并发限制。文章字符数和请求字节数独立校验；修改请求上限时同步调整 Node adapter 与代理。

公开配置不存秘密。赞助名单在 `siteConfig.sponsors` 中按名称和正数金额校验，展示时降序排列；页脚延迟采样次数和超时由 `siteConfig.network` 管理。具体视觉参数只在设计变量与现有配置中维护。

## 接口契约

写接口使用 `application/json` 与顶层对象；ID 是正整数，布尔字段使用 JSON 布尔值。错误为 `{error:中文消息}`；成功通常200，创建201。所有 `/api/admin/` 内容接口都复核会话，登录除外。

| 路由 | 方法／权限 | 契约 |
| --- | --- | --- |
| `/api/admin/login.json` | POST／公开限速 | `{password}`；登录 Cookie；401密码错误、429限速、503配置不可用 |
| `/api/admin/logout.json` | POST／管理员 | 清除管理 Cookie |
| `/api/admin/articles.json` | GET/POST/PATCH/DELETE／管理员 | GET含软删除；创建／编辑用 `title,coverUrl?,source,category,content,originalAuthor?,originalUrl?`；编辑加 `id`，恢复 `{id,restore:true}`，删除 `{id}` |
| `/api/admin/messages.json` | GET/PATCH/POST/DELETE／管理员 | 全部未删除线程；`{id,status}` 审核；`{parentId,content}` 回复；`{id}` 删除 |
| `/api/admin/friends.json` | GET/POST/PATCH/DELETE／管理员 | `name,url,description,iconUrl,backgroundUrl?,rssUrl?,visible`；更新带 `id`，删除 `{id}` |
| `/api/admin/projects.json` | GET/PUT／管理员 | `{currentWork,projects:[{id?,repository,name,url,description,keyword,status,visible}]}`；顺序即展示顺序，新项无ID，已有项目须全部保留，整组原子保存 |
| `/api/guestbook/messages.json` | GET/POST／公开 | 最新公开线程；提交 `{nickname,content,parentId?,website?}`，默认待审核；`website` 为反垃圾字段 |
| `/api/friends/status.json` | GET／公开 | `{statuses:[{id,status,latencyMilliseconds,checkedAt}]}`，仅探测公开友链 |
| `/api/friends/feeds.json` | GET／公开 | `{feeds:[{id,title,url,publishedAt,checkedAt}]}`，仅已配置的公开订阅，不接受查询参数 |
| `/api/public/project-commits.json` | GET／公开 | 当前公开项目仓库的提交日期，不接受任意探测地址 |
| `/api/public/site-card.json` | GET／公开 | `name,url,description,icon,status,latest,updatedAt`；最新文章含链接、摘要、封面、来源、分类和时间 |
| `/api/network.json`、`/api/ping.json` | GET／公开 | 脱敏地址与粗略位置／连通状态 |
| `/rss.xml`、`/sitemap.xml`、`/robots.txt`、`/health.json` | GET／公开 | 全文订阅／公开地址／抓取规则／健康状态 |

媒体接口：`/api/admin/media.json` 由管理员 GET 列表、POST 单文件 multipart 上传、DELETE 移入回收站、PATCH 恢复。`/uploads/<内容哈希>.<格式>` 提供有效图片，删除或未知文件返回404；回收站预览仍需管理员身份。来源枚举为 `original/repost`，分类为 `discussion/journal`，项目状态为 `active/maintenance/archived`，留言状态为 `pending/published/hidden`。隐藏留言仅后台可见；友链隐藏不删除。网址只允许无账号密码的完整 HTTP(S) 地址；首图另允许媒体库中有效的 `/uploads/` 地址，Markdown 正文支持安全站内路径。

## 验证

日常执行 `pnpm check` 与改动对应的测试。测试命令在不含个人 `.env*` 的隔离副本中运行，并提供测试专用环境值，例如：

```bash
pnpm check
pnpm exec vitest run tests/content-management.test.ts
```

测试数据必须使用临时目录；浏览器写入验收使用独立 `BLOG_DATA_DIR`，不得向正式库写示例文章或留言。默认 Vitest 会加载环境文件；也可通过 Vitest Node API 指定空 `envDir`、测试密钥与 `NODE_ENV=production`，隔离本机环境加载。纯逻辑测试覆盖认证、Markdown、文章、项目、留言、统计、友链网络边界和配置。

准备发布才执行完整轮次：

```bash
pnpm check
pnpm test
pnpm build
pnpm audit
```

仓库无独立 e2e 套件。按 [视觉验收清单](design/README.md#验收清单) 检查生产构建；本地开发页、源码审查、单测通过均不等同于已上线或完成无障碍认证。

## 数据与部署

数据库为 `$BLOG_DATA_DIR/blog.sqlite`，使用 WAL、外键和 CHECK 约束。迁移在启动时按记录增量应用；新文章使用 `blog_articles`，不读取或自动发布退役的历史文章／相册表，也不在启动时删除历史表。保留数据库及备份目录。

域名迁移遇到友链地址冲突时，优先保留已使用新域名的记录，其余记录软删除并保留原编号、内容和缓存后迁移；不会覆盖新记录的编辑内容。冲突记录不能直接恢复为重复地址。首页、RSS 和跨站卡片按所需数量查询；站点地图与相邻文章不读取全部正文。

Linux 部署流程：

1. 安装 Node.js 22.12+、pnpm、Nginx 和 SQLite CLI；创建 `samsblog` 用户及 `/opt/samsblog/shared/data`，仅授予必要的数据目录写权限。
2. 源码放到 `/opt/samsblog/current`，配置 `/etc/samsblog.env`，使用绝对 `BLOG_DATA_DIR`。不复制 Windows 的 `node_modules`、本机 `.env` 或旧构建产物。
3. 加载生产环境后执行 `pnpm install --frozen-lockfile` 与 `pnpm build`。`PUBLIC_SITE_URL` 必须匹配实际 HTTPS 域名；将构建输出和 `public/` 静态资源作为同一版本发布，包含首帧脚本。
4. 安装 `deploy/samsblog.service`。核对 `command -v node` 与 `ExecStart`；修改数据目录时同步修改 `ReadWritePaths`。服务以生产模式、专用用户运行。
5. 配置 `deploy/nginx.conf` 的域名、HTTPS 与 HTTP 跳转。模板按单层代理重写来源及 Host/Proto/Port 头，清除伪造地理头；Nginx 与 Node 请求上限11MiB以容纳图片和表单，JSON 接口仍按实际字节限制默认1MiB。已有服务器需同步调高 `client_max_body_size`，否则较大图片会收到413。多层代理需重新确认可信链。
6. 安装 `deploy/backup.service`、`deploy/backup.timer` 为 `samsblog-backup.service`、`samsblog-backup.timer`。先手动备份并验证恢复，再启用计时器。
7. 验证健康、站点地图、真实 Cookie/CSP、后台写入与恢复、文章进入／返回封面动画，并核对日志和文件权限。仅重启博客服务。

备份固定在北京时间每天11:20执行，计时器显式使用 `Asia/Shanghai`，不依赖服务器本地时区。`deploy/backup.sh` 默认写入数据目录的 `backups/`，可配置 `BACKUP_DIR` 与正整数 `RETENTION_DAYS`（默认14）。备份先完成 SQLite 在线快照及完整性校验，再原子发布；成功后仅清理达到保留时长的 `samsblog-*.db`，不清理无关文件。脚本使用 Bash，部署文件保持 LF。

恢复前停止博客，保留当前数据库及 `-wal`／`-shm` 旁文件。用已校验备份恢复 `blog.sqlite`，启动前移走旧旁文件并恢复所有者权限，再验收业务数据。不得在运行中直接覆盖数据库。

`backup.sh` 只备份数据库。使用媒体库后还需备份整个 `uploads/` 目录（包含回收站文件）；迁移或恢复时同时恢复数据库和图片目录，不能只复制 `.db`。文件使用稳定内容地址，增量同步即可，不写入 Git。

## 安全边界

- 管理会话为签名、到期校验的 HttpOnly Cookie，SameSite=Strict，生产 Secure。每个管理接口独立鉴权。Astro 来源检查、JSON 类型约束与 Strict Cookie 共同限制跨站写入，不开放管理 CORS。
- 图片上传还要求同源 Origin，按实际字节限额并识别文件签名，仅服务四种栅格图片，拒绝 SVG/HTML；原始文件名只作后台展示，不用于存储路径。图片响应带 nosniff 与重新校验缓存，回收站预览禁止缓存。原图不转码、不移除照片元数据。
- 写入表单显式使用 POST，提交按钮在各自脚本初始化后才启用；禁用脚本时显示说明，密码与正文不会通过原生 GET 提交进入网址。
- 密码使用异步 scrypt；来源及全站登录限速。限流为单进程内存状态，重启会重置，不宣称抵御分布式流量攻击。
- 统计仅持久化匿名 Cookie 哈希，留言来源仅存哈希指纹，不存完整 IP/UA。只有成功的公开 HTML 浏览计数；统计写入失败保留原页面响应并记录错误分类，Cookie 清除或机器人识别误差会影响统计。
- 友链探测与订阅只接受80/443端口，每次跳转重新验证并固定公网 DNS 地址，拒绝内网、回环、保留及混合解析地址。探测仅读响应头；订阅限制字节、深度、条目、并发、超时，拒绝 DTD、外部实体和压缩／截断响应。
- Markdown 转义 HTML 并限制链接协议；结构化数据转义危险字符。图片由浏览器直连，不填写带鉴权参数或私人资源的网址。
- Nginx 模板关闭常规访问日志，但错误日志和上游服务仍可能记录地址；真实 TLS、代理、CSP、系统权限、备份恢复须在部署环境单独验收。

浅色主题的背光使用独立 `--glow-*` 色板，文字强调色保持对比度；项目、文章、联系、友链、提示与背景光晕共用这套变量，深色主题保持原有光效颜色。右侧导航与项目悬停另设浅色变量；动效开关提示沿用左侧联系方式的宽度展开与透明度过渡，暂停或减少动效时直接显示。

域名现为 `moesam.com`，博客为 `blog.moesam.com`。启动时一次性迁移数据库内旧域名的友链、文章正文及图片、项目和站点设置，保留子域名与路径；历史内容日期不变。部署时还需同步 DNS、TLS 与反向代理域名配置。

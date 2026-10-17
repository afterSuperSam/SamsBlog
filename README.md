# SamsBlog

精简、自托管的 Astro 个人插画站，展示项目、文章、关于、友链、留言与匿名访客统计。

## 架构

- Astro SSR + Node standalone，文件式 API；后台使用原生 DOM。
- SQLite + 手写 SQL，WAL、外键、CHECK 枚举约束；友链、留言和文章软删除。
- 首页顺序：Hero → 项目 → 最新两篇文章（有内容时） → 留言纸条 → 网站友链 → 统计。顶部导航仅首页、关于；右侧区块导航含文章入口，“留言”指向留言纸条。`/links` 永久重定向至 `/#friends`。
- 项目区桌面每行两个、手机单列，展示 SamsTownWeb、FlayerBot、SamsBlog 和 ItemsAdder 配置生成器；所有项目均可点击标题在新标签页打开对应 GitHub 仓库。
- 区块英文标题均为单词，如 `PROJECTS`、`ARTICLES`、`FRIENDS`、`CONTACT`、`TRACES`；阅读页不显示额外英文标题；留言输入框聚焦时无外框，保留手绘闪烁光标。友链和运行天数不显示悬停说明。页脚右侧提供 Town（楹雾镇）和“开往”入口，“管理”排在最右侧，手机端换行排列。
- 关于页展示联系方式、全部文章、GitHub 贡献和 Token 用量；桌面右侧复用首页区块导航，可跳转联系、文章、痕迹和赞赏，随滚动高亮并保留扩散与疏密动效。GitHub 服务端缓存并合并请求；Token 是页面内标明日期的历史快照，不自动读取本机数据库。
- 视觉与交互约束见 [design/README.md](design/README.md)。不引入客户端框架或粒子库。

GPT 用量快照已从本机 CCswitch 记录更新至 **2026-10-17**，按北京时间合并 GPT 模型的日汇总和未汇总请求记录，校验历史日期不重叠，并按记录的输入口径区分命中缓存、未命中与输出。累计 **1,699,975,744 Token**；不包含 Claude 或自动审核模型。DeepSeek 保留已核对的历史数据。页面只保存汇总快照，不读取本机凭据或自动扫描本机记录。

## 文章

后台“文章”分区使用 Markdown 编辑与实时预览，共用一套无依赖安全渲染器。支持标题、列表、引用、代码、粗斜体、删除线、链接和图片；原始 HTML 转为文字。首图可选，只填写不含账号密码的公开 HTTP(S) 图片链接，不上传文件。

每篇分别选择来源（原创／搬运）和分类（杂谈／日志）。保存即公开；编辑保留创建日期并更新编辑日期，删除后退出公开列表和站点地图，详情返回404；“已删除”中可恢复，原始日期保留。未保存修改在站内跳转或切换文章前使用主题确认框提示，保存失败保留输入；类型选择、删除与放弃修改均用站内控件，不弹原生确认框。刷新或关闭浏览器前请先保存。

首页展示按创建时间倒序的最新两篇（数量由 `src/config/site.ts` 的 `articles.homepageCount` 控制），提供“全部文章”到 `/about#articles`；顶部导航仍只有首页、关于。关于页文章单列排列，使用无外框的紧凑横向卡片与两行摘要，首图按当前可见顺序左右交替，与正文分区，图片朝正文方向渐隐并向外柔和虚化；图片与悬停缩放裁切在组件圆角内，外层保留 GitHub 日期提示同款柔和背光；右侧竖排点击栏提供排序、来源和分类，支持创建或编辑时间升降序，默认最新发布。手机端筛选分组收至列表上方。独立阅读地址为 `/articles/<id>`，卡片、编辑器、正文、代码与提示均复用现有 `--playful` 艺术字体和深浅主题，不新增字体或示例文章。

## 使用与配置

需要 Node.js 22.12+ 与 pnpm。复制 `.env.example` 为 `.env`，配置后运行：

```bash
pnpm install --frozen-lockfile
pnpm dev:background
```

本地 `http://localhost:4321`，后台 `/admin`。使用 `pnpm dev:status`、`pnpm dev:stop`、`pnpm astro dev logs` 管理服务。

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_SITE_URL` | 最终 HTTPS 源地址，不带路径、查询或账号密码；构建时必填，修改域名后重新构建 |
| `BLOG_SECRET` | 至少32个随机字符，用于管理签名与来源指纹；生产缺失或过短时拒绝管理认证 |
| `ADMIN_PASSWORD_HASH` | scrypt 哈希，禁止明文；用 `pnpm hash:admin -- "至少12字符的密码"` 生成 |
| `BLOG_DATA_DIR` | SQLite 目录；生产推荐 `/srv/samsblog/shared/data`，应用和备份共用 |
| `SITE_LAUNCHED_AT` | 严格 `YYYY-MM-DD`，默认 `2026-08-22`；按北京时间自然日计数，当天为第1天 |
| `HOST` / `PORT` | 生产使用 `127.0.0.1` / `4321`，仅通过 Nginx 暴露 |

开发加载 `.env`，生产服务只读进程环境。管理密钥不进入构建产物。环境文件权限设为 `600`。

后端参数及校验集中于 `src/config/server.ts`，可通过同名环境变量覆盖：

- 管理：`ADMIN_SESSION_SECONDS=28800`、`ADMIN_PASSWORD_MAX_LENGTH=256`、`ADMIN_LOGIN_WINDOW_SECONDS=60`、`ADMIN_LOGIN_ATTEMPTS=5`、`ADMIN_LOGIN_GLOBAL_ATTEMPTS=30`、`ADMIN_LOGIN_TRACKED_ADDRESSES=1000`。
- 留言：`MESSAGE_COOLDOWN_SECONDS=60`。
- 文章：`ARTICLE_TITLE_MAX_LENGTH=160`、`ARTICLE_CONTENT_MAX_LENGTH=100000`、`ARTICLE_REQUEST_MAX_BYTES=1048576`；均校验为正整数。请求实际字节、标题与正文字符数分别校验，中文多字节内容也受限制。
- GitHub：`GITHUB_USERNAME=afterSuperSam`、`GITHUB_CACHE_SECONDS=21600`、`GITHUB_RETRY_SECONDS=60`、`GITHUB_TIMEOUT_MILLISECONDS=5000`。
- 友链探测：`FRIEND_STATUS_CACHE_SECONDS=300`、`FRIEND_STATUS_TIMEOUT_MILLISECONDS=5000`（上限15000）、`FRIEND_STATUS_SLOW_MILLISECONDS=1800`（小于超时）、`FRIEND_STATUS_CONCURRENCY=3`（上限6）、`FRIEND_STATUS_MAX_REDIRECTS=3`（上限5）。数值须为正整数。

站点入口、社交地址和动效参数在 `src/config/site.ts`。主题、字号、焦点、背景及动效变量集中于 `src/styles/global.css`；首页和留言样式分别在 `home.css`、`guestbook.css`。动效可暂停，并适配系统减少动效偏好。顶部动效图标在模式切换图标左侧，悬停/键盘聚焦时向左展开功能文字，无提示框；延迟固定在社交图标左侧，不显示“访客”，手机端保持 SamsBlog 后跟延迟。

## 接口契约

JSON 写接口要求 `Content-Type: application/json` 和顶层对象；ID 为正整数，布尔值使用 JSON 布尔类型。创建不带 ID，更新/删除必须带 ID。后台提供文章新建、编辑、删除、恢复，留言审核、回复、删除与友链导入、编辑、隐藏、删除。

| 路由 | 方法 / 权限 | 内容 |
| --- | --- | --- |
| `/api/admin/login.json` | POST / 公开限速 | `{password}`；设置管理 Cookie；失败401、限速429、配置缺失503 |
| `/api/admin/logout.json` | POST / 管理员 | 清除管理 Cookie |
| `/api/admin/messages.json` | GET/PATCH/POST/DELETE / 管理员 | 列表；`{id,status}` 审核；`{parentId,content}` 回复；`{id}` 删除线程 |
| `/api/admin/articles.json` | GET/POST/PATCH/DELETE / 管理员 | GET 包含已删除；POST `{title,coverUrl?,source,category,content}`；PATCH 更新加 `id`，恢复 `{id,restore:true}`；DELETE `{id}`；来源为 `original/repost`，分类为 `discussion/journal` |
| `/api/admin/friends.json` | GET/POST/PATCH/DELETE / 管理员 | `name,url,description,iconUrl,backgroundUrl?,visible`；更新带 ID，删除 `{id}` |
| `/api/guestbook/messages.json` | GET/POST / 公开 | 公开根留言及回复；提交 `{nickname,content,parentId?,website?}` 默认待审核 |
| `/api/friends/status.json` | GET / 公开 | `{statuses:[{id,status,latencyMilliseconds,checkedAt}]}`；仅探测公开友链 |
| `/api/network.json` / `/api/ping.json` | GET / 公开 | 脱敏地址与粗略位置 / 在线状态和时间 |
| `/api/public/site-card.json` | GET / 公开 | `name,url,description,icon,status,latest,updatedAt`；`latest:[]` 保留兼容 |
| `/health.json` / `/sitemap.xml` / `/robots.txt` | GET / 公开 | 健康状态 / 公开页面 / 抓取规则 |

错误统一 `{error:中文消息}`；登录保留 `{ok,message}`。成功通常200，创建201。留言状态为 `pending/published/hidden`；隐藏仅管理员可见，软删除退出业务查询。友链地址、图标与背景只接受不含账号密码的完整 HTTP(S) URL。背景留空或加载失败时回退头像。

## 验证

日常 `pnpm check` 加针对性测试。准备发布执行：

```bash
pnpm check
pnpm test
pnpm build
pnpm audit
```

构建必须提供真实 `PUBLIC_SITE_URL`。仓库无独立 e2e 套件；用生产构建复核首页、关于、后台、404，320/390/768/1280px、深浅色、菜单、键盘焦点、贡献图与 reduced-motion。贡献图每图一个 Tab 停靠点，方向键按日/周移动，Home/End 到首尾，Escape 关闭详情。

## 数据与部署

运行数据库为 `$BLOG_DATA_DIR/blog.sqlite`。相册及旧文章系统仍退役；现有历史表不读写、不在启动时删除。新文章使用独立 `blog_articles` 表，由 `20261017-blog-articles-v1` 自动增量初始化，不自动导入或公开旧表内容，新表初始为空。保留数据库和 `data/backups/`，勿当作无用文件清除。

Linux 部署：

1. 安装 Node.js 22.12+、pnpm、Nginx、SQLite CLI；创建 `samsblog` 用户与 `/srv/samsblog/shared/data`，授予数据目录读写权限。
2. 源码放 `/srv/samsblog/current`，配置 `/etc/samsblog.env`，使用绝对 `BLOG_DATA_DIR`。不要上传 Windows 的 `node_modules`、`.env` 或旧 `dist`。
3. 在源码目录加载环境后执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。构建域名决定 canonical、OG 和可信代理域名，必须与实际 HTTPS 域名一致。
4. 安装 `deploy/samsblog.service`；`ExecStart` 默认 `/usr/bin/node`，若安装路径不同需修改。服务以生产模式运行，代码只读，仅数据目录可写；修改 `BLOG_DATA_DIR` 时同步调整 `ReadWritePaths`。
5. 修改 `deploy/nginx.conf` 域名并配置 HTTPS，HTTP 跳转 HTTPS。模板用于单层代理，覆写来源地址及 Host/Proto/Port 转发头，清除访客伪造的地理信息头，请求上限1MiB，与 Node adapter 及文章默认请求限制保持一致；若提高文章限制，需同步调整代理和 adapter。多层代理需明确可信链。
6. 安装 `deploy/backup.service`、`deploy/backup.timer`，先手动备份并恢复验证，再启用定时任务。
7. 检查健康接口、站点地图、HTTPS Cookie、后台登录、文章保存/编辑/删除/恢复、留言审核及日志。上述本地验证不能代替服务器验收。

`deploy/backup.sh` 跟随 `BLOG_DATA_DIR`，默认备份到该目录下 `backups/`；可配置 `BACKUP_DIR`、正整数 `RETENTION_DAYS`（默认14）。缺源库立即失败；在线备份通过完整性检查后原子发布，文件权限仅所有者可读写。脚本由 Bash 调用，部署文件在 Git 中固定 LF 换行。

恢复时先停止站点，保存当前数据库及其 `-wal`/`-shm` 旁文件，将校验通过的备份恢复为 `blog.sqlite`；启动前移走旧旁文件并恢复 `samsblog` 所有权，再验证健康、后台与业务数据。不能在服务运行时直接覆盖数据库。

## 安全边界

- 会话使用 HttpOnly、SameSite=Strict，生产 Secure；每个管理 API 复核权限和请求来源。scrypt 异步执行，单来源与全站限速；单进程限流重启后重置。
- 数据库不保存完整 IP/UA；来源仅哈希指纹，统计只存匿名 Cookie 的 SHA-256，仅成功的公开 HTML 浏览计数。
- Nginx 关闭常规访问日志；错误日志及上游代理仍可能包含 IP，需按实际服务器日志策略管理。
- 友链探测只允许 HTTP(S) 的80/443端口，逐跳重新校验并固定已验证的公网地址，拒绝内网、回环、保留及混合解析地址；仅读响应头，有限并发和超时。检测失败不冒充站点离线，耗时不是访客延迟。
- 文章正文转义原始 HTML，仅允许安全网页地址和站内路径；禁止脚本/data 等危险协议。图片由浏览器直接加载，不由服务器代取，不填写私密资源地址。
- 友链图片由浏览器直连，不代理私密资源；不要填写带鉴权或私密参数的网址。GitHub 仅请求公开贡献页，失败降级。

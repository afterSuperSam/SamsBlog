# SamsBlog

精简、自托管的 Astro 个人插画站，展示项目、文章、关于、友链、留言与匿名访客统计。

## 架构

- Astro SSR + Node standalone，文件式 API；后台使用原生 DOM。
- SQLite + 手写 SQL，WAL、外键、CHECK 枚举约束；友链、留言和文章软删除。
- 首页顺序：Hero → 项目 → 最新两篇文章（有内容时） → 留言纸条 → 网站友链 → 统计。顶部导航仅首页、关于；右侧区块导航含文章入口，“留言”指向留言纸条。`/links` 永久重定向至 `/#friends`。
- 项目区桌面每行两个、手机单列；后台可新增、隐藏和排序，首页先显示前4个公开项目，其余通过无边框“更多项目”展开。标题可跳转自定义地址，悬停时沿字形发光并轻微偏移；项目近况胶带复用鼠标偏转，悬停轻移并显示柔和背景光，全部文章入口也使用背景光。
- 区块英文标题均为单词，如 `PROJECTS`、`ARTICLES`、`FRIENDS`、`CONTACT`、`TRACES`；阅读页不显示额外英文标题；留言输入框聚焦时无外框，保留手绘闪烁光标。友链和运行天数不显示悬停说明。页脚版本号右侧同一行显示“萌ICP备20269090号”，链接到萌备记录；随后是 RSS 和管理，管理排在最右侧。萌备配置位于 `siteConfig.registration`。
- 关于页展示联系方式、全部文章、GitHub 贡献和 Token 用量；桌面右侧复用首页区块导航，可跳转联系、文章、痕迹和赞赏，随滚动高亮并保留扩散与疏密动效。GitHub 服务端缓存并合并请求；Token 是页面内标明日期的历史快照，不自动读取本机数据库。
- 视觉与交互约束见 [design/README.md](design/README.md)。不引入客户端框架或粒子库。背景粒子桌面60个、手机18个，使用不同定位点；通过脚本逐项设置 CSS 属性，兼容生产 CSP，不放开内联样式权限。
- 公开页面页脚同一行居中展示小号圆润粗笔画 `SuperSam` 手写签名，与左侧 SamsBlog 对齐；r 与第二个 S 靠近但断笔，使用圆润舒展的本地 SVG 字形，沿独立中心笔迹从左到右书写，无需加载字体或第三方库。每次离开视野后重新滚到签名时，以整体慢起、加速、慢收的非线性节奏在1秒内重写；暂停动效或系统减少动效时直接显示完整签名。时长、笔间停顿、缓动与可见阈值在 `src/config/site.ts` 的 `signature` 中校验，后台不显示。书写结束后签名非线性左移，右侧逐字淡入项目实际版本号（自动读取 `package.json`），完整落款组居中；手机端缩小 SamsBlog 与签名，和 RSS、管理保持同一行，Hover 显示柔和蓝色背光；页脚品牌不显示头像，版本号使用较淡的辅助色。暂停或减少动效时直接显示完整落款，收束与逐字动画时长由签名配置校验。
- 公开页面滚动进入时，区块以非线性缓动渐入，项目、文章、友链、联系方式、痕迹面板及统计依次错峰出现（文章卡片不显示跳转箭头，保留整卡点击），短标题逐字轻弹淡入。每次载入仅播放一次，正文和输入文字保持静态；暂停或系统减少动效会取消动画并显示全部内容。参数由 `src/config/site.ts` 的 `reveal` 校验，后台不应用。
- 装饰使用站内 SVG 与 CSS：友链右上角可选 RSS 入口，悬停或键盘聚焦时波纹展开、轻微偏转并显示主题色背光。书签与回形针已移除。星座每4.2秒重新随机连接附近的粒子，桌面每组最多10条线、14个点，移动端最多5条线、8个点；两层星图非线性交替淡入淡出，连线与端点同步漂移，并随滚动调整透明度。保持桌面60、移动端18个粒子。数量、周期与距离限制由 `effects.constellation` 校验，视觉参数集中于 `global.css`；暂停、系统减少动态效果及切到后台时停止重选连接，无持续逐帧 JavaScript 渲染循环。
- 内容后台提供右侧文章／留言／友链／项目区块导航，去除顶部文章快捷按钮；顶栏仅暂停动效按钮显示展开说明，主题按钮保留图标。网站友链 Hover 添加主题色柔光，关于页联系方式按各组件的蓝、粉、橙、青色显示背光；统计数字首次进入视野时从0非线性增长，配置在 `statistics` 校验，读屏与减少动效始终显示真实值。

GPT 用量快照已从本机 CCswitch 记录覆盖更新至 **2026-10-18**，按北京时间汇总 GPT 模型，沿用 CCswitch 的日汇总与请求明细合并口径，并按 input_token_semantics 还原未命中输入，缓存不重复计入输入。累计 **2,317,673,302 Token**；不包含 Claude 或自动审核模型，DeepSeek 历史数据不变。仅覆盖站内日汇总快照，不修改 CCswitch 数据库。当天用量为导入时快照。统计口径参考 [CCswitch 源码](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/sql_helpers.rs)。

## 文章

后台“文章”分区使用 Markdown 编辑与实时预览，共用一套无依赖安全渲染器。支持标题、列表、引用、代码、粗斜体、删除线、链接和图片；原始 HTML 转为文字。首图可选，只填写不含账号密码的公开 HTTP(S) 图片链接，不上传文件。

每篇分别选择来源（原创／搬运）和分类（杂谈／日志）。保存即公开；编辑保留创建日期并更新编辑日期，删除后退出公开列表和站点地图，详情返回404；“已删除”中可恢复，原始日期保留。未保存修改在站内跳转或切换文章前使用主题确认框提示，保存失败保留输入；类型选择、删除与放弃修改均用站内控件，不弹原生确认框。刷新或关闭浏览器前请先保存。

首页展示按创建时间倒序的最新两篇（数量由 `src/config/site.ts` 的 `articles.homepageCount` 控制），提供“全部文章”到 `/about#articles`；此类文章跳转使用更大字号、非线性位移和箭头反馈，不加下划线，适配减少动效；顶部导航仍只有首页、关于。关于页文章单列排列，使用无外框的紧凑横向卡片与两行摘要，首图按当前可见顺序左右交替，与正文分区，图片朝正文方向渐隐并向外柔和虚化；图片与悬停缩放裁切在组件圆角内，外层保留 GitHub 日期提示同款柔和背光；右侧竖排点击栏提供排序、来源和分类，支持创建或编辑时间升降序，默认最新发布。手机端筛选分组收至列表上方。文章发布日期按北京时间显示到分钟。独立阅读地址为 `/articles/<id>`，卡片、编辑器、正文、代码与提示均复用现有 `--playful` 艺术字体和深浅主题，不新增字体或示例文章。

后台“项目”分区可新增、隐藏、上移和下移项目，编辑名称、跳转、简介、划线关键词、状态及可选 GitHub 仓库；“最近在做”整句可编辑。默认状态为活跃、维护、活跃、归档，保存至 SQLite；旧项目设置自动迁入，隐藏不删除。可选仓库仅用于提交日期，不限制跳转网址；沿用 GitHub 缓存与超时，失败保留已有日期。关键词在 Hover／键盘聚焦时以0.9秒绘制同色、等粗、上短下长的双横线，离开时按下横线、连笔、上横线反向收回，不淡出；归档徽标为红色。

阅读页提供舒适阅读、自动目录、唯一标题锚点、上一篇／下一篇；正文图片可点击放大、再次放大与 Escape 关闭，保留手机系统缩放。代码支持原样复制和换行切换，成功后显示粉色渐变“复制成功”；长代码只在代码区滚动。阅读偏好和最近50篇阅读位置仅保存在本机，再次打开时可主动恢复。搬运文章可独立填写原作者和原文链接；详情输出文章专属封面、时间、Open Graph 与 `BlogPosting` 数据。

文章筛选通过 FLIP 位移平滑重排，筛选与排序记录在 URL，刷新和返回均保留。封面采用原生跨文档 View Transitions；支持的浏览器展开为阅读页头图，返回原列表位置，不支持时正常跳转。无首图文章不做封面转场。留言列表与左侧纸条等高，超出内容在内部滚动，底部长渐隐与虚化随滚动到末尾解除；留言区域隐藏滚动条，滚到底后继续滚动页面，支持键盘滚动；输入框标题聚焦时从左到右由灰色渐变为蓝色，适配减少动效偏好。留言提示与标题共用逐字渐入逻辑，读屏获得完整消息；暂停或减少动效时立即显示。

`/rss.xml` 动态读取最新20篇公开文章，提供首图和完整正文，保留 Markdown 排版、图片与链接；站内链接和图片地址按文章地址转为完整网址，保存、编辑、软删除、恢复后自动更新，无需生成文件或手动触发。订阅器自身决定拉取频率与历史条目保留方式。页脚按 RSS、管理排列，提供 RSS 入口，页面声明订阅地址。跨站卡片 `/api/public/site-card.json` 继续提供最新文章摘要，Town 前端接入留待后续；数量与排序动效时长由 `siteConfig.articles` 校验。

页脚 RSS 打开订阅说明，可复制地址或直接打开 XML；禁用脚本时直接进入原订阅源。配置了 RSS 的友链展示最近更新日期，点击展开标题。服务端按需刷新并持久缓存30分钟，失败保留同一订阅的上次有效条目；更换地址立即隔离旧缓存，不猜测缺失日期。仅支持受限 RSS／Atom 元数据，不执行 HTML、DTD 或外部实体。

动效按点击反馈、内容重排、装饰分层；划线0.9秒、签名1秒保持不变。主题从按钮位置圆形展开，封面进入620ms、返回400ms；暂停和减少动效时直接完成。触摸设备关闭粘滞 Hover 位移。Token 年度图默认定位最新端，可按月跳转；手机文章筛选默认收起；留言和后台提示平滑调整高度，中文输入期间保留原生选区。

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
| `BLOG_DATA_DIR` | SQLite 目录；生产推荐 `/opt/samsblog/shared/data`，应用和备份共用 |
| `SITE_LAUNCHED_AT` | 严格 `YYYY-MM-DD`，默认 `2026-08-22`；按北京时间自然日计数，当天为第1天 |
| `HOST` / `PORT` | 生产使用 `127.0.0.1` / `4321`，仅通过 Nginx 暴露 |

开发加载 `.env`，生产服务只读进程环境。管理密钥不进入构建产物。环境文件权限设为 `600`。

Astro 配置使用 Node 内置解析读取 `.env`、`.env.local` 和当前模式对应文件，后者覆盖前者，进程环境优先；不依赖未声明的 Vite 包。`PUBLIC_SITE_URL` 填写完整地址，不使用变量插值。

后端参数及校验集中于 `src/config/server.ts`，可通过同名环境变量覆盖：

- 管理：`ADMIN_SESSION_SECONDS=28800`、`ADMIN_PASSWORD_MAX_LENGTH=256`、`ADMIN_LOGIN_WINDOW_SECONDS=60`、`ADMIN_LOGIN_ATTEMPTS=5`、`ADMIN_LOGIN_GLOBAL_ATTEMPTS=30`、`ADMIN_LOGIN_TRACKED_ADDRESSES=1000`。
- 留言：`MESSAGE_COOLDOWN_SECONDS=60`。
- 文章：`ARTICLE_TITLE_MAX_LENGTH=160`、`ARTICLE_CONTENT_MAX_LENGTH=100000`、`ARTICLE_REQUEST_MAX_BYTES=1048576`；均校验为正整数。请求实际字节、标题与正文字符数分别校验，中文多字节内容也受限制。
- GitHub：`GITHUB_USERNAME=afterSuperSam`、`GITHUB_CACHE_SECONDS=21600`、`GITHUB_RETRY_SECONDS=60`、`GITHUB_TIMEOUT_MILLISECONDS=5000`。
- 友链探测：`FRIEND_STATUS_CACHE_SECONDS=300`、`FRIEND_STATUS_TIMEOUT_MILLISECONDS=5000`（上限15000）、`FRIEND_STATUS_SLOW_MILLISECONDS=1800`（小于超时）、`FRIEND_STATUS_CONCURRENCY=3`（上限6）、`FRIEND_STATUS_MAX_REDIRECTS=3`（上限5）。数值须为正整数。
- 友链订阅：`FRIEND_FEED_CACHE_SECONDS=1800`（上限86400）、`FRIEND_FEED_MAXIMUM_BYTES=1048576`（上限4194304）、`FRIEND_FEED_MAXIMUM_ENTRIES=100`（上限500）、`FRIEND_FEED_MAXIMUM_DEPTH=32`（上限64）；复用友链探测的超时、重定向和并发限制。

站点入口、社交地址和动效参数在 `src/config/site.ts`。主题、字号、焦点、背景及动效变量集中于 `src/styles/global.css`；首页和留言样式分别在 `home.css`、`guestbook.css`。动效可暂停，并适配系统减少动效偏好。顶部动效图标在模式切换图标左侧，悬停/键盘聚焦时向左展开功能文字，无提示框；延迟固定在社交图标左侧，不显示“访客”，手机端保持 SamsBlog 后跟延迟。

## 接口契约

JSON 写接口要求 `Content-Type: application/json` 和顶层对象；ID 为正整数，布尔值使用 JSON 布尔类型。创建不带 ID，更新/删除必须带 ID。后台提供文章新建、编辑、删除、恢复，留言审核、回复、删除与友链导入、编辑、隐藏、删除。友链可填写可选 RSS 地址；保存后首页右上角显示独立订阅入口，留空则隐藏，卡片其他位置仍打开友链首页。

| 路由 | 方法 / 权限 | 内容 |
| --- | --- | --- |
| `/api/admin/login.json` | POST / 公开限速 | `{password}`；设置管理 Cookie；失败401、限速429、配置缺失503 |
| `/api/admin/logout.json` | POST / 管理员 | 清除管理 Cookie |
| `/api/admin/messages.json` | GET/PATCH/POST/DELETE / 管理员 | 列表；`{id,status}` 审核；`{parentId,content}` 回复；`{id}` 删除线程 |
| `/api/admin/articles.json` | GET/POST/PATCH/DELETE / 管理员 | GET 包含已删除；POST `{title,coverUrl?,source,category,content,originalAuthor?,originalUrl?}`；PATCH 更新加 `id`，恢复 `{id,restore:true}`；DELETE `{id}`；来源为 `original/repost`，分类为 `discussion/journal` |
| `/api/admin/friends.json` | GET/POST/PATCH/DELETE / 管理员 | `name,url,description,iconUrl,backgroundUrl?,rssUrl?,visible`；更新带 ID，删除 `{id}` |
| `/api/admin/projects.json` | GET/PUT / 管理员 | `{currentWork,projects:[{id?,repository,name,url,description,keyword,status,visible}]}`；数组顺序即展示顺序，新项不带ID，已有项目须全部保留，整组原子保存 |
| `/api/public/project-commits.json` | GET / 公开 | 当前公开项目仓库的最近提交时间，后台缓存；不接受任意探测地址 |
| `/rss.xml` | GET / 公开 | 动态 RSS 2.0 全文订阅，无手动更新步骤 |
| `/api/guestbook/messages.json` | GET/POST / 公开 | 公开根留言及回复；提交 `{nickname,content,parentId?,website?}` 默认待审核 |
| `/api/friends/status.json` | GET / 公开 | `{statuses:[{id,status,latencyMilliseconds,checkedAt}]}`；仅探测公开友链 |
| `/api/friends/feeds.json` | GET / 公开 | `{feeds:[{id,title,url,publishedAt,checkedAt}]}`；仅刷新公开友链的已配置订阅，拒绝查询参数 |
| `/api/network.json` / `/api/ping.json` | GET / 公开 | 脱敏地址与粗略位置 / 在线状态和时间 |
| `/api/public/site-card.json` | GET / 公开 | `name,url,description,icon,status,latest,updatedAt`；`latest` 为最新3篇公开文章，含标题、链接、摘要、封面、来源、分类和创建／编辑日期；允许 Town 源跨域读取，缓存5分钟 |
| `/health.json` / `/sitemap.xml` / `/robots.txt` | GET / 公开 | 健康状态 / 公开页面 / 抓取规则 |

错误统一 `{error:中文消息}`；登录保留 `{ok,message}`。成功通常200，创建201。留言状态为 `pending/published/hidden`；隐藏仅管理员可见，软删除退出业务查询。友链地址、图标、背景与 RSS 只接受不含账号密码的完整 HTTP(S) URL。背景留空或加载失败时回退头像。

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

1. 安装 Node.js 22.12+、pnpm、Nginx、SQLite CLI；创建 `samsblog` 用户与 `/opt/samsblog/shared/data`，授予数据目录读写权限。
2. 源码放 `/opt/samsblog/current`，配置 `/etc/samsblog.env`，使用绝对 `BLOG_DATA_DIR`。不要上传 Windows 的 `node_modules`、`.env` 或旧 `dist`。
3. 在源码目录加载环境后执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。构建域名决定 canonical、OG 和可信代理域名，必须与实际 HTTPS 域名一致。
4. 安装 `deploy/samsblog.service`；`ExecStart` 默认 `/usr/local/bin/node`，用 `command -v node` 核对实际路径，不同时需修改。服务以生产模式运行，代码只读，仅数据目录可写；修改 `BLOG_DATA_DIR` 时同步调整 `ReadWritePaths`。
5. 修改 `deploy/nginx.conf` 域名并配置 HTTPS，HTTP 跳转 HTTPS。模板用于单层代理，覆写来源地址及 Host/Proto/Port 转发头，清除访客伪造的地理信息头，请求上限1MiB，与 Node adapter 及文章默认请求限制保持一致；若提高文章限制，需同步调整代理和 adapter。多层代理需明确可信链。
6. 将 `deploy/backup.service`、`deploy/backup.timer` 安装为 `samsblog-backup.service`、`samsblog-backup.timer`，先手动备份并恢复验证，再启用定时任务。
7. 检查健康接口、站点地图、HTTPS Cookie、后台登录、文章保存/编辑/删除/恢复、留言审核及日志。上述本地验证不能代替服务器验收。

`deploy/backup.sh` 跟随 `BLOG_DATA_DIR`，默认备份到该目录下 `backups/`；可配置 `BACKUP_DIR`、正整数 `RETENTION_DAYS`（默认14，生产 `/etc/samsblog.env` 显式设置 `RETENTION_DAYS=14`）。每次成功备份后，按 UTC 截止时间清理满 14×24 小时的 `samsblog-*.db`，不使用会额外保留一天的 `-mtime +14`。缺源库立即失败；在线备份以不可变快照检查完整性，避免生成校验用 WAL/SHM 旁文件，通过后原子发布，文件权限仅所有者可读写。脚本由 Bash 调用，部署文件在 Git 中固定 LF 换行。

恢复时先停止站点，保存当前数据库及其 `-wal`/`-shm` 旁文件，将校验通过的备份恢复为 `blog.sqlite`；启动前移走旧旁文件并恢复 `samsblog` 所有权，再验证健康、后台与业务数据。不能在服务运行时直接覆盖数据库。

## 安全边界

- 会话使用 HttpOnly、SameSite=Strict，生产 Secure；每个管理 API 复核权限。跨站防护由 Astro 的表单来源检查、写入请求的 JSON 类型约束和 Strict Cookie 共同承担，管理接口不授权跨域访问。scrypt 异步执行，单来源与全站限速；单进程限流重启后重置。
- 数据库不保存完整 IP/UA；来源仅哈希指纹，统计只存匿名 Cookie 的 SHA-256，仅成功的公开 HTML 浏览计数。
- Nginx 关闭常规访问日志；错误日志及上游代理仍可能包含 IP，需按实际服务器日志策略管理。
- 友链探测与订阅只允许 HTTP(S) 的80/443端口，逐跳重新校验并固定已验证的公网地址，拒绝内网、回环、保留及混合解析地址。连通性仅读响应头；订阅限制响应体字节、嵌套与条目数量，拒绝压缩和截断响应，限制并发与超时。检测失败不冒充站点离线，耗时不是访客延迟。
- 文章正文转义原始 HTML，仅允许安全网页地址和站内路径；禁止脚本/data 等危险协议。图片由浏览器直接加载，不由服务器代取，不填写私密资源地址。
- 友链图片由浏览器直连，不代理私密资源；不要填写带鉴权或私密参数的网址。GitHub 仅请求公开贡献页，失败降级。

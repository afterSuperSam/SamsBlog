# SamsBlog

一个精简、自托管的 Astro 个人插画站，展示个人项目、关于、友链、留言与匿名访客统计。文章和相册功能已退役。

## 架构

- Astro SSR + Node standalone，页面和文件式 API 由一个进程提供；后台使用原生 DOM。
- SQLite + 手写 SQL，WAL、外键与 CHECK 枚举约束；友链、留言采用软删除。
- GitHub 贡献图在服务端缓存，共用进行中的请求，失败短暂缓存并返回旧数据。
- 沿用现有部署的夏日插画风格与粉蓝米配色，统一导航与主题，加入可暂停的轻量粒子和点击动效；视觉规范集中在 [design/README.md](design/README.md)。
- 后端参数集中于 `src/config/server.ts`，JSON解析、鉴权与错误分类集中于 `src/lib/http.ts`，不引入通用 CRUD 框架。

## 使用与配置

需要 Node.js 22.12+ 与 pnpm，只维护 `pnpm-lock.yaml`。

```bash
pnpm install
pnpm dev:background
```

本地地址 `http://localhost:4321`，后台 `/admin`。使用 `pnpm dev:status`、`pnpm dev:stop` 管理服务。

后台保留留言审核/回复/删除、友链导入/编辑/隐藏/删除；留言卡片在宽屏两列排列，长文本可换行显示。

页面使用稳定的系统字体栈，不下载网络字体，避免跳转时字体替换。留言审核后公开展示；失败保留输入，成功清空表单。

首页留言板采用轻拟物纸条：深色为灰色纸面，浅色为米白纸面，搭配胶带、花朵、星点与折角；纸条标题、字段标签、输入文字与字数提示统一使用手写艺术字体。输入区无外框、底线或横格，聚焦时字段标签变色，正文不显示占位提示。关闭浏览器原生必填气泡，提交时通过行内提示与字段聚焦校验称呼、留言长度；服务端校验仍保留。公开留言不显示序号，站长回复使用无描边的圆角底色。友链位于统计上方，名称、简介与域名使用放大的手写艺术字体，简介省去末尾句号；楹雾镇默认简介为“我的世界玩家社区”。统计区省去标题与英文，以圆角底色区分内外，不加描边；运行天数、友邻、累计访客与总浏览量使用不同主题色，桌面四列、手机两列。

主入口与社交链接在 `src/config/site.ts` 配置；公开友链读取 SQLite。全站主题变量在 `src/styles/global.css`，首页排版在 `home.css`，公共页面与后台布局在 `legacy-layout.css`。`site.ts` 的 effects 配置粒子数量（桌面28、手机12，上限40）和指针倾斜角度（2.5°，上限3°）；公共动效支持暂停与系统减少动效偏好，后台保持静态。

公开页采用无外框的文字/图标按钮，保留键盘焦点提示。项目区使用纸胶带标签和主题色点；顶部2px阅读进度线在减少动效时静止。Hero贴纸仅在鼠标与允许动效时轻微倾斜。关于页保留联系、痕迹与赞赏；个人介绍、重度玩家、日常爱好、探索创造与模型工具栏已移除。联系方式字号与图标放大，GitHub贡献格为16px，痕迹区新增来自 CCswitch 本地记录的 GPT 与已核对 DeepSeek 每日 Token 用量图，图表默认定位到最新日期，悬停或聚焦单日格子会展示命中缓存、未命中缓存和输出明细，窄屏可纵向查看；日期标记来自最近一次GitHub公开贡献，未获取到数据时不展示。赞赏区域使用颜文字，不在仓库保存或加载二维码素材；减少动效时颜文字保持静止。

复制 `.env.example`，配置：

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_SITE_URL` | 最终 HTTPS 地址 |
| `BLOG_SECRET` | 至少32个随机字符；管理签名与地址指纹。生产缺失/过短时拒绝管理认证 |
| `ADMIN_PASSWORD_HASH` | scrypt 哈希，禁止明文 |
| `BLOG_DATA_DIR` | SQLite目录；生产推荐 `/srv/samsblog/shared/data` |
| `SITE_LAUNCHED_AT` | 建站日期，严格使用 `YYYY-MM-DD`，默认沿用旧版配置示例的 `2026-08-22`；按北京时间自然日计数，建站当天为第1天，建站前为0天 |
| `HOST` / `PORT` | 监听地址与端口 |

开发模式由 Node 加载 `.env`，生产使用运行时环境变量，不把管理密钥写入构建产物。生成密码哈希：

```bash
pnpm hash:admin -- "一段至少 12 字符的密码"
```

可选行为参数在 `src/config/server.ts` 校验：`ADMIN_SESSION_SECONDS`（28800）、`ADMIN_PASSWORD_MAX_LENGTH`（256）、`ADMIN_LOGIN_WINDOW_SECONDS`（60）、`ADMIN_LOGIN_ATTEMPTS`（5）、`ADMIN_LOGIN_GLOBAL_ATTEMPTS`（30）、`ADMIN_LOGIN_TRACKED_ADDRESSES`（1000）、`MESSAGE_COOLDOWN_SECONDS`（60）、`GITHUB_USERNAME`（afterSuperSam）、`GITHUB_CACHE_SECONDS`（21600）、`GITHUB_RETRY_SECONDS`（60）、`GITHUB_TIMEOUT_MILLISECONDS`（5000）。数值须为正整数，用户名只允许 GitHub 用户名格式。



## 接口契约

JSON写接口需要 `Content-Type: application/json` 和顶层对象。ID 为正整数，布尔字段为 JSON 布尔值，时间使用 ISO 格式。POST 创建禁止带 ID，PATCH/DELETE 必须带 ID。公开、隐藏、软删除含义分别是匿名可读、仅管理员可见、从业务查询中退出。

| 路由 | 方法 / 权限 | 输入与输出 |
| --- | --- | --- |
| `/api/admin/login.json` | POST / 公开限速 | `{password}`；成功200 `{ok,message}`并设置Cookie；密码错误401、限速429、安全配置缺失503 |
| `/api/admin/logout.json` | POST / 管理员 | 清除管理Cookie，200 `{ok:true}` |
| `/api/admin/messages.json` | GET/PATCH/POST/DELETE / 管理员 | GET `{messages}`；PATCH `{id,status}`，POST `{parentId,content}`回复，DELETE `{id}`软删除整条留言线程 |
| `/api/admin/friends.json` | GET/POST/PATCH/DELETE / 管理员 | GET `{friends}`；创建/更新 `name,url,description,iconUrl,visible`，更新额外带ID；删除 `{id}` |
| `/api/guestbook/messages.json` | GET/POST / 公开 | GET `{messages}`仅公开根留言及回复；POST `{nickname,content,parentId?,website?}`，默认待审核，来源指纹限流 |
| `/api/network.json` / `/api/ping.json` | GET / 公开 | 脱敏地址、粗略位置、域名 / 在线状态与时间 |
| `/api/public/site-card.json` | GET / 公开 | `name,url,description,icon,status,latest,updatedAt`；文章退役后 `latest: []` 保留字段兼容互通 |
| `/health.json` / `/sitemap.xml` / `/robots.txt` | GET / 公开 | 健康状态 / 现有公开页面 / 抓取规则 |

写操作成功通常200 `{ok:true}`，创建201并包含ID（公开留言返回确认文案）。错误统一 `{error:中文消息}`：400参数/JSON错误、401未授权、404记录不存在、409地址冲突、413过大、415格式错误、429限流、500内部失败。登录成功/密码错误/安全配置缺失保留 `{ok,message}`。内部错误写英文日志，不把 SQL、文件路径等内部细节返回访客。

留言状态为 `pending/published/hidden`，友链地址和图标只允许完整 HTTP(S) URL。

## 验证

日常运行 `pnpm check`，只对改动涉及的行为运行测试：

```bash
pnpm exec vitest run tests/admin-auth.test.ts tests/network.test.ts tests/content-management.test.ts
```

保留鉴权、接口输入边界、代理地址、软删除、访客计数与 GitHub解析验证；不再维护颜色、文案、CSS源码字符串断言。视觉检查使用320/390/768/1280px、深浅色、键盘焦点、折叠区和 reduced-motion。

用户明确准备发布时再执行完整 `check → test → build → audit → e2e（如有）`。

## 数据、归档与部署

运行时数据只有 `data/blog.sqlite`；`deploy/backup.sh` 在线备份 SQLite，默认保留14天。恢复时将数据库文件恢复到 `BLOG_DATA_DIR`，再检查站点健康接口和后台登录。

文章页面、API、RSS、后台编辑器及文章贡献图已删除；`/articles/*` 与 `/rss.xml` 返回404，站点地图不再列文章。新数据库不再创建文章表；已有 `articles/article_activity` 表与历史数据保留，由完整数据库备份归档，应用不再读写。运行天数由 `SITE_LAUNCHED_AT` 独立配置，不依赖历史文章。默认OG插画继续保留。

Linux部署：

1. 安装 Node.js 22.12+、pnpm、Nginx、SQLite CLI、tar。
2. 在 `/srv/samsblog/current` 执行 `set -a; . /etc/samsblog.env; set +a; pnpm install --frozen-lockfile && pnpm build`。生产构建会校验 `PUBLIC_SITE_URL`，不会生成 localhost 的 canonical 或 OG 地址。
3. 创建 samsblog 用户与 `/srv/samsblog/shared/data`，授予数据目录读写权限。
4. 环境变量写入 `/etc/samsblog.env`，安装 `deploy/samsblog.service`。
5. 修改 `deploy/nginx.conf` 域名，配置 HTTPS。模板单层代理覆写 X-Real-IP/X-Forwarded-For，并限制请求为64k；多层代理需明确可信地址链。
6. 启用 `deploy/backup.service` 与 `deploy/backup.timer`，完成备份恢复演练。
7. 检查健康接口、站点地图、后台登录与留言审核。

## 安全边界

- 会话使用 HttpOnly、SameSite=Strict Cookie；生产Secure。管理权限在每个API复核。
- scrypt异步执行，单来源与全站均限速；限流在单进程内，重启会重置。
- Node端口仅对回环开放；代理必须覆写访客提供的地址头，不能将任意XFF当作可信来源。
- 数据库不保存完整IP/UA；登录与留言仅保存/使用哈希指纹，统计只存匿名Cookie的SHA-256标识。
- 友链图标由浏览器直接读取，不代理外部URL；不要填带鉴权或私密参数的地址。
- GitHub仅请求公开贡献页，失败降级；互通接口不共享Cookie、账号或数据库。
- systemd只允许写入数据目录，代码只读；历史文章归档保留，相册数据按退役要求清除。

相册功能已完全删除：页面、首页入口、后台图片管理、接口、数据库表、导入脚本、图库素材和旧设计概念图均移除，仅保留页面实际使用的插画与品牌素材。首页按 Hero → 我的项目 → 留言板 → 友链 → 站点统计组织。旧 `dist/` 不得直接复用，部署前必须重新构建。

顶部导航仅保留首页与关于；项目与友链展示放在首页。`/links` 永久重定向至 `/#friends`，旧 `/about#friends` 在浏览器中跳转至同一位置。Hero保留背景插画、装饰与项目入口，不显示居中标题图片和副标题；站点名称仅供辅助技术读取。底部额外增加120–220px的渐变过渡，直接衔接正文背景。

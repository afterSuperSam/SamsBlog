# 仓库协作规范

## 工作方式

- 先澄清关键决策：将模糊目标拆成可判断选项，存在取舍时给 2–3 个方案及推荐。
- 用户说“开始／开工／继续”后自主执行，不反复确认；只改任务相关内容。失败同一路径 2–3 次后停下，报告卡点与已尝试路径。
- 优先扩展现有文件，不做无关重构；仅任务确需时新增文件。默认不新增依赖，必要时先说明候选与理由并确认。
- 交付简述改动、影响与验证边界。commit 使用约定式前缀加中文描述；分支默认 `codex/`。功能、修复、大型更新分别递增次版本、补丁版本、主版本。

## 仓库职责

- Astro 单体 SSR，文件式页面与 API；后台使用原生 DOM，不引入客户端框架。
- `src/pages/` 处理路由与请求；`src/components/` 复用界面；`src/lib/` 管领域逻辑和数据访问；`src/config/` 管配置与校验；`src/styles/` 管样式。
- SQLite 与手写 SQL；枚举使用 CHECK，友链、留言、文章沿用软删除。不得绕过现有权限、校验与数据契约。
- 标识符使用完整英文；注释只用中文说明区域或函数职责。错误显式分类，用户提示中文，内部日志英文，不吞错。
- 行为参数集中配置并校验，避免散落硬编码。复用现有实现，保持最小完整改动。

## 文档与视觉

- 根 README 是功能、配置、验证、部署和安全边界的主文档，相关行为变化同步更新；中文短句，不重复维护多份产品说明。
- 视觉契约与验收清单见 `design/README.md`。变量集中在 `src/styles/global.css`，沿现有命名与字体体系；动效适配暂停和 `prefers-reduced-motion`。
- 复杂领域先明确术语，再改实现。审查建议与实际完成项分开记录。

## 开发与验证

开发服务器必须后台运行：

```powershell
pnpm dev:background
pnpm dev:status
pnpm astro dev logs
pnpm dev:stop
```

对应 Astro 命令为 `astro dev --background`、`astro dev status`、`astro dev logs`、`astro dev stop`。

- 日常：`pnpm check` 加改动点最小验证，不跑无关测试和完整构建。
- 用户要求“准备发布／release／上线”时：`pnpm check` → `pnpm test` → `pnpm build` → `pnpm audit` → E2E（如有），全部通过后报告。界面改动按设计验收清单验证。
- 本地通过、远程发布与线上运行证据分开陈述，不以构建成功代替线上验证。

## 隐私与安全边界

- 不存完整 IP 或 UA；匿名统计仅存哈希指纹。不要把环境密钥、真实数据库或私人数据带入日志、截图、测试和文档。
- 管理接口保留认证、来源检查、输入校验及限速；公开接口只返回公开内容，软删除记录不得意外公开。
- Markdown 不执行原始 HTML；外部请求复用现有地址限制、超时和缓存，不开放任意目标探测。
- 保持生产 CSP，不通过放开内联脚本或样式权限解决界面问题。

## Astro 官方指南

处理对应功能前查阅相关指南：

- [路由与中间件](https://docs.astro.build/en/guides/routing/)
- [Astro 组件](https://docs.astro.build/en/basics/astro-components/)
- [框架组件](https://docs.astro.build/en/guides/framework-components/)
- [内容集合](https://docs.astro.build/en/guides/content-collections/)
- [样式](https://docs.astro.build/en/guides/styling/)
- [国际化](https://docs.astro.build/en/guides/internationalization/)

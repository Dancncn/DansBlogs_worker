# 维护与安全

## 检查与部署

使用 Node 24 和 `npm ci`。`npm run ci` 执行 TS7 类型检查、Node 接口回归、Wrangler 模拟打包、真实 workerd 运行时验收以及依赖扫描。测试不接触生产数据。

两类测试分别执行，不能相互替代：

- `npm test`：16 项 Node 接口回归，使用内存 SQLite 和本地服务替身，覆盖鉴权、隐私、审核、格式识别等细节。
- `npm run test:runtime`：先使用提交到仓库的示例配置重新打包，再由 Miniflare 启动实际 workerd 进程并通过本机 HTTP 请求验收。D1、KV、R2 和 SQLite Durable Objects 使用独立临时目录，测试结束执行 `dispose()` 并删除临时数据。Miniflare 是开发依赖，版本与 Wrangler 使用的版本保持一致。

运行时验收覆盖允许名单来源的凭据 CORS、未授权管理员拒绝、D1 浏览量和评论读写、真实 KV 审核缓存、OAuth state Cookie 标志与清理、过期会话撤销、R2 文件字节和 MIME、随机图片目录并发创建和跨用户权限。DO 测试通过 8 个并发请求确认限流，再等待 workerd 自动执行 alarm 清理；只在测试包装类中增加只读存储探针，生产 API 和限流逻辑保持原样。最后关闭整个实例、轮换测试签名密钥并启动新进程，检查持久数据和图片归属。

Miniflare 配置完全由测试构造，不读取私有 `wrangler.toml` 或 `.dev.vars`；元数据获取和遥测关闭，Worker 外部请求统一由本地拦截器拒绝，HTTP 客户端不跟随外部重定向。测试会尝试一次带合成数据的 OAuth 交换来验证拦截器，但不会连接 GitHub。邮件、真实 AI 推理、线上 Access 公钥服务和云端资源配置不在该运行时验收范围内；本地验收通过不代表生产已经部署或第三方集成已在线验证。

`npm run build` 仅模拟打包，不部署。`npm run deploy` 先通过全部检查，再使用本地 `wrangler.toml` 发布。实际配置文件和秘密不提交。示例配置只适合首次创建项目；已有部署必须保留自己的 Durable Object migration 历史和资源绑定，不能直接用示例覆盖。

GitHub Actions 在 push、pull request 和手动触发时执行 CI，不自动部署 Worker。

## 管理身份

管理接口接受两种可信身份：

1. Bearer 会话的邮箱已验证，且位于 `ADMIN_EMAILS` 白名单。
2. Cloudflare Access JWT 通过签名、issuer、audience 和有效期检查，签名中的邮箱位于同一白名单。

Access 方式需要设置 `ACCESS_TEAM_DOMAIN`（例如 `your-team.cloudflareaccess.com`）和 `ACCESS_AUD`（应用 audience tag）。未设置时 Access 通道拒绝请求，已验证邮箱会话通道仍可使用。裸 `CF-Access-Authenticated-User-Email` 头不再作为身份证明。

这两个 Access 设置是部署配置；`ADMIN_EMAILS`、`CONTACT_TO_EMAIL`、OAuth/Resend/Turnstile 密钥以及 `MODERATION_SECRET` 均使用 `wrangler secret put`。不要把秘密写入示例配置或日志。

`PUBLIC_ALLOWED_ORIGIN` 只填写明确允许的来源。任意其他 `*.pages.dev` 不再默认被信任；需要预览站访问 API 时显式加入其准确来源。

## 兼容性与数据

- 新库直接执行完整 `db/schema.sql`。老库先检查列结构，只在缺少 `parent_id` 时使用旧 `0002` 迁移；完整 schema 已包含该列，不能再重复执行旧迁移。新增 `user_image_namespaces` 表将用户映射到随机图片目录，`0003` 是可重复执行的非破坏性建表迁移；图片接口也会按需创建该表，因此不要求部署前先修改现有用户表。详见 `db/README.md`。
- 旧的无有效期审核邮件链接不再有效。新链接有效 7 天，只能处理仍为 pending 的评论，处理一次后重放和反向操作都会被拒绝。存量待审评论可通过管理接口处理。
- 数据库用户 ID 不变，避免破坏既有会话和评论关联。公开评论使用 HMAC 作者 ID，签名密钥轮换会改变公开 ID。
- 普通用户的新图片位于持久随机 UUID 目录，与邮箱没有可计算关系，目录不会随签名密钥轮换改变。首次并发请求通过数据库唯一约束收敛到同一个目录。上传、列表、删除都检查同一用户目录；目录名不作为授权凭据。
- 已验证管理员邮箱会话可维护原有 `posts/` 和 `misc/` 图片地址。新上传仅接受受支持的光栅图片，大小上限 5 MiB。
- 旧图片与 URL 不自动迁移，包括历史上可能含邮箱的头像地址。公开评论会隐藏此类旧头像 URL，但旧 R2 对象如已被传播仍需所有者重新上传并按实际使用情况清理。本轮不删除线上对象。
- Resend 返回错误时登录和联系接口明确失败；审核通知发送失败仍保留待审评论，避免将通知故障误判为评论通过。

## TypeScript 7

后端使用 TS7.0.2。迁移时相同源码下，预热后交替运行六轮 `--noEmit`：TS5.9.3 中位 787.5 ms，TS7.0.2 中位 206.5 ms。该机器上的类型检查约快 3.8 倍，不代表 Wrangler 打包、运行时或前端构建同样加速。

前端独立使用 TS6，保留 Astro 类型检查所需编程 API。不要把两个仓库的 TypeScript 依赖强行统一。

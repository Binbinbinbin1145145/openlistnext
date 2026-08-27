import { Hono } from "hono"
import { setupRouter } from "./server/router"
import { rawRouter } from "./server/raw"
import { setEnvCtx } from "./internal/model/db"

const app = new Hono()

app.use("*", async (c, next) => {
  // 关键：每个请求注入 KV binding 上下文（CF Workers 多实例/冷启动时
  // 模块级 globalEnvCtx 为 null，会导致 getDb()/saveDb() 退回内存模式，
  // 网盘账号密码与 access_token 无法从 KV 持久化读取）
  setEnvCtx(c.env)
  await next()
})

// 在 Serverless 环境中，所有逻辑都是无状态的且由请求触发。
// 这里不应该初始化任何常驻的后台任务 (如 Cron 或 线程池)。

// 挂载 API 到 /api
const api = new Hono()
setupRouter(api)
app.route("/api", api)

// Mount specific short paths at root for better compatibility
app.route("/d", rawRouter)
app.route("/sd", rawRouter)
app.route("/p", rawRouter)

// SPA 兜底 HTML（由 EdgeOne 入口 api/_makers.ts 在构建期注入 dist/index.html；
// 其他平台入口不注入，保持原有 ASSETS / 404 行为）
let spaFallbackHtml: string | null = null

export function setSpaFallbackHtml(html: string) {
  spaFallbackHtml = html
}

// ============================================
// 修改点：SPA 回退逻辑重构
// ============================================
app.all("*", async (c) => {
  const url = new URL(c.req.url)
  const env = c.env as any

  // 1. API 请求直接跳过（让 Hono 路由处理）
  if (url.pathname.startsWith('/api/')) {
    return c.text('Not Found', 404)
  }

  // 2. 处理 GET/HEAD 请求
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    // 优先使用 ASSETS 绑定（Cloudflare Workers 环境）
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const assetRes = await env.ASSETS.fetch(c.req.raw)

      // 如果找到的是具体静态文件（JS/CSS/图片等），直接返回
      if (assetRes.status === 200) {
        // 判断是否为静态资源文件（带扩展名）
        const isStaticFile = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map)$/.test(url.pathname)
        if (isStaticFile) {
          return assetRes
        }
        
        // 如果是 / 或 /index.html，设置 no-cache 后返回
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const headers = new Headers(assetRes.headers)
          headers.set("Cache-Control", "no-cache, must-revalidate")
          return new Response(assetRes.body, { status: assetRes.status, headers })
        }
      }

      // 【核心修改】所有其他情况（包括 404、带 @ 的特殊路径、/manage 等）
      // 都返回 index.html，让前端路由接管
      const indexReq = new Request(`${url.origin}/index.html`, c.req.raw)
      const indexRes = await env.ASSETS.fetch(indexReq)
      
      // 对 index.html 强制设置 no-cache
      const headers = new Headers(indexRes.headers)
      headers.set("Cache-Control", "no-cache, must-revalidate")
      return new Response(indexRes.body, { status: 200, headers })
    }

    // 3. 兜底：EdgeOne 等无 ASSETS 的环境，使用内联 HTML
    if (spaFallbackHtml) {
      return c.body(spaFallbackHtml, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, must-revalidate",
      })
    }
  }

  // 其他情况返回 404
  return c.text("404 Not Found", 404)
})

export default app

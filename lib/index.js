/**
 * dsh-session-move（宿主侧）—— 给 Web 客户端提供“把会话移动到另一个工作区”。
 *
 * 只注册一条同源 HTTP 路由，不替换官方任何服务：
 *   GET  /api/dsh-session-move?sessionId=<id>   读取工作区列表与这条会话的当前归属
 *   POST /api/dsh-session-move                   { action: "move", sessionId, workspaceId | targetPath, title? }
 *
 * @module dsh-session-move
 */

import { applyPendingMoves, listState, listWorkspaces, moveSession, readPendingMoves } from "./engine.js";
import { applyFolderAction, foldersSnapshot } from "./folders.js";

const ROUTE = "/api/dsh-session-move";
const MAX_BODY = 64 * 1024;

/** 需要的宿主服务；其余（sessions / sessionQuery / sessionController）按需可选取用。 */
export const inject = ["webServer", "workspaceRegistry", "sessionPersistence"];

function json(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopback(value) {
  const address = String(value ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return address === "localhost" || address === "localhost." || address === "::1"
    || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** 同源 + 本机 才接受写请求；跨站页面拿不到 loopback 的 Host/Origin 组合。 */
function trusted(request) {
  const site = header(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = header(request, "origin");
  const host = header(request, "host");
  if (origin === undefined || origin === "") {
    if (host === undefined) return false;
    try {
      return isLoopback(new URL("http://" + host).hostname);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopback(url.hostname) && url.host === host;
  } catch {
    return false;
  }
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectBody(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

async function readJson(request) {
  const text = await readBody(request);
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

const message = (error) => (error instanceof Error ? error.message : String(error));

/** 兜底：宿主侧激活失败同样会让整个 web boot 失败，所以异常一律就地吞掉。 */
export function apply(ctx) {
  try {
    return applyPlugin(ctx);
  } catch (error) {
    ctx.logger?.warn?.("session-move: 初始化失败，已跳过本插件功能（不影响 DSH 启动）：" + String(error && error.message ? error.message : error));
    return () => {};
  }
}

function applyPlugin(ctx) {
  // 幂等保护：生态里的插件市场会对同一插件再跑一次 apply（热启用/重启激活），
  // 那时 webServer 会因为“重复的 exact 路由”抛错，把整个插件判成失败 —— 这里就地兜住。
  // （同类问题真实发生过：dsh-plugin-wallpaper-engine 的 "/wallpaper-engine/inventory"。）
  let dispose = () => {};
  try {
    dispose = ctx.webServer.register({
    kind: "exact",
    path: ROUTE,
    handler: async (request, response) => {
      try {
        if (request.method === "GET" || request.method === "HEAD") {
          const url = new URL(request.url ?? ROUTE, "http://localhost");
          const sessionId = url.searchParams.get("sessionId") ?? undefined;
          if (url.searchParams.get("view") === "folders") {
            if (request.method === "HEAD") {
              response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              response.end();
              return;
            }
            json(response, 200, { ok: true, ...(await foldersSnapshot(ctx.sessionPersistence)) });
            return;
          }
          const state = sessionId === undefined
            ? { workspaces: listWorkspaces(ctx), currentWorkspaceId: null }
            : await listState(ctx, sessionId);
          if (request.method === "HEAD") {
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            response.end();
            return;
          }
          const pending = await readPendingMoves(ctx.sessionPersistence).catch(() => []);
          json(response, 200, { ok: true, pending: pending.length, ...state });
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "GET, HEAD, POST" });
          response.end();
          return;
        }
        if (!trusted(request)) {
          json(response, 403, { ok: false, error: "已拒绝非本机同源请求。" });
          return;
        }
        const body = await readJson(request);
        if (body?.action === "move") {
          const result = await moveSession(ctx, body);
          ctx.logger?.info?.(result.deferred === true
            ? "session-move: 已登记待办移动 " + result.sessionId
            : "session-move: moved " + result.sessionId + " -> " + result.to);
          json(response, 200, result);
          return;
        }
        if (body?.action === "ping") {
          json(response, 200, { ok: true, plugin: "dsh-session-move" });
          return;
        }
        if (body?.action === "folder") {
          const result = await applyFolderAction(ctx.sessionPersistence, body);
          json(response, 200, { ok: true, ...result, ...(await foldersSnapshot(ctx.sessionPersistence)) });
          return;
        }
        json(response, 400, { ok: false, error: "未知操作：" + String(body?.action) });
      } catch (error) {
        ctx.logger?.warn?.("session-move: " + message(error));
        json(response, 200, { ok: false, error: message(error) });
      }
    }
    });
    ctx.logger?.info?.("session-move: /api/dsh-session-move ready");
  } catch (error) {
    // 已经有同路径路由（本插件被激活了第二次）：沿用旧的那条，不再注册，也不报失败。
    ctx.logger?.warn?.("session-move: 路由已存在，跳过重复注册：" + message(error));
  }

  // 启动时补做上次登记的移动：等到宿主把 agents / sessionController 都挂好再动手，
  // 失败就重试几次（此刻页面还没连上来，会话都是冷的）。
  let attempts = 0;
  let cancelled = false;
  let timer;
  const runPending = async () => {
    if (cancelled) return;
    try {
      const result = await applyPendingMoves(ctx);
      if (result.remaining > 0 && attempts < 3) {
        attempts += 1;
        timer = setTimeout(() => {
          void runPending();
        }, 2500);
      }
    } catch (error) {
      ctx.logger?.warn?.("session-move: 待办移动处理失败：" + message(error));
    }
  };
  timer = setTimeout(() => {
    void runPending();
  }, 1200);

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    dispose();
  };
}

/**
 * 会话移动引擎 —— 把一条会话的工作目录（cwd）迁到目标工作区，并用宿主 API 完成归属记账。
 *
 * 为什么这么做：DSH 里“会话属于哪个工作区”完全由会话日志头部里的 cwd 决定，
 * workspaceRegistry.attachSession() 会拿 cwd 和工作区路径比对，不一致就拒绝；
 * 日志在磁盘上的位置也由 cwd 推导，位置与头部 cwd 不符会被判为损坏。
 * 内核没有“移动会话”的接口，所以要做两件事：
 *   1) 离线数据手术：重写日志第 1 个 zstd 帧（头部）里的 cwd，并把会话目录搬到
 *      新 cwd 对应的项目目录下；事件帧逐字节不动。
 *   2) 用宿主 API 记账：让宿主重新认识这条会话的新 cwd（观察/接管），再
 *      attachSession() 到目标工作区、从旧工作区摘除。
 * 归一步骤失败时回滚文件，保证不会留下“文件动了、归属没动”的中间态。
 *
 * @module dsh-session-move/engine
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { constants as ZC, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216;
const LOG_NAME_RE = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;
const CHECKSUM = { params: { [ZC.ZSTD_c_checksumFlag]: 1 } };
const MAX_ID = 1024;

/** 内核 encodeSegment：把任意字符串编码成一个安全路径段。 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("空路径段");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

/** 内核 projectKey：cwd -> sessions 下的项目目录名。与 jsonl 持久化实现一致。 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("空工作目录");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + ((readable.replace(/^-+/, "") || "root").slice(0, 251)) + "--";
}

/** 内核 scanZstdFrames：不接压定位完整 zstd 帧。 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("日志不是完整的 zstd 帧（偏移 " + offset + "）");
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("zstd 帧头保留位异常");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remaining = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remaining) return { frames, tornStart: start };
    offset += remaining;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("zstd 保留块类型");
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 解码一份会话日志（zstd 多帧或明文）。 */
function decodeLog(bytes, compressed) {
  if (!compressed) return { text: bytes.toString("utf8"), frames: [{ start: 0, end: bytes.length }] };
  const { frames, tornStart } = scanZstdFrames(bytes);
  if (tornStart !== undefined) throw new Error("日志末尾有未写完的 zstd 帧，先让 DSH 修完再移动");
  const chunks = [];
  for (const frame of frames) chunks.push(zstdDecompressSync(bytes.subarray(frame.start, frame.end)));
  return { text: Buffer.concat(chunks).toString("utf8"), frames };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** 生成改过 cwd 的新日志字节；事件帧逐字节不变，并立刻自检。 */
function rewriteLog(bytes, compressed, sessionId, newCwd) {
  const { text, frames } = decodeLog(bytes, compressed);
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1) throw new Error("日志没有换行，头部不完整");
  const header = JSON.parse(text.slice(0, firstNewline));
  const rest = text.slice(firstNewline + 1);
  if (header?.type !== "session") throw new Error("日志第一行不是会话头部");
  if (header.id !== sessionId) throw new Error("日志头部 id 与要移动的会话不一致");
  const headBytes = Buffer.from(JSON.stringify({ ...header, cwd: newCwd }) + "\n", "utf8");
  const next = compressed
    ? Buffer.concat([zstdCompressSync(headBytes, CHECKSUM), ...frames.slice(1).map((frame) => bytes.subarray(frame.start, frame.end))])
    : Buffer.concat([headBytes, Buffer.from(rest, "utf8")]);
  const verified = decodeLog(next, compressed);
  const breakAt = verified.text.indexOf("\n");
  const verifiedHeader = JSON.parse(verified.text.slice(0, breakAt));
  if (verifiedHeader.id !== sessionId || verifiedHeader.cwd !== newCwd) throw new Error("自检失败：新日志头部不正确");
  if (verified.text.slice(breakAt + 1) !== rest) throw new Error("自检失败：新日志正文与原文不一致");
  return { bytes: next, header };
}

function sessionsRoot(persistence) {
  const root = persistence?.root ?? persistence?.config?.root;
  if (typeof root !== "string" || root.length === 0) throw new Error("无法确定会话存储目录（sessionPersistence.root 不可用）");
  return resolve(root);
}

function artifactPath(persistence, header) {
  const location = typeof persistence?.locate === "function" ? persistence.locate(header) : undefined;
  if (location === undefined || typeof location.path !== "string" || location.path.length === 0) {
    throw new Error("当前会话存储后端不支持定位会话文件");
  }
  return location.path;
}

function checkedId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new Error("会话 ID 无效");
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function disposeLease(lease) {
  if (lease === undefined || lease === null) return;
  const dispose = typeof lease[Symbol.dispose] === "function" ? lease[Symbol.dispose] : lease.dispose;
  if (typeof dispose === "function") dispose.call(lease);
}

/** 工作区列表（供选择器与状态接口使用）。 */
export function listWorkspaces(ctx) {
  return ctx.workspaceRegistry.list().map((workspace) => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessions: workspace.sessionIds.length,
    missing: false
  }));
}

/** 选择器需要的一份状态：工作区 + 这条会话当前归属 + 它的待办移动。 */
export async function listState(ctx, sessionId) {
  const workspaces = listWorkspaces(ctx);
  const current = sessionId === undefined
    ? undefined
    : workspaces.find((workspace) => ctx.workspaceRegistry.get(workspace.id)?.sessionIds.includes(sessionId));
  for (const workspace of workspaces) {
    try {
      workspace.missing = (await fsp.stat(workspace.path)).isDirectory() !== true;
    } catch {
      workspace.missing = true;
    }
  }
  const pendingMoves = sessionId === undefined
    ? []
    : (await readPendingMoves(ctx.sessionPersistence).catch(() => [])).filter((item) => item.sessionId === sessionId);
  return { workspaces, currentWorkspaceId: current?.id ?? null, pendingMoves };
}

/** 解析请求里的目标：已有工作区 id / 已登记路径 / 新目录（自动登记）。 */
async function resolveTarget(ctx, request) {
  const registry = ctx.workspaceRegistry;
  if (typeof request.workspaceId === "string" && request.workspaceId.length > 0) {
    const workspace = registry.get(request.workspaceId);
    if (workspace === undefined) throw new Error("目标工作区不存在");
    return workspace;
  }
  if (typeof request.targetPath === "string" && request.targetPath.length > 0) {
    // 用户明确输入的目录：不存在就建出来（和「添加工作区」里新建文件夹同样的效果）。
    const raw = resolve(request.targetPath);
    const existed = await fsp.stat(raw).then((value) => value.isDirectory(), () => false);
    if (!existed) await fsp.mkdir(raw, { recursive: true });
    const canonical = await fsp.realpath(raw).catch(() => {
      throw new Error("目标目录不可用：" + raw);
    });
    const existing = await registry.resolveByPath(canonical);
    if (existing !== undefined) return existing;
    // 没给标题时用目录名，别让侧栏出现一长串路径。
    const title = typeof request.title === "string" && request.title.trim().length > 0
      ? request.title.trim()
      : basename(canonical) || undefined;
    return registry.create(canonical, title);
  }
  throw new Error("缺少目标工作区");
}

/** 让宿主重新读到这条会话的新 cwd，然后把会话挂到目标工作区。 */
async function attachToWorkspace(ctx, sessionId, workspace) {
  const sessions = ctx.get?.("sessions");
  const prepared = sessions?.get?.(sessionId);
  if (prepared !== undefined) {
    // 内存里可能还留着旧的“已准备”会话（头部是旧 cwd），先让它离开。
    try {
      const entry = sessions.liveEntryFor?.(prepared);
      if (entry !== undefined) sessions.detachEntered(entry);
    } catch {
      /* 摘不掉就交给后面的观察重新读取 */
    }
  }
  // 首选：自己恢复一次会话（此刻头部 cwd 已是目标目录），挂好工作区后立刻释放。
  // 这样不会把会话长期留在内存里，之后还能再次移动它。
  const agents = ctx.get?.("agents");
  if (typeof agents?.resume === "function") {
    let agentOptions;
    try {
      const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
      if (selection !== undefined && selection !== null) agentOptions = { provider: selection.provider, model: selection.model };
    } catch {
      /* 没有默认模型也不影响归属写入 */
    }
    const handle = await agents.resume({
      resumeSessionId: sessionId,
      ...(agentOptions === undefined ? {} : { agentOptions })
    });
    try {
      await workspace.attachSession(sessionId);
      return "resume";
    } finally {
      try {
        await handle?.dispose?.();
      } catch {
        /* 释放失败只是让会话留在内存里，不影响归属 */
      }
    }
  }
  // 退路：官方入口。显式 id 的 session.create 会按磁盘现状读取这条会话并接管它。
  const controller = ctx.get?.("sessionController");
  if (typeof controller?.create === "function") {
    await controller.create({ sessionId, workspaceId: workspace.id });
    return "adopt";
  }
  // 退路：用观察接口按磁盘现状装载会话，再自己挂到工作区。
  const query = ctx.get?.("sessionQuery");
  if (typeof query?.observeSession === "function") {
    const lease = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      await workspace.attachSession(sessionId);
      return "observe";
    } finally {
      disposeLease(lease);
    }
  }
  throw new Error("宿主没有可用的会话归属接口（sessionController / sessionQuery 都不可用）");
}

/**
 * 确认目标工作区的目录可用；不存在就先新建一个同名空目录，再继续搬。
 *
 * 目录被 DSH 之外的操作删掉/改名时，宿主的 cwd 索引解析不了这条会话的工作目录，
 * 工作区的 sessionIds 会把它过滤成空（侧栏里它变成“未分组”），attachSession 也会因为
 * realpath 失败而拒绝 —— 所以目录必须先回来，否则移动只会得到一句“目录不存在”。
 * 默认行为就是“先建目录、再移动”；只有请求里显式写了 createMissingDir: false 才报错。
 * @returns 是否新建了目录（用于给用户看的明细）。
 */
async function prepareTargetDirectory(workspace, createMissing) {
  const target = workspace.path;
  const stat = await fsp.stat(target).catch(() => undefined);
  if (stat !== undefined && stat.isDirectory()) return false;
  if (stat !== undefined) throw new Error("目标路径不是一个目录：" + target);
  if (createMissing === false) {
    throw new Error("工作区「" + (workspace.title ?? target) + "」的目录不存在：" + target
      + "\n  这次勾掉了「目录不存在时自动新建同名目录」，所以没有替你建。"
      + "\n  · 想让它自己建：勾上再移动一次；"
      + "\n  · 目录已经改名：用下面的「移动到新目录」填真正的路径。");
  }
  await fsp.mkdir(target, { recursive: true });
  const after = await fsp.stat(target).catch(() => undefined);
  if (after === undefined || !after.isDirectory()) throw new Error("无法新建目标目录：" + target);
  return true;
}

/**
 * 让宿主重新认一遍“这条会话的 cwd 就是目标工作区”。
 *
 * 宿主的 cwd 索引只在启动时建一次：目录当时不存在，索引里就记成“解析不了”，工作区的
 * sessionIds 会把这个 id 过滤掉（侧栏显示“未分组”）；之后再建好目录，attachSession 又会
 * 因为“记录里已经有这个 id”直接跳过校验，索引永远修不好。先摘再挂能逼它重新 realpath 一次。
 * 只在路径确实对得上时才做，避免把工作区归属弄丢。
 * @returns 是否做过“摘了再挂”的修复。
 */
async function revalidateMembership(workspace, sessionId, cwd) {
  if (workspace.sessionIds.includes(sessionId)) return false;
  const real = await fsp.realpath(cwd).catch(() => undefined);
  if (real === undefined || real !== workspace.path) return false;
  await workspace.detachSession(sessionId);
  await workspace.attachSession(sessionId);
  return workspace.sessionIds.includes(sessionId);
}

/**
 * 会话当前是否被宿主占着。
 * - "running"：有回合在跑；
 * - "open"：会话已经在宿主里打开（空闲，但持有日志写入句柄）。
 * 两种情况都不能改写日志：前者不能打断，后者的写入句柄还指着旧路径。
 * @returns "cold" | "open" | "running"
 */
export function sessionState(ctx, sessionId) {
  const agent = ctx.get?.("agents")?.get?.(sessionId);
  if (agent === undefined) {
    // 内存里没有 agent，但可能有“已准备”的会话条目（只读观察留下的）
    return ctx.get?.("sessions")?.get?.(sessionId) === undefined ? "cold" : "open";
  }
  return agent.status === "running" ? "running" : "open";
}

/** 尽力释放一个空闲会话（多数情况下 DSH 不给第三方释放，失败就交给“重启后自动完成”）。 */
async function tryReleaseOpenSession(ctx, sessionId) {
  const agent = ctx.get?.("agents")?.get?.(sessionId);
  if (agent !== undefined && agent.status !== "running") {
    const fiber = agent?.ctx?.fiber;
    if (fiber?._unload !== undefined) {
      try {
        await fiber._unload();
      } catch {
        /* 卸载失败就让下面的复查决定 */
      }
    }
  }
  const entry = ctx.get?.("sessions")?.store?.get?.(sessionId);
  if (entry?.detach !== undefined) {
    try {
      entry.detach();
    } catch {
      /* 已经不在内存里就算了 */
    }
  }
  return sessionState(ctx, sessionId) === "cold";
}

/* ------------------------------------------------------- 待办移动（重启后自动完成） */

/** 待办移动的落盘位置：DSH 数据目录下的 storages/。 */
function pendingFile(persistence) {
  return join(dirname(sessionsRoot(persistence)), "storages", "session-move-pending.json");
}

/** 读取待办移动记录。 */
export async function readPendingMoves(persistence) {
  try {
    const parsed = JSON.parse(await fsp.readFile(pendingFile(persistence), "utf8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter((item) => item !== null && typeof item === "object" && typeof item.sessionId === "string");
  } catch {
    return [];
  }
}

async function writePendingMoves(persistence, items) {
  const file = pendingFile(persistence);
  if (items.length === 0) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ version: 1, items }, null, 2) + "\n", "utf8");
}

/** 把一次移动登记成待办（同一会话只保留最新一条）。 */
async function deferMove(ctx, request, sessionId) {
  const persistence = ctx.sessionPersistence;
  const items = (await readPendingMoves(persistence)).filter((item) => item.sessionId !== sessionId);
  items.push({
    sessionId,
    workspaceId: typeof request.workspaceId === "string" ? request.workspaceId : null,
    targetPath: typeof request.targetPath === "string" ? request.targetPath : null,
    title: typeof request.title === "string" ? request.title : null,
    // 目标目录不存在时是否新建：默认新建（只有用户显式关掉才不建），重放时照做。
    createMissingDir: request.createMissingDir !== false,
    at: new Date().toISOString()
  });
  await writePendingMoves(persistence, items);
  return { count: items.length };
}

/** 移动成功后清掉同一条会话的待办记录（否则下次启动会把它再重放一遍）。 */
async function clearPendingMoves(persistence, sessionId) {
  const items = await readPendingMoves(persistence);
  if (!items.some((item) => item.sessionId === sessionId)) return;
  await writePendingMoves(persistence, items.filter((item) => item.sessionId !== sessionId));
}

/** 待办重放前先看它是不是其实已经做完了（cwd 已是目标路径、工作区也还记着它）。 */
async function isMoveSatisfied(ctx, item) {
  if (typeof item.workspaceId !== "string") return false;
  const workspace = ctx.workspaceRegistry.get(item.workspaceId);
  if (workspace === undefined) return false;
  const snapshot = await ctx.sessionPersistence.stat(item.sessionId).catch(() => undefined);
  if (snapshot === undefined) return false;
  const cwd = snapshot.header.cwd;
  if (typeof cwd !== "string" || cwd.toLowerCase() !== workspace.path.toLowerCase()) return false;
  // sessionIds 是过滤后的视图：目录不见了它就是空的，这里当然不算“已完成”。
  return workspace.sessionIds.includes(item.sessionId);
}

/**
 * 启动时补做上次登记的移动 —— 此刻所有会话都是冷的，一定能改。
 *
 * 失败不再“攒够 3 次就丢掉”：把失败原因写回待办记录，界面能直接告诉用户上次为什么没成，
 * 用户把目录准备好之后下次启动还会自动重试。
 * @returns 统计信息，便于日志。
 */
export async function applyPendingMoves(ctx) {
  const persistence = ctx.sessionPersistence;
  const items = await readPendingMoves(persistence);
  if (items.length === 0) return { applied: 0, failed: 0, remaining: 0 };
  const remaining = [];
  const appliedIds = new Set();
  let applied = 0;
  let failed = 0;
  for (const item of items) {
    try {
      // 已经做成的直接清掉：以前这种记录会在每次启动时重放并失败（“已经在里面了”），
      // 攒够 3 次就被当成放弃删掉，看起来就像“移动莫名其妙没了”。
      if (await isMoveSatisfied(ctx, item)) {
        appliedIds.add(item.sessionId);
        ctx.logger?.info?.("session-move: 待办移动其实已经完成，清除记录 " + item.sessionId);
        continue;
      }
      if (sessionState(ctx, item.sessionId) !== "cold") {
        remaining.push(item);
        continue;
      }
      await moveSession(ctx, {
        sessionId: item.sessionId,
        ...(item.workspaceId === null || item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }),
        ...(item.targetPath === null || item.targetPath === undefined ? {} : { targetPath: item.targetPath }),
        ...(item.title === null || item.title === undefined ? {} : { title: item.title }),
        // 旧记录没有这个字段：默认“目录没了就先建出来再搬”，
        // 否则这条待办只会永远失败。
        createMissingDir: item.createMissingDir !== false
      });
      applied += 1;
      appliedIds.add(item.sessionId);
      ctx.logger?.info?.("session-move: 启动时完成待办移动 " + item.sessionId);
    } catch (error) {
      failed += 1;
      const tries = (typeof item.attempts === "number" ? item.attempts : 0) + 1;
      ctx.logger?.warn?.("session-move: 待办移动失败(" + tries + ") " + item.sessionId + "：" + message(error));
      remaining.push({ ...item, attempts: tries, lastError: message(error), lastTriedAt: new Date().toISOString() });
    }
  }
  // 处理期间可能又登记了新的待办（moveSession 自己也会 defer），把它们并进来；
  // 已经成功的不再保留。
  const after = await readPendingMoves(persistence);
  for (const item of after) {
    if (appliedIds.has(item.sessionId)) continue;
    if (remaining.some((kept) => kept.sessionId === item.sessionId)) continue;
    remaining.push(item);
  }
  await writePendingMoves(persistence, remaining);
  return { applied, failed, remaining: remaining.length };
}

async function rollbackMove(moved) {
  if (moved === undefined) return;
  try {
    await fsp.mkdir(moved.fromDir, { recursive: true });
    await fsp.writeFile(moved.fromFile, moved.original);
    await fsp.rm(moved.toFile, { force: true });
    await fsp.rmdir(moved.toDir).catch(() => {});
  } catch {
    /* 回滚失败时保留现场，交给人工处理（文件仍在目标目录） */
  }
}

/**
 * 把一条会话移动到目标工作区。
 * @param ctx - 宿主上下文（需要 workspaceRegistry 与 sessionPersistence）。
 * @param request - { sessionId, workspaceId | targetPath, title? }
 * @returns 结果摘要，供界面提示。
 */
export async function moveSession(ctx, request) {
  const sessionId = checkedId(request?.sessionId);
  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;
  const detail = [];
  // 目录不存在时先自动新建同名目录，再搬会话；只有显式传 false 才保持“报错不建”。
  const createMissingDir = request?.createMissingDir !== false;

  // 先把“这次移动到底能不能做”全部查清楚，再决定直接做还是登记成待办。
  // 以前是先看会话开没开、开着就记待办：目标目录不存在也会回一句“已登记”，
  // 重启后必然失败，用户只看到“移动失败”，却拿不到任何能照做的线索。
  const state = sessionState(ctx, sessionId);
  if (state === "running") throw new Error("这条会话正在运行（有回合在跑），先结束后再移动。");

  const snapshot = await persistence.stat(sessionId);
  if (snapshot === undefined) throw new Error("找不到这条会话。");
  const header = snapshot.header;
  if (header.origin === "subagent") throw new Error("子代理会话不能移动。");
  const oldCwd = header.cwd;
  if (typeof oldCwd !== "string" || oldCwd.length === 0) throw new Error("这条会话没有记录工作目录，无法移动。");

  const target = await resolveTarget(ctx, request);
  const newCwd = target.path;
  const current = registry.list().find((workspace) => workspace.sessionIds.includes(sessionId));
  const alreadyThere = oldCwd.toLowerCase() === newCwd.toLowerCase();
  if (alreadyThere && current?.id === target.id) throw new Error("这条会话已经在「" + target.title + "」里了。");

  if (await prepareTargetDirectory(target, createMissingDir)) detail.push("目标目录原本不存在，已自动新建：" + newCwd);

  if (state === "open") {
    const freed = await tryReleaseOpenSession(ctx, sessionId);
    if (!freed) {
      // 宿主没提供关闭会话的接口：把这次移动登记下来，等下次启动（会话都是冷的）再自动完成。
      const pending = await deferMove(ctx, { ...request, createMissingDir }, sessionId);
      return {
        ok: true,
        deferred: true,
        sessionId,
        pending: pending.count,
        detail: ["会话在对话页开着，宿主不允许在打开时改工作目录；已登记为待办移动，重启 DSH 后自动完成。"]
      };
    }
  }

  let moved;
  if (!alreadyThere) {
    const root = sessionsRoot(persistence);
    const fromFile = artifactPath(persistence, header);
    const logName = basename(fromFile);
    if (!LOG_NAME_RE.test(logName)) throw new Error("会话日志文件名无法识别：" + logName);
    const fromDir = dirname(fromFile);
    const toDir = join(root, projectKey(newCwd), encodeSegment(sessionId));
    const toFile = join(toDir, logName);
    if (await fsp.stat(toDir).then(() => true, () => false)) throw new Error("目标位置已有同名会话目录：" + toDir);

    const original = await fsp.readFile(fromFile);
    const nextLog = rewriteLog(original, logName.endsWith(".zstd"), sessionId, newCwd);
    await fsp.mkdir(toDir, { recursive: true });
    const temp = join(toDir, ".move-" + randomUUID());
    await fsp.writeFile(temp, nextLog.bytes);
    await fsp.rename(temp, toFile);
    const written = await fsp.readFile(toFile);
    if (sha256(written) !== sha256(nextLog.bytes)) throw new Error("写入的新日志与预期不一致");
    const decoded = decodeLog(written, logName.endsWith(".zstd"));
    if (JSON.parse(decoded.text.slice(0, decoded.text.indexOf("\n"))).cwd !== newCwd) throw new Error("新日志头部校验失败");
    await fsp.rm(fromFile);
    await fsp.rmdir(fromDir).catch(() => {});
    moved = { fromFile, fromDir, toFile, toDir, original };
    detail.push("日志目录：" + fromDir + " → " + toDir);
  } else {
    detail.push("日志已经在目标目录，只补工作区归属。");
  }

  try {
    if (alreadyThere) {
      // cwd 本来就是目标路径：不用把会话恢复起来，只把归属补好（必要时顺手修宿主的 cwd 索引）。
      const repaired = await revalidateMembership(target, sessionId, oldCwd);
      if (!repaired) await target.attachSession(sessionId);
      detail.push("已挂到「" + target.title + "」" + (repaired ? "（并刷新了宿主的目录索引）" : ""));
    } else {
      const how = await attachToWorkspace(ctx, sessionId, target);
      detail.push("已挂到「" + target.title + "」" + (how === "adopt" ? "（接管）" : ""));
    }
  } catch (error) {
    await rollbackMove(moved);
    throw new Error("会话归属更新失败：" + message(error));
  }

  if (current !== undefined && current.id !== target.id) {
    try {
      await current.detachSession(sessionId);
      detail.push("已从「" + current.title + "」摘除");
    } catch (error) {
      detail.push("旧工作区摘除失败（可忽略）：" + message(error));
    }
  }

  // 这次已经做成了，之前挂着的同一条待办就没必要再重放一遍。
  await clearPendingMoves(persistence, sessionId).catch(() => {});

  return { ok: true, deferred: false, sessionId, from: oldCwd, to: newCwd, workspace: { id: target.id, title: target.title }, detail };
}

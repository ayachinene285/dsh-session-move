/**
 * 工作区“文件夹”（分组）模型 —— 侧栏里可以随便建的层级容器。
 *
 * 官方 Workspace 只认目录，没有父子概念；文件夹完全由本插件维护：
 *   <DSH 数据目录>/storages/session-move-folders.json
 *   {
 *     "version": 1,
 *     "folders": { "<folderId>": { "id", "name", "createdAt", "updatedAt" } },
 *     "containers": { "root": [ {"kind":"folder"|"workspace","id"} ], "<folderId>": [ ... ] }
 *   }
 * 规则：文件夹可以套文件夹、可以放工作区；工作区不能当父级（根本不存在这个容器）。
 *
 * @module dsh-session-move/folders
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { dirname, join } from "node:path";

const NAME_MAX = 120;
// ref 的三种类型：文件夹、工作区、以及「直接挂在文件夹下的会话」（纯侧栏分组，不改 cwd）。
const KINDS = new Set(["folder", "workspace", "session"]);

function storeFile(persistence) {
  const root = persistence?.root ?? persistence?.config?.root;
  if (typeof root !== "string" || root.length === 0) throw new Error("无法确定 DSH 数据目录（sessionPersistence.root 不可用）");
  return join(dirname(root), "storages", "session-move-folders.json");
}

const emptyState = () => ({ version: 1, folders: {}, containers: { root: [] } });

/** 规范化一次：丢掉不认识的引用、重复引用和孤儿文件夹。 */
function normalize(raw) {
  const state = emptyState();
  const source = raw !== null && typeof raw === "object" ? raw : {};
  const folders = source.folders !== null && typeof source.folders === "object" ? source.folders : {};
  for (const [id, value] of Object.entries(folders)) {
    if (value === null || typeof value !== "object") continue;
    if (typeof id !== "string" || id.length === 0) continue;
    state.folders[id] = {
      id,
      name: typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim().slice(0, NAME_MAX) : "文件夹",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
    };
  }
  const containers = source.containers !== null && typeof source.containers === "object" ? source.containers : {};
  const seenWorkspaces = new Set();
  const seenFolders = new Set();
  const seenSessions = new Set();
  const readContainer = (key) => {
    const list = Array.isArray(containers[key]) ? containers[key] : [];
    const out = [];
    for (const ref of list) {
      if (ref === null || typeof ref !== "object") continue;
      const kind = ref.kind;
      const id = ref.id;
      if (!KINDS.has(kind) || typeof id !== "string" || id.length === 0) continue;
      if (kind === "folder") {
        if (state.folders[id] === undefined || seenFolders.has(id) || id === key) continue;
        seenFolders.add(id);
      } else if (kind === "workspace") {
        if (seenWorkspaces.has(id)) continue;
        seenWorkspaces.add(id);
      } else {
        if (seenSessions.has(id)) continue;
        seenSessions.add(id);
      }
      out.push({ kind, id });
    }
    return out;
  };
  state.containers.root = readContainer("root");
  for (const id of Object.keys(state.folders)) state.containers[id] = readContainer(id);
  return state;
}

/** 读取文件夹状态。 */
export async function readFolderState(persistence) {
  try {
    return normalize(JSON.parse(await fsp.readFile(storeFile(persistence), "utf8")));
  } catch {
    return emptyState();
  }
}

async function writeFolderState(persistence, state) {
  const file = storeFile(persistence);
  await fsp.mkdir(dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

const containerOf = (state, folderId) => state.containers[folderId] ?? state.containers.root;
const isInside = (state, folderId, candidateId) => {
  let current = candidateId;
  let guard = 0;
  while (current !== undefined && current !== null && guard < 200) {
    if (current === folderId) return true;
    const parent = Object.keys(state.containers).find((key) => key !== "root" && state.containers[key].some((ref) => ref.kind === "folder" && ref.id === current));
    current = parent === "root" ? undefined : parent;
    guard += 1;
  }
  return false;
};

const findRef = (state, kind, id) => {
  for (const [containerId, list] of Object.entries(state.containers)) {
    const index = list.findIndex((ref) => ref.kind === kind && ref.id === id);
    if (index !== -1) return { containerId, index };
  }
  return undefined;
};

const removeRef = (state, kind, id) => {
  for (const list of Object.values(state.containers)) {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].kind === kind && list[index].id === id) list.splice(index, 1);
    }
  }
};

function checkedName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0) throw new Error("名称不能为空");
  if (name.length > NAME_MAX) throw new Error("名称不能超过 " + NAME_MAX + " 个字符");
  return name;
}

function requireFolder(state, folderId) {
  const folder = state.folders[folderId];
  if (folder === undefined) throw new Error("文件夹不存在");
  return folder;
}

/**
 * 执行一次文件夹/归属变更。
 * @param persistence - sessionPersistence 服务（用于定位数据目录）。
 * @param request - { op, ... }：create / rename / delete / move / place
 * @returns 最新状态摘要。
 */
export async function applyFolderAction(persistence, request) {
  const state = await readFolderState(persistence);
  const op = request?.op;
  const now = () => new Date().toISOString();

  if (op === "create") {
    const name = checkedName(request.name);
    const parentId = typeof request.parentId === "string" && request.parentId.length > 0 ? request.parentId : "root";
    if (parentId !== "root") requireFolder(state, parentId);
    const id = randomUUID();
    state.folders[id] = { id, name, createdAt: now(), updatedAt: now() };
    state.containers[id] = [];
    containerOf(state, parentId).push({ kind: "folder", id });
    await writeFolderState(persistence, state);
    return { folderId: id };
  }

  if (op === "rename") {
    const folder = requireFolder(state, request.folderId);
    folder.name = checkedName(request.name);
    folder.updatedAt = now();
    await writeFolderState(persistence, state);
    return { folderId: folder.id };
  }

  if (op === "delete") {
    const folder = requireFolder(state, request.folderId);
    const at = findRef(state, "folder", folder.id);
    const parentId = at === undefined || at.containerId === "root" ? "root" : at.containerId;
    const parentList = containerOf(state, parentId);
    const children = state.containers[folder.id] ?? [];
    removeRef(state, "folder", folder.id);
    delete state.containers[folder.id];
    delete state.folders[folder.id];
    if (at !== undefined) parentList.splice(Math.min(at.index, parentList.length), 0, ...children);
    else parentList.push(...children);
    await writeFolderState(persistence, state);
    return { removed: folder.id, movedChildren: children.length };
  }

  if (op === "move") {
    const folder = requireFolder(state, request.folderId);
    const parentId = typeof request.parentId === "string" && request.parentId.length > 0 ? request.parentId : "root";
    if (parentId === folder.id) throw new Error("不能把文件夹放进它自己");
    if (parentId !== "root") {
      requireFolder(state, parentId);
      if (isInside(state, folder.id, parentId)) throw new Error("不能把文件夹放进它自己的子目录");
    }
    removeRef(state, "folder", folder.id);
    const list = containerOf(state, parentId);
    const index = Number.isInteger(request.index) ? Math.max(0, Math.min(request.index, list.length)) : list.length;
    list.splice(index, 0, { kind: "folder", id: folder.id });
    folder.updatedAt = now();
    await writeFolderState(persistence, state);
    return { folderId: folder.id, parentId };
  }

  if (op === "place") {
    const workspaceId = request.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("缺工作区 id");
    const folderId = typeof request.folderId === "string" && request.folderId.length > 0 ? request.folderId : "root";
    if (folderId !== "root") requireFolder(state, folderId);
    removeRef(state, "workspace", workspaceId);
    const list = containerOf(state, folderId);
    const index = Number.isInteger(request.index) ? Math.max(0, Math.min(request.index, list.length)) : list.length;
    list.splice(index, 0, { kind: "workspace", id: workspaceId });
    await writeFolderState(persistence, state);
    return { workspaceId, folderId };
  }

  // 会话直接归到文件夹下：只影响侧栏分组，工作区归属（cwd）一个字节都不改。
  if (op === "session.place") {
    const sessionId = request.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("缺会话 id");
    removeRef(state, "session", sessionId);
    const folderId = typeof request.folderId === "string" && request.folderId.length > 0 ? request.folderId : null;
    if (folderId !== null) {
      requireFolder(state, folderId);
      containerOf(state, folderId).push({ kind: "session", id: sessionId });
    }
    await writeFolderState(persistence, state);
    return { sessionId, folderId };
  }

  throw new Error("未知的文件夹操作：" + String(op));
}

/** 给客户端的一份快照。 */
export async function foldersSnapshot(persistence) {
  const state = await readFolderState(persistence);
  return { folders: state.folders, containers: state.containers };
}

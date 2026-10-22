/**
 * dsh-session-move（客户端侧）—— 侧栏「工作区树 + 文件夹」与「移动会话到工作区」。
 *
 * 本插件接管官方 sidebar.workspaces 槽位（priority -1 覆盖优先）：官方浏览器只认
 * “工作区（目录）”，这里在它上面加了一层纯虚拟的“文件夹”分组 —— 文件夹随便建、
 * 可以套文件夹、可以放任意多个工作区；工作区不能当父级。
 *
 * 官方能力全部保留：
 *   - 会话行的「…」菜单仍走官方子槽位 sidebar.workspaces.session.menu.item，
 *     置顶/重命名/fork/归档 以及本插件的“移动到工作区…”照样出现；
 *   - 打开会话 / 新建会话 / 重命名 / 删除工作区走官方 ctx.uiWorkspace 与 ctx.workspaces；
 *   - 新增工作区走官方目录选择器（ctx.uiWorkspace.pickDirectory）。
 *
 * @module dsh-session-move/client
 */

window.__ModuleLoader__.load({
  id: "dsh-session-move",
  factory: (require) => {
    const React = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;
    const Fragment = jsxRuntime.Fragment;
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const module = { exports: {} };
    const exports = module.exports;

    const API = "/api/dsh-session-move";
    const MENU_ITEM_LABEL = "移动到工作区 / 文件夹…";
    const DIALOG_TITLE = "移动会话到…";
    const TREE_KEY = "dsh-session-move.tree.v1";
    const SELECTED_BG = "var(--dsw-alias-fill-secondary, rgba(127,127,127,.14))";
    const DIM = "var(--dsw-alias-label-tertiary, #9ca3af)";
    const SECONDARY = "var(--dsw-alias-label-secondary, #8a8f98)";
    const ERROR = "var(--dsw-alias-state-error-primary, #dc2626)";

    const messageOf = (error) => String((error && error.message) || error);

    const MODAL_CLASS = "dsh-session-move-modal";

    /**
     * 官方 Modal 的 .dialog 宽度写死 min(380px, 100%)，文件夹/工作区这种“两行 + 右侧按钮”的行会被挤爆。
     * 这里注入一小段自己的样式，把本插件的弹窗放宽（只影响带 MODAL_CLASS 的那个弹窗）。
     */
    function ensureModalStyle() {
      try {
        if (typeof document === "undefined" || document === null) return;
        if (document.querySelector("style[data-dsh-session-move]") !== null) return;
        const tag = document.createElement("style");
        tag.setAttribute("data-dsh-session-move", "true");
        tag.textContent = "." + MODAL_CLASS + " { width: min(720px, 100%) !important; }";
        document.head.appendChild(tag);
      } catch (error) {
        console.warn("session-move: 注入弹窗样式失败", error);
      }
    }


    function displayTitleOf(session, id) {
      if (session === undefined || session === null) return id;
      if (typeof session.title === "string" && session.title.length > 0) return session.title;
      if (typeof session.cwd === "string" && session.cwd.length > 0) {
        const parts = session.cwd.split(/[\\/]+/).filter((part) => part.length > 0);
        if (parts.length > 0) return parts[parts.length - 1];
      }
      return id;
    }

    const useStore = (store) => React.useSyncExternalStore(
      (listener) => store.subscribe(listener),
      () => store.getSnapshot(),
      () => store.getSnapshot()
    );

    /* -------------------------------------------------------- 文件夹数据源 */

    function createFolderStore() {
      let state = { phase: "pending", folders: {}, containers: { root: [] } };
      const listeners = new Set();
      const notify = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      };
      const adopt = (data) => {
        state = {
          phase: "ready",
          folders: data.folders !== null && typeof data.folders === "object" ? data.folders : {},
          containers: data.containers !== null && typeof data.containers === "object" ? data.containers : { root: [] }
        };
        notify();
      };
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** 直接用一份宿主返回的快照更新本地状态。 */
        adopt,
        async refresh() {
          const response = await fetch(API + "?view=folders", { headers: { accept: "application/json" } });
          const data = await response.json();
          if (data === null || data === undefined || data.ok !== true) throw new Error((data && data.error) || "读取文件夹失败");
          adopt(data);
        },
        async apply(body) {
          const response = await fetch(API, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ action: "folder", ...body })
          });
          const data = await response.json();
          if (data === null || data === undefined || data.ok !== true) throw new Error((data && data.error) || "操作失败");
          adopt(data);
        }
      };
    }

    /* ------------------------------------------------------------ 展开状态 */

    function loadOpenMap() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(TREE_KEY) ?? "null");
        if (parsed !== null && typeof parsed === "object" && parsed.open !== null && typeof parsed.open === "object") return { ...parsed.open };
      } catch {
        /* 坏数据当没有 */
      }
      return {};
    }

    function saveOpenMap(open) {
      try {
        window.localStorage.setItem(TREE_KEY, JSON.stringify({ open }));
      } catch {
        /* 存不下就算了 */
      }
    }

    /* ------------------------------------------------------------ 通知条 */

    function createNoticeStore() {
      let state = null;
      const listeners = new Set();
      const emit = () => {
        for (const listener of Array.from(listeners)) listener();
      };
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        show(text) {
          state = { text, seq: (state === null ? 0 : state.seq) + 1 };
          emit();
        },
        clear() {
          state = null;
          emit();
        }
      };
    }

    const inject = ["slots", "workspaces", "sessions"];

    /**
     * 兜底：插件激活期间任何异常都就地吞掉。
     * 客户端 loader 对「entry 没有 fiber」是直接判 boot 失败的（会弹"应用无法启动"），
     * 所以这里绝不能让异常逃出去 —— 最坏情况只是本插件功能不可用。
     */
    function apply(ctx) {
      try {
        return applyPlugin(ctx);
      } catch (error) {
        console.warn("session-move: 初始化失败，已跳过本插件功能（不影响 DSH 启动）", error);
        return () => {};
      }
    }

    function applyPlugin(ctx) {
      const folderStore = createFolderStore();
      const noticeStore = createNoticeStore();
      let openMap = loadOpenMap();
      const openListeners = new Set();
      const treeStore = {
        getSnapshot: () => openMap,
        subscribe(listener) {
          openListeners.add(listener);
          return () => openListeners.delete(listener);
        }
      };
      const isOpen = (key, fallback) => (typeof openMap[key] === "boolean" ? openMap[key] : fallback);
      const toggleOpen = (key, fallback) => {
        openMap = { ...openMap, [key]: !isOpen(key, fallback) };
        saveOpenMap(openMap);
        for (const listener of Array.from(openListeners)) listener();
      };

      // 注意：Cordis 上下文里访问未声明的服务属性（ctx.xxx）会直接抛
      // "cannot get property ... without inject"，所以一律走 ctx.get(...) 拿可选服务，
      // 绝不能写 ctx.uiWorkspace / ctx.shortcuts 这种直读。
      const navigation = () => {
        try {
          return ctx.get?.("uiWorkspace");
        } catch {
          return undefined;
        }
      };

      // 桌面版在 Windows 上只给 F12，没有刷新菜单项，Ctrl+R 是不响应的；这里自带一个刷新入口。
      const reloadClient = () => {
        try {
          window.location.reload();
        } catch (error) {
          console.warn("session-move: 刷新界面失败", error);
        }
      };
      const shortcuts = (() => {
        try {
          return ctx.get?.("shortcuts");
        } catch {
          return undefined;
        }
      })();
      if (shortcuts !== undefined && typeof shortcuts.register === "function") {
        const reloadCommand = {
          id: "session-move.reload-ui",
          label: () => "刷新界面（重新加载客户端）",
          aliases: ["reload ui", "刷新界面", "重新加载"],
          regions: ["page", "editable"],
          modals: [],
          resolve: () => {
            reloadClient();
          }
        };
        const reloadKey = { code: "KeyR", modifiers: ["primary", "alt"] };
        // ！这里任何异常都必须就地吞掉：宿主端的快捷键服务会因为「平台不允许 / 保留键 / 与
        // 其它插件默认键冲突」而 throw，而抛进 ctx.effect 会让整个客户端插件被判为 failed，
        // 进而让 DSH 的 web boot 报「entry did not activate」启动失败。
        ctx.effect(() => {
          const attempt = (defaults) => shortcuts.register({ ...reloadCommand, defaults });
          try {
            return attempt({ "desktop:windows": reloadKey, "desktop:macos": reloadKey, "desktop:linux": reloadKey });
          } catch (error) {
            console.warn("session-move: 刷新快捷键未注册（与其它默认键冲突或平台不允许），菜单项仍然可用", error);
          }
          try {
            // 退一步：只登记命令，不占默认键，用户可以在快捷键设置里自己绑。
            return attempt({});
          } catch (error) {
            console.warn("session-move: 刷新命令未登记", error);
            return () => {};
          }
        }, "session-move: reload shortcut");
      }

      folderStore.refresh().catch((error) => {
        console.warn("session-move: 读取文件夹失败", error);
        noticeStore.show("读取文件夹失败：" + messageOf(error));
      });

      /* ---------------------------------------------------- 会话菜单项（移动） */

      function MoveSessionMenuItem(props) {
        const menuState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
        const closeMenu = Array.isArray(menuState) ? menuState[1] : undefined;
        return jsx(primitives.MenuItemButton, {
          icon: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 14 }),
          onSelect: () => {
            if (typeof closeMenu === "function") closeMenu(false);
            openPicker({ sessionId: props.sessionId, displayTitle: props.displayTitle });
            // 弹窗组件挂载后会订阅这个 store；没人订阅说明它压根没挂上（例如客户端与宿主版本不一致），
            // 这时给一句能看懂的提示，而不是"点了没反应"。
            if (pickerListeners.size === 0) {
              console.warn("session-move: 弹窗未挂载，pickerListeners 为空");
              noticeStore.show("移动弹窗没有挂载成功，请完全退出 DSH 后重新打开");
            }
          },
          children: MENU_ITEM_LABEL
        });
      }

      /* ------------------------------------------------- 移动弹窗（官方槽位） */

      let pickerRequest = null;
      let toastState = null;
      const pickerListeners = new Set();
      const emitPicker = () => {
        for (const listener of Array.from(pickerListeners)) {
          try {
            listener();
          } catch {
            /* 忽略 */
          }
        }
      };
      const subscribePicker = (listener) => {
        pickerListeners.add(listener);
        return () => pickerListeners.delete(listener);
      };
      const readPicker = () => pickerRequest;
      const readToast = () => toastState;
      function openPicker(request) {
        pickerRequest = request;
        emitPicker();
      }
      function closePicker() {
        pickerRequest = null;
        emitPicker();
      }
      function showToast(text) {
        toastState = { text, seq: (toastState === null ? 0 : toastState.seq) + 1 };
        emitPicker();
      }
      function clearToast() {
        toastState = null;
        emitPicker();
      }

      function MoveSessionOverlay() {
        const request = React.useSyncExternalStore(subscribePicker, readPicker, readPicker);
        const toast = React.useSyncExternalStore(subscribePicker, readToast, readToast);
        // 目标列表按左侧的文件夹结构展示：文件夹可以展开/收起。
        const folderState = useStore(folderStore);
        const [openFolders, setOpenFolders] = React.useState({});
        const [state, setState] = React.useState({ loading: false, error: null, workspaces: [], currentWorkspaceId: null, pendingMoves: [] });
        const [selected, setSelected] = React.useState(null);
        // 会话也可以直接归到某个文件夹下（纯侧栏分组）：null = 没选文件夹，"" = 移出文件夹回到所属工作区。
        const [selectedFolderId, setSelectedFolderId] = React.useState(null);
        const [manualPath, setManualPath] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const [failure, setFailure] = React.useState(null);
        const [hovered, setHovered] = React.useState(null);
        // 目标工作区的目录被删掉/改名时，是否顺手重建一个空目录（默认重建，否则移动只会报错）。
        const [autoCreate, setAutoCreate] = React.useState(true);
        const sessionId = request === null ? null : request.sessionId;
        const sessionFolderId = (() => {
          const containers = folderState.containers !== null && folderState.containers !== undefined ? folderState.containers : {};
          for (const [containerId, list] of Object.entries(containers)) {
            if (!Array.isArray(list)) continue;
            if (list.some((ref) => ref !== null && ref !== undefined && ref.kind === "session" && ref.id === sessionId)) {
              return containerId === "root" ? "" : containerId;
            }
          }
          return null;
        })();

        React.useEffect(() => {
          if (sessionId === null) return undefined;
          let cancelled = false;
          setState({ loading: true, error: null, workspaces: [], currentWorkspaceId: null, pendingMoves: [] });
          setSelected(null);
          setSelectedFolderId(null);
          setManualPath("");
          setAutoCreate(true);
          setFailure(null);
          setOpenFolders({});
          fetch(API + "?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
            .then((response) => response.json())
            .then((data) => {
              if (cancelled) return;
              if (data === null || data === undefined || data.ok !== true) throw new Error((data && data.error) || "读取工作区失败");
              setState({
                loading: false,
                error: null,
                workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
                currentWorkspaceId: data.currentWorkspaceId === undefined ? null : data.currentWorkspaceId,
                // 这条会话上次没做成的移动（宿主重启后会重试），拿来在弹窗里说清楚为什么没动。
                pendingMoves: Array.isArray(data.pendingMoves) ? data.pendingMoves : []
              });
              // 会话当前所在的工作区如果在文件夹里，把它的父级链路默认展开，省得用户找。
              const snapshot = folderStore.getSnapshot();
              const containers = snapshot.containers !== null && snapshot.containers !== undefined ? snapshot.containers : {};
              const parentOf = (childId) => Object.keys(containers).find((key) => Array.isArray(containers[key])
                && containers[key].some((ref) => ref !== null && ref !== undefined && ref.id === childId));
              const opened = {};
              let cursor = data.currentWorkspaceId === undefined || data.currentWorkspaceId === null ? undefined : parentOf(data.currentWorkspaceId);
              let guard = 0;
              while (cursor !== undefined && cursor !== "root" && guard < 50) {
                opened[cursor] = true;
                cursor = parentOf(cursor);
                guard += 1;
              }
              setOpenFolders(opened);
            })
            .catch((error) => {
              if (cancelled) return;
              setState({ loading: false, error: messageOf(error), workspaces: [], currentWorkspaceId: null, pendingMoves: [] });
            });
          return () => {
            cancelled = true;
          };
        }, [sessionId]);

        const submit = React.useCallback(() => {
          if (sessionId === null) return;
          if (selectedFolderId !== null) {
            // 归到文件夹：只改侧栏分组，不动会话的工作目录。
            setBusy(true);
            setFailure(null);
            fetch(API, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ action: "folder", op: "session.place", sessionId, folderId: selectedFolderId === "" ? null : selectedFolderId })
            })
              .then((response) => response.json())
              .then((data) => {
                if (data === null || data === undefined || data.ok !== true) throw new Error((data && data.error) || "归到文件夹失败");
                const name = data.folders !== null && data.folders !== undefined && data.folders[selectedFolderId] !== undefined
                  ? data.folders[selectedFolderId].name
                  : undefined;
                folderStore.adopt(data);
                closePicker();
                showToast(selectedFolderId === "" ? "已移出文件夹，回到它所属的工作区" : "已归到文件夹「" + name + "」");
              })
              .catch((error) => setFailure(messageOf(error)))
              .finally(() => setBusy(false));
            return;
          }
          const target = manualPath.trim().length > 0 ? { targetPath: manualPath.trim() } : { workspaceId: selected };
          if (target.workspaceId === null || target.workspaceId === undefined) return;
          setBusy(true);
          setFailure(null);
          fetch(API, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ action: "move", sessionId, ...target, createMissingDir: autoCreate })
          })
            .then((response) => response.json())
            .then((data) => {
              if (data === null || data === undefined || data.ok !== true) throw new Error((data && data.error) || "移动失败");
              const title = data.workspace && data.workspace.title ? data.workspace.title : "目标工作区";
              closePicker();
              showToast(data.deferred === true
                ? "已登记：这条会话在对话页开着，完全退出并重开 DSH 后会自动完成移动"
                : "已移动到「" + title + "」");
            })
            .catch((error) => setFailure(messageOf(error)))
            .finally(() => setBusy(false));
        }, [sessionId, selected, selectedFolderId, manualPath, autoCreate]);

        const nodes = [];
        if (request !== null) {
          const folders = folderState.folders !== null && folderState.folders !== undefined ? folderState.folders : {};
          const containers = folderState.containers !== null && folderState.containers !== undefined ? folderState.containers : { root: [] };
          const workspaceById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
          const selectedWorkspace = selected === null ? undefined : workspaceById.get(selected);
          const folderIds = Object.keys(folders);
          const toggleFolder = (folderId) => setOpenFolders((map) => ({ ...map, [folderId]: map[folderId] !== true }));
          const countInFolder = (folderId) => {
            let total = 0;
            const list = Array.isArray(containers[folderId]) ? containers[folderId] : [];
            for (const ref of list) {
              if (ref === null || ref === undefined) continue;
              if (ref.kind === "workspace") total += 1;
              else if (ref.kind === "folder" && folders[ref.id] !== undefined) total += countInFolder(ref.id);
            }
            return total;
          };
          // 注意 boxSizing：默认 content-box 时 width:100% 再加上左右 padding 与边框会整体溢出，
          // 右侧按钮就被挤出可视区（上次那个「把会话放这里」显示不全就是这么来的）。
          const cardStyle = (depth, extra) => ({
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: depth === 0 ? "100%" : "calc(100% - " + depth * 14 + "px)",
            marginLeft: depth === 0 ? 0 : depth * 14,
            padding: "9px 12px",
            borderRadius: 8,
            textAlign: "left",
            ...extra
          });

          const workspaceOption = (workspace, depth) => {
            const current = workspace.id === state.currentWorkspaceId;
            const picked = workspace.id === selected && manualPath.trim().length === 0;
            const hover = hovered === "ws:" + workspace.id && !current && !busy;
            return jsxs("button", {
              key: "ws-" + workspace.id,
              type: "button",
              disabled: current || busy,
              onMouseEnter: () => setHovered("ws:" + workspace.id),
              onMouseLeave: () => setHovered((value) => (value === "ws:" + workspace.id ? null : value)),
              onClick: () => {
                setSelected(workspace.id);
                setManualPath("");
              },
              style: cardStyle(depth, {
                border: "1px solid " + (picked
                  ? "var(--dsw-static-blue-500, #3b82f6)"
                  : hover
                    ? "var(--dsw-alias-border-primary, rgba(127,127,127,.55))"
                    : "var(--dsw-alias-border-secondary, rgba(127,127,127,.28))"),
                background: picked
                  ? "var(--dsw-static-blue-600, #2563eb)"
                  : hover
                    ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.18))"
                    : "transparent",
                color: picked ? "var(--dsw-alias-label-primary-inverted, #fff)" : "var(--dsw-alias-label-primary, inherit)",
                opacity: current ? 0.55 : 1,
                cursor: current || busy ? "default" : "pointer"
              }),
              children: [
                jsx("span", { style: { display: "inline-flex", flex: "none", color: picked ? "inherit" : SECONDARY }, children: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 16 }) }),
                jsxs("span", {
                  style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
                  children: [
                    jsx("span", { style: { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: workspace.title + (workspace.missing ? "（目录不存在）" : "") }),
                    jsx("span", {
                      style: {
                        fontSize: 11,
                        color: picked ? "var(--dsw-alias-label-primary-inverted, #fff)" : DIM,
                        opacity: picked ? 0.85 : 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      },
                      children: workspace.path
                    })
                  ]
                }),
                current ? jsx("span", { style: { flex: "none", fontSize: 11, color: DIM }, children: "当前所在" }) : null,
                current ? null : jsx("span", { style: { flex: "none", color: picked ? "inherit" : DIM }, children: jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) })
              ]
            });
          };

          const pillStyle = (chosen) => ({
            flex: "none",
            fontSize: 11,
            padding: "3px 9px",
            borderRadius: 999,
            cursor: "pointer",
            border: "1px solid " + (chosen ? "var(--dsw-static-blue-500, #3b82f6)" : "var(--dsw-alias-border-secondary, rgba(127,127,127,.35))"),
            background: chosen ? "var(--dsw-static-blue-600, #2563eb)" : "transparent",
            color: chosen ? "var(--dsw-alias-label-primary-inverted, #fff)" : SECONDARY
          });
          const folderOption = (folder, depth) => {
            const expanded = openFolders[folder.id] === true;
            const hover = hovered === "folder:" + folder.id;
            const chosen = selectedFolderId === folder.id;
            // 这条会话是不是已经在这个文件夹里。
            // （以前误写在组件作用域，那里没有 folder 变量 → 只要会话在文件夹里，
            //   一渲染弹窗就 ReferenceError: folder is not defined，表现正是"点了没反应"。）
            const alreadyHere = sessionFolderId !== null && sessionFolderId === folder.id;
            return jsxs("div", {
              key: "folder-" + folder.id,
              onMouseEnter: () => setHovered("folder:" + folder.id),
              onMouseLeave: () => setHovered((value) => (value === "folder:" + folder.id ? null : value)),
              style: cardStyle(depth, {
                border: "1px solid " + (chosen
                  ? "var(--dsw-static-blue-500, #3b82f6)"
                  : hover
                    ? "var(--dsw-alias-border-primary, rgba(127,127,127,.55))"
                    : "var(--dsw-alias-border-secondary, rgba(127,127,127,.28))"),
                background: chosen
                  ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.22))"
                  : hover
                    ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.18))"
                    : "transparent",
                color: "var(--dsw-alias-label-primary, inherit)"
              }),
              children: [
                jsxs("button", {
                  type: "button",
                  onClick: () => toggleFolder(folder.id),
                  style: { display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, padding: 0, border: "none", background: "transparent", color: "inherit", cursor: "pointer", textAlign: "left" },
                  children: [
                    jsx("span", { style: { display: "inline-flex", flex: "none", width: 14, color: DIM }, children: expanded ? jsx(primitives.IconChevronDownOutlineRegular, { size: 12 }) : jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) }),
                    jsx("span", { style: { display: "inline-flex", flex: "none", color: SECONDARY }, children: jsx(primitives.IconFolderOpenRegular, { size: 16 }) }),
                    jsxs("span", {
                      style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
                      children: [
                        jsx("span", { style: { fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: folder.name }),
                        jsx("span", {
                          style: { fontSize: 11, color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                          children: countInFolder(folder.id) + " 个工作区 · 点名称" + (expanded ? "收起" : "展开")
                        })
                      ]
                    })
                  ]
                }),
                alreadyHere ? jsx("span", { style: { flex: "none", fontSize: 11, color: DIM }, children: "会话已在此" }) : null,
                jsx("button", {
                  type: "button",
                  disabled: alreadyHere || busy,
                  onClick: () => {
                    setSelectedFolderId(folder.id);
                    setSelected(null);
                    setManualPath("");
                  },
                  style: { ...pillStyle(chosen || alreadyHere), opacity: alreadyHere ? 0.55 : 1, cursor: alreadyHere ? "default" : "pointer" },
                  children: chosen ? "已选" : "把会话放这里"
                })
              ]
            });
          };

          const rows = pickerRows(containers, folders, state.workspaces.map((workspace) => workspace.id), (folderId) => openFolders[folderId] === true)
            .map((row) => {
              if (row.kind === "folder") {
                const folder = folders[row.id];
                return folder === undefined ? null : folderOption(folder, row.depth);
              }
              const workspace = workspaceById.get(row.id);
              return workspace === undefined ? null : workspaceOption(workspace, row.depth);
            })
            .filter((node) => node !== null);
          if (sessionFolderId !== null) {
            const chosenRoot = selectedFolderId === "";
            rows.unshift(jsxs("div", {
              key: "leave-folder",
              style: cardStyle(0, {
                border: "1px solid " + (chosenRoot ? "var(--dsw-static-blue-500, #3b82f6)" : "var(--dsw-alias-border-secondary, rgba(127,127,127,.28))"),
                background: chosenRoot ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.22))" : "transparent"
              }),
              children: [
                jsx("span", { style: { display: "inline-flex", flex: "none", color: SECONDARY }, children: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 16 }) }),
                jsxs("span", {
                  style: { display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 },
                  children: [
                    jsx("span", { style: { fontSize: 13 }, children: "移出文件夹" }),
                    jsx("span", { style: { fontSize: 11, color: DIM }, children: "回到它所属的工作区下面" })
                  ]
                }),
                jsx("button", {
                  type: "button",
                  disabled: busy,
                  onClick: () => {
                    setSelectedFolderId("");
                    setSelected(null);
                    setManualPath("");
                  },
                  style: { ...pillStyle(chosenRoot), cursor: "pointer" },
                  children: chosenRoot ? "已选" : "放回工作区"
                })
              ]
            }, "leave-folder"));
          }
          if (folderIds.length > 0) {
            rows.unshift(jsxs("div", {
              key: "expand-controls",
              style: { display: "flex", alignItems: "center", gap: 8, padding: "0 2px 4px", flexWrap: "wrap" },
              children: [
                jsx("span", { style: { flex: "1 1 260px", minWidth: 0, fontSize: 11, color: DIM }, children: "工作区 = 真的搬过去（会改工作目录）；文件夹 = 只让它在侧栏归到这里" }),
                jsx("button", {
                  type: "button",
                  style: { border: "none", background: "transparent", color: SECONDARY, fontSize: 11, cursor: "pointer", padding: 0 },
                  onClick: () => setOpenFolders(Object.fromEntries(folderIds.map((id) => [id, true]))),
                  children: "展开全部"
                }),
                jsx("button", {
                  type: "button",
                  style: { border: "none", background: "transparent", color: SECONDARY, fontSize: 11, cursor: "pointer", padding: 0 },
                  onClick: () => setOpenFolders({}),
                  children: "收起全部"
                })
              ]
            }));
          }
          ensureModalStyle();
          nodes.push(jsx(primitives.Modal, {
            open: true,
            onClose: busy ? () => {} : closePicker,
            className: MODAL_CLASS,
            title: DIALOG_TITLE,
            closeLabel: "关闭",
            description: request.displayTitle === undefined || request.displayTitle === null || request.displayTitle === "" ? undefined : "会话：" + request.displayTitle,
            children: [
              state.loading ? jsx("p", { key: "loading", style: { margin: 0, fontSize: 12, color: DIM }, children: "正在读取工作区…" }) : null,
              state.error !== null ? jsx("p", { key: "error", style: { margin: 0, fontSize: 12, color: ERROR }, children: state.error }) : null,
              state.pendingMoves.length > 0
                ? jsx("p", {
                  key: "pending",
                  style: { margin: 0, fontSize: 12, color: SECONDARY },
                  children: "上一次的移动还没完成"
                    + (typeof state.pendingMoves[0].lastError === "string" && state.pendingMoves[0].lastError.length > 0
                      ? "：" + state.pendingMoves[0].lastError
                      : "（已登记，等下次启动 DSH 时自动完成）")
                    + " —— 再点一次「移动」会立刻重试。"
                })
                : null,
              rows.length > 0 ? jsx("div", { key: "rows", style: { display: "flex", flexDirection: "column", gap: 2, maxHeight: 420, overflowY: "auto" }, children: rows }) : null,
              selectedWorkspace !== undefined && selectedWorkspace.missing === true
                ? jsx("p", {
                  key: "missing",
                  style: { margin: "8px 0 0", fontSize: 12, color: ERROR },
                  children: "「" + selectedWorkspace.title + "」的目录不存在：" + selectedWorkspace.path
                    + (autoCreate
                      ? " —— 移动时会先自动新建这个同名目录，再搬过去。"
                      : " —— 已关掉「自动新建同名目录」，请先自己把目录建好。")
                })
                : null,
              jsxs("div", {
                key: "manual",
                style: { marginTop: 12, display: "flex", flexDirection: "column", gap: 6 },
                children: [
                  jsx("span", { style: { fontSize: 12, color: DIM }, children: "或者移动到新目录（会自动登记为工作区）：" }),
                  jsx(primitives.Input, {
                    value: manualPath,
                    onChange: (event) => {
                      setManualPath(event.target.value);
                      setSelected(null);
                    },
                    placeholder: "例如 D:\\Projects\\NewProject",
                    disabled: busy
                  }),
                  jsxs("label", {
                    style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: SECONDARY, cursor: busy ? "default" : "pointer" },
                    children: [
                      jsx("input", {
                        type: "checkbox",
                        checked: autoCreate,
                        disabled: busy,
                        onChange: (event) => setAutoCreate(event.target.checked)
                      }),
                      jsx("span", { children: "目录不存在时自动新建同名目录（默认开启，取消勾选则报错）" })
                    ]
                  })
                ]
              }),
              failure !== null ? jsx("p", { key: "failure", style: { margin: "8px 0 0", fontSize: 12, color: ERROR }, children: failure }) : null
            ],
            footer: jsxs(Fragment, { children: [
              jsx(primitives.Button, { variant: "outline", onClick: closePicker, disabled: busy, children: "取消" }),
              jsx(primitives.Button, {
                variant: "primary",
                onClick: submit,
                disabled: busy || (selected === null && selectedFolderId === null && manualPath.trim().length === 0),
                children: busy
                  ? "处理中…"
                  : selectedFolderId !== null
                    ? (selectedFolderId === "" ? "移出文件夹" : "归到这个文件夹")
                    : "移动"
              })
            ] })
          }, "modal"));
        }
        if (toast !== null) nodes.push(jsx(primitives.Toast, { text: toast.text, onDone: clearToast }, toast.seq));
        return nodes.length === 0 ? null : jsx(Fragment, { children: nodes });
      }

      /* ------------------------------------------------------------ 样式 */

      const S = {
        root: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, boxSizing: "border-box", padding: "0 2px" },
        header: { display: "flex", alignItems: "center", gap: 4, padding: "2px 2px 4px" },
        headerTitle: { fontSize: 12, fontWeight: 600, color: DIM, flex: 1, letterSpacing: 0.4 },
        iconButton: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color: SECONDARY,
          cursor: "pointer",
          flex: "none"
        },
        list: { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1, paddingBottom: 8 },
        row: (depth, selected) => ({
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 30,
          padding: "0 4px 0 " + (4 + depth * 14) + "px",
          borderRadius: 6,
          background: selected ? SELECTED_BG : "transparent",
          color: "var(--dsw-alias-label-primary, inherit)",
          cursor: "default",
          userSelect: "none"
        }),
        rowMain: { display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, cursor: "pointer" },
        rowTitle: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
        rowMeta: { fontSize: 11, color: DIM, flex: "none" },
        chevron: { display: "inline-flex", width: 14, justifyContent: "center", color: DIM, flex: "none" },
        dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, flex: "none" }),
        empty: { padding: "10px 8px", fontSize: 12, color: DIM },
        searchWrap: { padding: "0 2px 6px" },
        error: { padding: "0 4px 6px", fontSize: 12, color: ERROR }
      };

      /**
     * 把文件夹结构摊平成「移动到工作区」目标列表的行（纯函数，便于测试）。
     * 文件夹行只在展开时继续往下走；没放进任何文件夹的工作区补在最后。
     * @param containers - { root: [ref], <folderId>: [ref] }，ref = {kind,id}
     * @param folders - { <folderId>: {id,name} }
     * @param workspaceIds - 宿主返回的全部工作区 id（按显示顺序）
     * @param isOpen - (folderId) => 是否展开
     * @returns 行数组：[{ kind: "folder" | "workspace", id, depth }]
     */
    function pickerRows(containers, folders, workspaceIds, isOpen) {
      const rows = [];
      const walk = (containerId, depth) => {
        const list = Array.isArray(containers[containerId]) ? containers[containerId] : [];
        for (const ref of list) {
          if (ref === null || ref === undefined) continue;
          if (ref.kind === "folder") {
            if (folders[ref.id] === undefined) continue;
            rows.push({ kind: "folder", id: ref.id, depth });
            if (isOpen(ref.id) === true) walk(ref.id, depth + 1);
          } else {
            rows.push({ kind: "workspace", id: ref.id, depth });
          }
        }
      };
      // 注意：判断“已在文件夹里”必须看原始容器，不能看摊平结果 —— 折叠的文件夹不会走进去，
      // 否则它里面的工作区会被当成“没归组”再补一份到根级（重复显示）。
      const placed = new Set();
      for (const list of Object.values(containers)) {
        if (!Array.isArray(list)) continue;
        for (const ref of list) {
          if (ref !== null && ref !== undefined && ref.kind === "workspace") placed.add(ref.id);
        }
      }
      walk("root", 0);
      for (const id of workspaceIds) if (!placed.has(id)) rows.push({ kind: "workspace", id, depth: 0 });
      return rows;
    }

    /* ------------------------------------------------- 对话框里的可点选项行 */

      /**
       * 一眼能看出能点的选项行：卡片底 + 描边 + 悬停高亮 + 图标 + 副标题 + 右侧箭头，
       * 当前所在位置显示「当前」并置灰。文件夹/工作区选择都用它，避免再出现
       * “两行纯文字，不知道能不能点”的情况。
       */
      function OptionRow({ icon, title, subtitle, current, disabled, onSelect }) {
        const [hover, setHover] = React.useState(false);
        const inactive = disabled === true || current === true;
        return jsxs("button", {
          type: "button",
          disabled: inactive,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          onClick: inactive ? undefined : onSelect,
          style: {
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 10,
            width: "100%",
            padding: "9px 12px",
            borderRadius: 8,
            textAlign: "left",
            border: "1px solid " + (current === true
              ? "var(--dsw-static-blue-500, #3b82f6)"
              : hover && !inactive
                ? "var(--dsw-alias-border-primary, rgba(127,127,127,.55))"
                : "var(--dsw-alias-border-secondary, rgba(127,127,127,.28))"),
            background: current === true
              ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.16))"
              : hover && !inactive
                ? "var(--dsw-alias-fill-secondary, rgba(127,127,127,.18))"
                : "transparent",
            color: "var(--dsw-alias-label-primary, inherit)",
            opacity: inactive ? 0.6 : 1,
            cursor: inactive ? "default" : "pointer"
          },
          children: [
            jsx("span", { style: { display: "inline-flex", flex: "none", color: SECONDARY }, children: icon }),
            jsxs("span", {
              style: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
              children: [
                jsx("span", { style: { fontSize: 13 }, children: title }),
                subtitle === undefined || subtitle === null ? null : jsx("span", { style: { fontSize: 11, color: DIM, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: subtitle })
              ]
            }),
            current === true ? jsx("span", { style: { flex: "none", fontSize: 11, color: DIM }, children: "当前" }) : null,
            inactive ? null : jsx("span", { style: { flex: "none", color: DIM }, children: jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) })
          ]
        });
      }

      /* ------------------------------------------------------------ 侧栏树 */

      function FolderTree(props) {
        const { wide, renderSlot } = props;
        const expandSidebar = props.expandSidebar;
        const folderState = useStore(folderStore);
        // 数据与动作优先用官方入口注入进来的（也就是官方浏览器拿到的同一套），
        // 拿不到时退回自己的客户端服务，保证任何组合下都能渲染。
        const useWorkspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces : (selector) => selector(useStore(ctx.workspaces.list));
        const useSessions = typeof props.useSessions === "function" ? props.useSessions : (selector) => selector(useStore(ctx.sessions.list));
        const workspaceState = useWorkspaces((state) => state);
        const sessionState = useSessions((state) => state);
        const openState = useStore(treeStore);
        const notice = useStore(noticeStore);
        const [searchOpen, setSearchOpen] = React.useState(false);
        const [query, setQuery] = React.useState("");
        const [dialog, setDialog] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [addOpen, setAddOpen] = React.useState(false);
        // 官方 viewStore 拿不到时的兜底归档筛选器（默认值同官方：default=隐藏已归档）。
        const [localArchivedFilter, setLocalArchivedFilter] = React.useState("default");

        const workspaces = Array.isArray(workspaceState.items) ? workspaceState.items : [];
        const sessions = sessionState.byId !== null && sessionState.byId !== undefined ? sessionState.byId : {};
        const archived = new Set(Array.isArray(workspaceState.archivedSessionIds) ? workspaceState.archivedSessionIds : []);
        const folders = folderState.folders !== null && folderState.folders !== undefined ? folderState.folders : {};
        const containers = folderState.containers !== null && folderState.containers !== undefined ? folderState.containers : { root: [] };
        const workspaceById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]));
        const normalizedQuery = query.trim().toLowerCase();

        const placedWorkspaces = new Set();
        const folderSessionIds = new Map();
        for (const [containerId, list] of Object.entries(containers)) {
          if (!Array.isArray(list)) continue;
          for (const ref of list) {
            if (ref === null || ref === undefined) continue;
            if (ref.kind === "workspace") placedWorkspaces.add(ref.id);
            else if (ref.kind === "session") folderSessionIds.set(ref.id, containerId);
          }
        }
        const looseWorkspaces = workspaces.filter((workspace) => !placedWorkspaces.has(workspace.workspaceId));

        const countWorkspaces = (folderId) => {
          let total = 0;
          for (const ref of containers[folderId] ?? []) {
            if (ref.kind === "workspace") total += 1;
            else if (folders[ref.id] !== undefined) total += countWorkspaces(ref.id);
          }
          return total;
        };

        const matches = (text) => normalizedQuery.length === 0 || String(text ?? "").toLowerCase().includes(normalizedQuery);

        // 官方侧栏的可见性规则（照搬）：子代理会话不显示；不是当前选中项的空会话不显示；
        // 归档会话按归档筛选器（默认隐藏）。之前没做这层过滤，所以归档过的会话还挂在列表里。
        const currentSessionId = Object.values(sessions).find((row) => row !== null
          && row !== undefined
          && row.retainedBy !== undefined
          && (row.retainedBy.mainView ?? 0) > 0)?.id;
        const archivedFilter = typeof props.useStore === "function"
          ? props.useStore((state) => state.archivedFilter ?? "default")
          : localArchivedFilter;
        const setArchivedFilter = (value) => {
          if (props.actions !== undefined && typeof props.actions.setArchivedFilter === "function") props.actions.setArchivedFilter(value);
          else setLocalArchivedFilter(value);
        };
        const sessionVisible = (sessionId) => {
          const session = sessions[sessionId];
          if (session === undefined) return false;
          if (session.origin === "subagent") return false;
          if (session.blank === true && sessionId !== currentSessionId) return false;
          if (archivedFilter === "show") return true;
          if (archivedFilter === "only") return archived.has(sessionId);
          return !archived.has(sessionId);
        };
        const sessionMatches = (sessionId) => sessionVisible(sessionId)
          && (normalizedQuery.length === 0 || matches(displayTitleOf(sessions[sessionId], sessionId)) || matches(sessions[sessionId]?.cwd));
        // 已经归到某个文件夹下的会话，不在它所属工作区的分组里重复出现。
        const visibleSessionsOf = (workspace) => (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
          .filter((sessionId) => !folderSessionIds.has(sessionId))
          .filter(sessionMatches);

        const run = (operation, successText) => {
          setBusy(true);
          setError(null);
          Promise.resolve()
            .then(operation)
            .then(() => {
              if (successText !== undefined) noticeStore.show(successText);
            })
            .catch((failure) => setError(messageOf(failure)))
            .finally(() => setBusy(false));
        };
        const closeDialog = () => {
          if (busy) return;
          setDialog(null);
          setError(null);
        };

        const openSession = (sessionId) => {
          if (typeof props.open === "function") {
            props.open(sessionId);
            return;
          }
          const service = navigation();
          if (service !== undefined && typeof service.openSession === "function") service.openSession(sessionId);
          else console.warn("session-move: 打开会话的入口不可用");
        };
        const startSession = (workspaceId) => {
          if (typeof props.startSession === "function") {
            props.startSession(workspaceId);
            return;
          }
          const service = navigation();
          if (service !== undefined && typeof service.startSession === "function") service.startSession(workspaceId);
        };
        const createWorkspace = (input) => (typeof props.createWorkspace === "function" ? props.createWorkspace(input) : ctx.workspaces.create(input));
        const renameWorkspace = (workspaceId, title) => (typeof props.renameWorkspace === "function" ? props.renameWorkspace(workspaceId, title) : ctx.workspaces.rename(workspaceId, title));
        const deleteWorkspace = (workspaceId) => (typeof props.deleteWorkspace === "function" ? props.deleteWorkspace(workspaceId) : ctx.workspaces.delete(workspaceId));
        /**
         * 走官方目录选择器新增工作区。
         * @param folderId - 传了就顺手把新增的工作区放进这个文件夹（文件夹菜单里的「新建工作区」）。
         */
        const addWorkspace = (folderId) => {
          run(async () => {
            const service = navigation();
            if (service === undefined || typeof service.pickDirectory !== "function") throw new Error("目录选择器不可用");
            const picked = await service.pickDirectory();
            const path = typeof picked === "string" ? picked : picked && typeof picked.path === "string" ? picked.path : undefined;
            if (path === undefined || path.length === 0) return;
            const created = await createWorkspace({ path });
            if (folderId === undefined) return;
            let workspaceId = created !== null && created !== undefined
              ? (created.workspaceId ?? created.id ?? (typeof created === "string" ? created : undefined))
              : undefined;
            if (workspaceId === undefined) {
              // 兜底：宿主返回的形状变了就按路径在列表里找。
              const normalize = (value) => String(value ?? "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
              workspaceId = (workspaceState.items ?? []).find((item) => normalize(item.path) === normalize(path))?.workspaceId;
            }
            if (workspaceId === undefined) throw new Error("工作区已创建，但没拿到它的 id，请在树里手动「移入文件夹…」。");
            await folderStore.apply({ op: "place", workspaceId, folderId });
          }, folderId === undefined ? "已新增工作区" : "已新增工作区并放进该文件夹");
        };

        /* ---- 会话行 ---- */
        const SessionRow = ({ sessionId, depth }) => {
          const [menuOpen, setMenuOpen] = React.useState(false);
          const session = sessions[sessionId];
          const isArchived = archived.has(sessionId);
          const title = session !== undefined && session.blank === true ? "新会话（空）" : displayTitleOf(session, sessionId);
          const running = session !== undefined && session.running === true;
          const pending = session !== undefined && session.pendingInteraction !== null && session.pendingInteraction !== undefined;
          const current = session !== undefined && session.retainedBy !== undefined && (session.retainedBy.mainView ?? 0) > 0;
          return jsxs("div", {
            style: { ...S.row(depth, current), opacity: isArchived ? 0.55 : 1 },
            children: [
              jsx("span", { style: S.chevron }),
              jsxs("div", {
                style: S.rowMain,
                onClick: () => openSession(sessionId),
                title,
                children: [
                  pending ? jsx("span", { style: S.dot("var(--dsw-alias-state-warn-primary, #d97706)") })
                    : running ? jsx("span", { style: S.dot("var(--dsw-static-blue-500, #3b82f6)") })
                      : archived.has(sessionId) ? jsx("span", { style: S.dot("var(--dsw-static-neutral-400, #9ca3af)") })
                        : renderSlot("sidebar.session.row.leading", { sessionId }),
                  jsx("span", { style: S.rowTitle, children: title }),
                  isArchived ? jsx("span", { style: { ...S.rowMeta, fontSize: 10, border: "1px solid currentColor", borderRadius: 4, padding: "0 3px" }, children: "已归档" }) : null
                ]
              }),
              jsx(primitives.Menu, {
                open: menuOpen,
                onClose: () => setMenuOpen(false),
                portal: true,
                closeOnPointerLeave: false,
                anchor: jsx("button", {
                  type: "button",
                  style: S.iconButton,
                  "aria-label": "会话操作",
                  onClick: () => setMenuOpen((value) => !value),
                  children: jsx(primitives.IconEllipsisOutlineRegular, {})
                }),
                children: renderSlot("sidebar.workspaces.session.menu.item", { sessionId, displayTitle: title }, { hookContext: [menuOpen, setMenuOpen] })
              }),
              jsx("span", {
                style: { display: "inline-flex", alignItems: "center", gap: 2 },
                onClick: (event) => event.stopPropagation(),
                children: renderSlot("sidebar.workspaces.session.row.action", { sessionId, displayTitle: title })
              })
            ]
          });
        };

        /* ---- 工作区行 ---- */
        const WorkspaceRow = ({ workspaceId, depth }) => {
          const [menuOpen, setMenuOpen] = React.useState(false);
          const workspace = workspaceById.get(workspaceId);
          if (workspace === undefined) return null;
          const title = workspace.title === undefined || workspace.title === null || workspace.title === "" ? workspace.path : workspace.title;
          const key = "ws:" + workspaceId;
          // 默认展开（和官方一致）；收起时不再显示任何会话行。
          const expanded = isOpen(key, true);
          const all = visibleSessionsOf(workspace);
          const visible = expanded ? all : [];
          return jsxs(Fragment, {
            children: [
              jsxs("div", {
                style: S.row(depth, false),
                children: [
                  jsxs("div", {
                    style: S.rowMain,
                    onClick: () => toggleOpen(key, false),
                    children: [
                      jsx("span", { style: S.chevron, children: expanded ? jsx(primitives.IconChevronDownOutlineRegular, { size: 12 }) : jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) }),
                      jsx("span", { style: S.rowTitle, title: workspace.path, children: title }),
                      jsx("span", { style: S.rowMeta, children: all.length })
                    ]
                  }),
                  jsx(primitives.Menu, {
                    open: menuOpen,
                    onClose: () => setMenuOpen(false),
                    portal: true,
                    // portal 菜单里指针一离开锚点就会开始 200ms 倒计时（官方 usePointerGrace 里写死），
                  // 鼠标稍微一偏菜单就没了，所以这里关掉"移开即关"：只按外部点击 / Esc / 选中关闭。
                  closeOnPointerLeave: false,
                    anchor: jsx("button", {
                      type: "button",
                      style: S.iconButton,
                      "aria-label": "工作区操作",
                      onClick: () => setMenuOpen((value) => !value),
                      children: jsx(primitives.IconEllipsisOutlineRegular, {})
                    }),
                    children: [
                      jsx(primitives.MenuItemButton, {
                        key: "new",
                        icon: jsx(primitives.IconPlusOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          startSession(workspaceId);
                        },
                        children: "新建会话"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "rename",
                        icon: jsx(primitives.IconEditOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "renameWorkspace", workspaceId, value: title });
                        },
                        children: "重命名工作区"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "place",
                        icon: jsx(primitives.IconFolderOpenRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "placeWorkspace", workspaceId });
                        },
                        children: "移入文件夹…"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "archived",
                        icon: jsx(primitives.IconArchiveOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setArchivedFilter(archivedFilter === "show" ? "default" : "show");
                        },
                        children: archivedFilter === "show" ? "隐藏已归档的会话" : "显示已归档的会话"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "delete",
                        danger: true,
                        icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "deleteWorkspace", workspaceId, value: title });
                        },
                        children: "删除工作区"
                      })
                    ]
                  })
                ]
              }),
              visible.map((sessionId) => jsx(SessionRow, { sessionId, depth: depth + 1 }, sessionId))
            ]
          });
        };

        const descendantFolders = (folderId) => {
          const blocked = new Set([folderId]);
          let changed = true;
          while (changed) {
            changed = false;
            for (const [parentId, list] of Object.entries(containers)) {
              if (!Array.isArray(list) || !blocked.has(parentId)) continue;
              for (const item of list) {
                if (item.kind === "folder" && !blocked.has(item.id) && folders[item.id] !== undefined) {
                  blocked.add(item.id);
                  changed = true;
                }
              }
            }
          }
          return blocked;
        };

        /* ---- 文件夹行 ---- */
        const FolderRow = ({ folderId, depth }) => {
          const [menuOpen, setMenuOpen] = React.useState(false);
          const folder = folders[folderId];
          if (folder === undefined) return null;
          const key = "folder:" + folderId;
          const expanded = isOpen(key, true);
          const count = countWorkspaces(folderId);
          const sessionCount = (containers[folderId] ?? []).filter((ref) => ref !== null && ref.kind === "session").length;
          return jsxs(Fragment, {
            children: [
              jsxs("div", {
                style: S.row(depth, false),
                children: [
                  jsxs("div", {
                    style: S.rowMain,
                    onClick: () => toggleOpen(key, true),
                    children: [
                      jsx("span", { style: S.chevron, children: expanded ? jsx(primitives.IconChevronDownOutlineRegular, { size: 12 }) : jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) }),
                      jsx("span", { style: { display: "inline-flex", color: SECONDARY }, children: jsx(primitives.IconFolderOpenRegular, { size: 14 }) }),
                      jsx("span", { style: { ...S.rowTitle, fontWeight: 500 }, title: folder.name, children: folder.name }),
                      jsx("span", { style: S.rowMeta, children: sessionCount > 0 ? count + " · " + sessionCount + " 会话" : count })
                    ]
                  }),
                  jsx(primitives.Menu, {
                    open: menuOpen,
                    onClose: () => setMenuOpen(false),
                    portal: true,
                    // portal 菜单里指针一离开锚点就会开始 200ms 倒计时（官方 usePointerGrace 里写死），
                  // 鼠标稍微一偏菜单就没了，所以这里关掉"移开即关"：只按外部点击 / Esc / 选中关闭。
                  closeOnPointerLeave: false,
                    anchor: jsx("button", {
                      type: "button",
                      style: S.iconButton,
                      "aria-label": "文件夹操作",
                      onClick: () => setMenuOpen((value) => !value),
                      children: jsx(primitives.IconEllipsisOutlineRegular, {})
                    }),
                    children: [
                      jsx(primitives.MenuItemButton, {
                        key: "newWorkspace",
                        icon: jsx(primitives.IconProjectAddOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          addWorkspace(folderId);
                        },
                        children: "新建工作区（选目录后放进这里）"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "newSub",
                        icon: jsx(primitives.IconPlusOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "newFolder", parentId: folderId, value: "" });
                        },
                        children: "新建子文件夹"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "rename",
                        icon: jsx(primitives.IconEditOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "renameFolder", folderId, value: folder.name });
                        },
                        children: "重命名"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "move",
                        icon: jsx(primitives.IconFolderOpenRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "moveFolder", folderId });
                        },
                        children: "移入其它文件夹…"
                      }),
                      jsx(primitives.MenuItemButton, {
                        key: "delete",
                        danger: true,
                        icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
                        onSelect: () => {
                          setMenuOpen(false);
                          setDialog({ kind: "deleteFolder", folderId, value: folder.name });
                        },
                        children: "删除文件夹"
                      })
                    ]
                  })
                ]
              }),
              expanded ? renderContainer(folderId, depth + 1) : null
            ]
          });
        };

        const renderRef = (ref, depth) => {
          if (ref === null || ref === undefined) return null;
          if (ref.kind === "session") {
            if (!sessionMatches(ref.id)) return null;
            return jsx(SessionRow, { sessionId: ref.id, depth }, "fs-" + ref.id);
          }
          if (ref.kind === "folder") {
            const folder = folders[ref.id];
            if (folder === undefined) return null;
            if (normalizedQuery.length > 0 && !matches(folder.name) && countWorkspaces(ref.id) === 0) return null;
            return jsx(FolderRow, { folderId: ref.id, depth }, "folder:" + ref.id);
          }
          const workspace = workspaceById.get(ref.id);
          if (workspace === undefined) return null;
          const title = workspace.title ?? workspace.path ?? "";
          if (!matches(title) && !matches(workspace.path)) return null;
          return jsx(WorkspaceRow, { workspaceId: ref.id, depth }, "ws:" + ref.id);
        };

        // 官方把没归入任何工作区的会话放在末尾的「未分组」组里，这里保持一致。
        const accountedSessionIds = new Set();
        for (const workspace of workspaces) {
          for (const id of Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []) accountedSessionIds.add(id);
        }
        const straySessionIds = (Array.isArray(sessionState.ids) ? sessionState.ids : [])
          .filter((id) => !accountedSessionIds.has(id) && !folderSessionIds.has(id) && sessionMatches(id));

        function renderContainer(containerId, depth) {
          const explicit = containerId === "root"
            ? (Array.isArray(containers.root) ? containers.root : [])
            : (Array.isArray(containers[containerId]) ? containers[containerId] : []);
          const refs = containerId === "root"
            ? [...explicit, ...looseWorkspaces.map((workspace) => ({ kind: "workspace", id: workspace.workspaceId }))]
            : explicit;
          const rendered = refs.map((ref) => renderRef(ref, depth)).filter((node) => node !== null);
          if (containerId === "root") {
            if (straySessionIds.length > 0) {
              const key = "ws:__ungrouped__";
              const expanded = isOpen(key, true);
              rendered.push(jsxs(Fragment, {
                key: "ungrouped",
                children: [
                  jsxs("div", {
                    style: S.row(0, false),
                    children: [
                      jsxs("div", {
                        style: S.rowMain,
                        onClick: () => toggleOpen(key, true),
                        children: [
                          jsx("span", { style: S.chevron, children: expanded ? jsx(primitives.IconChevronDownOutlineRegular, { size: 12 }) : jsx(primitives.IconChevronRightOutlineRegular, { size: 12 }) }),
                          jsx("span", { style: { ...S.rowTitle, color: SECONDARY }, children: "未分组" }),
                          jsx("span", { style: S.rowMeta, children: straySessionIds.length })
                        ]
                      })
                    ]
                  }),
                  expanded ? straySessionIds.map((sessionId) => jsx(SessionRow, { sessionId, depth: 1 }, sessionId)) : null
                ]
              }, "ungrouped"));
            }
            return rendered;
          }
          if (rendered.length === 0) {
            return jsx("div", { style: { ...S.empty, paddingLeft: 20 + depth * 14 }, children: "空文件夹" }, "empty:" + containerId);
          }
          return rendered;
        }

        /* ---- 弹窗 ---- */
        const foldersList = Object.values(folders);
        const containerIdOf = (kind, id) => {
          for (const [containerId, list] of Object.entries(containers)) {
            if (Array.isArray(list) && list.some((ref) => ref !== null && ref.kind === kind && ref.id === id)) return containerId;
          }
          return undefined;
        };
        const currentContainerOfWorkspace = (workspaceId) => containerIdOf("workspace", workspaceId) ?? "root";
        const currentContainerOfFolder = (folderId) => containerIdOf("folder", folderId) ?? "root";
        const dialogNode = (() => {
          if (dialog === null) return null;
          const textValue = String(dialog.value ?? "").trim();
          const isDelete = dialog.kind === "deleteFolder" || dialog.kind === "deleteWorkspace";
          ensureModalStyle();
          return jsx(primitives.Modal, {
            open: true,
            onClose: closeDialog,
            className: MODAL_CLASS,
            title: dialog.kind === "newFolder" ? "新建文件夹"
              : dialog.kind === "renameFolder" ? "重命名文件夹"
                : dialog.kind === "deleteFolder" ? "删除文件夹"
                  : dialog.kind === "placeWorkspace" ? "移入文件夹"
                    : dialog.kind === "moveFolder" ? "移入其它文件夹"
                      : dialog.kind === "renameWorkspace" ? "重命名工作区"
                        : "删除工作区",
            closeLabel: "关闭",
            description: dialog.kind === "newFolder" || dialog.kind === "renameFolder"
              ? "文件夹只是侧栏里的分组，不会在磁盘上建目录。"
              : dialog.kind === "placeWorkspace" || dialog.kind === "moveFolder"
                ? "点一个文件夹即可移入（点「关闭」放弃）。"
                : undefined,
            children: dialog.kind === "newFolder" || dialog.kind === "renameFolder" || dialog.kind === "renameWorkspace"
              ? jsx(primitives.Input, {
                value: dialog.value ?? "",
                placeholder: dialog.kind === "newFolder" ? "例如 客户项目" : undefined,
                autoFocus: true,
                onChange: (event) => setDialog({ ...dialog, value: event.target.value })
              })
              : dialog.kind === "deleteFolder"
                ? jsx("p", { style: { margin: 0, fontSize: 13 }, children: "删除「" + (dialog.value ?? "") + "」？里面的工作区和子文件夹会移到上一层，不会删除任何会话。" })
                : dialog.kind === "deleteWorkspace"
                  ? jsx("p", { style: { margin: 0, fontSize: 13 }, children: "删除工作区「" + (dialog.value ?? "") + "」？只移除侧栏分组，目录、会话和日志都不会动。" })
                  : jsxs("div", {
                    style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 340, overflowY: "auto" },
                    children: [
                      foldersList.length === 0 ? jsx("p", {
                        key: "no-folder",
                        style: { margin: "0 0 2px", fontSize: 12, color: DIM },
                        children: "还没有文件夹：先在侧栏右上「＋」→ 新增文件夹。"
                      }, "no-folder") : null,
                      dialog.kind === "placeWorkspace" ? jsx(OptionRow, {
                        key: "top-level",
                        icon: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 16 }),
                        title: "不放入文件夹（顶层）",
                        subtitle: "工作区直接显示在侧栏根目录",
                        current: currentContainerOfWorkspace(dialog.workspaceId) === "root",
                        onSelect: () => {
                          const workspaceId = dialog.workspaceId;
                          closeDialog();
                          run(() => folderStore.apply({ op: "place", workspaceId, folderId: "root" }), "已移到顶层");
                        }
                      }) : dialog.kind === "moveFolder" ? jsx(OptionRow, {
                        key: "top-level-folder",
                        icon: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 16 }),
                        title: "移到顶层",
                        subtitle: "文件夹直接显示在侧栏根目录",
                        current: currentContainerOfFolder(dialog.folderId) === "root",
                        onSelect: () => {
                          const folderId = dialog.folderId;
                          closeDialog();
                          run(() => folderStore.apply({ op: "move", folderId, parentId: "root" }), "已移到顶层");
                        }
                      }) : null,
                      foldersList
                        .filter((folder) => dialog.kind !== "moveFolder" || !descendantFolders(dialog.folderId).has(folder.id))
                        .map((folder) => jsx(OptionRow, {
                          key: folder.id,
                          icon: jsx(primitives.IconFolderOpenRegular, { size: 16 }),
                          title: folder.name,
                          subtitle: countWorkspaces(folder.id) + " 个工作区" + (Object.values(folders).some((item) => (containers[item.id] ?? []).some((ref) => ref.kind === "folder" && ref.id === folder.id)) ? "，含子文件夹" : ""),
                          current: dialog.kind === "placeWorkspace"
                            ? currentContainerOfWorkspace(dialog.workspaceId) === folder.id
                            : currentContainerOfFolder(dialog.folderId) === folder.id,
                          onSelect: () => {
                            if (dialog.kind === "placeWorkspace") {
                              const workspaceId = dialog.workspaceId;
                              closeDialog();
                              run(() => folderStore.apply({ op: "place", workspaceId, folderId: folder.id }), "已移入「" + folder.name + "」");
                            } else {
                              const folderId = dialog.folderId;
                              closeDialog();
                              run(() => folderStore.apply({ op: "move", folderId, parentId: folder.id }), "已移入「" + folder.name + "」");
                            }
                          }
                        }))
                    ]
                  }),
            footer: jsxs(Fragment, { children: [
              jsx(primitives.Button, { variant: "outline", onClick: closeDialog, disabled: busy, children: dialog.kind === "placeWorkspace" || dialog.kind === "moveFolder" ? "关闭" : "取消" }),
              dialog.kind === "placeWorkspace" || dialog.kind === "moveFolder" ? null : jsx(primitives.Button, {
                variant: "primary",
                disabled: busy
                  || (dialog.kind === "newFolder" && textValue === "")
                  || (dialog.kind === "renameFolder" && textValue === "")
                  || (dialog.kind === "renameWorkspace" && textValue === ""),
                onClick: () => {
                  const current = dialog;
                  if (current.kind === "newFolder") {
                    closeDialog();
                    run(() => folderStore.apply({ op: "create", name: textValue, parentId: current.parentId }), "已新建文件夹「" + textValue + "」");
                  } else if (current.kind === "renameFolder") {
                    closeDialog();
                    run(() => folderStore.apply({ op: "rename", folderId: current.folderId, name: textValue }), "已重命名");
                  } else if (current.kind === "deleteFolder") {
                    closeDialog();
                    run(() => folderStore.apply({ op: "delete", folderId: current.folderId }), "文件夹已解散，里面的内容已上移");
                  } else if (current.kind === "renameWorkspace") {
                    closeDialog();
                    run(() => renameWorkspace(current.workspaceId, textValue), "工作区已重命名");
                  } else if (current.kind === "deleteWorkspace") {
                    closeDialog();
                    run(() => deleteWorkspace(current.workspaceId));
                  }
                },
                children: busy ? "处理中…" : isDelete ? "删除" : "确定"
              })
            ] })
          }, "dialog");
        })();

        if (wide === false) {
          return jsxs("div", {
            style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "4px 0" },
            children: [
              jsx("button", {
                type: "button",
                style: { ...S.iconButton, width: 36, height: 36 },
                "aria-label": "搜索会话",
                onClick: () => {
                  if (typeof expandSidebar === "function") expandSidebar();
                },
                children: jsx(primitives.IconSearchOutlineRegular, { size: 18 })
              }),
              jsx("button", {
                type: "button",
                style: { ...S.iconButton, width: 36, height: 36 },
                "aria-label": "工作区",
                onClick: () => {
                  if (typeof expandSidebar === "function") expandSidebar();
                },
                children: jsx(primitives.IconWorkspaceTreeOutlineRegular, { size: 18 })
              })
            ]
          });
        }

        const addMenu = jsx(primitives.Menu, {
          open: addOpen,
          onClose: () => setAddOpen(false),
          portal: true,
          closeOnPointerLeave: false,
          anchor: jsx("button", {
            type: "button",
            style: S.iconButton,
            "aria-label": "新增",
            onClick: () => setAddOpen((value) => !value),
            children: jsx(primitives.IconPlusOutlineRegular, {})
          }),
          children: [
            jsx(primitives.MenuItemButton, {
              key: "workspace",
              icon: jsx(primitives.IconProjectAddOutlineRegular, { size: 14 }),
              onSelect: () => {
                setAddOpen(false);
                addWorkspace();
              },
              children: "新增工作区（选择本地目录）"
            }),
            jsx(primitives.MenuItemButton, {
              key: "folder",
              icon: jsx(primitives.IconFolderOpenRegular, { size: 14 }),
              onSelect: () => {
                setAddOpen(false);
                setDialog({ kind: "newFolder", parentId: "root", value: "" });
              },
              children: "新增文件夹（只在侧栏分组）"
            }),
            jsx(primitives.MenuItemButton, {
              key: "reload",
              icon: jsx(primitives.IconRefreshOutlineRegular, { size: 14 }),
              onSelect: () => {
                setAddOpen(false);
                reloadClient();
              },
              children: "刷新界面（加载最新客户端代码 · Ctrl+Alt+R）"
            })
          ]
        });

        return jsxs(Fragment, {
          children: [
            jsxs("div", {
              style: S.root,
              children: [
                jsxs("div", {
                  style: S.header,
                  children: [
                    jsx("span", { style: S.headerTitle, children: "工作区" }),
                    jsx("button", {
                      type: "button",
                      style: S.iconButton,
                      "aria-label": "搜索",
                      onClick: () => {
                        setSearchOpen((value) => {
                          if (value) setQuery("");
                          return !value;
                        });
                      },
                      children: jsx(primitives.IconSearchOutlineRegular, {})
                    }),
                    addMenu
                  ]
                }),
                searchOpen ? jsx("div", {
                  style: S.searchWrap,
                  children: jsx(primitives.Input, {
                    value: query,
                    autoFocus: true,
                    placeholder: "按名称筛选…",
                    onChange: (event) => setQuery(event.target.value)
                  })
                }) : null,
                error !== null ? jsx("div", { style: S.error, children: error }) : null,
                jsx("div", { style: S.list, children: renderContainer("root", 0) })
              ]
            }),
            dialogNode,
            notice !== null ? jsx(primitives.Toast, { text: notice.text, onDone: noticeStore.clear }, notice.seq) : null
          ]
        });
      }

      /* ------------------------------------------------------------ 注册 */

      /* ------------------------------------------------ 接管侧栏任务树（就地包裹） */

      // 平台不允许第二个 entry 再声明同一批子槽位（single/list 的 children 归属唯一），
      // 所以不新注册一个占用者，而是像 dsh-im-connect 那样把官方 entry 的 component
      // 就地换成本插件的工作区树：官方渲染器仍会把「官方 entry 自己的」props（含它声明过的
      // renderSlot 绑定、open / startSession / createWorkspace 等动作）交给我们，于是
      // 生态里注册在 sidebar.workspaces.session.menu.item 的菜单项照样能渲染。
      const readEntries = (key) => {
        try {
          const read = ctx.slots.entriesOfSlot ?? ctx.slots.entries;
          const list = typeof read === "function" ? read.call(ctx.slots, key) : [];
          return Array.isArray(list) ? list : [];
        } catch {
          return [];
        }
      };
      const isOfficialBrowser = (component) => typeof component === "function"
        && (component.name === "WorkspaceBrowser" || component.displayName === "WorkspaceBrowser");

      class SidebarBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { failed: false };
        }
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(error) {
          console.warn("session-move: 工作区树渲染失败，已回落到官方侧栏", error);
        }
        render() {
          if (this.state.failed) {
            const Official = this.props.officialTree;
            return Official === null || Official === undefined ? null : jsx(Official, this.props.hostProps);
          }
          return this.props.children;
        }
      }

      let wrappedEntry = null;
      let originalComponent = null;
      let wrapper = null;

      const unwrap = () => {
        if (wrappedEntry !== null && originalComponent !== null && wrappedEntry.component === wrapper) {
          wrappedEntry.component = originalComponent;
        }
        wrappedEntry = null;
        originalComponent = null;
        wrapper = null;
      };

      const syncSidebar = () => {
        try {
          if (wrappedEntry !== null && wrappedEntry.component === wrapper) return;
          if (wrappedEntry !== null) unwrap();
          const entries = readEntries("sidebar.workspaces");
          const official = entries.find((entry) => entry !== null && entry !== undefined && isOfficialBrowser(entry.component))
            ?? entries.find((entry) => entry !== null && entry !== undefined && typeof entry.component === "function");
          if (official === undefined || official.component === undefined) return;
          if (official.component.__sessionMoveWrapped === true) {
            wrappedEntry = official;
            wrapper = official.component;
            return;
          }
          originalComponent = official.component;
          const original = originalComponent;
          function SessionMoveWorkspaceTree(innerProps) {
            return jsx(SidebarBoundary, {
              officialTree: original,
              hostProps: innerProps,
              children: jsx(FolderTree, { ...innerProps })
            });
          }
          SessionMoveWorkspaceTree.displayName = "SessionMoveWorkspaceTree";
          SessionMoveWorkspaceTree.__sessionMoveWrapped = true;
          SessionMoveWorkspaceTree.__sessionMoveOriginal = original;
          official.component = SessionMoveWorkspaceTree;
          wrappedEntry = official;
          wrapper = SessionMoveWorkspaceTree;
        } catch (error) {
          console.warn("session-move: 接管侧栏失败，保持官方侧栏", error);
        }
      };

      try {
        syncSidebar();
        if (typeof ctx.slots.subscribe === "function") {
          try {
            ctx.slots.subscribe("sidebar.workspaces", syncSidebar);
          } catch {
            /* 没有订阅能力就算了，首次接管已经生效 */
          }
        }
      } catch (error) {
        console.warn("session-move: 接管侧栏失败，保持官方侧栏", error);
      }

      try {
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
          name: "sidebar.workspaces.session.menu.item",
          id: "session-move",
          order: 350
        }, MoveSessionMenuItem));
      } catch (error) {
        console.warn("session-move: 会话菜单项注册失败", error);
      }

      try {
        ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay",
          id: "session-move-picker"
        }, MoveSessionOverlay));
      } catch (error) {
        console.warn("session-move: 选择弹窗注册失败", error);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});

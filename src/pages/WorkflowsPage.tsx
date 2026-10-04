import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  BookOpen,
  Check,
  Clipboard,
  Copy,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Home,
  LayoutTemplate,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Scissors,
  Share2,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { api } from "../api";
import type { Catalog, FolderShare, Workflow, WorkflowFolder } from "../types";
import { Toast, useToast } from "../components/Toast";
import TemplateGallery from "../components/TemplateGallery";
import FolderShareModal from "../components/FolderShareModal";
import Select from "../components/Select";

interface Props {
  catalog: Catalog;
  onOpen: (id: string) => void;
  /** opens the user guide (Settings → Documentation) from the empty state */
  onOpenGuide?: () => void;
  /** on a fresh load, jump straight into the editor (most recent workflow only) */
  instantOpen?: boolean;
  /** open the dashboard focused on this folder (from the editor's breadcrumb) */
  initialFolderId?: string;
}

type ClipboardState = { mode: "copy" | "cut"; ids: string[] } | null;
const WORKFLOW_DRAG_TYPE = "application/x-w-flow-workflow";
// The explorer shows a folder another account shared as `shared:<folderId>`.
const SHARED_FILTER_PREFIX = "shared:";

function triggerNames(wf: Workflow, catalog: Catalog) {
  const names: string[] = [];
  for (const n of wf.nodes) {
    const def = catalog.nodes[n.type];
    if (def?.kind === "trigger") names.push(def.name.replace(/ —.*/, ""));
  }
  return names.length ? names.slice(0, 3) : [];
}

export default function WorkflowsPage({ catalog, onOpen, onOpenGuide, instantOpen, initialFolderId }: Props) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [folders, setFolders] = useState<WorkflowFolder[]>([]);
  const [folderFilter, setFolderFilter] = useState<string>(initialFolderId || "");
  // The account's main folder (auto-created, cannot be deleted). Everything the
  // user saves lives inside it or one of its subfolders — there is no
  // "Workspace" root and no "unfiled" state.
  const homeFolder = useMemo(() => folders.find((folder) => folder.home === true), [folders]);
  const homeId = homeFolder?.id || "";
  // Folder sharing — the account's own single shared folder plus the folders
  // other accounts shared with it (listed in the sidebar under "Shared with you").
  const [folderShares, setFolderShares] = useState<{ mine: FolderShare[]; incoming: FolderShare[] }>({ mine: [], incoming: [] });
  // The explorer can also show a folder another account shared with this user.
  // That view is display-only, so creating/moving/pasting always targets a
  // folder the account really owns (activeFolderId).
  const incomingShare = useMemo(
    () =>
      folderFilter.startsWith(SHARED_FILTER_PREFIX)
        ? folderShares.incoming.find((s) => s.folderId === folderFilter.slice(SHARED_FILTER_PREFIX.length))
        : undefined,
    [folderFilter, folderShares.incoming]
  );
  const activeFolderId = folderFilter && !folderFilter.startsWith(SHARED_FILTER_PREFIX) ? folderFilter : homeId;
  const mySharedFolder = folderShares.mine[0];
  // Whether one of MY folders is covered by my single folder share — either it
  // is the shared folder itself, or it sits below it with subfolders included.
  const isFolderSharedByMe = useCallback(
    (folderId: string) => {
      if (!mySharedFolder || !folderId) return false;
      if (mySharedFolder.folderId === folderId) return true;
      if (!mySharedFolder.includeSubfolders) return false;
      let cursor = folders.find((folder) => folder.id === folderId);
      const seen = new Set<string>();
      while (cursor?.parentId && !seen.has(cursor.id)) {
        if (cursor.parentId === mySharedFolder.folderId) return true;
        seen.add(cursor.id);
        cursor = folders.find((folder) => folder.id === cursor!.parentId);
      }
      return false;
    },
    [folders, mySharedFolder]
  );
  const [folderName, setFolderName] = useState("");
  const [folderDialogParentId, setFolderDialogParentId] = useState<string | undefined>(undefined);
  const [folderDialogName, setFolderDialogName] = useState("");
  const [renameFolderId, setRenameFolderId] = useState<string | undefined>(undefined);
  const [renameFolderName, setRenameFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  // the workflow card whose ⋮ menu is open
  const [menuId, setMenuId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // The directory is expanded by default so existing workflows are visible
  // immediately instead of making the user discover a second click.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  const clipboardRef = useRef<ClipboardState>(null);
  const { toast, show } = useToast();

  // name + folder dialog
  const [showDialog, setShowDialog] = useState(false);
  // Starter templates — ready-to-run skeletons (shared/templates.js).
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [newFolderId, setNewFolderId] = useState("");
  const dialogRef = useRef<HTMLInputElement>(null);
  // import (button + drag-and-drop)
  const [dragOver, setDragOver] = useState(false);
  // Folder the workflow drag currently hovers over (its id, or HOME_KEY for the
  // main folder) — used to highlight the drop target while dragging.
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [shareTarget, setShareTarget] = useState<WorkflowFolder | null>(null);

  const setExplorerClipboard = useCallback((value: ClipboardState) => {
    clipboardRef.current = value;
    setClipboard(value);
  }, []);

  const refresh = useCallback(async () => {
    const [list, folderList, shares] = await Promise.all([
      api.workflows.list(),
      api.workflows.folders(),
      api.workflows.folderShares().catch(() => ({ mine: [], incoming: [] })),
    ]);
    setWorkflows(list);
    setFolders(folderList);
    setFolderShares(shares);
    // Open every folder that already contains workflows on first load. New
    // empty folders remain collapsed, like a normal file explorer.
    setExpandedFolders((current) => {
      const populated = new Set(folderList.filter((folder) => list.some((wf) => wf.folderId === folder.id)).map((folder) => folder.id));
      return current.size ? current : populated;
    });
  }, []);

  const importWorkflow = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const wf = JSON.parse(text) as Workflow;
        if (!Array.isArray(wf.nodes)) throw new Error("no nodes");
        const created = await api.workflows.create({
          name: `${(wf.name || file.name.replace(/\.json$/i, "") || "Imported").trim()} (imported)`,
          description: wf.description || `Imported from ${file.name}`,
          folderId: activeFolderId && activeFolderId !== homeId ? activeFolderId : homeId || undefined,
          nodes: wf.nodes,
          edges: wf.edges || [],
        });
        setWorkflows((ws) => [...ws, created]);
        show(`Imported "${wf.name || file.name}"`);
        onOpen(created.id);
      } catch {
        show("Import failed: invalid workflow JSON", "err");
      }
    },
    [activeFolderId, homeId, onOpen, show]
  );

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importWorkflow(file);
    e.target.value = "";
  };

  useEffect(() => {
    refresh()
      .then(() => {
        if (instantOpen && workflows.length > 0) {
          const sorted = [...workflows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          onOpen(sorted[0].id);
        }
      })
      .catch(() => show("Failed to load workflows", "err"))
      .finally(() => setLoading(false));
    // The initial list is intentionally loaded once. instantOpen is handled
    // below from the response so it does not depend on a stale state value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the instant-open behavior correct without making the normal dashboard
  // reopen itself whenever the workflow list changes.
  const instantOpenedRef = useRef(false);
  useEffect(() => {
    if (!instantOpen || instantOpenedRef.current || loading || !workflows.length) return;
    instantOpenedRef.current = true;
    const sorted = [...workflows].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    onOpen(sorted[0].id);
  }, [instantOpen, loading, workflows, onOpen]);

  // The editor's breadcrumb can open the dashboard focused on a folder. Select
  // it and expand its whole ancestor chain so it is visible in the directory.
  useEffect(() => {
    if (!initialFolderId) return;
    setFolderFilter(initialFolderId);
    setExpandedFolders((current) => {
      const next = new Set(current);
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      let cursor = byId.get(initialFolderId);
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        next.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
      return next;
    });
  }, [initialFolderId, folders]);

  useEffect(() => {
    if (showDialog) dialogRef.current?.focus();
  }, [showDialog]);

  const openDialog = () => {
    setNameInput(`Workflow ${workflows.length + 1}`);
    // new workflows are created in the folder currently being viewed, or the
    // account's main folder — never "outside" any folder
    setNewFolderId(activeFolderId && activeFolderId !== homeId ? activeFolderId : homeId);
    setShowDialog(true);
  };

  const closeDialog = () => setShowDialog(false);

  const openFolderDialog = (parentId?: string) => {
    setFolderDialogParentId(parentId);
    setFolderDialogName("");
  };

  const createFolder = async (parentId: string | undefined, requestedName: string) => {
    const name = requestedName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    try {
      const folder = await api.workflows.createFolder(name, parentId);
      setFolders((current) => [...current, folder]);
      setExpandedFolders((current) => parentId ? new Set(current).add(parentId) : current);
      if (!parentId) setFolderFilter(folder.id);
      setFolderName("");
      setFolderDialogName("");
      setFolderDialogParentId(undefined);
      show(`${parentId ? "Subfolder" : "Folder"} "${folder.name}" created`);
    } catch (err) {
      show(String((err as Error).message || err), "err");
    } finally {
      setCreatingFolder(false);
    }
  };

  const openRenameFolder = (folder: WorkflowFolder) => {
    setRenameFolderId(folder.id);
    setRenameFolderName(folder.name);
  };

  const renameFolder = async () => {
    const folder = folders.find((item) => item.id === renameFolderId);
    const name = renameFolderName.trim();
    if (!folder || !name || name === folder.name) {
      if (folder && name === folder.name) setRenameFolderId(undefined);
      return;
    }
    try {
      const saved = await api.workflows.renameFolder(folder.id, name);
      setFolders((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      setRenameFolderId(undefined);
      show(`Folder renamed to "${saved.name}"`);
    } catch (err) {
      show(String((err as Error).message || err), "err");
    }
  };

  const deleteFolder = async (folder: WorkflowFolder) => {
    const childCount = folders.filter((item) => item.parentId === folder.id).length;
    const warning = childCount
      ? `Delete folder "${folder.name}"? Its ${childCount} subfolder${childCount === 1 ? "" : "s"} will move up one level. Workflows in this folder become unfiled.`
      : `Delete folder "${folder.name}"? Workflows will become unfiled.`;
    if (!window.confirm(warning)) return;
    try {
      await api.workflows.removeFolder(folder.id);
      const home = folders.find((item) => item.home === true);
      setFolders((current) => current.filter((item) => item.id !== folder.id).map((item) => item.parentId === folder.id ? { ...item, parentId: folder.parentId } : item));
      // Workflows from the deleted folder move back into the main folder (the
      // server does the same — a workflow can never be outside the tree).
      setWorkflows((current) => current.map((wf) => (wf.folderId === folder.id ? { ...wf, folderId: home?.id || wf.folderId } : wf)));
      if (folderFilter === folder.id) setFolderFilter(home?.id || "");
      show(`Folder "${folder.name}" deleted`);
    } catch (err) {
      show(String((err as Error).message || err), "err");
    }
  };

  const create = async (name?: string) => {
    setCreating(true);
    closeDialog();
    try {
      const wf = await api.workflows.create({
        name: name?.trim() || `Workflow ${workflows.length + 1}`,
        description: "New automation workflow",
        folderId: newFolderId || undefined,
        nodes: [],
        edges: [],
      });
      setWorkflows((current) => [...current, wf]);
      setSelectedIds([wf.id]);
      onOpen(wf.id);
    } catch {
      show("Failed to create workflow", "err");
    } finally {
      setCreating(false);
    }
  };

  const move = useCallback(
    async (ids: string[], folderId?: string) => {
      const uniqueIds = [...new Set(ids)];
      if (!uniqueIds.length) return;
      try {
        const saved = await Promise.all(uniqueIds.map((id) => api.workflows.moveToFolder(id, folderId || undefined)));
        setWorkflows((current) => current.map((wf) => saved.find((item) => item.id === wf.id) || wf));
        setSelectedIds([]);
        show(uniqueIds.length === 1 ? folderId ? "Workflow moved to folder" : "Workflow made unfiled" : `${uniqueIds.length} workflows moved`);
      } catch (err) {
        show(String((err as Error).message || err), "err");
      }
    },
    [show]
  );

  const paste = useCallback(
    async (targetFolderId = activeFolderId) => {
      const current = clipboardRef.current;
      if (!current?.ids.length) return;
      const source = current.ids.map((id) => workflows.find((wf) => wf.id === id)).filter((wf): wf is Workflow => !!wf);
      // Everything lives inside a folder — paste always lands in a folder (the
      // main folder when no specific one is targeted).
      const destination = targetFolderId && targetFolderId !== homeId ? targetFolderId : homeId || undefined;
      if (!source.length) return;
      if (current.mode === "cut") {
        await move(source.map((wf) => wf.id), destination || undefined);
        setExplorerClipboard(null);
        return;
      }
      try {
        const created = await Promise.all(
          source.map((wf) =>
            api.workflows.create({
              name: `${wf.name} (copy)`,
              description: wf.description,
              folderId: destination || undefined,
              nodes: wf.nodes,
              edges: wf.edges || [],
            })
          )
        );
        setWorkflows((currentWorkflows) => [...currentWorkflows, ...created]);
        setSelectedIds(created.map((wf) => wf.id));
        show(`${created.length} workflow${created.length === 1 ? "" : "s"} pasted`);
      } catch (err) {
        show(String((err as Error).message || err), "err");
      }
    },
    [activeFolderId, homeId, move, setExplorerClipboard, show, workflows]
  );

  const deleteSelected = useCallback(async () => {
    const selected = selectedIds.map((id) => workflows.find((wf) => wf.id === id)).filter((wf): wf is Workflow => !!wf);
    if (!selected.length) return;
    if (!window.confirm(`Delete ${selected.length} selected workflow${selected.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    try {
      await Promise.all(selected.map((wf) => api.workflows.remove(wf.id)));
      setWorkflows((current) => current.filter((wf) => !selectedIds.includes(wf.id)));
      setSelectedIds([]);
      show(`${selected.length} workflow${selected.length === 1 ? "" : "s"} deleted`);
    } catch {
      show("Failed to delete selected workflows", "err");
    }
  }, [selectedIds, show, workflows]);

  const del = async (e: React.MouseEvent, wf: Workflow) => {
    e.stopPropagation();
    setSelectedIds([wf.id]);
    if (!window.confirm(`Delete workflow "${wf.name}"? This cannot be undone.`)) return;
    try {
      await api.workflows.remove(wf.id);
      setWorkflows((ws) => ws.filter((w) => w.id !== wf.id));
      setSelectedIds((ids) => ids.filter((id) => id !== wf.id));
      show("Workflow deleted");
    } catch {
      show("Failed to delete workflow", "err");
    }
  };

  const run = async (e: React.MouseEvent, wf: Workflow) => {
    e.stopPropagation();
    setRunningId(wf.id);
    try {
      const res = await api.workflows.run(wf.id, {});
      // A non-manual trigger (Schedule, webhook, crypto price, …) does not run
      // yet — it waits for its event or a pasted payload, and only the editor
      // has the panel for that. Open it there instead of leaving an orphaned
      // wait behind a toast that reads like a finished run.
      if ("waiting" in res) {
        show(`⏳ ${res.message}`);
        onOpen(wf.id);
      } else show(`Run finished in ${res.durationMs} ms — ${res.success ? "all nodes OK" : "some nodes failed"}`, res.success ? "ok" : "err");
    } catch (err) {
      show(String((err as Error).message || err), "err");
    } finally {
      setRunningId(null);
    }
  };

  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // the menu's own clicks stop propagation, so any click that arrives here is outside it
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  const duplicate = async (wf: Workflow) => {
    try {
      const created = await api.workflows.create({
        name: `${wf.name} (copy)`,
        description: wf.description,
        folderId: wf.folderId || undefined,
        nodes: wf.nodes,
        edges: wf.edges || [],
      });
      setWorkflows((current) => [...current, created]);
      setSelectedIds([created.id]);
      show("Workflow duplicated");
    } catch (err) {
      show(String((err as Error).message || err), "err");
    }
  };

  // The same JSON the editor's code view shows — enough to re-import it via
  // "Import" or to keep it in version control.
  const downloadJson = (wf: Workflow) => {
    const body = JSON.stringify({ name: wf.name, description: wf.description || "", nodes: wf.nodes, edges: wf.edges || [] }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(wf.name || "workflow").replace(/[^\w.-]+/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const selectWorkflow = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedIds((current) => (e.ctrlKey || e.metaKey ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : [id]));
  };

  // The corner control is an explicit selection toggle. Unlike opening a card,
  // clicking a selected checkbox again must clear that workflow's selection.
  const toggleWorkflowSelection = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setSelectedIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return e.ctrlKey || e.metaKey ? [...current, id] : [id];
    });
  };

  const visibleWorkflows = useMemo(
    () => {
      if (incomingShare) return workflows.filter((wf) => wf.sharedFolderId === incomingShare.folderId);
      if (!folderFilter || folderFilter === homeId) return workflows.filter((wf) => !wf.folderId || wf.folderId === homeId);
      return workflows.filter((wf) => wf.folderId === folderFilter);
    },
    [folderFilter, workflows, homeId, incomingShare]
  );
  const folderLabel = incomingShare
    ? `${incomingShare.folderName || "Shared folder"} · shared with you`
    : folderFilter && folderFilter !== homeId
      ? folders.find((folder) => folder.id === folderFilter)?.name
      : homeFolder?.name || "My Workflows";

  // Keep folder pickers useful with deep trees by showing the complete path.
  const folderPath = useCallback((folderId: string) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = folders.find((folder) => folder.id === folderId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = current.parentId ? folders.find((folder) => folder.id === current!.parentId) : undefined;
    }
    return parts.join(" / ");
  }, [folders]);

  const folderOptions = useMemo(() => {
    const options: Array<{ folder: WorkflowFolder; depth: number }> = [];
    const visit = (parentId: string | undefined, depth: number) => {
      for (const folder of folders.filter((item) => (item.parentId || undefined) === parentId)) {
        options.push({ folder, depth });
        visit(folder.id, depth + 1);
      }
    };
    visit(undefined, 0);
    return options;
  }, [folders]);
  const selectedCount = selectedIds.length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = !!target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
      if (editing && !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "a" && !editing) {
        e.preventDefault();
        setSelectedIds(visibleWorkflows.map((wf) => wf.id));
      } else if ((e.ctrlKey || e.metaKey) && key === "c" && !editing) {
        if (!selectedIds.length) return;
        e.preventDefault();
        setExplorerClipboard({ mode: "copy", ids: selectedIds });
        show(`${selectedIds.length} workflow${selectedIds.length === 1 ? "" : "s"} copied`);
      } else if ((e.ctrlKey || e.metaKey) && key === "x" && !editing) {
        if (!selectedIds.length) return;
        e.preventDefault();
        setExplorerClipboard({ mode: "cut", ids: selectedIds });
        show(`${selectedIds.length} workflow${selectedIds.length === 1 ? "" : "s"} cut`);
      } else if ((e.ctrlKey || e.metaKey) && key === "v" && !editing) {
        if (!clipboardRef.current?.ids.length) return;
        e.preventDefault();
        paste();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !editing && selectedIds.length) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "Escape" && !editing) {
        setSelectedIds([]);
      } else if (e.key === "Enter" && !editing && selectedIds.length === 1) {
        onOpen(selectedIds[0]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, onOpen, paste, selectedIds, setExplorerClipboard, show, visibleWorkflows]);

  const startWorkflowDrag = (e: React.DragEvent, wf: Workflow) => {
    const ids = selectedIds.includes(wf.id) ? selectedIds : [wf.id];
    setSelectedIds(ids);
    e.dataTransfer.setData(WORKFLOW_DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  };

  const isWorkflowDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types || []).includes(WORKFLOW_DRAG_TYPE);

  const folderDropKey = (folderId?: string) => folderId || homeId || "";

  // One folder row (or workflow row) as a drop target — returns the React drag
  // handlers for moving the dragged workflows into `folderId`. The caller adds
  // the highlight class itself from dragOverFolder.
  const folderDropProps = (folderId?: string) => {
    const key = folderDropKey(folderId);
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!isWorkflowDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (dragOverFolder !== key) setDragOverFolder(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverFolder((current) => (current === key ? null : current));
      },
      onDrop: (e: React.DragEvent) => {
        if (!isWorkflowDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOverFolder(null);
        try {
          const ids = JSON.parse(e.dataTransfer.getData(WORKFLOW_DRAG_TYPE)) as string[];
          if (Array.isArray(ids) && ids.length) move(ids, folderId || undefined);
        } catch {
          /* not an internal workflow drag */
        }
      },
    };
  };

  return (
    <div
      className="dashboard"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types || []).includes("Files")) setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (Array.from(e.dataTransfer.types || []).includes("Files")) setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer.types || []).includes(WORKFLOW_DRAG_TYPE)) return;
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        if (file) importWorkflow(file);
      }}
    >
      {dragOver && (
        <div className="drop-import-overlay">
          <div className="drop-import-box">Drop workflow JSON to import<small>creates a new workflow and opens it</small></div>
        </div>
      )}
      <div className="dash-head">
        <div className="dash-title">
          Your workflows
          <small>{folderLabel || "Your automation projects"}</small>
          {!loading && <span className="dash-count" aria-label={`${visibleWorkflows.length} workflows`}>{visibleWorkflows.length} {visibleWorkflows.length === 1 ? "workflow" : "workflows"}</span>}
        </div>
        <div className="dash-actions">
          <button className="btn" onClick={() => setTemplatesOpen(true)} title="Start from a ready-made workflow template"><LayoutTemplate size={14} /> Templates</button>
          <button className="btn" onClick={() => fileInputRef.current?.click()} title="Import a workflow from a JSON file"><Upload size={14} /> Import</button>
          <input ref={fileInputRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={pickFile} />
          <button className="btn btn-primary" onClick={openDialog} disabled={creating}><Plus size={14} /> {creating ? "Creating…" : "New workflow"}</button>
        </div>
      </div>

      <div className="workflow-explorer">
        <aside className="workflow-sidebar" aria-label="Workflow folders">
          {/* One single directory: the main folder row at the top, then every
              subfolder and workflow nested under it. No separate sections. */}
          <div
            className={`explorer-tree-row ${!folderFilter || folderFilter === homeId ? "active" : ""} ${dragOverFolder === folderDropKey(homeId) ? "drop-target" : ""}`}
            onClick={() => setFolderFilter(homeId)}
            {...folderDropProps(homeId)}
            title={`${homeFolder?.name || "My Workflows"} — your main folder, it cannot be deleted and every workflow lives inside it`}
          >
            <Home size={14} /> <span>{homeFolder?.name || "My Workflows"}</span>
            <span className="explorer-home-badge" title="Your main folder">Main</span>
            {homeFolder && isFolderSharedByMe(homeFolder.id) && (
              <span className="explorer-shared-badge" title={`Shared with ${mySharedFolder?.email}${mySharedFolder?.includeSubfolders ? " (including subfolders)" : ""}`}>
                SHARED
              </span>
            )}
            <small>{workflows.length}</small>
            {homeFolder && (
              <div className="explorer-tree-actions">
                <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setShareTarget(homeFolder); }} title={`Share ${homeFolder.name} with another user`}>
                  <Share2 size={11} />
                </button>
              </div>
            )}
          </div>
          {workflows.filter((wf) => !wf.folderId || wf.folderId === homeId).map((wf) => (
            <button
              key={wf.id}
              className={`explorer-tree-workflow ${selectedIds.includes(wf.id) ? "selected" : ""} ${dragOverFolder === folderDropKey(homeId) ? "drop-target" : ""}`}
              draggable
              onDragStart={(e) => startWorkflowDrag(e, wf)}
              onDragEnd={() => setDragOverFolder(null)}
              {...folderDropProps(homeId)}
              onClick={() => onOpen(wf.id)}
              title={`Open ${wf.name} · drag to move it to another folder`}
            >
              <GitBranch size={11} /> <span>{wf.name}</span>
            </button>
          ))}
          {(() => {
            // Folders are rendered inside the main folder (depth starts at 1 so
            // they sit visually under it) — the old "Workspace" root is gone.
            const renderFolder = (folder: WorkflowFolder, depth = 1): ReactElement => {
              const children = workflows.filter((wf) => wf.folderId === folder.id);
              const childFolders = folders.filter((item) => item.parentId === folder.id);
              const expanded = expandedFolders.has(folder.id);
              return (
                <div key={folder.id} className="explorer-folder-group">
                  <div
                    className={`explorer-tree-row ${folderFilter === folder.id ? "active" : ""} ${dragOverFolder === folderDropKey(folder.id) ? "drop-target" : ""}`}
                    style={{ paddingLeft: `${7 + Math.min(depth, 8) * 14}px` }}
                    onClick={() => { setFolderFilter(folder.id); setExpandedFolders((current) => new Set(current).add(folder.id)); }}
                    {...folderDropProps(folder.id)}
                  >
                    <button
                      className="explorer-disclosure"
                      onClick={(e) => { e.stopPropagation(); setExpandedFolders((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; }); }}
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}
                    >{expanded ? "▾" : "▸"}</button>
                    {expanded ? <FolderOpen size={14} /> : <Folder size={14} />} <span title={folderPath(folder.id)}>{folder.name}</span>
                    {isFolderSharedByMe(folder.id) && (
                      <span
                        className="explorer-shared-badge"
                        title={
                          mySharedFolder?.folderId === folder.id
                            ? `Shared with ${mySharedFolder.email}${mySharedFolder.includeSubfolders ? " (including subfolders)" : ""}`
                            : `Shared with ${mySharedFolder?.email} through the folder “${mySharedFolder?.folderName || ""}”`
                        }
                      >
                        {mySharedFolder?.folderId === folder.id ? `SHARED${mySharedFolder.includeSubfolders ? " +SUBFOLDERS" : ""}` : "SHARED"}
                      </span>
                    )}
                    <small>{children.length + childFolders.length}</small>
                    <div className="explorer-tree-actions">
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); setShareTarget(folder); }} title={`Share ${folder.name} with another user — workflows inside it are shared too`}><Share2 size={11} /></button>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); openRenameFolder(folder); }} title={`Rename ${folder.name}`}><Pencil size={11} /></button>
                      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); openFolderDialog(folder.id); }} title={`New subfolder in ${folder.name}`}><FolderPlus size={11} /></button>
                      <button className="icon-btn btn-danger" onClick={(e) => { e.stopPropagation(); deleteFolder(folder); }} title={`Delete ${folder.name}`}><Trash2 size={11} /></button>
                    </div>
                  </div>
                  {expanded && childFolders.map((child) => renderFolder(child, depth + 1))}
                  {expanded && children.map((wf) => (
                    <button
                      key={wf.id}
                      className={`explorer-tree-workflow ${selectedIds.includes(wf.id) ? "selected" : ""} ${dragOverFolder === folderDropKey(folder.id) ? "drop-target" : ""}`}
                      style={{ marginLeft: `${26 + Math.min(depth, 8) * 14}px`, width: `calc(100% - ${26 + Math.min(depth, 8) * 14}px)` }}
                      draggable
                      onDragStart={(e) => startWorkflowDrag(e, wf)}
                      onDragEnd={() => setDragOverFolder(null)}
                      {...folderDropProps(folder.id)}
                      onClick={() => onOpen(wf.id)}
                      title={`Open ${wf.name} · drag to move it to another folder`}
                    >
                      <GitBranch size={11} /> <span>{wf.name}</span>
                    </button>
                  ))}
                </div>
              );
            };
            // The account's main folder (home:true) is the MAIN row at the top —
            // never render it again as a regular folder, otherwise every
            // workflow in it would appear twice in the sidebar.
            return folders.filter((folder) => !folder.parentId && !folder.home).map((folder) => renderFolder(folder));
          })()}
          <div className="explorer-new-folder">
            <input aria-label="New folder name" value={folderName} onChange={(e) => setFolderName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createFolder(undefined, folderName)} placeholder="New folder name" />
            <button className="btn btn-sm" onClick={() => createFolder(undefined, folderName)} disabled={!folderName.trim() || creatingFolder}><FolderPlus size={13} /> {creatingFolder ? "Creating…" : "New folder"}</button>
          </div>
          {folderShares.incoming.length > 0 && (
            <div className="explorer-shared-section">
              <div className="explorer-shared-head">
                <Users size={11} /> SHARED WITH YOU
              </div>
              {folderShares.incoming.map((share) => {
                const filter = `${SHARED_FILTER_PREFIX}${share.folderId}`;
                return (
                  <button
                    key={share.id}
                    className={`explorer-tree-row explorer-shared-row ${folderFilter === filter ? "active" : ""}`}
                    onClick={() => setFolderFilter(filter)}
                    title={`${share.folderName || "Folder"} — shared by ${share.ownerName || share.ownerEmail || "another user"}`}
                  >
                    <FolderOpen size={13} /> <span>{share.folderName || "Shared folder"}</span>
                    <small>{share.ownerName || share.ownerEmail || "shared"}</small>
                  </button>
                );
              })}
            </div>
          )}
          <div className="explorer-sidebar-help">Everything lives inside your main folder — it cannot be deleted and you can't save outside it. Drag workflows onto a folder to move them, use ＋ on a folder for a subfolder and the share icon to share one folder (with workflows, optionally with its subfolders).</div>
        </aside>

        <main className="workflow-explorer-main">
          <div className="explorer-toolbar">
            <div className="explorer-breadcrumb"><FolderOpen size={14} /> {folderLabel}</div>
            <div className="explorer-selection-actions">
              {clipboard && <span className="explorer-clipboard"><Clipboard size={12} /> {clipboard.mode === "cut" ? "Cut" : "Copied"} {clipboard.ids.length}</span>}
              {selectedCount > 0 && <>
                <button className="btn btn-sm" onClick={() => setExplorerClipboard({ mode: "copy", ids: selectedIds })} title="Copy selected workflows (Ctrl/Cmd+C)"><Copy size={12} /> Copy</button>
                <button className="btn btn-sm" onClick={() => setExplorerClipboard({ mode: "cut", ids: selectedIds })} title="Cut selected workflows (Ctrl/Cmd+X)"><Scissors size={12} /> Cut</button>
                <button className="btn btn-sm" onClick={() => paste()} disabled={!clipboard} title="Paste into the current folder (Ctrl/Cmd+V)"><Clipboard size={12} /> Paste</button>
                <button className="btn btn-sm btn-ghost btn-danger" onClick={deleteSelected} title="Delete selected workflows"><Trash2 size={12} /></button>
                <button className="btn btn-sm btn-ghost" onClick={() => setSelectedIds([])} title="Clear selection"><X size={12} /></button>
              </>}
            </div>
          </div>

          {loading ? (
            <div className="run-loading" style={{ padding: 40 }}><span className="spinner" /> Loading workflows…</div>
          ) : visibleWorkflows.length === 0 ? (
            <div className="wf-empty">
              <span className="plus">+</span>
              <div className="wf-empty-title">{folderFilter && folderFilter !== "__unfiled__" ? `No workflows in ${folderLabel}` : "Create your first workflow"}</div>
              <div className="wf-empty-sub">{folderFilter ? "Create a workflow here, paste one, or drag an existing workflow into this folder." : "Build an automation: add a trigger, connect nodes, run it. Your workspace starts empty — the guide has example workflows to follow."}</div>
              <div className="wf-empty-actions">
                <button className="btn btn-primary" onClick={openDialog} disabled={creating}><Plus size={14} /> {creating ? "Creating…" : "New workflow"}</button>
                <button className="btn" onClick={() => setTemplatesOpen(true)} title="Start from a ready-made workflow template"><LayoutTemplate size={14} /> Start from a template</button>
                {!folderFilter && onOpenGuide && <button className="btn" onClick={onOpenGuide} title="Open the user guide on its own page"><BookOpen size={14} /> Read the guide</button>}
              </div>
            </div>
          ) : (
            <div className="wf-grid">
              {visibleWorkflows.map((wf) => {
                const triggers = triggerNames(wf, catalog);
                const selected = selectedIds.includes(wf.id);
                return (
                  <div
                    key={wf.id}
                    className={`wf-card ${selected ? "selected" : ""} ${dragOverFolder === folderDropKey(wf.folderId || homeId) ? "drop-target" : ""}`}
                    draggable
                    onDragStart={(e) => startWorkflowDrag(e, wf)}
                    onDragEnd={() => setDragOverFolder(null)}
                    {...folderDropProps(wf.folderId || homeId)}
                    onClick={() => onOpen(wf.id)}
                    title="Click to open · use the checkbox to select · drag to move"
                  >
                    <button
                      type="button"
                      className="wf-card-select"
                      onClick={(e) => toggleWorkflowSelection(e, wf.id)}
                      aria-label={`${selected ? "Deselect" : "Select"} ${wf.name}`}
                      title={selected ? "Deselect workflow" : "Select workflow"}
                    >{selected ? <Check size={16} strokeWidth={3} /> : null}</button>
                    <div className="wf-card-head"><div className="wf-card-icon"><GitBranch size={16} /></div><div className="wf-card-name">{wf.name}</div>
                      <button
                        type="button"
                        className="wf-card-more"
                        aria-label={`More actions for ${wf.name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuId === wf.id}
                        title="More actions"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuId((id) => (id === wf.id ? null : wf.id));
                        }}
                      ><MoreVertical size={14} /></button>
                      {menuId === wf.id && (
                        <div className="wf-card-menu" role="menu" onClick={(e) => { e.stopPropagation(); setMenuId(null); }}>
                          <button type="button" role="menuitem" onClick={() => onOpen(wf.id)}><FolderOpen size={12} /> Open</button>
                          <button type="button" role="menuitem" onClick={(e) => run(e, wf)} disabled={runningId === wf.id}><Play size={12} /> Run</button>
                          <button type="button" role="menuitem" onClick={() => duplicate(wf)}><Copy size={12} /> Duplicate</button>
                          <button type="button" role="menuitem" onClick={() => downloadJson(wf)}><Download size={12} /> Download JSON</button>
                          <button type="button" role="menuitem" className="danger" onClick={(e) => del(e, wf)}><Trash2 size={12} /> Delete</button>
                        </div>
                      )}
                    </div>
                    <div className="wf-card-desc">{wf.description || "No description"}</div>
                    <div className="wf-card-meta">
                      <span className="tag">{wf.nodes.length} Nodes</span><span className="tag">{wf.edges?.length || 0} Links</span>
                      {wf.shared && (
                        <span className="tag" style={{ color: "var(--cyan)", borderColor: "color-mix(in srgb, var(--cyan) 40%, transparent)" }} title={wf.sharedViaFolder ? `From the folder “${wf.sharedFolderName || ""}” shared with you` : "Shared with you by another user"}>
                          <Users size={10} /> {wf.sharedViaFolder ? "Shared folder" : "Shared"}
                        </span>
                      )}
                      {triggers.map((t) => <span key={t} className="tag" style={{ color: "var(--green)" }}>{t}</span>)}
                    </div>
                    <div className="wf-card-actions">
                      <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); onOpen(wf.id); }} title="Open workflow">Open</button>
                      <button className="btn btn-sm" onClick={(e) => run(e, wf)} disabled={runningId === wf.id} title="Run workflow now"><Play size={11} /> {runningId === wf.id ? "Running…" : "Run"}</button>
                      <button className="btn btn-sm btn-ghost btn-danger" onClick={(e) => del(e, wf)} title="Delete"><Trash2 size={11} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>

      {folderDialogParentId !== undefined && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setFolderDialogParentId(undefined)}>
          <div className="modal panel panel-corner" role="dialog" aria-modal="true" aria-label="Create subfolder">
            <div className="modal-title">New subfolder</div>
            <div className="modal-sub">Create a folder inside {folders.find((folder) => folder.id === folderDialogParentId)?.name || "this folder"}</div>
            <input
              autoFocus
              aria-label="Subfolder name"
              value={folderDialogName}
              onChange={(e) => setFolderDialogName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createFolder(folderDialogParentId, folderDialogName);
                if (e.key === "Escape") setFolderDialogParentId(undefined);
              }}
              placeholder="e.g. Daily reports"
            />
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setFolderDialogParentId(undefined)}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={() => createFolder(folderDialogParentId, folderDialogName)} disabled={!folderDialogName.trim() || creatingFolder}>
                <FolderPlus size={12} /> {creatingFolder ? "Creating…" : "Create subfolder"}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameFolderId !== undefined && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setRenameFolderId(undefined)}>
          <div className="modal panel panel-corner" role="dialog" aria-modal="true" aria-label="Rename folder">
            <div className="modal-title">Rename folder</div>
            <div className="modal-sub">Choose a new name for {folders.find((folder) => folder.id === renameFolderId)?.name || "this folder"}</div>
            <input
              autoFocus
              aria-label="Folder name"
              value={renameFolderName}
              onChange={(e) => setRenameFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") renameFolder();
                if (e.key === "Escape") setRenameFolderId(undefined);
              }}
              placeholder="Folder name"
            />
            <div className="modal-actions">
              <button className="btn btn-sm" onClick={() => setRenameFolderId(undefined)}>Cancel</button>
              <button className="btn btn-sm btn-primary" onClick={renameFolder} disabled={!renameFolderName.trim()}>Save name</button>
            </div>
          </div>
        </div>
      )}

      {showDialog && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeDialog()}>
          <div className="modal panel panel-corner">
            <div className="modal-title">New workflow</div><div className="modal-sub">Give your workflow a name</div>
            <input ref={dialogRef} value={nameInput} onChange={(e) => setNameInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(nameInput); if (e.key === "Escape") closeDialog(); }} placeholder="e.g. Daily report" />
            <div className="field" style={{ marginTop: 12 }}><div className="field-label">Folder</div><Select value={newFolderId} onChange={(e) => setNewFolderId(e.target.value)}><option value={homeId}>{homeFolder?.name || "My Workflows"}</option>{folderOptions.filter((o) => o.folder.id !== homeId).map(({ folder, depth }) => <option key={folder.id} value={folder.id}>{"— ".repeat(Math.max(depth - 1, 0))}{folder.name}</option>)}</Select></div>
            <div className="modal-actions"><button className="btn btn-sm" onClick={closeDialog}>Cancel</button><button className="btn btn-sm btn-primary" onClick={() => create(nameInput)} disabled={creating}><Plus size={12} /> {creating ? "Creating…" : "Create"}</button></div>
          </div>
        </div>
      )}
      {shareTarget && (
        <FolderShareModal
          folder={{ id: shareTarget.id, name: shareTarget.name }}
          onClose={() => setShareTarget(null)}
          onChanged={() => refresh().catch(() => show("Failed to refresh folders", "err"))}
          onMessage={show}
        />
      )}

      {templatesOpen && (
        <TemplateGallery
          folderId={activeFolderId || homeId || undefined}
          onCreated={(wf) => {
            setWorkflows((current) => [...current, wf]);
            setSelectedIds([wf.id]);
            onOpen(wf.id);
          }}
          onClose={() => setTemplatesOpen(false)}
          onMessage={show}
        />
      )}

      <Toast toast={toast} />
    </div>
  );
}

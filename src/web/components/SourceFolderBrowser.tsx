import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useI18n } from "../lib/i18n";
import { ErrorState, GhostButton } from "./ui";

export function SourceFolderBrowser({ initialPath, onSelect, onClose }: { initialPath: string; onSelect: (path: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initialPath);
  const [address, setAddress] = useState(initialPath);
  const state = useAsync(async () => ({ ...await api.sourceFolders(path), requestedPath: path }), [path]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const navigate = (next: string) => { setPath(next); setAddress(next); };
  const ready = state.data?.requestedPath === path;
  return <dialog ref={dialog} className="source-folder-dialog" aria-label={t("Choose folder", "Wybierz folder")} onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="ui-toolbar"><strong className="ui-display" style={{ fontSize: "var(--fs-card-title)" }}>{t("Choose folder", "Wybierz folder")}</strong><span className="ui-spacer" /><GhostButton onClick={onClose}>×</GhostButton></div>
    <div className="ui-toolbar">
      <GhostButton disabled={!ready || !state.data?.parent} onClick={() => state.data?.parent && navigate(state.data.parent)}>↑</GhostButton>
      <input className="ui-date-input" aria-label={t("Folder path", "Ścieżka folderu")} placeholder={state.data?.path} value={address} onChange={event => setAddress(event.target.value)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); navigate(address); } }} />
      <GhostButton onClick={() => navigate(address)}>{t("Open", "Otwórz")}</GhostButton>
    </div>
    <div className="ui-toolbar"><GhostButton onClick={() => navigate("")}>{t("Home", "Folder użytkownika")}</GhostButton>{state.data?.roots.filter(root => root !== state.data?.roots[0]).map(root => <GhostButton key={root} onClick={() => navigate(root)}>{root}</GhostButton>)}</div>
    {state.error && <ErrorState message={state.error} onRetry={state.reload} />}
    <div className="source-folder-list" aria-label={t("Folders", "Foldery")}>
      {state.loading ? <span>{t("Loading…", "Wczytuję…")}</span> : ready && state.data?.folders.map(folder =>
        <button type="button" key={folder.path} onClick={() => navigate(folder.path)}><span aria-hidden="true">▸</span> {folder.name}</button>)}
    </div>
    <div className="ui-toolbar"><span className="ui-spacer" /><GhostButton emphasis disabled={!ready || state.loading || !!state.error} onClick={() => state.data && onSelect(state.data.path)}>{t("Choose this folder", "Wybierz ten folder")}</GhostButton><GhostButton onClick={onClose}>{t("Cancel", "Anuluj")}</GhostButton></div>
  </dialog>;
}

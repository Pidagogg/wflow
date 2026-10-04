/**
 * RoleSelect — what a share allows, set by the owner per person (and per
 * shared folder). The server enforces it (server/index.js denyUnlessRole).
 */
import type { ShareRole } from "../types";
import Select from "./Select";

export const ROLE_LABEL: Record<ShareRole, string> = { viewer: "Can view", runner: "Can view & run", editor: "Can edit" };
export const ROLE_HELP: Record<ShareRole, string> = {
  viewer: "Opens the workflow, its runs and comments — cannot run or change it.",
  runner: "Also runs it (Run, Debug, chat) — cannot change it.",
  editor: "Changes and saves it, like you.",
};

export default function RoleSelect({ value, onChange, disabled }: { value?: ShareRole; onChange: (r: ShareRole) => void; disabled?: boolean }) {
  return (
    <Select className="role-select" value={value || "editor"} onChange={(e) => onChange(e.target.value as ShareRole)} disabled={disabled} title={ROLE_HELP[value || "editor"]}>
      <option value="viewer">{ROLE_LABEL.viewer}</option>
      <option value="runner">{ROLE_LABEL.runner}</option>
      <option value="editor">{ROLE_LABEL.editor}</option>
    </Select>
  );
}

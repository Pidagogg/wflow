import type { InputHTMLAttributes } from "react";

// ============================================================================
// SecretInput — a masked field for API keys, tokens and secret values.
//
// Deliberately NOT type="password". Browsers treat a text box followed by a
// password box as a login form: they fill the W flow e-mail and password into
// it (silently saving the user's own login as a credential or variable) and
// offer to store every pasted key in the password manager. Chrome ignores
// autocomplete="off" on real password fields, so the dots come from
// .secret-mask (-webkit-text-security) on a plain text field instead.
// Real passwords — sign-in, change password, delete account — keep
// type="password".
// ============================================================================

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { revealed?: boolean };

export function SecretInput({ revealed = false, className = "", ...rest }: Props) {
  return (
    <input
      {...rest}
      type="text"
      className={[className, revealed ? "" : "secret-mask"].filter(Boolean).join(" ") || undefined}
      autoComplete="off"
      data-lpignore="true"
      data-1p-ignore=""
      spellCheck={false}
    />
  );
}

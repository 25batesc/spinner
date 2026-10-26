// Flat ESLint config shared by every package. Packages do not carry their own ESLint config so
// that one rule set applies across the workspace.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            "max-len": ["error", { code: 100, ignoreUrls: true }],
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
);

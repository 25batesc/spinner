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
        // The example stacks are plain Node scripts that run inside containers.
        files: ["examples/**/*.js"],
        languageOptions: {
            globals: {
                process: "readonly",
                console: "readonly",
                URL: "readonly",
                fetch: "readonly",
            },
        },
    },
    {
        rules: {
            "max-len": ["error", { code: 100, ignoreUrls: true }],
            "@typescript-eslint/consistent-type-imports": "error",
        },
    },
);

// The commits of the diff viewer and its comment library that Spinner runs. They are not
// package dependencies: the viewer's `package.json` names peanut as `file:../peanut`, and
// peanut ships TypeScript sources that Node refuses to run from under `node_modules`. The
// daemon clones both side by side under `<home>/diffview/src/` on first use (MISSION.md s012,
// Contracts 23:48). Move a pin here and the next `diff/start` fetches again.

export interface DiffPin {
    /** `owner/name` on GitHub. */
    repo: string;
    /** The full commit sha. */
    sha: string;
    /** The directory name under `<home>/diffview/src/`. The viewer expects `../peanut`. */
    dir: string;
}

export const DIFF_PINS = {
    viewer: {
        repo: "adamsanghera/diff-viewer",
        sha: "0707cd677fd64cbe0a83bee88c4073ad8d2e1df7",
        dir: "diff-viewer",
    },
    peanut: {
        repo: "adamsanghera/peanut",
        sha: "eba4e3424bb238ae51944f71f8a574a65bcc7923",
        dir: "peanut",
    },
} as const satisfies Record<string, DiffPin>;

/** The viewer's executable, relative to its checkout. */
export const DIFF_VIEWER_BIN = "bin/diffview.mjs";

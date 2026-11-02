// The Review block's reading and writing of `settings.review`.
import { REVIEW_MODELS_DEFAULT, REVIEW_N_DEFAULT } from "@spinner/protocol";
import { expect, it } from "vitest";

import { parseModels, reviewModelsText, reviewN, withReview } from "./review-settings.ts";

it("shows the defaults when nothing is set", () => {
    expect(reviewModelsText({ theme: "system" })).toBe(REVIEW_MODELS_DEFAULT.join("\n"));
    expect(reviewN({ theme: "system" })).toBe(REVIEW_N_DEFAULT);
});

it("parses the lines: trimmed, blanks dropped, duplicates folded", () => {
    expect(parseModels(" a/x \n\nb/y\na/x\n")).toEqual(["a/x", "b/y"]);
});

it("writes models and n, keeps command, and drops models when the list is empty", () => {
    const base = { theme: "system", review: { command: "/opt/rb", models: ["old"], n: 2 } };
    expect(withReview(base, "a/x\nb/y", 4)).toEqual({
        theme: "system", review: { command: "/opt/rb", models: ["a/x", "b/y"], n: 4 },
    });
    expect(withReview(base, "  \n", 1)).toEqual({
        theme: "system", review: { command: "/opt/rb", n: 1 },
    });
});

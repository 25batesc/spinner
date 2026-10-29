// Goal: the inline pages escape what they interpolate. Method: feed markup through each page.
import { describe, expect, it } from "vitest";
import { down_page, error_page, escape_html, starting_page } from "./pages.js";

describe("pages", () => {
    it("escape the url and the detail", () => {
        const hostile = `http://x/<script>alert("1")</script>`;
        for (const html of [
            starting_page(hostile),
            down_page(hostile, hostile),
            error_page(hostile, hostile),
        ]) {
            expect(html).not.toContain("<script>");
            expect(html).toContain("&lt;script&gt;");
        }
    });

    it("the error page links back to the real url", () => {
        expect(error_page("http://web.s1.localhost/a?b=1&c=2", "x")).toContain(
            `href="http://web.s1.localhost/a?b=1&amp;c=2"`,
        );
    });

    it("escape_html covers the four characters HTML needs", () => {
        expect(escape_html(`<a href="x">&</a>`)).toBe(
            "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;",
        );
    });
});

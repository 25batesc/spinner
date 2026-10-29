// Inline HTML the app shows when the daemon's UI is not there to show: the window while the
// daemon starts, the window when no daemon can be reached, and the error page inside a
// preview view whose load failed. Plain strings, no templating; values are escaped.

const STYLE = `
    body { font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #ddd; background: #1b1b1f;
           margin: 0; display: grid; place-items: center; height: 100vh; }
    main { max-width: 36rem; padding: 2rem; }
    h1 { font-size: 1.1rem; margin: 0 0 .5rem; }
    code { background: #2a2a30; padding: .1rem .3rem; border-radius: 3px; }
    a { color: #8ab4f8; }
    p.muted { color: #999; }
`;

function page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escape_html(title)}</title>
<style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function starting_page(url: string): string {
    return page(
        "Spinner: starting the daemon",
        `<h1>Starting the daemon…</h1>
<p class="muted">No daemon answered at <code>${escape_html(url)}</code>, so the app runs
<code>spinner daemon start</code> and waits up to 30 s for <code>/health</code>.</p>`,
    );
}

export function down_page(url: string, detail: string): string {
    return page(
        "Spinner: no daemon",
        `<h1>No daemon at <code>${escape_html(url)}</code></h1>
<p>${escape_html(detail)}</p>
<p class="muted">Start one with <code>spinner daemon start</code> from the checkout, then use
the tray item <em>Reconnect</em>, or <em>Start daemon</em> to let the app try again.</p>`,
    );
}

export function error_page(url: string, error: string): string {
    return page(
        "Preview failed",
        `<h1>The preview did not load</h1>
<p><code>${escape_html(url)}</code></p>
<p>${escape_html(error)}</p>
<p class="muted">Is the service up? <a href="${escape_attribute(url)}">Retry</a></p>`,
    );
}

export function escape_html(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function escape_attribute(text: string): string {
    return escape_html(text).replaceAll("'", "&#39;");
}

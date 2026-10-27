// The sample web page: one HTML page that lists the items from the API and says which
// session it runs in. The page is rendered on the server from the internal API URL, so a
// plain `curl` through the proxy shows the data without a browser.
import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const session_id = process.env.SESSION_ID ?? "unknown";
const api_url = process.env.API_URL ?? "http://api:3000";
const public_api_url = process.env.PUBLIC_API_URL ?? api_url;

const server = createServer(async (request, response) => {
    let items = [];
    let problem = null;
    try {
        const reply = await fetch(`${api_url}/items`);
        const body = await reply.json();
        items = body.items ?? [];
    } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
    }
    const rows = items.map((item) => `<li>${item.id}. ${escape_html(item.name)}</li>`);
    const body =
        problem === null
            ? `<ul>\n${rows.join("\n")}\n</ul>`
            : `<p class="error">API error: ${escape_html(problem)}</p>`;
    const html = `<!doctype html>
<title>sample · ${session_id}</title>
<h1>sample stack, session ${session_id}</h1>
<p>API: <a href="${public_api_url}/items">${public_api_url}/items</a></p>
${body}
`;
    const status = problem === null ? 200 : 502;
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
});

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function escape_html(text) {
    return String(text).replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);
}

server.listen(port, "0.0.0.0", () => {
    console.log(`sample web for ${session_id} listening on ${port}`);
});

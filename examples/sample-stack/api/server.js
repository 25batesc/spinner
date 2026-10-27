// The sample API: `GET /items` reads the seeded table, `GET /health` checks the database.
// It uses only `node:http` and `pg`, so the dependency install the stack runner does per
// lockfile hash is exercised by one small package.
import { createServer } from "node:http";
import pg from "pg";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const session_id = process.env.SESSION_ID ?? "unknown";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
        if (url.pathname === "/health") {
            await pool.query("SELECT 1");
            return send(response, 200, { ok: true, session: session_id });
        }
        if (url.pathname === "/items") {
            const result = await pool.query("SELECT id, name FROM items ORDER BY id");
            return send(response, 200, { session: session_id, items: result.rows });
        }
        return send(response, 404, { error: "not found" });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return send(response, 500, { error: message });
    }
});

function send(response, status, body) {
    response.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
    });
    response.end(JSON.stringify(body));
}

server.listen(port, "0.0.0.0", () => {
    console.log(`sample api for ${session_id} listening on ${port}`);
});

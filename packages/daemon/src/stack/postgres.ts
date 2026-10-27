// Database operations on the shared Postgres server: clone a session database from the
// template, drop it, and rebuild the template. Spinner creates and drops databases and
// nothing else, whether the server is its own `spinner-postgres` container or an external one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import type { StackDatabase } from "@spinner/protocol";
import { POSTGRES_HOST_PORT, POSTGRES_PASSWORD } from "./docker.js";

export interface ServerAddress {
    host: string;
    port: number;
    user: string;
    password: string;
}

/** Where the CLI reaches the server from the host. */
export function server_address(database: StackDatabase | undefined): ServerAddress {
    if (database?.server === "external") {
        const external = database.external;
        assert.ok(external !== undefined, "database.external is required with server: external");
        return {
            host: external.host,
            port: external.port,
            user: external.user,
            password: external.password ?? external.user,
        };
    }
    return {
        host: "127.0.0.1",
        port: POSTGRES_HOST_PORT,
        user: "postgres",
        password: POSTGRES_PASSWORD,
    };
}

/** Database names come from the spec and from session ids; a strict pattern keeps SQL safe. */
export function assert_identifier(name: string): void {
    assert.ok(/^[a-z_][a-z0-9_]{0,62}$/.test(name), `not a safe database name: ${name}`);
}

/** Upper bound on the wait for a server that is still starting. */
const READY_ATTEMPTS_MAX = 60;
const READY_INTERVAL_MS = 500;

export class DatabaseServer {
    private readonly address: ServerAddress;

    constructor(address: ServerAddress) {
        this.address = address;
    }

    describe(): string {
        return `${this.address.user}@${this.address.host}:${this.address.port}`;
    }

    /** Polls until the server accepts a connection. Throws after the bound. */
    async wait_ready(): Promise<void> {
        let last = "";
        for (let attempt = 0; attempt < READY_ATTEMPTS_MAX; attempt += 1) {
            try {
                await this.query("postgres", "SELECT 1");
                return;
            } catch (error) {
                last = error instanceof Error ? error.message : String(error);
                await sleep(READY_INTERVAL_MS);
            }
        }
        throw new Error(`postgres at ${this.describe()} did not answer: ${last}`);
    }

    async database_exists(name: string): Promise<boolean> {
        assert_identifier(name);
        const sql = "SELECT 1 FROM pg_database WHERE datname = $1";
        const rows = await this.query("postgres", sql, [name]);
        return rows.length > 0;
    }

    async list_databases(prefix: string): Promise<string[]> {
        const rows = await this.query<{ datname: string }>(
            "postgres",
            "SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname",
            [`${prefix}%`],
        );
        return rows.map((row) => row.datname);
    }

    /**
     * `CREATE DATABASE <name> TEMPLATE <template>`. Postgres refuses while any client is on
     * the template, so those sessions are ended first. A database that exists is left alone.
     */
    async clone_from_template(name: string, template: string): Promise<"created" | "exists"> {
        assert_identifier(name);
        assert_identifier(template);
        if (await this.database_exists(name)) {
            return "exists";
        }
        if (!(await this.database_exists(template))) {
            throw new Error(
                `template database ${template} does not exist; run \`spinner seed rebuild\``,
            );
        }
        await this.terminate_clients(template);
        await this.query("postgres", `CREATE DATABASE "${name}" TEMPLATE "${template}"`);
        assert.ok(await this.database_exists(name), "clone must exist afterwards");
        return "created";
    }

    async drop_database(name: string): Promise<"dropped" | "absent"> {
        assert_identifier(name);
        if (!(await this.database_exists(name))) {
            return "absent";
        }
        await this.query("postgres", `ALTER DATABASE "${name}" IS_TEMPLATE false`);
        await this.terminate_clients(name);
        await this.query("postgres", `DROP DATABASE "${name}" WITH (FORCE)`);
        assert.ok(!(await this.database_exists(name)), "database must be gone afterwards");
        return "dropped";
    }

    /** Creates an empty database, loads a SQL dump into it and marks it as a template. */
    async rebuild_template_from_dump(template: string, dump_path: string): Promise<void> {
        assert_identifier(template);
        const sql = read_dump(dump_path);
        await this.drop_database(template);
        await this.query("postgres", `CREATE DATABASE "${template}"`);
        await this.query(template, sql);
        await this.query("postgres", `ALTER DATABASE "${template}" IS_TEMPLATE true`);
    }

    /** Marks a database built by host commands (migrations, fixtures) as the template. */
    async mark_template(template: string): Promise<void> {
        assert_identifier(template);
        await this.query("postgres", `ALTER DATABASE "${template}" IS_TEMPLATE true`);
    }

    /** Copies an existing database into a new template, for seeds that fill a fixed database. */
    async copy_to_template(source: string, template: string): Promise<void> {
        assert_identifier(source);
        assert_identifier(template);
        await this.drop_database(template);
        await this.terminate_clients(source);
        await this.query("postgres", `CREATE DATABASE "${template}" TEMPLATE "${source}"`);
        await this.mark_template(template);
    }

    private async terminate_clients(name: string): Promise<void> {
        await this.query(
            "postgres",
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity " +
                "WHERE datname = $1 AND pid <> pg_backend_pid()",
            [name],
        );
    }

    private async query<Row extends object = Record<string, unknown>>(
        database: string,
        sql: string,
        params: unknown[] = [],
    ): Promise<Row[]> {
        const client = new pg.Client({ ...this.address, database, connectionTimeoutMillis: 5_000 });
        await client.connect();
        try {
            // Without values, pg uses the simple query protocol, which allows the many
            // statements of a dump in one call. The extended protocol allows only one.
            const result =
                params.length === 0 ? await client.query(sql) : await client.query(sql, params);
            return (result.rows ?? []) as Row[];
        } finally {
            await client.end();
        }
    }
}

function read_dump(path: string): string {
    const bytes = readFileSync(path);
    const text = path.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
    assert.ok(text.trim().length > 0, `dump ${path} is empty`);
    return text;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

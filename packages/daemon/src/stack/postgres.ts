// Database operations on the shared Postgres server: clone a session database from the
// template, drop it, and rebuild the template. Spinner creates and drops databases and
// nothing else, whether the server is its own `spinner-postgres` container or an external one.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pg from "pg";
import type { StackDatabase } from "@spinner/protocol";
import { POSTGRES_HOST_PORT, POSTGRES_PASSWORD } from "./docker.js";
import { run } from "./shell.js";

export interface ServerAddress {
    host: string;
    port: number;
    user: string;
    password: string;
    /** A superuser for the steps `user` may not do; absent on the managed server. */
    admin_user?: string;
}

/** Supabase's superuser; `postgres` there is not one. */
const ADMIN_USER_DEFAULT = "supabase_admin";

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
            admin_user: external.admin_user ?? ADMIN_USER_DEFAULT,
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

/** Upper bound on one dump or restore of a seed database. */
const DUMP_TIMEOUT_MS = 30 * 60_000;

/** The clone is retried 5 times over 10 s while something holds the template. */
const CLONE_ATTEMPTS_MAX = 5;
const CLONE_RETRY_MS = 2_000;

/** Upper bound on the wait for a server that is still starting. */
const READY_ATTEMPTS_MAX = 60;
const READY_ATTEMPTS_EXTERNAL = 3;
const READY_INTERVAL_MS = 500;

export class DatabaseServer {
    private readonly address: ServerAddress;

    constructor(address: ServerAddress) {
        this.address = address;
    }

    describe(): string {
        return `${this.address.user}@${this.address.host}:${this.address.port}`;
    }

    /**
     * Polls until the server accepts a connection. A managed container gets the full bound
     * because it may still be starting; an external server gets a few tries, because nobody
     * else will start it, and the error says so.
     */
    async wait_ready(managed: boolean): Promise<void> {
        const attempts = managed ? READY_ATTEMPTS_MAX : READY_ATTEMPTS_EXTERNAL;
        let last = "";
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                await this.query("postgres", "SELECT 1");
                return;
            } catch (error) {
                last = error instanceof Error ? error.message : String(error);
                await sleep(READY_INTERVAL_MS);
            }
        }
        const hint = managed ? "" : " (database.server is external: start that server first)";
        throw new Error(`postgres at ${this.describe()} did not answer${hint}: ${last}`);
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
        // A Supabase service may hold the template for a moment, and `postgres` there may
        // not end its session; the create is retried over a bounded window.
        let last = "";
        for (let attempt = 0; attempt < CLONE_ATTEMPTS_MAX; attempt += 1) {
            await this.terminate_clients(template);
            try {
                await this.query("postgres", `CREATE DATABASE "${name}" TEMPLATE "${template}"`);
                assert.ok(await this.database_exists(name), "clone must exist afterwards");
                return "created";
            } catch (error) {
                last = error instanceof Error ? error.message : String(error);
                await sleep(CLONE_RETRY_MS);
            }
        }
        throw new Error(
            `clone of ${template} into ${name} failed ${CLONE_ATTEMPTS_MAX} times: ${last}`,
        );
    }

    async drop_database(name: string): Promise<"dropped" | "absent"> {
        assert_identifier(name);
        if (!(await this.database_exists(name))) {
            return "absent";
        }
        await this.clear_template_flag(name);
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

    /** A connection URL for host commands that take `DATABASE_URL`. */
    url(database: string): string {
        assert_identifier(database);
        const { user, password, host, port } = this.address;
        return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
    }

    async create_database(name: string): Promise<void> {
        assert_identifier(name);
        await this.query("postgres", `CREATE DATABASE "${name}"`);
    }

    /** Marks a database built by host commands (migrations, fixtures) as the template. */
    async mark_template(template: string): Promise<void> {
        assert_identifier(template);
        await this.query("postgres", `ALTER DATABASE "${template}" IS_TEMPLATE true`);
    }

    /**
     * Copies an existing database into a new template. `CREATE DATABASE ... TEMPLATE` is a
     * file copy but needs the source free of other clients; a Supabase `postgres` database
     * always has its services connected and its `postgres` role may not end their sessions.
     * Then the copy goes through `pg_dump` and `pg_restore` on the host instead.
     */
    async copy_to_template(source: string, template: string): Promise<string> {
        assert_identifier(source);
        assert_identifier(template);
        await this.drop_database(template);
        try {
            await this.terminate_clients(source);
            await this.query("postgres", `CREATE DATABASE "${template}" TEMPLATE "${source}"`);
            await this.mark_template(template);
            return "cloned as a file copy";
        } catch {
            await this.drop_database(template);
        }
        await this.query("postgres", `CREATE DATABASE "${template}"`);
        const report = await this.dump_restore(source, template);
        await this.mark_template(template);
        return `copied with pg_dump and pg_restore${report}`;
    }

    /**
     * Returns a note about restore errors, or an empty string when there were none. The dump
     * goes through a file, not through the child's stdout: a seeded database is gigabytes,
     * and `run` caps captured output at a few tens of megabytes. Privileges are kept: a
     * Supabase application runs `SET LOCAL ROLE authenticated` per request, so the clone
     * needs the grants to `anon`, `authenticated` and `service_role`. Ownership is not kept,
     * because the `postgres` role on a Supabase server cannot give objects to `supabase_admin`.
     */
    private async dump_restore(source: string, target: string): Promise<string> {
        const env = { ...process.env, PGPASSWORD: this.address.password };
        const common = ["--host", this.address.host, "--port", String(this.address.port)];
        const scratch = mkdtempSync(join(tmpdir(), "spinner-dump-"));
        const dump_file = join(scratch, `${source}.dump`);
        try {
            const dump = await run(
                "pg_dump",
                [...common, "--username", this.address.user, "--format", "custom",
                    "--no-owner", "--file", dump_file, source],
                { env, timeout_ms: DUMP_TIMEOUT_MS },
            );
            if (dump.code !== 0) {
                throw new Error(`pg_dump ${source} failed: ${dump.stderr}`);
            }
            return await this.restore_file(dump_file, target, common, env);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }

    private async restore_file(
        dump_file: string,
        target: string,
        common: string[],
        env: NodeJS.ProcessEnv,
    ): Promise<string> {
        const restore = await run(
            "pg_restore",
            [...common, "--username", this.address.user, "--no-owner",
                "--dbname", target, dump_file],
            { env, timeout_ms: DUMP_TIMEOUT_MS },
        );
        // pg_restore exits 1 when some objects failed (extension-owned schemas on a Supabase
        // server, for example) and still restores the rest; a failed connection exits 2.
        if (restore.code > 1) {
            throw new Error(`pg_restore into ${target} failed: ${restore.stderr}`);
        }
        if (restore.code === 0) {
            return "";
        }
        const lines = restore.stderr.trim().split("\n");
        const errors = lines.filter((line) => line.includes("error:"));
        return `; ${errors.length} objects failed, first: ${errors[0] ?? lines[0] ?? ""}`;
    }

    /**
     * `ALTER DATABASE ... IS_TEMPLATE false` fails for `postgres` on Supabase when the
     * database is invalid (a failed clone); the superuser clears the flag in the catalog.
     */
    private async clear_template_flag(name: string): Promise<void> {
        try {
            await this.query("postgres", `ALTER DATABASE "${name}" IS_TEMPLATE false`);
            return;
        } catch (error) {
            if (this.address.admin_user === undefined) {
                throw error;
            }
        }
        const admin = { ...this.address, user: this.address.admin_user };
        await this.query(
            "postgres",
            "UPDATE pg_database SET datistemplate = false WHERE datname = $1",
            [name],
            admin,
        );
    }

    /** Runs statements on a database, one call each, as the configured user. */
    async run_statements(database: string, statements: string[]): Promise<void> {
        assert_identifier(database);
        for (const statement of statements) {
            assert.ok(statement.trim().length > 0, "empty statement");
            await this.query(database, statement);
        }
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
        address: ServerAddress = this.address,
    ): Promise<Row[]> {
        const client = new pg.Client({ ...address, database, connectionTimeoutMillis: 5_000 });
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

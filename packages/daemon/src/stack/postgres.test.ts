// Goal: the server address for an external database carries the superuser for the steps the
// configured user may not do, and the managed server has none. Method: pure derivation.
import { describe, expect, it } from "vitest";
import { server_address } from "./postgres.js";

describe("server_address", () => {
    it("adds supabase_admin for an external server and nothing for the managed one", () => {
        const external = server_address({
            mode: "template",
            server: "external",
            external: { host: "127.0.0.1", port: 54322, user: "postgres" },
        });
        expect(external).toEqual({
            host: "127.0.0.1",
            port: 54322,
            user: "postgres",
            password: "postgres",
            admin_user: "supabase_admin",
        });
        const custom = server_address({
            mode: "template",
            server: "external",
            external: { host: "h", port: 1, user: "u", password: "p", admin_user: "root" },
        });
        expect(custom.admin_user).toBe("root");
        expect(server_address({ mode: "template" }).admin_user).toBeUndefined();
    });
});

// The sample-stack steps the drivers share: a new session on the project through the UI's
// form, `run local` until the web service is healthy, and the web preview tab selected.
import { sleep, text, type Page } from "./cdp.ts";

export interface SampleSession {
    dir: string;
    /** `s017` from `s017-desktop-popout-93809`. */
    id: string;
    title: string;
}

export async function create_sample_session(
    ui: Page,
    project: string,
    title: string,
): Promise<SampleSession> {
    // The side panel with the sessions list may be hidden; the bar's toggle shows it.
    const shown = await ui.evaluate(`document.querySelector("[aria-label=Sessions]") !== null`);
    if (shown !== true) {
        await ui.click("[aria-label='Show side panel']");
        await ui.until("side panel", `document.querySelector("[aria-label=Sessions]") !== null`);
    }
    await ui.fill("[aria-label='New session title']", title);
    const picked = await ui.evaluate(`(() => {
        const select = document.querySelector("form[aria-label='New session'] select");
        const name = ${JSON.stringify(project)};
        const option = [...select.options].find((o) => o.textContent === name);
        if (!option) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    })()`);
    if (picked !== true) {
        throw new Error(`no project named ${project} in the new-session form`);
    }
    await ui.click("form[aria-label='New session'] button");
    const quoted = JSON.stringify(title);
    await ui.until("new session selected", `${text(".session-selected")}.includes(${quoted})`);
    const dir = (await ui.evaluate(
        `document.querySelector(".session-selected")?.innerText.match(/s\\d+-[a-z0-9-]+/)?.[0]`,
    )) as string | undefined;
    if (dir === undefined) {
        throw new Error("could not read the new session's dir from the pane");
    }
    const id = dir.split("-")[0];
    if (id === undefined) {
        throw new Error(`no id in ${dir}`);
    }
    console.log(`session ${dir}`);
    return { dir, id, title };
}

export async function run_local(ui: Page): Promise<void> {
    await ui.until(
        "run local enabled",
        `[...document.querySelectorAll(".actions button")]
            .some((b) => b.textContent === "run local" && !b.disabled)`,
    );
    await ui.click(".actions button", "run local");
    await ui.until(
        "web healthy",
        `[...document.querySelectorAll(".services tbody tr")]
            .some((r) => r.innerText.includes("web") && r.innerText.includes("healthy"))`,
    );
    await ui.until("job finished", `${text(".drawer")}.includes("ok")`);
    await ui.click(".drawer button", "close");
}

/**
 * Selects the web tab and reloads it once the proxy has the route. The reload sometimes
 * leaves the first tab selected (seen in the desktop app, reported to ui), so the tab is
 * selected again after it.
 */
export async function open_web_tab(ui: Page): Promise<void> {
    const web_box = `document.querySelector('.preview-box[data-preview$="/web"]') !== null`;
    await ui.click(".preview-pane .tab", "web");
    await ui.until("web box rendered", web_box);
    await sleep(2500);
    await ui.click(".preview-bar button", "reload");
    await sleep(2000);
    await ui.click(".preview-pane .tab", "web");
    await ui.until("web box rendered again", web_box);
    await sleep(1000);
}

/** The operator's daemon port; a driver that closes sessions never runs against it. */
const OPERATOR_PORT = "7777";

/**
 * The drivers create and close sessions, so they run against a scratch daemon only: start
 * one with `SPINNER_HOME=$(mktemp -d) SPINNER_PORT=<port> spinner daemon start` and point
 * the app and `E2E_DAEMON_URL` at it. The operator's daemon on :7777 is refused.
 */
export function assert_scratch_daemon(daemon_url: string): void {
    if (new URL(daemon_url).port === OPERATOR_PORT) {
        throw new Error(
            `${daemon_url} is the operator's daemon; the drivers close sessions, so run a` +
                ` scratch daemon (SPINNER_HOME, SPINNER_PORT) and set E2E_DAEMON_URL`,
        );
    }
}

/**
 * Closes the session by its dir through the daemon's API, never through the UI's button:
 * the button acts on whatever is selected, and a hand may change that during a run. Waits
 * until the daemon no longer lists the session.
 */
export async function close_session(session: SampleSession, daemon_url: string): Promise<void> {
    assert_scratch_daemon(daemon_url);
    const reply = await fetch(`${daemon_url}/sessions/${session.dir}/close`, { method: "POST" });
    if (!reply.ok) {
        throw new Error(`close ${session.dir}: ${reply.status} ${await reply.text()}`);
    }
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        const body = await (await fetch(`${daemon_url}/sessions`)).text();
        if (!body.includes(`"${session.dir}"`)) {
            await sleep(1500);
            return;
        }
        await sleep(1000);
    }
    throw new Error(`${session.dir} is still listed by the daemon`);
}

// Drives the running desktop app through the pane controls the UI renders, the way the
// operator does it: hide the agents pane (the preview pane takes the room and the view
// follows), pop the previews pane out from its header (the view moves to a window, no
// reload), dock it back from the strip, and close the session. Start the app as for
// `popout.ts`, then:
//   E2E_CDP_PORT=<port> E2E_APP_PID=<pid> E2E_WINPID=<helper> node e2e/panes.ts <shot dir>
// The login step of Plan 5 (the operator's app signed in inside the pop-out) is the
// operator's: the hash kept across the moves is the stand-in here.
// This flow drives the UI of 13:20 on 2026-10-29 (pane headers with `hide` and `pop out`,
// strips). The UI pass of 13:53 took the header controls out, so against it the flow stops
// at `Hide agents`; `popout.ts` covers the bridge without the UI's buttons.
import { execFileSync } from "node:child_process";
import { Page, sleep, target_with, targets, text } from "./cdp.ts";
import {
    assert_scratch_daemon,
    close_session,
    create_sample_session,
    open_web_tab,
    run_local,
} from "./sample-session.ts";

const [out_dir] = process.argv.slice(2);
if (out_dir === undefined) {
    throw new Error("Usage: panes.ts <screenshot dir>");
}
const APP_PID = process.env["E2E_APP_PID"];
const WINPID = process.env["E2E_WINPID"];
const DAEMON_URL = process.env["E2E_DAEMON_URL"] ?? "http://127.0.0.1:7777";
const PROJECT = process.env["E2E_PROJECT"] ?? "sample";
assert_scratch_daemon(DAEMON_URL);

function shot(step: string): void {
    if (APP_PID === undefined || WINPID === undefined) {
        return;
    }
    const lines = execFileSync(WINPID, [APP_PID], { encoding: "utf8" }).trim().split("\n");
    for (const line of lines.filter((l) => l !== "")) {
        const [number, title] = line.split("\t");
        const slug = (title ?? "window").replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
        const path = `${out_dir}/${step}-${slug}.png`;
        execFileSync("screencapture", ["-x", "-o", "-l", String(number), path]);
        console.log(`screenshot ${path}`);
    }
}

function expect(label: string, ok: boolean, detail: string): void {
    console.log(`${label}: ${detail} ${ok ? "ok" : "FAIL"}`);
    if (!ok) {
        shot("failure");
        throw new Error(label);
    }
}

interface Size {
    width: number;
    height: number;
}

async function view_state(prefix: string): Promise<{ id: string; size: Size; hash: string }> {
    const target = await target_with(prefix);
    const page = await Page.open(target);
    const value = (await page.evaluate(
        `({ width: window.innerWidth, height: window.innerHeight, hash: location.hash })`,
    )) as Size & { hash: string };
    page.close();
    return { id: target.id, size: { width: value.width, height: value.height }, hash: value.hash };
}

async function box(ui: Page): Promise<Size> {
    return (await ui.evaluate(`(() => {
        const r = document.querySelector(".preview-box").getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
    })()`)) as Size;
}

function fits(view: Size, expected: Size): boolean {
    const width_ok = Math.abs(view.width - expected.width) <= 1;
    const height_ok = Math.abs(view.height - expected.height) <= 1;
    return width_ok && height_ok;
}

const ui_target = (await targets()).find((t) => t.url.startsWith(DAEMON_URL));
if (ui_target === undefined) {
    throw new Error(`no CDP target at ${DAEMON_URL}; is the app running with the port?`);
}
const ui = await Page.open(ui_target, () => shot("failure"));
await ui.until("daemon connected", `${text(".status")}.includes("open")`);
expect("bridge", (await ui.evaluate(`typeof window.spinnerDesktop`)) === "object", "on page");
// A strip left by an earlier run or a hand would skew the widths; start from the default.
await ui.evaluate(`(localStorage.removeItem("spinner.layout.v2"), location.reload(), true)`);
await sleep(2500);
await ui.until("agents pane", `document.querySelector("[aria-label=Agents]") !== null`);

const session = await create_sample_session(ui, PROJECT, `Desktop panes ${Date.now() % 100000}`);
await run_local(ui);
const web_url = `http://web.${session.id}.localhost`;
await open_web_tab(ui);
{
    const page = await Page.open(await target_with(web_url));
    await page.evaluate(`(location.hash = "#kept", true)`);
    page.close();
}
const docked = await view_state(web_url);
const docked_box = await box(ui);
expect("view fits the pane", fits(docked.size, docked_box),
    `view ${docked.size.width}x${docked.size.height} box ${docked_box.width}x${docked_box.height}`);
shot("30-three-panes");

// Hide agents: the pane becomes a strip, the previews pane takes the room, the view follows.
await ui.click("[aria-label='Hide agents']");
await ui.until("agents strip", `document.querySelector(".strip[data-pane=agents]") !== null`);
await sleep(1200);
const wide = await view_state(web_url);
const wide_box = await box(ui);
expect("preview pane grew", wide_box.width > docked_box.width + 100,
    `box ${docked_box.width} -> ${wide_box.width}`);
expect("view follows the wider pane", fits(wide.size, wide_box),
    `view ${wide.size.width}x${wide.size.height} box ${wide_box.width}x${wide_box.height}`);
shot("31-agents-hidden");

// Pop out from the previews header: a strip in the main window, the same page in a window.
await ui.click("[aria-label='Pop out previews']");
await ui.until("previews strip", `document.querySelector(".strip[data-pane=previews]") !== null`);
await sleep(1500);
const popped = await view_state(web_url);
expect("pop out keeps the page", popped.id === docked.id && popped.hash === "#kept",
    `target ${popped.id} hash ${popped.hash}`);
expect("pop out window at the pane's size", fits(popped.size, wide_box),
    `view ${popped.size.width}x${popped.size.height}` +
        ` pane was ${wide_box.width}x${wide_box.height}`);
const listed = (await ui.evaluate(`window.spinnerDesktop.panes.list()`)) as unknown[];
expect("one popped-out window", listed.length === 1, JSON.stringify(listed));
shot("32-previews-popped");

// Dock back from the strip: the pane returns, the view is placed again, still the same page.
await ui.click(".strip[data-pane=previews]");
await ui.until("previews pane back", `document.querySelector(".preview-box") !== null`);
await sleep(1500);
const back = await view_state(web_url);
const back_box = await box(ui);
expect("docked view keeps the page", back.id === docked.id && back.hash === "#kept",
    `target ${back.id} hash ${back.hash}`);
expect("docked view fits the pane", fits(back.size, back_box),
    `view ${back.size.width}x${back.size.height} box ${back_box.width}x${back_box.height}`);
expect("no window left", ((await ui.evaluate(`window.spinnerDesktop.panes.list()`)) as unknown[])
    .length === 0, "");
shot("33-docked-back");

// Restore agents from its strip, then close the session.
await ui.click(".strip[data-pane=agents]");
await ui.until("agents pane back", `document.querySelector(".strip[data-pane=agents]") === null`);
await close_session(session, DAEMON_URL);
const leftover = (await targets()).filter((t) => t.url.includes(`.${session.id}.localhost`));
expect("views gone with the session", leftover.length === 0, `${leftover.length} left`);
shot("34-closed");
console.log("panes flow ok");
ui.close();
process.exit(0);

// Drives the browser-bar half of the bridge over the DevTools protocol, calling the bridge
// from the UI page so it does not need the bar itself. Start the app as for `popout.ts`, then:
//   E2E_CDP_PORT=<port> node e2e/browser-bar.ts
// The flow, on the web preview of a new sample session: navigate to the api's `/items`,
// back, forward (the view's CDP target stays, its URL and the `navigated` events follow),
// zoom in, in, reset (the page's CSS width shrinks and returns), find a word (count and
// the next match), clear the search, set a localStorage value and clear the origin's
// storage (gone after the reload the call makes), and close the session.
import { Page, sleep, target_with, targets, text } from "./cdp.ts";
import {
    assert_scratch_daemon,
    close_session,
    create_sample_session,
    open_web_tab,
    run_local,
} from "./sample-session.ts";

const DAEMON_URL = process.env["E2E_DAEMON_URL"] ?? "http://127.0.0.1:7777";
const PROJECT = process.env["E2E_PROJECT"] ?? "sample";
assert_scratch_daemon(DAEMON_URL);

function expect(label: string, ok: boolean, detail: string): void {
    console.log(`${label}: ${detail} ${ok ? "ok" : "FAIL"}`);
    if (!ok) {
        throw new Error(label);
    }
}

interface ViewState {
    id: string;
    url: string;
    width: number;
    stored: string | null;
}

/** The web view's target, by the host part: the path changes during the flow. */
async function view_state(host: string): Promise<ViewState> {
    const target = await target_with(`http://${host}`);
    const page = await Page.open(target);
    const value = (await page.evaluate(
        `({ url: location.href, width: window.innerWidth, stored: localStorage.getItem("mark") })`,
    )) as Omit<ViewState, "id">;
    page.close();
    return { id: target.id, ...value };
}

interface Navigated {
    url: string;
    title: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
}

const ui_target = (await targets()).find((t) => t.url.startsWith(DAEMON_URL));
if (ui_target === undefined) {
    throw new Error(`no CDP target at ${DAEMON_URL}; is the app running with the port?`);
}
const ui = await Page.open(ui_target);
await ui.until("daemon connected", `${text(".status")}.includes("open")`);
await ui.evaluate(`(localStorage.removeItem("spinner.layout.v2"), location.reload(), true)`);
await sleep(2500);
await ui.until("agents pane", `document.querySelector("[aria-label=Agents]") !== null`);
expect("bridge", (await ui.evaluate(`typeof window.spinnerDesktop`)) === "object", "on page");
await ui.evaluate(`(() => {
    window.__nav = [];
    window.spinnerDesktop.previews.subscribe((event) => {
        if (event.type === "navigated") window.__nav.push(event);
    });
    return true;
})()`);
const bridge = (call: string) => ui.evaluate(`window.spinnerDesktop.previews.${call}`);
/** The last `navigated` event for the key, once the view is idle. */
async function last_navigated(key: string): Promise<Navigated> {
    await ui.until(
        "view idle",
        `(() => { const e = window.__nav.filter((n) => n.key === ${JSON.stringify(key)}).at(-1);
            return e !== undefined && e.loading === false; })()`,
        20_000,
    );
    return (await ui.evaluate(
        `window.__nav.filter((n) => n.key === ${JSON.stringify(key)}).at(-1)`,
    )) as Navigated;
}

const session = await create_sample_session(ui, PROJECT, `Browser bar ${Date.now() % 100000}`);
await run_local(ui);
const host = `web.${session.id}.localhost`;
const key = `${session.dir}/web`;
await open_web_tab(ui);
const start = await view_state(host);
const api_url = `http://api.${session.id}.localhost/items`;

// Navigate inside the view: same target, the api page, back is possible.
await bridge(`navigate(${JSON.stringify(key)}, ${JSON.stringify(api_url)})`);
await sleep(1500);
let nav = await last_navigated(key);
expect("navigate changes the view's url", nav.url === api_url && nav.canGoBack,
    JSON.stringify(nav));
const api_target = await target_with(api_url);
expect("navigate stays in the view", api_target.id === start.id, `target ${api_target.id}`);

// Back and forward walk the history; the events tell the bar which buttons to enable.
await bridge(`back(${JSON.stringify(key)})`);
await sleep(1500);
nav = await last_navigated(key);
expect("back returns to the web page",
    nav.url.startsWith(`http://${host}`) && nav.canGoForward && !nav.canGoBack,
    JSON.stringify(nav));
expect("back reports the title", nav.title.includes("sample"), JSON.stringify(nav.title));
await bridge(`forward(${JSON.stringify(key)})`);
await sleep(1500);
nav = await last_navigated(key);
expect("forward returns to the api page", nav.url === api_url && nav.canGoBack, nav.url);
await bridge(`back(${JSON.stringify(key)})`);
await sleep(1500);
await last_navigated(key);

// Zoom: the CSS viewport narrows by one level (20 %) per step and comes back on reset.
await bridge(`zoom(${JSON.stringify(key)}, "in")`);
await bridge(`zoom(${JSON.stringify(key)}, "in")`);
await sleep(800);
const zoomed = await view_state(host);
const expected_zoomed = Math.round(start.width / 1.44);
expect("zoom in twice narrows the css viewport", Math.abs(zoomed.width - expected_zoomed) <= 2,
    `${start.width} -> ${zoomed.width} (expected ${expected_zoomed})`);
await bridge(`zoom(${JSON.stringify(key)}, "reset")`);
await sleep(800);
const reset = await view_state(host);
expect("zoom reset restores it", Math.abs(reset.width - start.width) <= 1, `${reset.width}`);

// Find: the page says "sample stack" once and "API" twice or more; the same text again moves on.
type Found = { matches: number; active: number };
const find = (what: string) => bridge(`find(${JSON.stringify(key)}, ${JSON.stringify(what)})`);
const first = (await find("api")) as Found;
expect("find counts the matches", first.matches >= 2 && first.active === 1, JSON.stringify(first));
const second = (await find("api")) as Found;
expect("the same text finds the next match",
    second.matches === first.matches && second.active === 2, JSON.stringify(second));
const none = (await find("zzqx-not-there")) as Found;
expect("no match is zero", none.matches === 0, JSON.stringify(none));
expect("null clears", (await bridge(`find(${JSON.stringify(key)}, null)`)) === null, "");

// Clear storage: a mark in localStorage is gone after the call's reload, same target.
{
    const page = await Page.open(await target_with(`http://${host}`));
    await page.evaluate(`(localStorage.setItem("mark", "1"), document.cookie = "mark=1", true)`);
    page.close();
}
expect("mark set", (await view_state(host)).stored === "1", "");
await bridge(`clearStorage(${JSON.stringify(key)})`);
await sleep(2000);
await last_navigated(key);
const cleared = await view_state(host);
expect("storage cleared and the page reloaded", cleared.stored === null && cleared.id === start.id,
    `stored ${String(cleared.stored)} target ${cleared.id}`);
const cookie = await (async () => {
    const page = await Page.open(await target_with(`http://${host}`));
    const value = await page.evaluate(`document.cookie`);
    page.close();
    return value;
})();
expect("cookie cleared", cookie === "", JSON.stringify(cookie));

await close_session(session, DAEMON_URL);
const events = (await ui.evaluate(`window.__nav.length`)) as number;
console.log(`navigated events: ${events}`);
console.log("browser bar flow ok");
ui.close();
process.exit(0);

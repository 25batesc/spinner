import { useState } from "react";

import type { Session } from "@spinner/protocol";

import { Preview } from "./Preview.tsx";
import { Tabs } from "./Tabs.tsx";

export interface PreviewPaneProps {
    session: Session | undefined;
}

export function PreviewPane({ session }: PreviewPaneProps) {
    const [picked, setPicked] = useState<string | undefined>(undefined);
    const hosts = session?.stack.hosts ?? {};
    const services = Object.keys(hosts);
    const selected = picked !== undefined && services.includes(picked) ? picked : services[0];
    const host = selected === undefined ? undefined : hosts[selected];
    const url = host === undefined ? undefined : `http://${host}`;
    const running = session?.stack.state === "up";

    return (
        <section className="pane preview-pane" aria-label="Previews">
            <Tabs labels={services} selected={selected} onSelect={setPicked} />
            {url !== undefined && selected !== undefined && running ? (
                <>
                    <a href={url} target="_blank" rel="noreferrer">open in new window</a>
                    <Preview url={url} title={selected} />
                </>
            ) : (
                <p className="muted">
                    {session === undefined
                        ? "No session selected."
                        : `Stack ${session.stack.state}.`}
                </p>
            )}
        </section>
    );
}

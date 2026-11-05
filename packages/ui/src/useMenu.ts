// One rule for every toolbar menu (dogfood row 8, round 4 item r4.3): a menu opens and closes on
// its button, and it also closes on a pointer press outside its container and on Escape. The
// EGM ▾ menu (DesignActions.tsx), the ⋯ menu (SessionToolbar.tsx) and the Track menu
// (PaneHead.tsx) share it, so one menu never stays open while the operator works elsewhere.
import { useEffect, useRef, useState, type RefObject } from "react";

/** The part of a DOM event the close rule reads; a plain object in the tests. */
export interface MenuEvent {
    type: string;
    key?: string | undefined;
    target: unknown;
}

/** The part of the container the close rule reads: `Node.contains`. */
export interface MenuContainer {
    contains(node: unknown): boolean;
}

/**
 * True when the event closes an open menu: Escape, or a pointer press whose target lies outside
 * the container (the button and the menu inside it). A press inside, and any other key, keep
 * it open. Without a container (not mounted yet) only Escape closes.
 */
export function closesMenu(event: MenuEvent, container: MenuContainer | null): boolean {
    if (event.type === "keydown") {
        return event.key === "Escape";
    }
    if (event.type !== "pointerdown") {
        return false;
    }
    if (container === null) {
        return false;
    }
    return !container.contains(event.target);
}

export interface Menu<T extends HTMLElement> {
    open: boolean;
    toggle: () => void;
    close: () => void;
    /** Goes on the element that holds the button and the menu. */
    ref: RefObject<T | null>;
}

/**
 * An open flag with the close rule above. `onClose` runs on every close, whichever way it
 * came (the button, an item, an outside press, Escape), so a caller can forget its own state,
 * for example the ⋯ menu's archive question. The listeners exist only while the menu is open.
 */
export function useMenu<T extends HTMLElement>(onClose?: () => void): Menu<T> {
    const [open, setOpen] = useState(false);
    const ref = useRef<T | null>(null);
    const close = () => {
        setOpen(false);
        onClose?.();
    };
    const toggle = () => {
        if (open) {
            close();
        } else {
            setOpen(true);
        }
    };
    useEffect(() => {
        if (!open) {
            return;
        }
        const listener = (event: Event) => {
            const key = event instanceof KeyboardEvent ? event.key : undefined;
            const read: MenuEvent = { type: event.type, key, target: event.target };
            if (closesMenu(read, ref.current)) {
                close();
            }
        };
        // Capture, so a press on an element that stops propagation still closes the menu.
        document.addEventListener("pointerdown", listener, true);
        document.addEventListener("keydown", listener, true);
        return () => {
            document.removeEventListener("pointerdown", listener, true);
            document.removeEventListener("keydown", listener, true);
        };
        // `close` reads only setters and `onClose`; the listeners follow the open flag.
    }, [open]);
    return { open, toggle, close, ref };
}

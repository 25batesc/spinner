// The `archive` action of a session card and a review card (s038). The small button shows on
// hover and on keyboard focus; a click asks once in place of the card's content, and the
// confirm runs the existing `close` job through the caller. The context bar's `⋯` menu asks
// the same question (`SessionToolbar.tsx`).
export const ARCHIVE_QUESTION =
    "Archive this session? It moves to the archive and its agents stop.";

export function ArchiveButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            type="button"
            className="card-archive"
            title="Archive this session: its agents stop and its stack goes."
            onClick={onClick}
        >
            archive
        </button>
    );
}

export function ArchiveConfirm(props: { onArchive: () => void; onCancel: () => void }) {
    return (
        <div className="card-confirm" role="group" aria-label="Confirm archive">
            <span className="card-confirm-text">{ARCHIVE_QUESTION}</span>
            <span className="card-confirm-actions">
                <button type="button" className="danger" onClick={props.onArchive}>
                    archive
                </button>
                <button type="button" onClick={props.onCancel} autoFocus>
                    cancel
                </button>
            </span>
        </div>
    );
}

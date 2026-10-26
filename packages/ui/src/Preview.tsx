// The only component that knows how a preview is embedded. Today it is an iframe. The desktop
// shell will replace this file with a native web view; nothing else in the UI changes.

export interface PreviewProps {
    url: string;
    title: string;
}

export function Preview({ url, title }: PreviewProps) {
    return <iframe className="preview-frame" src={url} title={title} />;
}

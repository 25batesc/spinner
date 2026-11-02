// The EGM commit the daemon runs (docs/designs/egm-adoption.md, T2). This file is the source
// of truth for the pin. A moved pin fetches again on the next lead start or
// `POST /egm/fetch`, because `egm_fetched` compares the marker's sha with this one.
export const EGM_PIN = {
    repo: "google/elephant-goldfish-model",
    sha: "a119668d7dc5d558664ba711d4671d11fb7270a8",
} as const;

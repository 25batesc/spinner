# Cloud services that allow only fixed origins

## Symptoms

- `Access to XMLHttpRequest at 'https://api.example.com/...' from origin 'http://web.s1.localhost' has been blocked by CORS policy`: a cloud API the frontend calls keeps an allow-list of origins (`http://localhost:3001`, the dev domain). A session's hostname is not on it.
- `error=redirect_mismatch` from an OAuth provider (Cognito, Auth0): the app sends `window.location.origin + '/auth/callback'` and the provider's callback list has no wildcard.

Why it works "outside the container": locally the page is `http://localhost:3001`, which is exactly what those lists contain. It is the origin string, not the container.

## CORS: proxy through the session's origin

```yaml
services:
  web:
    host: web
    env:
      REACT_APP_LEGACY_API: http://web.${SESSION_ID}.localhost/upstream/legacy/api/v1/
    upstreams:                             # path prefix on this hostname → outside URL
      /upstream/legacy: https://api.example.com
```

The page calls `http://web.s1.localhost/upstream/legacy/api/v1/project`, which is same-origin, so the browser sends no preflight. The proxy strips the prefix and forwards to `https://api.example.com/api/v1/project` with the request's own headers, including the user's token. This is what webpack's `devServer.proxy` does, moved into the proxy so it works for every service and every session.

Rules:

1. Keep the trailing part of the URL the app expects; many apps concatenate without a slash (`.../dev/` + `project`).
2. A cloud service that allows any origin (a public auth API) stays direct. Proxy only what blocks you.
3. The proxy forwards whatever the page sends. Nothing is stored.

## OAuth callbacks: a reserved block of session ids

A redirect is a navigation, not a request the proxy can rewrite. The provider must know the callback URL. Ask the provider's administrator for one block, for example `http://web.s001.localhost/auth/callback` through `s020`, and let Spinner reserve ids in that block. Until then, use a login method that does not redirect (email and password through the auth API).

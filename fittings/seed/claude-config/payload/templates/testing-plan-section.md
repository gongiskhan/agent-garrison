## Testing Plan

<!-- Argus executes this section step-by-step at medium effort.
     Every VERIFY line must be directly observable (visible text, HTTP status,
     test pass/fail). Never write "works as expected" or vague outcomes. -->

### Environment Setup

<!-- Commands to start the dev server / test environment. -->

- Start dev server: `<command>`
- Wait for: `<health-check-URL or log line pattern>`
- Preconditions: `<required data, auth state, or seed — or "none">`

### Smoke Checks

<!-- Basic "is it alive" before functional testing. -->

1. Navigate to `<url>`
2. VERIFY: `<element or text is visible>`
3. VERIFY: no JavaScript console errors

### Functional Checks

<!-- Each numbered block tests one behavior. -->

1. `<user action>`
2. VERIFY: `<exact expected outcome — text, element, status code>`
3. `<next action>`
4. VERIFY: `<exact expected outcome>`

<!-- Add more blocks as needed. One behavior per block. -->

### Regression Checks

<!-- Features potentially disrupted by this change that must still work. -->

- `<feature area>`: `<specific observable thing to verify>`
- `<feature area>`: `<specific observable thing to verify>`

### Browser Flows (UI tasks only)

<!-- Skip this section for non-UI tasks. Use exact selectors and expected state. -->

1. `<action — e.g. Click button[data-testid="submit"]>`
2. VERIFY: `<text change or element appears — e.g. "Success" toast visible>`
3. `<next action>`
4. VERIFY: `<next expected state>`

### Test Commands

<!-- Exact shell commands to run automated tests. Omit if no test suite exists. -->

```bash
<test command>
```

Expected output: `<success pattern — e.g. "X passed, 0 failed">`

### Acceptance Criteria

<!-- Binary checklist — all must be true before the task is marked complete. -->

- [ ] `<criterion — must be falsifiable and observable>`
- [ ] `<criterion>`
- [ ] No regressions in `<related feature area>`

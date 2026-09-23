# Synthetic project

A miniature tree of JavaScript, TypeScript, Python, Go, Compose and CI inputs.
It exists only as deterministic input for the collector tests.

No credential-shaped file is committed here on purpose: the host packager strips
`.env*` and private-key files from the `.piplug`, so such a fixture would be
missing from an installed plugin while the tests still expected it. Sensitive
path skipping is covered by an in-memory test in `tests/collectors.test.js`.

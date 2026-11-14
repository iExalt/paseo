[ad-hoc-daemon-testing.md](upstream/ad-hoc-daemon-testing.md).
or any wide layout) needs the scale recipe above. The phone was not measured.
Prepare a fresh local or remote QA checkout with `npm ci` at the repository root, then run
`npm run build:server` and `npm run build:daemon-web-ui` there. Do not copy or symlink another
checkout's whole `node_modules` tree into it: workspace links can resolve to the other checkout,
and missing package-local dependencies can select an incompatible root dependency. Install and
build in the QA checkout before starting its daemon or browser tests.


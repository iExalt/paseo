# Keep normal e2e helpers: packaging hooks import them even when smoke is disabled.
name: builtins.match ".*\\.(test|spec)\\.[cm]?[jt]sx?" name != null

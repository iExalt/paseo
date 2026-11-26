# Test clocks

When the code under test owns a timer, control its clock. For a debounce test,
call `vi.useFakeTimers()`, trigger the debounce, then advance through its
deadline with `vi.advanceTimersByTimeAsync()` before checking the result.
Restore real timers in cleanup. Use Playwright's `page.clock` for browser app
timers or inject a clock when the test needs to control one component.

When a process or service owns the work, wait for an explicit signal or
observable state. For example, wait for a PTY to render a sentinel before taking
a screenshot.

Use wall-clock timeouts only as generous hang guards. For example, give the PTY
30 seconds to reach the sentinel before reporting a hang. Assert on behavior
after advancing the clock or observing the signal. For a negative timer assertion,
advance past the deadline before checking that the effect is absent. For
performance tests, prefer counting work or measuring CPU time when either
captures the property under test.

Convert fork-owned tests as you work on them. Convert upstream-owned tests when
you touch them or fix a flake in them. Keeping the conversions with related
changes reduces conflict during rebases onto upstream.
